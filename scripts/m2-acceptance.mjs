// M2 live acceptance, against the real CLIs.
//
// The script from the plan: one recipe, write(grok) -> review(claude) ->
// apply(codex), with a human gate on the edge into apply. Start ONCE, watch
// two handoffs happen on their own, get exactly ONE decision to make, and
// after approving it see codex actually write a file in the mission's
// directory.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startServer } from '../src/server/server.mjs';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kaprek-m2-'));
const missionDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kaprek-m2-project-'));
fs.writeFileSync(path.join(missionDir, 'README.md'), '# A tiny project\n\nNothing here yet.\n', 'utf8');

fs.mkdirSync(path.join(dataDir, 'recipes'), { recursive: true });
fs.writeFileSync(
  path.join(dataDir, 'recipes', 'acceptance.json'),
  JSON.stringify({
    id: 'acceptance',
    title: 'write, review, apply',
    description: 'M2 acceptance',
    steps: [
      { id: 'write', agent: 'grok' },
      { id: 'review', agent: 'claude' },
      { id: 'apply', agent: 'codex', tools: 'full' },
    ],
    edges: [
      { from: 'write', to: 'review' },
      { from: 'review', to: 'apply', requiresHuman: true },
      { from: 'apply', to: 'write' },
    ],
    budgets: { maxRounds: 1 },
  }),
  'utf8',
);

const { url, token } = await startServer({ port: 0, rootDir: dataDir, dataDir, webDist: null });
const H = { 'x-kaprek-token': token, 'x-app-request': '1', 'Content-Type': 'application/json' };
const say = (...args) => console.log(new Date().toISOString().slice(11, 19), ...args);
say('server on', url, 'data', dataDir, 'project', missionDir);

async function api(pathname, init = {}) {
  const res = await fetch(`${url}${pathname}`, { ...init, headers: { ...H, ...(init.headers ?? {}) } });
  const text = await res.text();
  let body = null;
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }
  return { status: res.status, body };
}

/** Runs one chat turn and drains its SSE stream, so the chat exists. */
async function seedTurn(missionId) {
  const res = await fetch(`${url}/api/chat/turn`, {
    method: 'POST',
    headers: H,
    body: JSON.stringify({ text: 'Say the single word: ready.', missionId }),
  });
  const reader = res.body.getReader();
  let raw = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    raw += Buffer.from(value).toString('utf8');
  }
  const chatId = /"chatId":"([^"]+)"/.exec(raw)?.[1] ?? null;
  return chatId;
}

async function waitFor(label, check, timeoutMs = 15 * 60_000) {
  const startedAt = Date.now();
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() - startedAt > timeoutMs) throw new Error(`timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 5_000));
  }
}

const mission = await api('/api/missions', {
  method: 'POST',
  body: JSON.stringify({ title: 'M2 acceptance', goal: 'let codex write a file', cwd: missionDir }),
});
say('mission', mission.status, mission.body?.mission?.id);

const chatId = await seedTurn(mission.body.mission.id);
say('chat', chatId);

const started = await api(`/api/chat/${chatId}/relay`, {
  method: 'POST',
  body: JSON.stringify({
    goal: 'Write a file NOTES.md in the project directory containing three bullet points about what this project is. The apply step must create the file.',
    recipeId: 'acceptance',
  }),
});
say('relay start', started.status, JSON.stringify(started.body));
if (started.status !== 200) process.exit(1);

// --- 1. two handoffs, then exactly one question -----------------------------
const gate = await waitFor('the edge gate', async () => {
  const { body } = await api('/api/approvals');
  const found = (body.approvals ?? []).find((entry) => entry.kind === 'relay.gate');
  if (!found) {
    const chat = await api(`/api/chat/${chatId}`);
    const relayEvents = (chat.body.events ?? []).filter((event) => event.kind === 'relay');
    say('  waiting…', relayEvents.map((event) => `${event.eventType}${event.from ? `:${event.from}` : ''}${event.reason ? `(${event.reason})` : ''}`).join(' '));
  }
  return found ?? null;
});

const beforeApproval = await api(`/api/chat/${chatId}`);
const relayEvents = beforeApproval.body.events.filter((event) => event.kind === 'relay');
const handoffs = relayEvents.filter((event) => event.eventType === 'message').map((event) => event.from);
const openQuestions = (await api('/api/approvals')).body.approvals.length;

say('handoffs before the first question:', JSON.stringify(handoffs));
say('open questions at the gate:', openQuestions);
say('gate says:', gate.description);
say('gate kind:', beforeApproval.body.chat.relay.gateReason, '-> step', beforeApproval.body.chat.relay.stepId);

// --- 2. approve, and watch codex do real work ------------------------------
const answered = await api(`/api/approvals/${encodeURIComponent(gate.id)}`, {
  method: 'POST',
  body: JSON.stringify({ chatId, behavior: 'allow' }),
});
say('approved', answered.status);

// Codex may itself ask for permission to write; answer anything it files.
const finished = await waitFor('the run to settle', async () => {
  const pending = (await api('/api/approvals')).body.approvals ?? [];
  for (const entry of pending) {
    if (entry.kind === 'relay.gate') continue;
    say('  codex asks:', entry.toolName, '-', (entry.description ?? '').slice(0, 90));
    await api(`/api/approvals/${encodeURIComponent(entry.id)}`, {
      method: 'POST',
      body: JSON.stringify({ chatId: entry.chatId ?? chatId, behavior: 'allow' }),
    });
  }
  const chat = await api(`/api/chat/${chatId}`);
  const relay = chat.body.chat.relay;
  const events = chat.body.events.filter((event) => event.kind === 'relay');
  say('  status', relay.status, 'step', relay.stepId, 'turns', relay.turns, '|', events.at(-1)?.eventType);
  return ['completed', 'stopped', 'waiting_gate'].includes(relay.status) ? relay : null;
});

// --- 3. what actually came out of it ---------------------------------------
const final = await api(`/api/chat/${chatId}`);
const events = final.body.events.filter((event) => event.kind === 'relay');
say('---');
say('final status:', finished.status, 'reason:', events.at(-1)?.reason ?? '');
say('messages:', JSON.stringify(events.filter((e) => e.eventType === 'message').map((e) => e.from)));
say('gates asked:', JSON.stringify(events.filter((e) => e.eventType === 'gate.requested').map((e) => e.reason)));
say('interrupted events:', events.filter((e) => e.eventType === 'run.interrupted').length);
say('project now holds:', JSON.stringify(fs.readdirSync(missionDir)));

const runsFile = path.join(dataDir, 'runs.jsonl');
if (fs.existsSync(runsFile)) {
  const lines = fs.readFileSync(runsFile, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
  say('runs.jsonl:', JSON.stringify(lines.map((entry) => `${entry.harness}/${entry.origin}/${entry.stopReason}`)));
}
say('data dir kept for inspection:', dataDir);
process.exit(0);
