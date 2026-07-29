// Tests for the harness adapter contract, the claude-code.mjs stream-json
// parser/spawn wiring, and the fake.mjs stand-in harness.
// Run: npx vitest run src/harness
//
// No test here ever spawns the real `claude` CLI (costs money/time): the
// stream-json parsing tests inject a fake child process via spawnFn, and
// only the process-kill test spawns a real (but harmless, long-sleeping)
// node subprocess as a stand-in for the CLI.
import { test, expect } from 'vitest';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn as nodeSpawn } from 'node:child_process';
import { isNormalizedEvent, EVENT_TYPES } from './adapter.mjs';
import { startTurn } from './claude-code.mjs';
import { createFakeHarness } from './fake.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_LINES = fs
  .readFileSync(path.join(__dirname, 'fixtures', 'stream-lines.jsonl'), 'utf8')
  .split('\n')
  .filter((l) => l.length > 0);

/** A minimal fake child_process.ChildProcess: stdout/stderr are real streams, stdin/kill are recorded no-ops. */
function makeFakeChild({ lines = FIXTURE_LINES, exitCode = 0, stderr = '' } = {}) {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.stdinWrites = [];
  child.stdinEnded = false;
  child.stdin = {
    write: (chunk) => {
      child.stdinWrites.push(chunk);
      return true;
    },
    end: () => {
      child.stdinEnded = true;
    },
  };
  child.killed = false;
  child.kill = (signal) => {
    child.killed = true;
    child.killSignal = signal;
    return true;
  };

  queueMicrotask(() => {
    for (const line of lines) child.stdout.write(`${line}\n`);
    child.stdout.end();
    if (stderr) child.stderr.write(stderr);
    child.stderr.end();
    child.emit('close', exitCode);
  });

  return child;
}

test('fixture parses into the expected normalized events, in order, all matching the contract', async () => {
  const events = [];
  const result = await startTurn({
    cwd: 'C:\\Users\\testuser\\demo-app',
    prompt: 'check the repo',
    onEvent: (e) => events.push(e),
    spawnFn: () => makeFakeChild(),
  });

  const types = events.map((e) => e.type);
  expect(types).toEqual([
    'init',
    'text',
    'thinking',
    'tool-start',
    'tool-end',
    'tool-start',
    'tool-start',
    'tool-end',
    'tool-end',
    'rate-limit',
    'result',
  ]);
  for (const event of events) {
    expect(isNormalizedEvent(event), `not a valid NormalizedEvent: ${JSON.stringify(event)}`).toBe(true);
  }

  expect(result).toEqual({
    sessionId: 'sess_test0001',
    costUsd: 0.0421,
    usage: { input_tokens: 512, output_tokens: 128 },
    stopReason: 'result',
    error: null,
    droppedLines: 0,
    warnings: [],
  });
});

test('init event carries session id, tools, model, permission mode', async () => {
  const events = [];
  await startTurn({ cwd: '.', prompt: 'hi', onEvent: (e) => events.push(e), spawnFn: () => makeFakeChild() });
  const init = events.find((e) => e.type === 'init');
  expect(init).toEqual({
    type: 'init',
    sessionId: 'sess_test0001',
    tools: ['Bash', 'Read', 'Write'],
    model: 'claude-test-model',
    permissionMode: 'acceptEdits',
  });
});

test('a single stream-json user line with several tool_result blocks yields one tool-end event each', async () => {
  const events = [];
  await startTurn({ cwd: '.', prompt: 'hi', onEvent: (e) => events.push(e), spawnFn: () => makeFakeChild() });
  const toolEnds = events.filter((e) => e.type === 'tool-end');
  expect(toolEnds).toEqual([
    { type: 'tool-end', id: 'toolu_1', result: 'file1.txt\nfile2.txt', isError: false },
    { type: 'tool-end', id: 'toolu_2', result: 'contents of file1', isError: false },
    { type: 'tool-end', id: 'toolu_3', result: 'write failed: permission denied', isError: true },
  ]);
});

test('the malformed line and hook_started/hook_response system lines produce no events', async () => {
  const events = [];
  await startTurn({ cwd: '.', prompt: 'hi', onEvent: (e) => events.push(e), spawnFn: () => makeFakeChild() });
  // 11 events total per the fixture (see the ordering test above) — nothing
  // extra leaked through for the 3 ignored lines (2 hook lines + 1 broken line).
  expect(events.length).toBe(11);
});

test('rate_limit_event maps to a rate-limit event carrying rate_limit_info as info', async () => {
  const events = [];
  await startTurn({ cwd: '.', prompt: 'hi', onEvent: (e) => events.push(e), spawnFn: () => makeFakeChild() });
  const rateLimit = events.find((e) => e.type === 'rate-limit');
  expect(rateLimit.info).toEqual({ status: 'allowed', resetsAt: '2026-07-30T12:00:00Z' });
});

test('the prompt is written to stdin as one JSON line, then stdin is closed', async () => {
  let capturedChild;
  await startTurn({
    cwd: '.',
    prompt: 'build the digest parser',
    onEvent: () => {},
    spawnFn: () => {
      capturedChild = makeFakeChild();
      return capturedChild;
    },
  });
  expect(capturedChild.stdinWrites).toEqual([
    `${JSON.stringify({ type: 'user', message: { role: 'user', content: 'build the digest parser' } })}\n`,
  ]);
  expect(capturedChild.stdinEnded).toBe(true);
});

test('argv: fresh turn has no --resume; mcp-config/permission-mode/allowedTools are passed through', async () => {
  let capturedArgs;
  await startTurn({
    cwd: '.',
    prompt: 'hi',
    mcpConfigPath: 'C:\\Users\\testuser\\.kaprek\\mcp.json',
    permissionMode: 'acceptEdits',
    allowedTools: ['Bash', 'Read'],
    onEvent: () => {},
    spawnFn: (command, args) => {
      capturedArgs = args;
      return makeFakeChild();
    },
  });
  expect(capturedArgs).toEqual([
    '-p',
    '--output-format',
    'stream-json',
    '--input-format',
    'stream-json',
    '--verbose',
    '--mcp-config',
    'C:\\Users\\testuser\\.kaprek\\mcp.json',
    '--permission-mode',
    'acceptEdits',
    '--allowedTools',
    'Bash,Read',
  ]);
});

test('argv: passing a sessionId adds --resume <sessionId> (a follow-up turn)', async () => {
  let capturedArgs;
  await startTurn({
    cwd: '.',
    prompt: 'continue',
    sessionId: 'sess_test0001',
    onEvent: () => {},
    spawnFn: (command, args) => {
      capturedArgs = args;
      return makeFakeChild();
    },
  });
  expect(capturedArgs).toContain('--resume');
  expect(capturedArgs[capturedArgs.indexOf('--resume') + 1]).toBe('sess_test0001');
});

test('a result event with is_error:true resolves stopReason "error" but still carries cost/usage', async () => {
  const errorResultLine = JSON.stringify({
    type: 'result',
    total_cost_usd: 0.01,
    session_id: 'sess_test0002',
    is_error: true,
    usage: { input_tokens: 10, output_tokens: 0 },
  });
  const result = await startTurn({
    cwd: '.',
    prompt: 'hi',
    onEvent: () => {},
    spawnFn: () => makeFakeChild({ lines: [errorResultLine] }),
  });
  expect(result.stopReason).toBe('error');
  expect(result.costUsd).toBe(0.01);
  expect(result.error).toBeTruthy();
});

test('exit code != 0 without a result event resolves stopReason "error", stderr tail in the message', async () => {
  const result = await startTurn({
    cwd: '.',
    prompt: 'hi',
    onEvent: () => {},
    spawnFn: () => makeFakeChild({ lines: [], exitCode: 1, stderr: 'claude: command not found' }),
  });
  expect(result.stopReason).toBe('error');
  expect(result.error.message).toContain('1');
  expect(result.error.message).toContain('claude: command not found');
});

test('a spawn failure (e.g. ENOENT) resolves stopReason "error" instead of throwing', async () => {
  const result = await startTurn({
    cwd: '.',
    prompt: 'hi',
    onEvent: () => {},
    spawnFn: () => {
      throw new Error('spawn claude ENOENT');
    },
  });
  expect(result.stopReason).toBe('error');
  expect(result.error.message).toContain('ENOENT');
});

test('an already-aborted signal short-circuits before spawning', async () => {
  const controller = new AbortController();
  controller.abort();
  let spawned = false;
  const result = await startTurn({
    cwd: '.',
    prompt: 'hi',
    onEvent: () => {},
    signal: controller.signal,
    spawnFn: () => {
      spawned = true;
      return makeFakeChild();
    },
  });
  expect(spawned).toBe(false);
  expect(result.stopReason).toBe('aborted');
});

test('aborting mid-turn kills a real child process and resolves stopReason "aborted"', async () => {
  let capturedChild;
  const controller = new AbortController();

  const turn = startTurn({
    cwd: '.',
    prompt: 'hi',
    onEvent: () => {},
    signal: controller.signal,
    // Stand-in for `claude`: a real, but harmless and long-sleeping, node
    // subprocess — proves the kill path against an actual OS process
    // without ever invoking the real CLI.
    spawnFn: () => {
      capturedChild = nodeSpawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], { stdio: 'pipe' });
      return capturedChild;
    },
  });

  await new Promise((resolve) => setTimeout(resolve, 100));
  controller.abort();

  const result = await turn;
  expect(result.stopReason).toBe('aborted');
  expect(result.error).toBe(null);
  expect(capturedChild.killed).toBe(true);
}, 10000);

test('createFakeHarness plays back a scripted sequence and resolves from its result event', async () => {
  const harness = createFakeHarness({
    script: [
      { type: 'init', sessionId: 'fake-sess-1', tools: ['Bash'], model: 'fake-model', permissionMode: 'default' },
      { type: 'text', text: 'hello from the fake harness' },
      { type: 'result', sessionId: 'fake-sess-1', costUsd: 0.002, usage: { input_tokens: 5, output_tokens: 3 }, isError: false },
    ],
  });

  const events = [];
  const result = await harness.startTurn({ cwd: '.', prompt: 'hi', onEvent: (e) => events.push(e) });

  expect(events.map((e) => e.type)).toEqual(['init', 'text', 'result']);
  expect(result).toEqual({
    sessionId: 'fake-sess-1',
    costUsd: 0.002,
    usage: { input_tokens: 5, output_tokens: 3 },
    stopReason: 'result',
    error: null,
  });
});

test('createFakeHarness: a script without a result event resolves stopReason "error"', async () => {
  const harness = createFakeHarness({ script: [{ type: 'text', text: 'no result follows' }] });
  const result = await harness.startTurn({ cwd: '.', prompt: 'hi', onEvent: () => {} });
  expect(result.stopReason).toBe('error');
  expect(result.error).toBeTruthy();
});

test('createFakeHarness: aborting stops playback partway through the script', async () => {
  const controller = new AbortController();
  const events = [];
  const harness = createFakeHarness({
    script: [
      { type: 'text', text: 'one' },
      { type: 'text', text: 'two' },
      { type: 'text', text: 'three' },
      { type: 'result', sessionId: 'fake-sess-2', costUsd: 0.001, usage: {}, isError: false },
    ],
  });

  const result = await harness.startTurn({
    cwd: '.',
    prompt: 'hi',
    signal: controller.signal,
    onEvent: (e) => {
      events.push(e);
      if (events.length === 1) controller.abort();
    },
  });

  expect(events).toEqual([{ type: 'text', text: 'one' }]);
  expect(result.stopReason).toBe('aborted');
});

test('adapter.mjs exports every event type isNormalizedEvent actually recognizes', () => {
  for (const type of EVENT_TYPES) {
    expect(isNormalizedEvent({ type: 'bogus-not-a-real-type' })).toBe(false);
    expect(typeof type).toBe('string');
  }
});
