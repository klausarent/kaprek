// Tests for the Codex harness (src/harness/codex.mjs) — the app-server
// lifecycle, event mapping, resume, and the permission-mode table.
//
// No real CLI is spawned: `codex app-server` speaks JSON-RPC over stdio, so
// the fake here is an in-memory child whose stdin handler answers requests
// the way the real server does (recorded live 01.08.2026, codex-cli 0.144.4;
// the protocol facts live in ccview-docs/plans/2026-08-01-m1-codex-harness.md).
import { test, expect, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import { startTurn, mapPermissionMode } from './codex.mjs';
import { isNormalizedEvent } from './adapter.mjs';

/**
 * An in-memory stand-in for the `codex app-server` process. Parses each
 * stdin line as JSON-RPC, records it, and lets the test's `handle` decide
 * what to send back. `send()` writes one message to stdout the way the real
 * server does — one JSON object per line.
 */
function makeFakeCodexServer(handle) {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.received = [];
  child.pid = 4242;
  child.send = (msg) => child.stdout.write(`${JSON.stringify(msg)}\n`);
  child.killed = false;
  child.kill = vi.fn(() => {
    if (child.killed) return;
    child.killed = true;
    queueMicrotask(() => child.emit('close', 0));
  });
  let buffer = '';
  child.stdin = new Writable({
    write(chunk, _enc, cb) {
      buffer += chunk.toString();
      let idx;
      while ((idx = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 1);
        if (!line.trim()) continue;
        const msg = JSON.parse(line);
        child.received.push(msg);
        queueMicrotask(() => handle(child, msg));
      }
      cb();
    },
  });
  child.stdin.end = vi.fn(child.stdin.end.bind(child.stdin));
  return child;
}

/** The standard happy-path handler: answers the handshake and, on turn/start, plays `turnEvents` (already-shaped notifications) before turn/completed. */
function happyServer({ threadId = 'th-1', turnEvents = [], turn = {} } = {}) {
  return makeFakeCodexServer((child, msg) => {
    if (msg.method === 'initialize') {
      child.send({ id: msg.id, result: { userAgent: 'fake/0' } });
    } else if (msg.method === 'thread/start' || msg.method === 'thread/resume') {
      child.send({ id: msg.id, result: { thread: { id: msg.params.threadId ?? threadId } } });
    } else if (msg.method === 'turn/start') {
      child.send({ id: msg.id, result: { turn: { id: 'turn-1', status: 'inProgress' } } });
      const tid = msg.params.threadId;
      for (const ev of turnEvents) child.send(ev);
      child.send({
        method: 'turn/completed',
        params: { threadId: tid, turn: { id: 'turn-1', status: 'completed', error: null, ...turn } },
      });
    }
  });
}

test('the handshake runs in order: initialize, initialized, thread/start, turn/start', async () => {
  const child = happyServer();
  const result = await startTurn({ cwd: 'C:/work', prompt: 'hi', spawnFn: () => child });

  const methods = child.received.map((m) => m.method);
  expect(methods).toEqual(['initialize', 'initialized', 'thread/start', 'turn/start']);
  // initialize carries the client identity and opts into the v2 API.
  expect(child.received[0].params.clientInfo.name).toBe('kaprek');
  expect(child.received[0].params.capabilities.experimentalApi).toBe(true);
  // initialized is a notification (no id); the requests carry ids.
  expect(child.received[1].id).toBeUndefined();
  expect(child.received[0].id).not.toBeUndefined();
  // The thread starts in the turn's cwd, persistent (resume needs it), with
  // the default permission mapping.
  const startParams = child.received[2].params;
  expect(startParams.cwd).toBe('C:/work');
  expect(startParams.ephemeral).toBe(false);
  expect(startParams.approvalPolicy).toBe('untrusted');
  expect(startParams.sandbox).toBe('read-only');
  // The prompt travels as a single text input item.
  expect(child.received[3].params.input).toEqual([{ type: 'text', text: 'hi' }]);
  expect(result.stopReason).toBe('result');
});

test('a sessionId resumes the existing thread instead of starting a new one', async () => {
  const child = happyServer();
  const result = await startTurn({ cwd: 'C:/work', prompt: 'again', sessionId: 'th-77', spawnFn: () => child });

  const methods = child.received.map((m) => m.method);
  expect(methods).toContain('thread/resume');
  expect(methods).not.toContain('thread/start');
  const resume = child.received.find((m) => m.method === 'thread/resume');
  expect(resume.params.threadId).toBe('th-77');
  expect(resume.params.cwd).toBe('C:/work');
  expect(child.received.find((m) => m.method === 'turn/start').params.threadId).toBe('th-77');
  expect(result.sessionId).toBe('th-77');
});

test('agent-message deltas stream as text events, reasoning deltas as thinking, and every event passes the adapter shape check', async () => {
  const child = happyServer({
    turnEvents: [
      { method: 'item/started', params: { threadId: 'th-1', turnId: 'turn-1', item: { type: 'reasoning', id: 'r1' } } },
      { method: 'item/reasoning/summaryTextDelta', params: { threadId: 'th-1', turnId: 'turn-1', itemId: 'r1', delta: 'pondering' } },
      { method: 'item/reasoning/summaryTextDelta', params: { threadId: 'th-1', turnId: 'turn-1', itemId: 'r1', delta: '' } },
      { method: 'item/completed', params: { threadId: 'th-1', turnId: 'turn-1', item: { type: 'reasoning', id: 'r1' } } },
      { method: 'item/started', params: { threadId: 'th-1', turnId: 'turn-1', item: { type: 'agentMessage', id: 'm1', text: '' } } },
      { method: 'item/agentMessage/delta', params: { threadId: 'th-1', turnId: 'turn-1', itemId: 'm1', delta: 'pon' } },
      { method: 'item/agentMessage/delta', params: { threadId: 'th-1', turnId: 'turn-1', itemId: 'm1', delta: 'g' } },
      { method: 'item/completed', params: { threadId: 'th-1', turnId: 'turn-1', item: { type: 'agentMessage', id: 'm1', text: 'pong' } } },
    ],
  });

  const events = [];
  await startTurn({ cwd: '.', prompt: 'hi', spawnFn: () => child, onEvent: (e) => events.push(e) });

  for (const event of events) expect(isNormalizedEvent(event), `not a normalized event: ${JSON.stringify(event)}`).toBe(true);
  expect(events.filter((e) => e.type === 'text').map((e) => e.text)).toEqual(['pon', 'g']);
  // The completed agentMessage already streamed as deltas — no duplicate text
  // event for the full string, and the empty reasoning delta is not emitted.
  expect(events.filter((e) => e.type === 'thinking').map((e) => e.text)).toEqual(['pondering']);
  expect(events[0].type).toBe('init');
  expect(events.at(-1).type).toBe('result');
});

test('command executions map to tool-start/tool-end with the command as input and the output aggregated', async () => {
  const child = happyServer({
    turnEvents: [
      {
        method: 'item/started',
        params: { threadId: 'th-1', turnId: 'turn-1', item: { type: 'commandExecution', id: 'x1', command: 'git status', cwd: 'C:/work', status: 'inProgress' } },
      },
      { method: 'item/commandExecution/outputDelta', params: { threadId: 'th-1', turnId: 'turn-1', itemId: 'x1', delta: 'clean' } },
      {
        method: 'item/completed',
        params: { threadId: 'th-1', turnId: 'turn-1', item: { type: 'commandExecution', id: 'x1', command: 'git status', cwd: 'C:/work', status: 'completed' } },
      },
    ],
  });

  const events = [];
  await startTurn({ cwd: '.', prompt: 'hi', spawnFn: () => child, onEvent: (e) => events.push(e) });

  const start = events.find((e) => e.type === 'tool-start');
  expect(start).toMatchObject({ id: 'x1', name: 'commandExecution', input: { command: 'git status', cwd: 'C:/work' } });
  const end = events.find((e) => e.type === 'tool-end');
  expect(end).toMatchObject({ id: 'x1', isError: false });
  expect(end.result).toContain('clean');
});

test('token usage lands in the result, and cost is honestly null — codex reports no USD', async () => {
  const child = happyServer({
    turnEvents: [
      {
        method: 'thread/tokenUsage/updated',
        params: {
          threadId: 'th-1',
          turnId: 'turn-1',
          tokenUsage: {
            total: { totalTokens: 100, inputTokens: 90, cachedInputTokens: 10, outputTokens: 10, reasoningOutputTokens: 2 },
            last: { totalTokens: 100, inputTokens: 90, cachedInputTokens: 10, outputTokens: 10, reasoningOutputTokens: 2 },
            modelContextWindow: 258400,
          },
        },
      },
    ],
  });

  const events = [];
  const result = await startTurn({ cwd: '.', prompt: 'hi', spawnFn: () => child, onEvent: (e) => events.push(e) });

  expect(result.stopReason).toBe('result');
  expect(result.costUsd).toBeNull();
  expect(result.usage).toEqual({
    input_tokens: 90,
    cached_input_tokens: 10,
    output_tokens: 10,
    reasoning_output_tokens: 2,
    total_tokens: 100,
    model_context_window: 258400,
  });
  const resultEvent = events.find((e) => e.type === 'result');
  expect(resultEvent.costUsd).toBeNull();
  expect(resultEvent.sessionId).toBe('th-1');
});

test('rate-limit updates pass through as rate-limit events', async () => {
  const child = happyServer({
    turnEvents: [{ method: 'account/rateLimits/updated', params: { rateLimits: { planType: 'plus', primary: { usedPercent: 1 } } } }],
  });
  const events = [];
  await startTurn({ cwd: '.', prompt: 'hi', spawnFn: () => child, onEvent: (e) => events.push(e) });
  const rl = events.find((e) => e.type === 'rate-limit');
  expect(rl.info).toMatchObject({ planType: 'plus' });
});

test('unrelated notifications (mcp startup, thread status, warnings) are ignored without breaking the turn', async () => {
  const child = happyServer({
    turnEvents: [
      { method: 'mcpServer/startupStatus/updated', params: { threadId: 'th-1', name: 'codex_apps', status: 'starting' } },
      { method: 'thread/status/changed', params: { threadId: 'th-1', status: { type: 'active' } } },
      { method: 'warning', params: { threadId: 'th-1', message: 'skills shortened' } },
    ],
  });
  const events = [];
  const result = await startTurn({ cwd: '.', prompt: 'hi', spawnFn: () => child, onEvent: (e) => events.push(e) });
  expect(result.stopReason).toBe('result');
  expect(events.map((e) => e.type)).toEqual(['init', 'result']);
});

test('the permission-mode table: default asks for every write, acceptEdits lets the workspace be written', () => {
  expect(mapPermissionMode('default')).toEqual({ approvalPolicy: 'untrusted', sandbox: 'read-only' });
  expect(mapPermissionMode(undefined)).toEqual({ approvalPolicy: 'untrusted', sandbox: 'read-only' });
  expect(mapPermissionMode('acceptEdits')).toEqual({ approvalPolicy: 'on-request', sandbox: 'workspace-write' });
  // Unknown modes fall back to the strictest row rather than guessing open.
  expect(mapPermissionMode('somethingNew')).toEqual({ approvalPolicy: 'untrusted', sandbox: 'read-only' });
});

test('after turn/completed the child is ended, and the turn result names the thread as its sessionId', async () => {
  const child = happyServer({ threadId: 'th-9' });
  const result = await startTurn({ cwd: '.', prompt: 'hi', spawnFn: () => child });
  expect(result.sessionId).toBe('th-9');
  expect(child.kill).toHaveBeenCalled();
});
