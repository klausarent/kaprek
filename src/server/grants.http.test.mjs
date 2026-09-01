// P6a — standing grants over HTTP: mint, match, stale, reactivation. Boots a
// real server like server.test.mjs; the nonce unit matrix lives in
// grants.test.mjs.
import { test, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startServer } from './server.mjs';
import { TOKEN_HEADER } from './token.mjs';

const APP_HEADERS = { 'x-app-request': '1' };
const APP_JSON_HEADERS = { ...APP_HEADERS, 'Content-Type': 'application/json' };

let tmpDir;
let dataDir;
let tmpRootDir;
let missionCwd;
let servers = [];
let currentToken = null;

const rawFetch = (...args) => globalThis.fetch(...args);
function fetch(input, init = {}) {
  return rawFetch(input, { ...init, headers: { ...(init.headers ?? {}), [TOKEN_HEADER]: currentToken ?? '' } });
}

function postJson(url, body) {
  return fetch(url, { method: 'POST', headers: APP_JSON_HEADERS, body: JSON.stringify(body) });
}

/**
 * A harness whose nth turn asks the nth request (cycling) and reports the
 * decision it got as its answer text — the SSE stream's text frames are how
 * the tests read what happened.
 */
function approvalHarness({ requests }) {
  let turn = 0;
  return {
    async startTurn({ onEvent, onApprovalRequest, signal } = {}) {
      const request = requests[turn % requests.length];
      turn += 1;
      const decision = await onApprovalRequest(request);
      await new Promise((resolve) => setTimeout(resolve, 10));
      if (signal?.aborted) return { sessionId: null, costUsd: null, usage: null, stopReason: 'aborted', error: null };
      onEvent?.({ type: 'text', text: `decision was ${decision.behavior}${decision.message ? `: ${decision.message}` : ''}` });
      onEvent?.({ type: 'result', sessionId: 's1', costUsd: 0.001, usage: {}, isError: false });
      return { sessionId: 's1', costUsd: 0.001, usage: {}, stopReason: 'result', error: null };
    },
  };
}

function writePolicy(policy) {
  fs.writeFileSync(path.join(dataDir, 'policy.json'), JSON.stringify({ version: 1, mode: 'observe', ...policy }), 'utf8');
}

async function boot(opts = {}) {
  const started = await startServer({ port: 0, rootDir: tmpDir, dataDir, tmpRoot: tmpRootDir, ...opts });
  servers.push(started);
  currentToken = started.token;
  return started;
}

async function readSse(res, onEvent) {
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
      const frame = JSON.parse(raw.slice('data: '.length));
      frames.push(frame);
      if (onEvent) await onEvent(frame);
    }
  }
  return frames;
}

/**
 * Runs one turn; the FIRST approval frame is answered by `answer(frame)`
 * INSIDE the stream — a question that nobody answers in-flight is only
 * resolved by its own ten-minute timer, which is exactly the deadlock a test
 * must not build against itself.
 */
async function runTurnWithApproval({ url, missionId = null, chatId = null, text = 'go', answer }) {
  const res = await fetch(`${url}/api/chat/turn`, {
    method: 'POST',
    headers: APP_JSON_HEADERS,
    body: JSON.stringify({ text, ...(missionId ? { missionId } : {}), ...(chatId ? { chatId } : {}) }),
  });
  let approvalFrame = null;
  const frames = await readSse(res, async (frame) => {
    if (frame.type === 'approval' && !approvalFrame) {
      approvalFrame = frame;
      if (answer) await answer(frame);
    }
  });
  return { approvalFrame, frames, chatId: frames[0]?.chatId ?? null };
}

/** Answers one approval frame: allow with the grant intent, then mint with the nonce. Returns the mint response. */
async function answerAndMint(url, frame) {
  const decision = await (await postJson(`${url}/api/approvals/${frame.id}`, { chatId: frame.chatId, behavior: 'allow', grant: true })).json();
  return postJson(`${url}/api/grants`, { approvalId: `${frame.chatId}:${frame.id}`, nonce: decision.grantNonce });
}

async function denyInside(url, frame) {
  await postJson(`${url}/api/approvals/${frame.id}`, { chatId: frame.chatId, behavior: 'deny' });
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'grants-route-'));
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'grants-route-data-'));
  tmpRootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'grants-route-tmp-'));
  missionCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'grants-route-cwd-'));
  servers = [];
  currentToken = null;
});

afterEach(async () => {
  for (const { server } of servers) await new Promise((resolve) => server.close(resolve));
  for (const dir of [tmpDir, dataDir, tmpRootDir, missionCwd]) fs.rmSync(dir, { recursive: true, force: true });
});

async function createMission(url, posture = null) {
  const { mission } = await (
    await postJson(`${url}/api/missions`, { title: 'm', cwd: missionCwd, ...(posture ? { posture } : {}) })
  ).json();
  return mission;
}

const LS_REQUEST = { id: 'req-1', toolName: 'Bash', displayName: 'Bash', input: { command: 'ls' } };

test('grants: mint from the just-answered question, second identical call is granted without asking, replay is 409', async () => {
  writePolicy({ posture: 'ask' });
  const { url } = await boot({ harness: approvalHarness({ requests: [LS_REQUEST] }), harnessName: 'fake' });
  const mission = await createMission(url);

  // Turn 1: the question is answered with the grant intent, then minted.
  let mintResponse;
  const { approvalFrame, chatId } = await runTurnWithApproval({
    url,
    missionId: mission.id,
    answer: async (frame) => {
      mintResponse = await answerAndMint(url, frame);
    },
  });
  expect(approvalFrame).toBeTruthy();
  expect(mintResponse.status).toBe(200);
  const { grant } = await mintResponse.json();
  expect(grant).toMatchObject({ scope: `mission:${mission.id}`, toolName: 'Bash', match: 'exact', missionId: mission.id, useCount: 0 });

  // A body without the nonce is a 400; a wrong nonce is 409.
  expect((await postJson(`${url}/api/grants`, { approvalId: `${chatId}:${approvalFrame.id}` })).status).toBe(400);
  expect((await postJson(`${url}/api/grants`, { approvalId: `${chatId}:${approvalFrame.id}`, nonce: 'a'.repeat(48) })).status).toBe(409);

  // Turn 2, same chat, same exact form: GRANTED, no question was ever raised.
  const second = await runTurnWithApproval({ url, chatId, text: 'again' });
  expect(second.approvalFrame).toBe(null);
  expect(second.frames.some((f) => f.type === 'text' && f.text.startsWith('decision was allow: standing grant'))).toBe(true);
  const { grants } = await (await fetch(`${url}/api/grants`)).json();
  expect(grants.find((g) => g.id === grant.id).useCount).toBe(1);
  // The use event's home is grants.jsonl — the audit trail does not depend
  // on the approval log, which prunes after 7 days / 500 entries.
  const log = fs.readFileSync(path.join(dataDir, 'grants.jsonl'), 'utf8');
  expect(log).toContain('grant.minted');
  expect(log).toContain('grant.used');

  // Widerruf: DELETE is an event, the record stays readable and marked.
  const del = await fetch(`${url}/api/grants/${grant.id}`, { method: 'DELETE', headers: APP_HEADERS });
  expect(del.status).toBe(200);
  const after = (await (await fetch(`${url}/api/grants`)).json()).grants.find((g) => g.id === grant.id);
  expect(after.revokedAt).toBeTruthy();
  expect(after.revokedReason).toBe('revoked-by-user');
  expect(after.useCount).toBe(1);

  // And a third identical call asks again — the grant is gone.
  const third = await runTurnWithApproval({ url, chatId, text: 'once more', answer: (frame) => denyInside(url, frame) });
  expect(third.approvalFrame).toBeTruthy();
});

test('grants: a chat outside any mission cannot mint (global is not mintable in this phase)', async () => {
  writePolicy({ posture: 'ask' });
  const { url } = await boot({ harness: approvalHarness({ requests: [LS_REQUEST] }), harnessName: 'fake' });

  let mintResponse = null;
  await runTurnWithApproval({
    url,
    answer: async (frame) => {
      const decision = await (await postJson(`${url}/api/approvals/${frame.id}`, { chatId: frame.chatId, behavior: 'allow', grant: true })).json();
      expect(decision.grantNonce).toMatch(/^[0-9a-f]{48}$/);
      mintResponse = await postJson(`${url}/api/grants`, { approvalId: `${frame.chatId}:${frame.id}`, nonce: decision.grantNonce });
    },
  });
  expect(mintResponse.status).toBe(409);
  const body = await mintResponse.json();
  expect(body.already).toBe('no-mission');
});

test('grants: minting from a foreign / never-decided approval is refused (404), a body without nonce is 400', async () => {
  writePolicy({ posture: 'ask' });
  const { url } = await boot({ harness: approvalHarness({ requests: [LS_REQUEST] }), harnessName: 'fake' });

  expect((await postJson(`${url}/api/grants`, { approvalId: 'somechat:1', nonce: 'a'.repeat(48) })).status).toBe(404);
  expect((await postJson(`${url}/api/grants`, { approvalId: 'somechat:1' })).status).toBe(400);
});

test('grants: the input hash matches the exact form — a secret input grants itself, not a different secret', async () => {
  writePolicy({ posture: 'ask' });
  const secretA = { id: 'req-1', toolName: 'Bash', input: { command: 'deploy --token SECRET-A' } };
  const secretB = { id: 'req-1', toolName: 'Bash', input: { command: 'deploy --token SECRET-B' } };
  const { url } = await boot({ harness: approvalHarness({ requests: [secretA, secretB, secretA] }), harnessName: 'fake' });
  const mission = await createMission(url);

  // Mint over Key A.
  const first = await runTurnWithApproval({
    url,
    missionId: mission.id,
    answer: async (frame) => {
      const mint = await answerAndMint(url, frame);
      expect(mint.status).toBe(200);
    },
  });
  expect(first.approvalFrame).toBeTruthy();

  // Key B: same tool, same shape, DIFFERENT secret — asks again (Key A does not speak for Key B).
  const withB = await runTurnWithApproval({ url, chatId: first.chatId, text: 'second', answer: (frame) => denyInside(url, frame) });
  expect(withB.approvalFrame).toBeTruthy();
  expect(withB.approvalFrame.input.command).toContain('SECRET-B');

  // Key A again: granted without asking.
  const withA = await runTurnWithApproval({ url, chatId: first.chatId, text: 'third' });
  expect(withA.approvalFrame).toBe(null);
  expect(withA.frames.some((f) => f.type === 'text' && f.text.includes('standing grant'))).toBe(true);
});

test('grants: an over-cap input mints nothing — the answer lands but no nonce exists', async () => {
  writePolicy({ posture: 'ask' });
  const bigRequest = { id: 'req-1', toolName: 'Write', input: { content: 'z'.repeat(1024 * 1024 + 64) } };
  const { url } = await boot({ harness: approvalHarness({ requests: [bigRequest] }), harnessName: 'fake' });
  const mission = await createMission(url);

  let nonce = 'never-set';
  await runTurnWithApproval({
    url,
    missionId: mission.id,
    answer: async (frame) => {
      const body = await (await postJson(`${url}/api/approvals/${frame.id}`, { chatId: frame.chatId, behavior: 'allow', grant: true })).json();
      nonce = body.grantNonce;
    },
  });
  // No hash was formed for the over-cap form, so no nonce — the allow still happened.
  expect(nonce ?? null).toBe(null); // absent: no hash, no nonce, no mint
});

test('grants: tightening the posture ceiling (mission posture) makes the grant stale — it asks and does not act', async () => {
  writePolicy({ posture: 'edits' }); // global ceiling: edits
  const { url } = await boot({ harness: approvalHarness({ requests: [LS_REQUEST] }), harnessName: 'fake' });
  const mission = await createMission(url, 'edits');

  const minted = await runTurnWithApproval({
    url,
    missionId: mission.id,
    answer: (frame) => answerAndMint(url, frame),
  });

  // Tighten: the mission's own posture is stricter than global.
  await postJson(`${url}/api/missions/${mission.id}/posture`, { posture: 'ask' });

  // Same form: the grant exists but is stale — a question, flagged as such.
  const tightened = await runTurnWithApproval({
    url,
    chatId: minted.chatId,
    text: 'again',
    answer: (frame) => denyInside(url, frame),
  });
  expect(tightened.approvalFrame).toBeTruthy();
  expect(tightened.approvalFrame.standingGrant).toMatchObject({ state: 'stale' });

  // A stale grant never lifts the question: the next hit asks again.
  const again = await runTurnWithApproval({ url, chatId: minted.chatId, text: 'third', answer: (frame) => denyInside(url, frame) });
  expect(again.approvalFrame).toBeTruthy();
  expect(again.approvalFrame.standingGrant.state).toBe('stale');

  // The grant was not consumed by any of this.
  const { grants } = await (await fetch(`${url}/api/grants`)).json();
  expect(grants[0].useCount).toBe(0);
});

test('grants: after a LOOSENING, the first hit asks exactly once (reactivation); allow re-confirms, then it grants again', async () => {
  writePolicy({ posture: 'edits' }); // global ceiling: edits
  const { url } = await boot({ harness: approvalHarness({ requests: [LS_REQUEST] }), harnessName: 'fake' });
  const mission = await createMission(url, 'ask'); // mint under the STRICTER mission posture

  const minted = await runTurnWithApproval({
    url,
    missionId: mission.id,
    answer: (frame) => answerAndMint(url, frame),
  });

  // Loosen: the mission's stricter dial is cleared, the ceiling is now 'edits'.
  await postJson(`${url}/api/missions/${mission.id}/posture`, { posture: null });

  // First hit after the loosening: the reactivation question, flagged; the
  // plain allow re-confirms the grant (binding posture moves to the ceiling).
  const reactivation = await runTurnWithApproval({
    url,
    chatId: minted.chatId,
    text: 'again',
    answer: async (frame) => {
      expect(frame.standingGrant.state).toBe('reactivation');
      await postJson(`${url}/api/approvals/${frame.id}`, { chatId: frame.chatId, behavior: 'allow' });
    },
  });
  expect(reactivation.approvalFrame).toBeTruthy();

  // Second hit after the answer: granted, no question.
  const redeemed = await runTurnWithApproval({ url, chatId: minted.chatId, text: 'third' });
  expect(redeemed.approvalFrame).toBe(null);
  expect(redeemed.frames.some((f) => f.type === 'text' && f.text.includes('standing grant'))).toBe(true);
});

test('grants: denying the reactivation question discards the grant', async () => {
  writePolicy({ posture: 'edits' });
  const { url } = await boot({ harness: approvalHarness({ requests: [LS_REQUEST] }), harnessName: 'fake' });
  const mission = await createMission(url, 'ask');
  const minted = await runTurnWithApproval({ url, missionId: mission.id, answer: (frame) => answerAndMint(url, frame) });
  await postJson(`${url}/api/missions/${mission.id}/posture`, { posture: null });

  const reactivation = await runTurnWithApproval({ url, chatId: minted.chatId, text: 'again', answer: (frame) => denyInside(url, frame) });
  expect(reactivation.approvalFrame.standingGrant.state).toBe('reactivation');

  const { grants } = await (await fetch(`${url}/api/grants`)).json();
  expect(grants[0].revokedReason).toBe('reactivation-discarded');
});

test('grants: a changed hard-denials list stales every grant minted under the old one', async () => {
  writePolicy({ posture: 'ask' });
  const { url } = await boot({ harness: approvalHarness({ requests: [LS_REQUEST] }), harnessName: 'fake' });
  const mission = await createMission(url);
  const minted = await runTurnWithApproval({ url, missionId: mission.id, answer: (frame) => answerAndMint(url, frame) });

  // The person edits policy.json: one extra hard denial. Authority changed.
  writePolicy({ posture: 'ask', hardDenials: [{ id: 'no-prod', tools: ['Bash'], command: 'deploy\\s+--prod' }] });
  const after = await runTurnWithApproval({ url, chatId: minted.chatId, text: 'again', answer: (frame) => denyInside(url, frame) });
  expect(after.approvalFrame).toBeTruthy();
  expect(after.approvalFrame.standingGrant.state).toBe('stale');
});

test('grants: under posture auto the grant sleeps — the same form asks again instead of acting silently', async () => {
  // No policy.json: the default ceiling is 'auto'.
  const { url } = await boot({ harness: approvalHarness({ requests: [LS_REQUEST] }), harnessName: 'fake' });
  const mission = await createMission(url);
  const minted = await runTurnWithApproval({
    url,
    missionId: mission.id,
    answer: async (frame) => {
      const mint = await answerAndMint(url, frame);
      expect(mint.status).toBe(200);
    },
  });
  expect(minted.approvalFrame).toBeTruthy();

  // postureAtGrant 'auto': under 'auto' no question exists for the grant to
  // replace, and there must be no silent fulfilment either — the next hit
  // is a question, not the grant.
  const next = await runTurnWithApproval({ url, chatId: minted.chatId, text: 'again', answer: (frame) => denyInside(url, frame) });
  expect(next.approvalFrame).toBeTruthy();
});

test('grants: setup-facing counts — GET /api/grants reports the active count, corrupt log aside at boot', async () => {
  writePolicy({ posture: 'ask' });
  // A torn log from a crashed append: moved aside, store starts empty.
  fs.writeFileSync(path.join(dataDir, 'grants.jsonl'), '{"schemaVersion":1,"type":"grant.mint', 'utf8');
  const { url } = await boot({ harness: approvalHarness({ requests: [LS_REQUEST] }), harnessName: 'fake' });
  const body = await (await fetch(`${url}/api/grants`)).json();
  expect(body.grants).toEqual([]);
  expect(body.activeCount).toBe(0);
  expect(fs.readdirSync(dataDir).some((f) => f.startsWith('grants.corrupt-'))).toBe(true);
});
