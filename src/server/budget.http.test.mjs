// Tagesbudget am echten Server (ALMANAC-PLAN §2.5 + BRIDGE-PLAN I2): dieselbe
// Technik wie server.test.mjs — ein echter Server auf einem ephemeren Port,
// der Fake-Harness spielt die Turns; keine echten Prozesse, kein Netz.
//
// Die Gnaden-Grenze selbst wird NICHT mit gefriger Systemuhr durch den
// HTTP-Stack geprüft (der Server teilt Date.now() mit dem Test, aber ein
// gefrorener Timer-Harness gehört dem Runner-Test) — stattdessen trägt der
// letzte Test hier die Tagesgrenze über den EXPORTIERTEN dailyBudgetCheck
// mit injiziertem `now` über die Grenze, exakt wie der Digest-Test seine
// Zeitzonen-Zerlegung injiziert.
import { test, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startServer, dailyBudgetCheck } from './server.mjs';
import { TOKEN_HEADER } from './token.mjs';
import { createFakeHarness } from '../harness/fake.mjs';
import { appendRun, readRuns } from '../orchestrator/runs.mjs';
import { loadPolicy } from '../policy/policy.mjs';

const APP_HEADERS = { 'x-app-request': '1' };
const APP_JSON_HEADERS = { ...APP_HEADERS, 'Content-Type': 'application/json' };
const H = 60 * 60_000;

let tmpDir;
let dataDir;
let tmpRootDir;
let servers = [];
let currentToken = null;

const rawFetch = (...args) => globalThis.fetch(...args);
function fetch(input, init = {}) {
  return rawFetch(input, { ...init, headers: { ...(init.headers ?? {}), [TOKEN_HEADER]: currentToken ?? '' } });
}

beforeEach(() => {
  currentToken = null;
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'budget-http-test-'));
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'budget-http-data-'));
  tmpRootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'budget-http-tmproot-'));
  servers = [];
});

afterEach(async () => {
  vi.restoreAllMocks();
  for (const { server } of servers) {
    await new Promise((resolve) => server.close(resolve));
  }
  fs.rmSync(tmpDir, { recursive: true, force: true });
  fs.rmSync(dataDir, { recursive: true, force: true });
  fs.rmSync(tmpRootDir, { recursive: true, force: true });
});

async function boot(opts) {
  const started = await startServer({ port: 0, rootDir: tmpDir, dataDir, tmpRoot: tmpRootDir, ...opts });
  servers.push(started);
  currentToken = started.token;
  return started;
}

function postJson(url, body, headers = APP_JSON_HEADERS) {
  return fetch(url, { method: 'POST', headers, body: JSON.stringify(body) });
}

async function readSse(res) {
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const frames = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let idx;
    while ((idx = buffer.indexOf('\n\n')) !== -1) {
      const raw = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      if (!raw.startsWith('data: ')) continue;
      frames.push(JSON.parse(raw.slice('data: '.length)));
    }
  }
  return frames;
}

function fakeScript(costUsd = 0.0123) {
  return [
    { type: 'init', sessionId: 'sess-1', tools: [], model: 'claude-opus-5', permissionMode: 'default' },
    { type: 'text', text: 'Hello from the fake harness' },
    { type: 'result', sessionId: 'sess-1', costUsd, usage: { input_tokens: 10, output_tokens: 5 }, isError: false },
  ];
}

/** Legt eine Mission an und fährt EINEN echten Turn, damit es Chat + Runs-Verbrauch gibt. */
async function missionWithTurn({ url, harness, budgetUsd = null, spend = null } = {}) {
  const created = await (await postJson(`${url}/api/missions`, { title: 'budget mission', ...(budgetUsd !== null ? { budgetUsd } : {}) })).json();
  const mission = created.mission;
  const first = await fetch(`${url}/api/chat/turn`, { method: 'POST', headers: APP_JSON_HEADERS, body: JSON.stringify({ text: 'seed', missionId: mission.id }) });
  expect(first.status).toBe(200);
  const frames = await readSse(first);
  const chatId = frames.find((f) => f.type === 'chat-id').chatId;
  if (spend !== null) {
    // Nachträgliches Guthaben für heute — derselbe Chat, echte Kosten-Zeile.
    appendRun(dataDir, { chatId, costUsd: spend, durationMs: 1000, stopReason: 'end_turn' });
  }
  return { mission, chatId };
}

async function pendingBudgetQuestions(url) {
  const inbox = await (await fetch(`${url}/api/approvals`)).json();
  return inbox.approvals.filter((a) => a.kind === 'budget.day');
}

// ------------------------------------------------------------------ Tests

test('budget: ein interaktiver Turn über dem Tagesbudget wird NICHT gestartet — die deferred Frage liegt in der Inbox', async () => {
  const harness = createFakeHarness({ script: fakeScript() });
  const { url } = await boot({ harness, harnessName: 'fake' });
  const { mission, chatId } = await missionWithTurn({ url, harness, budgetUsd: 0.01 }); // ein Turn = $0.0123 bekannt

  const blocked = await fetch(`${url}/api/chat/turn`, { method: 'POST', headers: APP_JSON_HEADERS, body: JSON.stringify({ text: 'noch einer', chatId }) });
  expect(blocked.status).toBe(409);
  const body = await blocked.json();
  expect(body.error).toContain('Tagesbudget');
  expect(body.error).toContain('Der Turn wurde nicht gestartet');
  expect(body.error).toContain('Allow = Gnaden-Tag');
  expect(body.budget).toMatchObject({ budgetUsd: 0.01, spentKnownUsd: 0.0123, unknownRuns: 0 });

  // Die Frage ist eine Budget-Frage: klar erkennbar, deferred, 24-h-Fenster.
  const questions = await pendingBudgetQuestions(url);
  expect(questions).toHaveLength(1);
  expect(questions[0].mode).toBe('deferred');
  expect(questions[0].description).toContain('Tagesbudget');
  expect(questions[0].description).toContain('Heute weiterfahren?');

  // Der Turn ist nie gefahren: nur der Seed-Turn steht im Harness-Protokoll.
  expect(harness.startedTurns).toHaveLength(1);
});

test('budget: Allow ist ein Gnaden-Tag — der nächste Turn läuft und die Detail-Seite zeigt die Freigabe', async () => {
  const harness = createFakeHarness({ script: fakeScript() });
  const { url } = await boot({ harness, harnessName: 'fake' });
  const { mission, chatId } = await missionWithTurn({ url, harness, budgetUsd: 0.01 });

  const blocked = await fetch(`${url}/api/chat/turn`, { method: 'POST', headers: APP_JSON_HEADERS, body: JSON.stringify({ text: 'noch einer', chatId }) });
  expect(blocked.status).toBe(409);
  const [question] = await pendingBudgetQuestions(url);

  const answer = await postJson(`${url}/api/approvals/${question.id}`, { chatId, behavior: 'allow' });
  expect(answer.status).toBe(200);
  expect(await answer.json()).toMatchObject({ ok: true, budget: 'grace' });

  // Gnade: derselbe über-budgetäre Turn fährt jetzt einfach.
  const after = await fetch(`${url}/api/chat/turn`, { method: 'POST', headers: APP_JSON_HEADERS, body: JSON.stringify({ text: 'gnaden-turn', missionId: mission.id }) });
  expect(after.status).toBe(200);
  const frames = await readSse(after);
  expect(frames.map((f) => f.type)).toContain('turn-complete');
  expect(harness.startedTurns).toHaveLength(2);

  // Sichtbar: Missions-Detail zeigt den Gnaden-Status, und die Gnade liegt
  // mit ihrem lokalen Tages-Datum auf disk (Reset über die Grenze, kein Cron).
  const detail = await (await fetch(`${url}/api/missions/${mission.id}`)).json();
  expect(detail.budget.graceToday).toBe(true);
  const graces = JSON.parse(fs.readFileSync(path.join(dataDir, 'budget-grace.json'), 'utf8'));
  expect(graces.graces[mission.id].decision).toBe('allow');
  expect(graces.graces[mission.id].dayKey).toMatch(/^\d{4}-\d{2}-\d{2}$/);
});

test('budget: die Gnade endet an der lokalen Tagesgrenze — mit injiziertem now über die Grenze fragt die Mission wieder', async () => {
  const { url } = await boot({ harness: createFakeHarness({ script: fakeScript() }), harnessName: 'fake' });
  const { mission, chatId } = await missionWithTurn({ url, budgetUsd: 0.01 });
  const fresh = (await (await fetch(`${url}/api/missions/${mission.id}`)).json()).mission; // mit dem verlinkten Chat

  // Run-Verbrauch INNERHALB des injizierten Tages (der Seed-Turn lief auf der
  // echten Uhr, dieses Append liegt auf den 2026-03-31 Berlin).
  const TZ = 'Europe/Berlin';
  const dtf = new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  });
  const parts = (ms) => {
    const p = {};
    for (const { type, value } of dtf.formatToParts(new Date(ms))) p[type] = value;
    return { y: +p.year, m: +p.month - 1, d: +p.day, h: +p.hour, min: +p.minute, s: +p.second };
  };
  const asUTC = ({ y, m, d, h = 0, min = 0, s = 0 }) => Date.UTC(y, m, d, h, min, s);
  const decompose = (ms) => { const { y, m, d } = parts(ms); return { y, m, d }; };
  const compose = ({ y, m, d }) => {
    let ms = asUTC({ y, m, d, h: 12 });
    const offset = asUTC(parts(ms)) - ms;
    ms = asUTC({ y, m, d }) - offset;
    return asUTC({ y, m, d }) - (asUTC(parts(ms)) - ms);
  };

  const evening = asUTC({ y: 2026, m: 2, d: 31, h: 12 }); // 14:00 Berlin am 2026-03-31
  const tomorrowNoon = asUTC({ y: 2026, m: 3, d: 1, h: 10 }) - 2 * H; // 12:00 Berlin am 2026-04-01
  // Run-Verbrauch in BEIDEN lokalen Fenstern: heute (die Gnade greift) und
  // morgen (nach der Grenze zählt der neue Tag neu).
  appendRun(dataDir, { chatId, costUsd: 0.0123, durationMs: 1000, stopReason: 'end_turn', ts: new Date(evening).toISOString() });
  appendRun(dataDir, { chatId, costUsd: 0.0123, durationMs: 1000, stopReason: 'end_turn', ts: new Date(tomorrowNoon).toISOString() });

  // Gnade für "heute" eintragen (derselbe Weg, den der Server beim Allow nimmt).
  fs.writeFileSync(
    path.join(dataDir, 'budget-grace.json'),
    JSON.stringify({ version: 1, graces: { [mission.id]: { dayKey: '2026-03-31', decidedAt: evening, decision: 'allow' } } }),
    'utf8',
  );

  const verdictToday = dailyBudgetCheck({ dataDir, policy: loadPolicy(dataDir), mission: fresh, chatList: [], missions: [fresh], now: evening, decompose, compose });
  expect(verdictToday.grace).toBe(true);
  expect(verdictToday.exceeded).toBe(false);

  // Über die Grenze: die Gnade ist weg, der Stand des NEUEN Tages
  // (0.0123 >= 0.01) zählt wieder — die Mission wird wieder gefragt.
  expect(decompose(tomorrowNoon)).toEqual({ y: 2026, m: 3, d: 1 });
  const verdictTomorrow = dailyBudgetCheck({ dataDir, policy: loadPolicy(dataDir), mission: fresh, chatList: [], missions: [fresh], now: tomorrowNoon, decompose, compose });
  expect(verdictTomorrow.grace).toBe(false);
  expect(verdictTomorrow.exceeded).toBe(true);
});

test('budget: Deny lehnt ehrlich ab — der Ablehnungstext nennt Budget und Stand, und die Frage kommt wieder', async () => {
  const harness = createFakeHarness({ script: fakeScript() });
  const { url } = await boot({ harness, harnessName: 'fake' });
  const { mission, chatId } = await missionWithTurn({ url, harness, budgetUsd: 0.01 });

  const firstBlock = await fetch(`${url}/api/chat/turn`, { method: 'POST', headers: APP_JSON_HEADERS, body: JSON.stringify({ text: 'noch einer', chatId }) });
  expect(firstBlock.status).toBe(409);
  const firstBody = await firstBlock.json();
  expect(firstBody.error).toContain('$0.01 von $0.01'); // der Stand, auf Cent gerundet

  const [question] = await pendingBudgetQuestions(url);
  const answer = await postJson(`${url}/api/approvals/${question.id}`, { chatId, behavior: 'deny', message: 'heute nicht' });
  expect(answer.status).toBe(200);
  expect(await answer.json()).toMatchObject({ ok: true, budget: 'denied' });

  // Kein Gnaden-Tag: der nächste Versuch wird wieder ehrlich abgelehnt und
  // fragt erneut (nur ein Allow unterdrückt das Wiederfragen).
  const secondBlock = await fetch(`${url}/api/chat/turn`, { method: 'POST', headers: APP_JSON_HEADERS, body: JSON.stringify({ text: 'noch einer', chatId }) });
  expect(secondBlock.status).toBe(409);
  const secondBody = await secondBlock.json();
  expect(secondBody.error).toContain('Tagesbudget');
  expect(secondBody.error).toContain('$0.01 von $0.01');
  expect(secondBody.error).toContain('Der Turn wurde nicht gestartet');
  const questions = await pendingBudgetQuestions(url);
  expect(questions).toHaveLength(1);
  expect(harness.startedTurns).toHaveLength(1);
});

test('budget: unbekannte Kosten zählen NICHT als Geld, stehen aber im Zähler — ein Tag nur unknown kann nicht sperren', async () => {
  const harness = createFakeHarness({ script: fakeScript() });
  const { url } = await boot({ harness, harnessName: 'fake' });
  const { mission, chatId } = await missionWithTurn({ url, harness, budgetUsd: 0.01 });

  // Bekannt $0.02 + zwei Läufe ohne Kostendaten → gesperrt, und der Text
  // zählt die unknown-Läufe, statt sie als 0 zu verschweigen.
  appendRun(dataDir, { chatId, costUsd: 0.02, durationMs: 1000, stopReason: 'end_turn' });
  appendRun(dataDir, { chatId, costUsd: null, durationMs: 1000, stopReason: 'end_turn' });
  appendRun(dataDir, { chatId, costUsd: null, durationMs: 1000, stopReason: 'end_turn' });

  const blocked = await fetch(`${url}/api/chat/turn`, { method: 'POST', headers: APP_JSON_HEADERS, body: JSON.stringify({ text: 'noch einer', chatId }) });
  expect(blocked.status).toBe(409);
  const body = await blocked.json();
  expect(body.budget).toMatchObject({ spentKnownUsd: 0.0323, unknownRuns: 2 }); // Seed-Turn + Append, die unknown zählen separat
  expect(body.error).toContain('$0.03 von $0.01');
  expect(body.error).toContain('2 Läufe ohne Kostendaten');

  // Und die andere Richtung: NUR unbekannte Kosten sperren nicht — der Turn fährt.
  const noCostScript = [
    { type: 'init', sessionId: 'sess-1', tools: [], model: 'm', permissionMode: 'default' },
    { type: 'text', text: 'Hello from the fake harness' },
    { type: 'result', sessionId: 'sess-1', usage: { input_tokens: 10, output_tokens: 5 }, isError: false },
  ];
  const harness2 = createFakeHarness({ script: noCostScript });
  const { url: url2 } = await boot({ harness: harness2, harnessName: 'fake' });
  const created2 = await (await postJson(`${url2}/api/missions`, { title: 'unknown only', budgetUsd: 0.01 })).json();
  const first2 = await fetch(`${url2}/api/chat/turn`, { method: 'POST', headers: APP_JSON_HEADERS, body: JSON.stringify({ text: 'seed ohne Kosten', missionId: created2.mission.id }) });
  expect(first2.status).toBe(200);
  await readSse(first2);
  // Sicherheitshalber noch zwei Läufe ohne Kostendaten dazu.
  const chatId2 = (await (await fetch(`${url2}/api/chat/list`)).json()).chats[0].id;
  appendRun(dataDir, { chatId: chatId2, costUsd: null, durationMs: 1000, stopReason: 'end_turn' });
  appendRun(dataDir, { chatId: chatId2, costUsd: null, durationMs: 1000, stopReason: 'end_turn' });

  const detail2 = await (await fetch(`${url2}/api/missions/${created2.mission.id}`)).json();
  expect(detail2.budget.spentKnownUsd).toBe(0); // bekannt ist nichts…
  expect(detail2.budget.unknownRuns).toBeGreaterThanOrEqual(3); // …aber die Läufe werden gezählt, nicht verschwiegen
  const turn2 = await fetch(`${url2}/api/chat/turn`, { method: 'POST', headers: APP_JSON_HEADERS, body: JSON.stringify({ text: 'noch einer', missionId: created2.mission.id }) });
  expect(turn2.status).toBe(200); // ein Tag ohne bekannte Kosten kann das Budget nicht ausreizen
  await readSse(turn2);
});

test('budget: kein Budget gesetzt — kein Eingriff, keine Frage, kein Fake-Limit', async () => {
  const harness = createFakeHarness({ script: fakeScript() });
  const { url } = await boot({ harness, harnessName: 'fake' });
  const { mission, chatId } = await missionWithTurn({ url, harness }); // kein budgetUsd

  // Sehr hoher bekannter Verbrauch ändert nichts: ohne Budget kein Limit.
  appendRun(dataDir, { chatId: 'free-chat', costUsd: 500, durationMs: 1000, stopReason: 'end_turn' });
  const turn = await fetch(`${url}/api/chat/turn`, { method: 'POST', headers: APP_JSON_HEADERS, body: JSON.stringify({ text: 'noch einer', chatId }) });
  expect(turn.status).toBe(200);
  await readSse(turn);
  expect(await pendingBudgetQuestions(url)).toHaveLength(0);

  const detail = await (await fetch(`${url}/api/missions/${mission.id}`)).json();
  expect(detail.budget).toMatchObject({ missionBudgetUsd: null, policyDefaultUsd: null, effectiveUsd: null, graceToday: false });
  expect(detail.budget.effectiveUsd).toBe(null); // ausdrücklich KEIN 0-Fake
});

test('budget: der policy-Default ist eine DECKE — die Mission verschärft, ein größeres Missions-Budget ändert nichts', async () => {
  fs.writeFileSync(path.join(dataDir, 'policy.json'), JSON.stringify({ budget: { defaultDailyUsd: 0.05 } }), 'utf8');
  const harness = createFakeHarness({ script: fakeScript() });
  const { url } = await boot({ harness, harnessName: 'fake' });

  // Engere Mission: effektiv 0.02, der Seed-Turn (0.0123) + 0.02 bekannt sperrt.
  const tight = await missionWithTurn({ url, harness, budgetUsd: 0.02, spend: 0.02 });
  const tightBlocked = await fetch(`${url}/api/chat/turn`, { method: 'POST', headers: APP_JSON_HEADERS, body: JSON.stringify({ text: 'noch einer', missionId: tight.mission.id }) });
  expect(tightBlocked.status).toBe(409);
  expect((await tightBlocked.json()).budget.budgetUsd).toBe(0.02);

  // Weitere Mission (2.00 über der Decke): effektiv 0.05, 0.0323 bekannt fährt durch.
  const loose = await missionWithTurn({ url, harness, budgetUsd: 2, spend: 0.02 });
  const looseDetail = await (await fetch(`${url}/api/missions/${loose.mission.id}`)).json();
  expect(looseDetail.budget.effectiveUsd).toBe(0.05); // die Decke, nicht das größere Mission-Budget
  const looseTurn = await fetch(`${url}/api/chat/turn`, { method: 'POST', headers: APP_JSON_HEADERS, body: JSON.stringify({ text: 'noch einer', missionId: loose.mission.id }) });
  expect(looseTurn.status).toBe(200);
  await readSse(looseTurn);

  // Das Feld am Mission-Endpunkt: setzen, leeren (null), Unsinn → 400.
  const set = await postJson(`${url}/api/missions/${loose.mission.id}/budget`, { budgetUsd: 0.01 });
  expect(set.status).toBe(200);
  expect((await set.json()).mission.budgetUsd).toBe(0.01);
  const cleared = await postJson(`${url}/api/missions/${loose.mission.id}/budget`, { budgetUsd: null });
  expect((await cleared.json()).mission.budgetUsd).toBe(null);
  const bad = await postJson(`${url}/api/missions/${loose.mission.id}/budget`, { budgetUsd: -1 });
  expect(bad.status).toBe(400);
  const detail = await (await fetch(`${url}/api/missions/${loose.mission.id}`)).json();
  expect(detail.budget.effectiveUsd).toBe(0.05); // wieder die Decke
});

test('budget: Missionsloses Turn zählt gegen den GLOBALEN policy-Default — Missions-Verbrauch bleibt draußen', async () => {
  fs.writeFileSync(path.join(dataDir, 'policy.json'), JSON.stringify({ budget: { defaultDailyUsd: 0.02 } }), 'utf8');
  const harness = createFakeHarness({ script: fakeScript() });
  const { url } = await boot({ harness, harnessName: 'fake' });

  // Eine Mission mit Verbrauch, aber OHNE eigenes Budget: unter einer Decke
  // von 0.05… hier 0.02 — ihr eigener Turn sperrt also sofort; wichtiger ist
  // der Global-Bucket: Missions-Runs zählen NICHT in ihn.
  const owned = await missionWithTurn({ url, harness, spend: 0.0123 });

  // Missionsloser Chat mit kleinem Verbrauch: der Global-Bucket steht bei $0.
  const freeTurn = await fetch(`${url}/api/chat/turn`, { method: 'POST', headers: APP_JSON_HEADERS, body: JSON.stringify({ text: 'frei' }) });
  expect(freeTurn.status).toBe(200);
  await readSse(freeTurn);

  // Der Missions-Turn dagegen sperrt (0.0246 >= 0.02, min-Decke greift am
  // Mission-Bucket), und die Frage trägt die Mission.
  const ownedBlocked = await fetch(`${url}/api/chat/turn`, { method: 'POST', headers: APP_JSON_HEADERS, body: JSON.stringify({ text: 'noch einer', missionId: owned.mission.id }) });
  expect(ownedBlocked.status).toBe(409);
  const [question] = await pendingBudgetQuestions(url);
  expect(question.missionId).toBe(owned.mission.id);

  // Jetzt den Global-Bucket sprengen: ein missionsloser Run mit $5 sperrt den
  // nächsten missionslosen Turn — der Gnaden-Schlüssel ist _global, nicht die Mission.
  appendRun(dataDir, { chatId: 'some-free-chat', costUsd: 5, durationMs: 1000, stopReason: 'end_turn' });
  const freeBlocked = await fetch(`${url}/api/chat/turn`, { method: 'POST', headers: APP_JSON_HEADERS, body: JSON.stringify({ text: 'noch frei?' }) });
  expect(freeBlocked.status).toBe(409);
  const body = await freeBlocked.json();
  expect(body.error).toContain('$5.01 von $0.02'); // $5-Append + der freie Seed-Turn
  expect(body.budget.chatId).toBeTruthy();
});

test('budget: der Leitstand aggregiert nur Missionen MIT Budget — keine Mission ohne Budget erscheint', async () => {
  const harness = createFakeHarness({ script: fakeScript() });
  const { url } = await boot({ harness, harnessName: 'fake' });
  const withBudget = await missionWithTurn({ url, harness, budgetUsd: 1, spend: 0.02 });
  // Zweite Mission OHNE Budget — sie darf in der Budget-Aggregat-Liste nicht auftauchen.
  await (await postJson(`${url}/api/missions`, { title: 'no budget' })).json();

  const leitstand = await (await fetch(`${url}/api/leitstand`)).json();
  expect(leitstand.budget.totals).not.toBe(null);
  expect(leitstand.budget.missions).toHaveLength(1);
  expect(leitstand.budget.missions[0]).toMatchObject({
    missionId: withBudget.mission.id,
    budgetUsd: 1,
    graceToday: false,
    exceeded: false,
  });
  expect(leitstand.budget.missions[0].unknownRuns).toBe(0);
  expect(leitstand.budget.totals.knownUsd).toBeCloseTo(0.0323);
});

test('budget: ein Trigger-Feuer über Budget läuft GAR NICHT — skipped-Zeile im Verlauf, keine Frage im Inbox', async () => {
  fs.writeFileSync(path.join(dataDir, 'policy.json'), JSON.stringify({ budget: { defaultDailyUsd: 0.01 } }), 'utf8');
  // Der Global-Bucket (Trigger haben keine Mission-Bindung) ist mit $5 gesprengt.
  appendRun(dataDir, { chatId: 'free-chat', costUsd: 5, durationMs: 1000, stopReason: 'end_turn' });

  const harness = createFakeHarness({ script: fakeScript() });
  const { url, runner } = await boot({ harness, harnessName: 'fake' });
  await postJson(`${url}/api/triggers`, {
    id: 'nightly-sync',
    type: 'schedule',
    config: { everyMinutes: 5 },
    promptTemplate: 'Run the nightly sync.',
    appScope: [],
    enabled: true,
  });

  // Feuer wie der Tick: cause.origin ist der Trigger-Typ selbst, nie 'user'.
  const result = await runner.fireTrigger('nightly-sync', { cause: { origin: 'schedule' } });
  expect(result.fired).toBe(false);
  expect(result.skipped).toBe('budget');
  expect(result.reason).toContain('daily budget');
  expect(harness.startedTurns).toHaveLength(0); // kein Turn

  // Sichtbar im Verlauf: skipped 'budget' mit triggerId und durationMs 0 …
  const runs = await (await fetch(`${url}/api/triggers/nightly-sync/runs`)).json();
  expect(runs.runs).toHaveLength(1);
  expect(runs.runs[0]).toMatchObject({ origin: 'trigger', triggerId: 'nightly-sync', skipped: 'budget', durationMs: 0 });
  // … und KEINE Frage: niemand wird um 3 Uhr für einen Hintergrund-Check geweckt.
  expect(await pendingBudgetQuestions(url)).toHaveLength(0);
  // Kein degraded-Zähler: der Skip ist Verknappung, kein Bedingungsfehler.
  const status = await (await fetch(`${url}/api/triggers`)).json();
  const nightly = status.triggers.find((t) => t.id === 'nightly-sync');
  expect(nightly.degraded).toBe(false);
  expect(nightly.conditionErrorStreak ?? 0).toBe(0);
});

test('budget: die skipped-Zeile im Run-Log ist weder Kosten noch unbekannte Kosten', async () => {
  await boot({ harness: createFakeHarness({ script: fakeScript() }), harnessName: 'fake' });
  appendRun(dataDir, { origin: 'trigger', triggerId: 't1', skipped: 'budget', durationMs: 0 });
  const runs = readRuns(dataDir);
  expect(runs).toHaveLength(1);
  expect(runs[0]).toMatchObject({ origin: 'trigger', triggerId: 't1', skipped: 'budget', durationMs: 0, costUsd: null });
});
