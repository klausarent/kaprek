// Tests for the harness's own process-lifecycle robustness (P1 fix wave):
// turn timeout, kill escalation/give-up, stdin EPIPE, a throwing onEvent
// consumer, an oversized output line, and is_error detail passthrough.
//
// Complements adapter.test.mjs (which covers the stream-json parsing/argv
// contract) — kept as a separate file since these tests are specifically
// about claude-code.mjs's own hardening, not the shared adapter contract.
import { test, expect, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import { spawn as nodeSpawn } from 'node:child_process';
import { startTurn } from './claude-code.mjs';

/** A stub child that never emits 'close' and whose kill() is a recorded no-op — simulates a process ignoring its kill signal. */
function makeHangingChild() {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.stdin = new Writable({ write: (_chunk, _enc, cb) => cb() });
  child.pid = 999999; // unlikely to collide with a real process on this machine
  child.kill = vi.fn();
  return child;
}

/** Spawns a real, short-lived node process running `script` — a harmless stand-in for `claude`. */
function spawnNodeScript(script) {
  return nodeSpawn(process.execPath, ['-e', script], { stdio: 'pipe' });
}

test('A1: a turn that exceeds timeoutMs is killed and resolves stopReason "timeout"', async () => {
  const result = await startTurn({
    cwd: '.',
    prompt: 'hi',
    timeoutMs: 100,
    spawnFn: () => spawnNodeScript('setTimeout(() => {}, 30000)'),
  });
  expect(result.stopReason).toBe('timeout');
  expect(result.error).toBeNull();
}, 10000);

test('A2: a child that ignores kill() is given up on after killGraceMs, resolves without hanging, marked orphaned', async () => {
  const controller = new AbortController();
  const hangingChild = makeHangingChild();

  const turn = startTurn({
    cwd: '.',
    prompt: 'hi',
    signal: controller.signal,
    killGraceMs: 30,
    spawnFn: () => hangingChild,
  });

  controller.abort();
  const result = await turn;

  expect(result.stopReason).toBe('aborted');
  expect(result.orphaned).toBe(true);
  expect(hangingChild.kill).toHaveBeenCalled();
}, 5000);

test('A3: stdin EPIPE (CLI exits immediately) does not throw/crash, turn still resolves', async () => {
  const result = await startTurn({
    cwd: '.',
    prompt: 'hi',
    spawnFn: () => spawnNodeScript('process.exit(0)'),
  });
  expect(result.stopReason).toBe('error');
  expect(typeof result.error.message).toBe('string');
}, 10000);

test('A4: an onEvent consumer that throws is caught, collected as a warning, turn still completes normally', async () => {
  const lines = [
    { type: 'system', subtype: 'init', session_id: 's1', tools: [], model: 'm' },
    { type: 'assistant', message: { content: [{ type: 'text', text: 'hi' }] } },
    { type: 'result', session_id: 's1', total_cost_usd: 0.001, usage: {}, is_error: false },
  ];
  const script = lines.map((l) => `console.log(${JSON.stringify(JSON.stringify(l))});`).join('\n');

  const seen = [];
  const result = await startTurn({
    cwd: '.',
    prompt: 'hi',
    spawnFn: () => spawnNodeScript(script),
    onEvent: (event) => {
      seen.push(event.type);
      if (event.type === 'text') throw new Error('boom in onEvent');
    },
  });

  expect(result.stopReason).toBe('result');
  expect(seen).toEqual(['init', 'text', 'result']); // playback continued past the throw
  expect(result.warnings).toEqual(['boom in onEvent']);
}, 10000);

test('A5: an oversized output line is dropped and counted, does not stop the turn', async () => {
  const resultLine = { type: 'result', session_id: 's-big', total_cost_usd: 0.02, usage: {}, is_error: false };
  const script = [
    "console.log('x'.repeat(9 * 1024 * 1024));",
    `console.log(${JSON.stringify(JSON.stringify(resultLine))});`,
  ].join('\n');

  const result = await startTurn({
    cwd: '.',
    prompt: 'hi',
    spawnFn: () => spawnNodeScript(script),
  });

  expect(result.stopReason).toBe('result');
  expect(result.droppedLines).toBe(1);
}, 10000);

test('A7: strictAskCoverage kills the turn immediately (not just resolves) when the CLI reports a tool not in requireAskCoverage', async () => {
  const initLine = { type: 'system', subtype: 'init', session_id: 's1', tools: ['Bash', 'SomeBrandNewTool'], model: 'm' };
  const script = [
    `console.log(${JSON.stringify(JSON.stringify(initLine))});`,
    'setTimeout(() => {}, 30000);', // would hang the test if the child were not actually killed
  ].join('\n');

  const result = await startTurn({
    cwd: '.',
    prompt: 'hi',
    spawnFn: () => spawnNodeScript(script),
    requireAskCoverage: ['Bash'],
    strictAskCoverage: true,
  });

  expect(result.stopReason).toBe('error');
  expect(result.error.message).toContain('SomeBrandNewTool');
}, 10000);

test('A8: without strictAskCoverage, an unrecognized tool is only a warning — the turn completes normally', async () => {
  const lines = [
    { type: 'system', subtype: 'init', session_id: 's1', tools: ['Bash', 'SomeBrandNewTool'], model: 'm' },
    { type: 'result', session_id: 's1', total_cost_usd: 0, usage: {}, is_error: false },
  ];
  const script = lines.map((l) => `console.log(${JSON.stringify(JSON.stringify(l))});`).join('\n');

  const result = await startTurn({
    cwd: '.',
    prompt: 'hi',
    spawnFn: () => spawnNodeScript(script),
    requireAskCoverage: ['Bash'],
    strictAskCoverage: false,
  });

  expect(result.stopReason).toBe('result');
  expect(result.warnings.some((w) => w.includes('SomeBrandNewTool'))).toBe(true);
}, 10000);

test('A9: a read-only tool (KNOWN_READONLY_TOOLS) is never an ask-coverage gap, even when absent from requireAskCoverage', async () => {
  const lines = [
    { type: 'system', subtype: 'init', session_id: 's1', tools: ['Bash', 'Read', 'Grep'], model: 'm' },
    { type: 'result', session_id: 's1', total_cost_usd: 0, usage: {}, is_error: false },
  ];
  const script = lines.map((l) => `console.log(${JSON.stringify(JSON.stringify(l))});`).join('\n');

  const result = await startTurn({
    cwd: '.',
    prompt: 'hi',
    spawnFn: () => spawnNodeScript(script),
    requireAskCoverage: ['Bash'], // deliberately does NOT list Read/Grep
    strictAskCoverage: true,
  });

  expect(result.stopReason).toBe('result');
  expect(result.warnings).toEqual([]);
});

test('A10: an MCP tool (mcp__…) is never an ask-coverage gap, regardless of requireAskCoverage', async () => {
  const lines = [
    { type: 'system', subtype: 'init', session_id: 's1', tools: ['Bash', 'mcp__kaprek-apps__notes.write'], model: 'm' },
    { type: 'result', session_id: 's1', total_cost_usd: 0, usage: {}, is_error: false },
  ];
  const script = lines.map((l) => `console.log(${JSON.stringify(JSON.stringify(l))});`).join('\n');

  const result = await startTurn({
    cwd: '.',
    prompt: 'hi',
    spawnFn: () => spawnNodeScript(script),
    requireAskCoverage: ['Bash'],
    strictAskCoverage: true,
  });

  expect(result.stopReason).toBe('result');
  expect(result.warnings).toEqual([]);
});

test('A12: strictAskCoverage still calls learnUnknownTools with the unknown tool name(s) BEFORE killing the turn', async () => {
  const initLine = { type: 'system', subtype: 'init', session_id: 's1', tools: ['Bash', 'ScheduleWakeup', 'Monitor'], model: 'm' };
  const script = [
    `console.log(${JSON.stringify(JSON.stringify(initLine))});`,
    'setTimeout(() => {}, 30000);',
  ].join('\n');

  const learned = [];
  const result = await startTurn({
    cwd: '.',
    prompt: 'hi',
    spawnFn: () => spawnNodeScript(script),
    requireAskCoverage: ['Bash'],
    strictAskCoverage: true,
    learnUnknownTools: (toolNames) => learned.push(...toolNames),
  });

  expect(result.stopReason).toBe('error');
  expect(learned.sort()).toEqual(['Monitor', 'ScheduleWakeup']);
});

test('A13: without strictAskCoverage, learnUnknownTools is still called (learning does not depend on aborting)', async () => {
  const lines = [
    { type: 'system', subtype: 'init', session_id: 's1', tools: ['Bash', 'ScheduleWakeup'], model: 'm' },
    { type: 'result', session_id: 's1', total_cost_usd: 0, usage: {}, is_error: false },
  ];
  const script = lines.map((l) => `console.log(${JSON.stringify(JSON.stringify(l))});`).join('\n');

  const learned = [];
  const result = await startTurn({
    cwd: '.',
    prompt: 'hi',
    spawnFn: () => spawnNodeScript(script),
    requireAskCoverage: ['Bash'],
    strictAskCoverage: false,
    learnUnknownTools: (toolNames) => learned.push(...toolNames),
  });

  expect(result.stopReason).toBe('result');
  expect(learned).toEqual(['ScheduleWakeup']);
});

test('A14: a throwing learnUnknownTools does not change how the coverage gap itself is handled', async () => {
  const initLine = { type: 'system', subtype: 'init', session_id: 's1', tools: ['Bash', 'ScheduleWakeup'], model: 'm' };
  const script = [
    `console.log(${JSON.stringify(JSON.stringify(initLine))});`,
    'setTimeout(() => {}, 30000);',
  ].join('\n');

  const result = await startTurn({
    cwd: '.',
    prompt: 'hi',
    spawnFn: () => spawnNodeScript(script),
    requireAskCoverage: ['Bash'],
    strictAskCoverage: true,
    learnUnknownTools: () => {
      throw new Error('learning boom');
    },
  });

  expect(result.stopReason).toBe('error');
  expect(result.error.message).toContain('ScheduleWakeup');
});

test('A11: omitting requireAskCoverage entirely skips the check (backward compatible)', async () => {
  const lines = [
    { type: 'system', subtype: 'init', session_id: 's1', tools: ['Bash', 'AnythingAtAll'], model: 'm' },
    { type: 'result', session_id: 's1', total_cost_usd: 0, usage: {}, is_error: false },
  ];
  const script = lines.map((l) => `console.log(${JSON.stringify(JSON.stringify(l))});`).join('\n');

  const result = await startTurn({
    cwd: '.',
    prompt: 'hi',
    spawnFn: () => spawnNodeScript(script),
  });

  expect(result.stopReason).toBe('result');
  expect(result.warnings).toEqual([]);
});

test('A6: an is_error result carries subtype and result text in error.message', async () => {
  const resultLine = {
    type: 'result',
    session_id: 's-err',
    total_cost_usd: 0.01,
    usage: {},
    is_error: true,
    subtype: 'error_during_execution',
    result: 'boom something failed',
  };
  const script = `console.log(${JSON.stringify(JSON.stringify(resultLine))});`;

  const result = await startTurn({
    cwd: '.',
    prompt: 'hi',
    spawnFn: () => spawnNodeScript(script),
  });

  expect(result.stopReason).toBe('error');
  expect(result.error.message).toContain('error_during_execution');
  expect(result.error.message).toContain('boom something failed');
}, 10000);

test('A15: a duplicated assistant line re-announcing an open tool_use id does not leak a lease — after the single tool_result the idle clock, not tool-lease, ends the turn', async () => {
  const toolUse = {
    type: 'assistant',
    message: { content: [{ type: 'tool_use', id: 'toolu_dup', name: 'Bash', input: { command: 'echo hi' } }] },
  };
  const toolResult = {
    type: 'user',
    message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_dup', content: 'hi' }] },
  };
  const lines = [
    { type: 'system', subtype: 'init', session_id: 's1', tools: [], model: 'm' },
    toolUse,
    toolUse, // the same line twice — a retransmit, not a second tool
    toolResult,
  ];
  const script = [
    ...lines.map((l) => `console.log(${JSON.stringify(JSON.stringify(l))});`),
    'setTimeout(() => {}, 30000);', // no result line: some clock has to end this turn
  ].join('\n');

  const result = await startTurn({
    cwd: '.',
    prompt: 'hi',
    spawnFn: () => spawnNodeScript(script),
    idleMs: 400,
    toolLeaseMs: 8000,
    timeoutMs: 8000,
  });

  // With the duplicate counted twice, the one tool_result leaves a phantom
  // lease open, idle never applies, and the turn dies much later as a bogus
  // 'tool-lease' timeout. Mutant that resurrects the bug (count tool-start
  // unconditionally): this test goes red with timeoutClock 'tool-lease'.
  expect(result.stopReason).toBe('timeout');
  expect(result.timeoutClock).toBe('idle');
  expect(result.warnings.some((w) => w.includes('already-open id'))).toBe(true);
}, 10000);
