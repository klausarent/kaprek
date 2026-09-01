// Tests for GET /api/leitstand — the Start page's one read-only aggregation.
// Same stance as server.test.mjs: a real server on an ephemeral port, real
// stores on a temp dataDir, a fake harness for turns — the route is only
// ever as honest as what it reads off disk.
import { test, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startServer } from './server.mjs';
import { TOKEN_HEADER } from './token.mjs';
import { createFakeHarness } from '../harness/fake.mjs';
import { appendRun } from '../orchestrator/runs.mjs';

const APP_JSON_HEADERS = { 'x-app-request': '1', 'Content-Type': 'application/json' };

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
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'leitstand-test-'));
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'leitstand-test-data-'));
  tmpRootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'leitstand-test-tmproot-'));
  servers = [];
});

afterEach(async () => {
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

/** A harness that asks exactly one approval, then waits for the decision (see server.test.mjs's approvalHarness). */
function approvalHarness({ request }) {
  return {
    async startTurn({ onEvent, onApprovalRequest, signal } = {}) {
      const decision = await onApprovalRequest(request);
      if (signal?.aborted) return { sessionId: null, costUsd: null, usage: null, stopReason: 'aborted', error: null };
      onEvent?.({ type: 'text', text: `decision was ${decision.behavior}` });
      onEvent?.({ type: 'result', sessionId: 's1', costUsd: 0.001, usage: {}, isError: false });
      return { sessionId: 's1', costUsd: 0.001, usage: {}, stopReason: 'result', error: null };
    },
  };
}

function fakeScript() {
  return [
    { type: 'init', sessionId: 'sess-1', tools: [], model: null, permissionMode: 'default' },
    { type: 'result', sessionId: 'sess-1', costUsd: 0.01, usage: { input_tokens: 1, output_tokens: 1 }, isError: false },
  ];
}

test('leitstand: empty stores answer 200 with empty collections, zeroed totals, and no invented attention', async () => {
  const { url } = await boot({ harness: createFakeHarness({ script: fakeScript() }), harnessName: 'fake' });
  const res = await fetch(`${url}/api/leitstand`);
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.running).toEqual([]);
  expect(body.pending).toEqual([]);
  expect(body.history).toEqual([]);
  expect(body.grants).toEqual([]);
  expect(body.overnight.totals).toMatchObject({ ran: 0, skippedCondition: 0, skippedConditionError: 0, failed: 0, costKnown: 0, costUnknown: 0, tokens: 0 });
  expect(body.overnight.byMission).toEqual([]);
  expect(body.attention.degradedTriggers).toEqual([]);
  expect(body.attention.staleGrants).toEqual([]);
  expect(body.attention.grantsActive).toBe(0);
  // No search index on disk → the read-only flag is absent, not guessed.
  expect(body.attention.searchReadOnly).toBeUndefined();
  expect(Number.isFinite(body.since)).toBe(true);
});

test('leitstand: the overnight window counts ran/skipped/failed, sums only KNOWN costs, and groups a trigger run by its triggerId', async () => {
  const now = Date.now();
  const today = (offsetMs) => new Date(now + offsetMs).toISOString();
  const yesterday = new Date(now - 24 * 60 * 60 * 1000).toISOString();
  // One run from yesterday must fall outside the default local-midnight window.
  appendRun(dataDir, { ts: yesterday, chatId: 'c-old', costUsd: 5, tokens: 1000, stopReason: 'result' });
  appendRun(dataDir, { ts: today(0), chatId: 'c-1', costUsd: 1.12, tokens: 41000, stopReason: 'result', origin: 'trigger', triggerId: 'nightly' });
  appendRun(dataDir, { ts: today(1), chatId: 'c-2', skipped: 'condition', conditionKind: 'file-exists', origin: 'trigger', triggerId: 'watch' });
  appendRun(dataDir, { ts: today(2), chatId: 'c-3', skipped: 'condition-error', conditionError: 'unreadable', origin: 'trigger', triggerId: 'watch' });
  // A run the harness reported no cost or token figure for — counted, not summed.
  appendRun(dataDir, { ts: today(3), chatId: 'c-4', costUsd: null, tokens: null, stopReason: 'error', error: { message: 'boom' }, origin: 'trigger', triggerId: 'nightly' });

  const { url } = await boot({ harness: createFakeHarness({ script: fakeScript() }), harnessName: 'fake' });
  const body = await (await fetch(`${url}/api/leitstand`)).json();

  expect(body.overnight.totals).toEqual({
    ran: 1,
    skippedCondition: 1,
    skippedConditionError: 1,
    failed: 1,
    costUsd: 1.12,
    costKnown: 1,
    costUnknown: 3,
    tokens: 41000,
    tokensKnown: 1,
    tokensUnknown: 3,
  });
  // The trigger runs group by their triggerId; the missionless chat run with
  // no trigger attribution stays totals-only.
  const nightly = body.overnight.byMission.find((g) => g.triggerId === 'nightly');
  expect(nightly).toMatchObject({ missionId: null, triggerId: 'nightly', ran: 1, failed: 1, costUsd: 1.12, costUnknown: 1 });
  const watch = body.overnight.byMission.find((g) => g.triggerId === 'watch');
  expect(watch).toMatchObject({ skippedCondition: 1, skippedConditionError: 1, costUnknown: 2 });
});

test('leitstand: ?since= narrows the window instead of local midnight', async () => {
  const now = Date.now();
  appendRun(dataDir, { ts: new Date(now - 60_000).toISOString(), chatId: 'c-1', costUsd: 1, stopReason: 'result' });
  const { url } = await boot({ harness: createFakeHarness({ script: fakeScript() }), harnessName: 'fake' });
  const body = await (await fetch(`${url}/api/leitstand?since=${now}`)).json();
  expect(body.overnight.totals.ran).toBe(0);
  expect(body.overnight.totals.costUnknown).toBe(0);
  expect(body.since).toBe(now);
});

test('leitstand: runs of a mission-bound chat group under that mission', async () => {
  const missionCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'leitstand-mission-'));
  const { url } = await boot({ harness: createFakeHarness({ script: fakeScript() }), harnessName: 'fake' });
  const { mission } = await (await fetch(`${url}/api/missions`, { method: 'POST', headers: APP_JSON_HEADERS, body: JSON.stringify({ title: 'overnight work', cwd: missionCwd }) })).json();
  const res = await fetch(`${url}/api/chat/turn`, { method: 'POST', headers: APP_JSON_HEADERS, body: JSON.stringify({ text: 'hi', missionId: mission.id }) });
  await res.text(); // drain the SSE stream to completion

  const body = await (await fetch(`${url}/api/leitstand`)).json();
  const group = body.overnight.byMission.find((g) => g.missionId === mission.id);
  expect(group).toMatchObject({ missionId: mission.id, title: 'overnight work', ran: 1, costKnown: 1 });
  fs.rmSync(missionCwd, { recursive: true, force: true });
});

test('leitstand: a turn waiting on an approval is running and abortable, its question is pending with remaining time, and the answer lands in history', async () => {
  const { url } = await boot({
    harness: approvalHarness({ request: { id: 'leit-1', toolName: 'Bash', displayName: 'Bash', input: { command: 'ls' } } }),
    harnessName: 'fake',
  });

  const res = await fetch(`${url}/api/chat/turn`, {
    method: 'POST',
    headers: APP_JSON_HEADERS,
    body: JSON.stringify({ text: 'approve please' }),
  });

  let leitstand = null;
  const frames = await readSse(res, async (frame) => {
    if (frame.type === 'approval' && leitstand === null) {
      leitstand = await (await fetch(`${url}/api/leitstand`)).json();
      await postJson(`${url}/api/approvals/${frame.id}`, { chatId: frame.chatId, behavior: 'allow' });
    }
  });
  expect(frames.at(-1)).toMatchObject({ type: 'turn-complete', stopReason: 'result' });

  expect(leitstand.running).toHaveLength(1);
  expect(leitstand.running[0]).toMatchObject({ abortable: true });
  expect(leitstand.pending).toHaveLength(1);
  expect(leitstand.pending[0]).toMatchObject({ id: 'leit-1', toolName: 'Bash', mode: 'interactive' });
  expect(leitstand.pending[0].remainingMs).toBeGreaterThan(0);

  const after = await (await fetch(`${url}/api/leitstand`)).json();
  expect(after.running).toEqual([]);
  expect(after.pending).toEqual([]);
  expect(after.history).toHaveLength(1);
  expect(after.history[0]).toMatchObject({ id: 'leit-1', status: 'decided', decision: { behavior: 'allow' }, decidedVia: 'web' });
  expect(after.history[0].waitMs).toBeGreaterThanOrEqual(0);
});

test('leitstand: a trigger with a condition-error streak shows up degraded in attention', async () => {
  const { url } = await boot({});
  const conditionPath = path.join(tmpDir, 'marker.txt');
  const create = await fetch(`${url}/api/triggers`, {
    method: 'POST',
    headers: APP_JSON_HEADERS,
    body: JSON.stringify({ id: 'watch-builds', type: 'schedule', config: { everyMinutes: 5 }, promptTemplate: 'watch', appScope: [], enabled: true, condition: { kind: 'file-exists', path: conditionPath } }),
  });
  expect(create.status).toBe(200);

  // Five unjudgeable runs in a row — the degraded threshold (see condition.mjs).
  for (let i = 0; i < 5; i += 1) {
    appendRun(dataDir, { chatId: `c-${i}`, skipped: 'condition-error', conditionError: 'unreadable', origin: 'trigger', triggerId: 'watch-builds' });
  }

  const body = await (await fetch(`${url}/api/leitstand`)).json();
  expect(body.attention.degradedTriggers).toHaveLength(1);
  expect(body.attention.degradedTriggers[0]).toMatchObject({ id: 'watch-builds', degraded: true, conditionErrorStreak: 5 });
});

async function postJson(url, body) {
  return fetch(url, { method: 'POST', headers: APP_JSON_HEADERS, body: JSON.stringify(body) });
}

/** Same SSE reader as server.test.mjs — parses `data: ` frames, awaits onEvent per frame. */
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
