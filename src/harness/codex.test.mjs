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
import { isApprovalRequest, isNormalizedEvent } from './adapter.mjs';

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
  // Full auto — the operator explicitly chose it, mirror of the claude
  // harness's bypassPermissions stance.
  expect(mapPermissionMode('bypassPermissions')).toEqual({ approvalPolicy: 'never', sandbox: 'danger-full-access' });
  // Unknown modes fall back to the strictest row rather than guessing open.
  expect(mapPermissionMode('somethingNew')).toEqual({ approvalPolicy: 'untrusted', sandbox: 'read-only' });
});

test('after turn/completed the child is ended, and the turn result names the thread as its sessionId', async () => {
  const child = happyServer({ threadId: 'th-9' });
  const result = await startTurn({ cwd: '.', prompt: 'hi', spawnFn: () => child });
  expect(result.sessionId).toBe('th-9');
  expect(child.kill).toHaveBeenCalled();
});

// --- approvals: the server-request bridge (M1 Task 2) ---

/**
 * A server that, on turn/start, walks an approval scenario: emits the
 * item/started for the pending item, sends the approval REQUEST (id-bearing),
 * and completes the turn only after the client answered. Records every
 * client response to a server request in `child.approvalAnswers`.
 */
function approvalServer({ requests, threadId = 'th-1' }) {
  const child = makeFakeCodexServer((c, msg) => {
    if (msg.method === 'initialize') {
      c.send({ id: msg.id, result: { userAgent: 'fake/0' } });
    } else if (msg.method === 'thread/start' || msg.method === 'thread/resume') {
      c.send({ id: msg.id, result: { thread: { id: msg.params.threadId ?? threadId } } });
    } else if (msg.method === 'turn/start') {
      c.send({ id: msg.id, result: { turn: { id: 'turn-1', status: 'inProgress' } } });
      for (const req of requests) {
        if (req.item) c.send({ method: 'item/started', params: { threadId, turnId: 'turn-1', item: req.item } });
        c.send({ id: req.serverRequestId, method: req.method, params: { threadId, turnId: 'turn-1', ...req.params } });
      }
    } else if (msg.id !== undefined && msg.method === undefined) {
      // A response to one of OUR requests: record it; when all are in,
      // complete the turn.
      child.approvalAnswers.push(msg);
      if (child.approvalAnswers.length === requests.length) {
        c.send({ method: 'turn/completed', params: { threadId, turn: { id: 'turn-1', status: 'completed', error: null } } });
      }
    }
  });
  child.approvalAnswers = [];
  return child;
}

test('a fileChange approval reaches onApprovalRequest with the diff from the item cache, and allow answers accept', async () => {
  const changes = [{ path: 'C:/work/NOTES.md', kind: { type: 'add' }, diff: 'hello\n' }];
  const child = approvalServer({
    requests: [
      {
        method: 'item/fileChange/requestApproval',
        serverRequestId: 0,
        item: { type: 'fileChange', id: 'fc-1', changes, status: 'inProgress' },
        params: { itemId: 'fc-1', startedAtMs: 1, reason: 'writing outside the sandbox', grantRoot: null },
      },
    ],
  });

  const seen = [];
  const result = await startTurn({
    cwd: '.',
    prompt: 'write it',
    spawnFn: () => child,
    onApprovalRequest: async (request) => {
      seen.push(request);
      return { behavior: 'allow' };
    },
  });

  expect(result.stopReason).toBe('result');
  expect(seen).toHaveLength(1);
  expect(isApprovalRequest(seen[0])).toBe(true);
  expect(seen[0].toolName).toBe('fileChange');
  expect(seen[0].input).toEqual({ changes });
  expect(seen[0].reason).toBe('writing outside the sandbox');
  expect(child.approvalAnswers).toEqual([{ jsonrpc: '2.0', id: 0, result: { decision: 'accept' } }]);
  // The request id must be unique ACROSS turns, not only within one: codex
  // numbers its JSON-RPC ids per process starting at 0, so a bare "0" would
  // collide with the previous turn's first approval in the server's
  // chatId-scoped inbox (found live in the M1 acceptance: turn 2's approval
  // was skipped as already-answered and the turn hung). The turn id makes it
  // unique — every turn is its own codex process with its own turn id.
  expect(seen[0].id).toBe('turn-1:0');
});

test('deny answers decline, with the command payload taken from params over the cache', async () => {
  const child = approvalServer({
    requests: [
      {
        method: 'item/commandExecution/requestApproval',
        serverRequestId: 7,
        item: { type: 'commandExecution', id: 'x-1', command: 'stale-from-cache', cwd: 'C:/cache', status: 'inProgress' },
        params: { itemId: 'x-1', startedAtMs: 1, command: 'rm -rf /', cwd: 'C:/work', reason: null },
      },
    ],
  });

  const seen = [];
  const result = await startTurn({
    cwd: '.',
    prompt: 'run it',
    spawnFn: () => child,
    onApprovalRequest: async (request) => {
      seen.push(request);
      return { behavior: 'deny', message: 'no' };
    },
  });

  expect(result.stopReason).toBe('result');
  expect(seen[0].toolName).toBe('commandExecution');
  // Params carry the authoritative command; the cache only fills gaps.
  expect(seen[0].input).toEqual({ command: 'rm -rf /', cwd: 'C:/work' });
  expect(child.approvalAnswers).toEqual([{ jsonrpc: '2.0', id: 7, result: { decision: 'decline' } }]);
});

test('no approval handler means auto-decline — fail-closed, never fail-open', async () => {
  const child = approvalServer({
    requests: [
      {
        method: 'item/fileChange/requestApproval',
        serverRequestId: 0,
        item: { type: 'fileChange', id: 'fc-1', changes: [], status: 'inProgress' },
        params: { itemId: 'fc-1', startedAtMs: 1 },
      },
    ],
  });

  const result = await startTurn({ cwd: '.', prompt: 'write it', spawnFn: () => child });
  expect(result.stopReason).toBe('result');
  expect(child.approvalAnswers).toEqual([{ jsonrpc: '2.0', id: 0, result: { decision: 'decline' } }]);
});

test('an unknown server request is declined immediately and collected as a warning, and the turn survives', async () => {
  const child = approvalServer({
    requests: [
      { method: 'item/tool/requestUserInput', serverRequestId: 3, params: { itemId: 'q-1', questions: [] } },
    ],
  });

  const result = await startTurn({
    cwd: '.',
    prompt: 'hi',
    spawnFn: () => child,
    onApprovalRequest: async () => {
      throw new Error('must not be called for a request kaprek cannot phrase');
    },
  });

  expect(result.stopReason).toBe('result');
  expect(result.warnings?.some((w) => w.includes('item/tool/requestUserInput'))).toBe(true);
  expect(child.approvalAnswers).toEqual([{ jsonrpc: '2.0', id: 3, result: { decision: 'decline' } }]);
});

test('the approval lifecycle is visible as events: requested, then resolved with the behavior', async () => {
  const child = approvalServer({
    requests: [
      {
        method: 'item/fileChange/requestApproval',
        serverRequestId: 0,
        item: { type: 'fileChange', id: 'fc-1', changes: [], status: 'inProgress' },
        params: { itemId: 'fc-1', startedAtMs: 1 },
      },
    ],
  });

  const events = [];
  await startTurn({
    cwd: '.',
    prompt: 'write it',
    spawnFn: () => child,
    onEvent: (e) => events.push(e),
    onApprovalRequest: async () => ({ behavior: 'allow' }),
  });

  const approvals = events.filter((e) => e.type === 'approval');
  expect(approvals).toHaveLength(2);
  expect(approvals[0]).toMatchObject({ phase: 'requested', toolName: 'fileChange' });
  expect(approvals[1]).toMatchObject({ phase: 'resolved', toolName: 'fileChange', behavior: 'allow' });
  for (const event of approvals) expect(isNormalizedEvent(event)).toBe(true);
});

test('two approvals in flight at once are answered independently, in whatever order the human decides', async () => {
  const child = approvalServer({
    requests: [
      {
        method: 'item/fileChange/requestApproval',
        serverRequestId: 0,
        item: { type: 'fileChange', id: 'fc-1', changes: [{ path: 'a', kind: { type: 'add' }, diff: 'a' }], status: 'inProgress' },
        params: { itemId: 'fc-1', startedAtMs: 1 },
      },
      {
        method: 'item/commandExecution/requestApproval',
        serverRequestId: 1,
        item: { type: 'commandExecution', id: 'x-1', command: 'run', cwd: '.', status: 'inProgress' },
        params: { itemId: 'x-1', startedAtMs: 2, command: 'run', cwd: '.' },
      },
    ],
  });

  // The FIRST request resolves only after the second one already answered —
  // the harness must not serialize them.
  let releaseFirst;
  const firstGate = new Promise((r) => {
    releaseFirst = r;
  });
  const result = await startTurn({
    cwd: '.',
    prompt: 'both',
    spawnFn: () => child,
    onApprovalRequest: async (request) => {
      if (request.toolName === 'fileChange') {
        await firstGate;
        return { behavior: 'allow' };
      }
      queueMicrotask(() => releaseFirst());
      return { behavior: 'deny', message: 'no' };
    },
  });

  expect(result.stopReason).toBe('result');
  const byId = Object.fromEntries(child.approvalAnswers.map((a) => [a.id, a.result.decision]));
  expect(byId).toEqual({ 0: 'accept', 1: 'decline' });
  // The decline (request 1) arrived before the accept (request 0).
  expect(child.approvalAnswers.map((a) => a.id)).toEqual([1, 0]);
});

// --- robustness: clocks, abort, error normalization (M1 Task 3) ---

/** A server that answers the handshake but then goes silent forever — the turn only ends by abort, clock, or child death. */
function silentServer({ threadId = 'th-1' } = {}) {
  return makeFakeCodexServer((c, msg) => {
    if (msg.method === 'initialize') c.send({ id: msg.id, result: { userAgent: 'fake/0' } });
    else if (msg.method === 'thread/start') c.send({ id: msg.id, result: { thread: { id: threadId } } });
    else if (msg.method === 'turn/start') c.send({ id: msg.id, result: { turn: { id: 'turn-1', status: 'inProgress' } } });
  });
}

test('an abort sends turn/interrupt before the kill and resolves stopReason aborted', async () => {
  const child = silentServer();
  const controller = new AbortController();
  const turn = startTurn({ cwd: '.', prompt: 'hi', signal: controller.signal, spawnFn: () => child });

  // Let the handshake complete before aborting, so a threadId exists.
  await new Promise((r) => setTimeout(r, 50));
  controller.abort();
  const result = await turn;

  expect(result.stopReason).toBe('aborted');
  expect(result.error).toBeNull();
  const interrupt = child.received.find((m) => m.method === 'turn/interrupt');
  expect(interrupt?.params?.threadId).toBe('th-1');
  expect(child.kill).toHaveBeenCalled();
});

test('a silent model trips the idle clock: stopReason timeout, timeoutClock idle', async () => {
  const child = silentServer();
  const result = await startTurn({ cwd: '.', prompt: 'hi', spawnFn: () => child, idleMs: 40, clockIntervalMs: 10 });
  expect(result.stopReason).toBe('timeout');
  expect(result.timeoutClock).toBe('idle');
  expect(result.error).toBeNull();
}, 10000);

test('a child that dies before the turn completes is an error carrying the exit code and stderr', async () => {
  const child = silentServer();
  const turn = startTurn({ cwd: '.', prompt: 'hi', spawnFn: () => child });
  await new Promise((r) => setTimeout(r, 30));
  child.stderr.write('ERROR model backend unreachable\n');
  child.killed = true;
  child.emit('close', 1);
  const result = await turn;
  expect(result.stopReason).toBe('error');
  expect(result.error.message).toContain('code 1');
  expect(result.error.message).toContain('backend unreachable');
});

test('a JSON-RPC error on turn/start ends the turn as an error, not a hang', async () => {
  const child = makeFakeCodexServer((c, msg) => {
    if (msg.method === 'initialize') c.send({ id: msg.id, result: {} });
    else if (msg.method === 'thread/start') c.send({ id: msg.id, result: { thread: { id: 'th-1' } } });
    else if (msg.method === 'turn/start') c.send({ id: msg.id, error: { code: -32000, message: 'model not available' } });
  });
  const result = await startTurn({ cwd: '.', prompt: 'hi', spawnFn: () => child });
  expect(result.stopReason).toBe('error');
  expect(result.error.message).toContain('model not available');
});

test('an oversized output line is dropped and counted instead of being parsed or ending the turn', async () => {
  const child = makeFakeCodexServer((c, msg) => {
    if (msg.method === 'initialize') c.send({ id: msg.id, result: {} });
    else if (msg.method === 'thread/start') c.send({ id: msg.id, result: { thread: { id: 'th-1' } } });
    else if (msg.method === 'turn/start') {
      c.send({ id: msg.id, result: { turn: { id: 'turn-1' } } });
      c.stdout.write(`${'x'.repeat(9 * 1024 * 1024)}\n`);
      c.send({ method: 'turn/completed', params: { threadId: 'th-1', turn: { id: 'turn-1', status: 'completed', error: null } } });
    }
  });
  const result = await startTurn({ cwd: '.', prompt: 'hi', spawnFn: () => child });
  expect(result.stopReason).toBe('result');
  expect(result.droppedLines).toBe(1);
}, 15000);

test('an onEvent consumer that throws is collected as a warning and the turn still completes', async () => {
  const child = happyServer({
    turnEvents: [{ method: 'item/agentMessage/delta', params: { threadId: 'th-1', turnId: 'turn-1', itemId: 'm1', delta: 'hi' } }],
  });
  const result = await startTurn({
    cwd: '.',
    prompt: 'hi',
    spawnFn: () => child,
    onEvent: (event) => {
      if (event.type === 'text') throw new Error('boom in onEvent');
    },
  });
  expect(result.stopReason).toBe('result');
  expect(result.warnings).toContain('boom in onEvent');
});
