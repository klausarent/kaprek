// Tests for the tool-use approval chain across the harness layer: the
// adapter contract's 'approval' NormalizedEvent / ApprovalRequest shapes
// (adapter.mjs), claude-code.mjs's actual can_use_tool control-channel
// protocol, and fake.mjs's scriptable stand-in for it. Complements
// adapter.test.mjs (stream-json parsing) and claude-code.test.mjs
// (process-lifecycle robustness) — kept separate since this file is
// specifically about the approval feature end to end.
//
// No test here spawns the real `claude` CLI — see the Fallstricke this
// protocol is modeled on: the control-channel messages below (control_request/
// control_response) were empirically confirmed against CLI 2.1.220, but every
// test injects them through a fake child process via spawnFn, same pattern
// as adapter.test.mjs/claude-code.test.mjs.
import { test, expect, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { isNormalizedEvent, isApprovalRequest, EVENT_TYPES } from './adapter.mjs';
import { startTurn } from './claude-code.mjs';
import { createFakeHarness } from './fake.mjs';

/** A minimal fake child_process.ChildProcess, but stdout stays open until the test explicitly closes it — lets a test control the exact timing of control_request/result lines relative to each other. */
function makeControllableChild() {
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
  child.kill = () => {
    child.killed = true;
  };
  return child;
}

function writeLine(child, obj) {
  child.stdout.write(`${JSON.stringify(obj)}\n`);
}

function closeChild(child, code = 0) {
  child.stdout.end();
  child.stderr.end();
  child.emit('close', code);
}

const RESULT_LINE = { type: 'result', session_id: 's1', total_cost_usd: 0, usage: {}, is_error: false };

// --- adapter.mjs contract ----------------------------------------------------

test('EVENT_TYPES includes approval, isNormalizedEvent recognizes both lifecycle phases', () => {
  expect(EVENT_TYPES).toContain('approval');
  expect(isNormalizedEvent({ type: 'approval', phase: 'requested', id: 'r1', toolName: 'Bash' })).toBe(true);
  expect(isNormalizedEvent({ type: 'approval', phase: 'resolved', id: 'r1', toolName: 'Bash', behavior: 'allow' })).toBe(true);
  // required keys missing -> not a valid NormalizedEvent
  expect(isNormalizedEvent({ type: 'approval', phase: 'requested' })).toBe(false);
});

test('isApprovalRequest checks for id/toolName/input, not exact value types', () => {
  expect(isApprovalRequest({ id: 'r1', toolName: 'Bash', input: { command: 'ls' } })).toBe(true);
  expect(isApprovalRequest({ id: 'r1', toolName: 'Bash' })).toBe(false); // missing input
  expect(isApprovalRequest(null)).toBe(false);
  expect(isApprovalRequest('not an object')).toBe(false);
});

// --- claude-code.mjs control-channel protocol -------------------------------

test('a can_use_tool control_request is answered with exactly one control_response carrying the same request_id', async () => {
  const child = makeControllableChild();
  const onApprovalRequest = vi.fn(async () => ({ behavior: 'allow' }));
  const requestId = 'req-alpha';

  const turn = startTurn({ cwd: '.', prompt: 'hi', onApprovalRequest, onEvent: () => {}, spawnFn: () => child });

  writeLine(child, {
    type: 'control_request',
    request_id: requestId,
    request: { subtype: 'can_use_tool', tool_name: 'Read', display_name: 'Read', input: { file_path: 'ziel.txt' }, tool_use_id: 'toolu_1' },
  });
  await new Promise((resolve) => setTimeout(resolve, 20)); // let the async approval round-trip settle
  writeLine(child, RESULT_LINE);
  closeChild(child);

  await turn;

  // stdinWrites[0] is the prompt line (see claude-code.mjs's final write) —
  // the control_response is the only write after it.
  const responses = child.stdinWrites.slice(1).map((w) => JSON.parse(w));
  expect(responses).toHaveLength(1);
  expect(responses[0]).toEqual({
    type: 'control_response',
    response: {
      subtype: 'success',
      request_id: requestId,
      response: { behavior: 'allow', updatedInput: { file_path: 'ziel.txt' }, toolUseID: 'toolu_1' },
    },
  });

  expect(onApprovalRequest).toHaveBeenCalledTimes(1);
  const request = onApprovalRequest.mock.calls[0][0];
  expect(isApprovalRequest(request)).toBe(true);
  expect(request).toMatchObject({ id: requestId, toolName: 'Read', displayName: 'Read', input: { file_path: 'ziel.txt' }, toolUseId: 'toolu_1' });
});

test('no onApprovalRequest configured auto-denies with "no approval handler configured" (fail-closed)', async () => {
  const child = makeControllableChild();
  const requestId = 'req-beta';

  const turn = startTurn({ cwd: '.', prompt: 'hi', onEvent: () => {}, spawnFn: () => child });

  writeLine(child, { type: 'control_request', request_id: requestId, request: { subtype: 'can_use_tool', tool_name: 'Bash', input: {} } });
  await new Promise((resolve) => setTimeout(resolve, 20));
  writeLine(child, RESULT_LINE);
  closeChild(child);

  await turn;

  const responses = child.stdinWrites.slice(1).map((w) => JSON.parse(w));
  expect(responses).toHaveLength(1);
  expect(responses[0].response).toEqual({
    subtype: 'success',
    request_id: requestId,
    response: { behavior: 'deny', message: 'no approval handler configured', interrupt: false },
  });
});

test('a throwing/rejecting onApprovalRequest handler produces a subtype:"error" control_response, the turn still runs to completion', async () => {
  const child = makeControllableChild();
  const onApprovalRequest = vi.fn(async () => {
    throw new Error('handler exploded');
  });
  const requestId = 'req-gamma';

  const turn = startTurn({ cwd: '.', prompt: 'hi', onApprovalRequest, onEvent: () => {}, spawnFn: () => child });

  writeLine(child, { type: 'control_request', request_id: requestId, request: { subtype: 'can_use_tool', tool_name: 'Write', input: {} } });
  await new Promise((resolve) => setTimeout(resolve, 20));
  writeLine(child, RESULT_LINE);
  closeChild(child);

  const result = await turn;

  expect(result.stopReason).toBe('result'); // the turn was NOT killed by the handler's throw
  const responses = child.stdinWrites.slice(1).map((w) => JSON.parse(w));
  expect(responses).toEqual([{ type: 'control_response', response: { subtype: 'error', request_id: requestId, error: 'handler exploded' } }]);
});

test('stdin stays open after the prompt is written (regression anthropics/claude-code#34046), closes only once the turn ends', async () => {
  const child = makeControllableChild();

  const turn = startTurn({ cwd: '.', prompt: 'hi', onEvent: () => {}, spawnFn: () => child });

  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(child.stdinEnded).toBe(false);

  writeLine(child, RESULT_LINE);
  closeChild(child);

  await turn;
  expect(child.stdinEnded).toBe(true);
});

test('two concurrent control_requests from different agents are each answered with their own decision, never serialized', async () => {
  const child = makeControllableChild();
  const seenIds = [];
  const onApprovalRequest = vi.fn(async (request) => {
    seenIds.push(request.id);
    if (request.agentId === 'agent-b') {
      // req-b resolves BEFORE req-a even though req-a arrived first —
      // proves the harness never forces one request to wait on another.
      return { behavior: 'allow' };
    }
    await new Promise((resolve) => setTimeout(resolve, 40));
    return { behavior: 'deny', message: 'not now' };
  });

  const turn = startTurn({ cwd: '.', prompt: 'hi', onApprovalRequest, onEvent: () => {}, spawnFn: () => child });

  writeLine(child, { type: 'control_request', request_id: 'req-a', request: { subtype: 'can_use_tool', tool_name: 'Bash', input: {}, agent_id: 'agent-a' } });
  writeLine(child, { type: 'control_request', request_id: 'req-b', request: { subtype: 'can_use_tool', tool_name: 'Read', input: {}, agent_id: 'agent-b' } });
  await new Promise((resolve) => setTimeout(resolve, 80));
  writeLine(child, RESULT_LINE);
  closeChild(child);

  await turn;

  const responses = child.stdinWrites.slice(1).map((w) => JSON.parse(w));
  const byId = Object.fromEntries(responses.map((r) => [r.response.request_id, r.response.response]));
  expect(byId['req-a']).toEqual({ behavior: 'deny', message: 'not now', interrupt: false });
  expect(byId['req-b']).toEqual({ behavior: 'allow', updatedInput: {}, toolUseID: null });
  expect(seenIds.sort()).toEqual(['req-a', 'req-b']);
});

test('ANSI escapes in decision_reason are stripped before the request reaches onApprovalRequest', async () => {
  const child = makeControllableChild();
  let seenReason;
  const onApprovalRequest = vi.fn(async (request) => {
    seenReason = request.reason;
    return { behavior: 'deny', message: 'no' };
  });

  const turn = startTurn({ cwd: '.', prompt: 'hi', onApprovalRequest, onEvent: () => {}, spawnFn: () => child });

  // Built via String.fromCharCode rather than a literal escape sequence in
  // this source file, to keep an actual ESC (0x1b) control byte out of the
  // repo's own text.
  const esc = String.fromCharCode(27);
  const ansiReason = `${esc}[31mdanger${esc}[0m`;
  writeLine(child, {
    type: 'control_request',
    request_id: 'req-ansi',
    request: { subtype: 'can_use_tool', tool_name: 'Bash', input: {}, decision_reason: ansiReason, decision_reason_type: 'rule' },
  });
  await new Promise((resolve) => setTimeout(resolve, 20));
  writeLine(child, RESULT_LINE);
  closeChild(child);

  await turn;
  expect(seenReason).toBe('danger');
});

test('an unrecognized control_request subtype is ignored (not crashed on, not mis-mapped), recorded as a warning', async () => {
  const child = makeControllableChild();

  const turn = startTurn({ cwd: '.', prompt: 'hi', onEvent: () => {}, spawnFn: () => child });

  writeLine(child, { type: 'control_request', request_id: 'req-x', request: { subtype: 'some_future_thing' } });
  await new Promise((resolve) => setTimeout(resolve, 20));
  writeLine(child, RESULT_LINE);
  closeChild(child);

  const result = await turn;
  expect(result.stopReason).toBe('result');
  expect(result.warnings.some((w) => w.includes('some_future_thing'))).toBe(true);
});

test('the requested/resolved approval NormalizedEvents are emitted via onEvent, in order, around the decision', async () => {
  const child = makeControllableChild();
  const onApprovalRequest = vi.fn(async () => ({ behavior: 'allow' }));
  const events = [];

  const turn = startTurn({
    cwd: '.',
    prompt: 'hi',
    onApprovalRequest,
    onEvent: (e) => {
      if (e.type === 'approval') events.push(e);
    },
    spawnFn: () => child,
  });

  writeLine(child, { type: 'control_request', request_id: 'req-order', request: { subtype: 'can_use_tool', tool_name: 'Bash', input: {} } });
  await new Promise((resolve) => setTimeout(resolve, 20));
  writeLine(child, RESULT_LINE);
  closeChild(child);
  await turn;

  expect(events.map((e) => e.phase)).toEqual(['requested', 'resolved']);
  expect(events[1].behavior).toBe('allow');
  for (const event of events) expect(isNormalizedEvent(event)).toBe(true);
});

// --- fake.mjs scriptable approvals -------------------------------------------

test('createFakeHarness: a script {approval: ...} entry calls onApprovalRequest and records the exchange in approvalLog', async () => {
  const harness = createFakeHarness({
    script: [
      { type: 'init', sessionId: 'fake-sess', tools: ['Bash'], model: 'fake-model', permissionMode: 'default' },
      { approval: { toolName: 'Bash', input: { command: 'rm -rf /' } } },
      { type: 'result', sessionId: 'fake-sess', costUsd: 0.001, usage: {}, isError: false },
    ],
  });

  const onApprovalRequest = vi.fn(async (request) => {
    expect(request.toolName).toBe('Bash');
    return { behavior: 'deny', message: 'no way' };
  });

  const result = await harness.startTurn({ cwd: '.', prompt: 'hi', onEvent: () => {}, onApprovalRequest });

  expect(result.stopReason).toBe('result');
  expect(onApprovalRequest).toHaveBeenCalledTimes(1);
  expect(harness.approvalLog).toHaveLength(1);
  expect(harness.approvalLog[0].request).toMatchObject({ toolName: 'Bash', input: { command: 'rm -rf /' } });
  expect(harness.approvalLog[0].decision).toEqual({ behavior: 'deny', message: 'no way' });
});

test('createFakeHarness: a script approval without onApprovalRequest configured is logged as fail-closed deny', async () => {
  const harness = createFakeHarness({
    script: [{ approval: { toolName: 'Write', input: {} } }, { type: 'result', sessionId: 's1', costUsd: 0, usage: {}, isError: false }],
  });

  await harness.startTurn({ cwd: '.', prompt: 'hi', onEvent: () => {} });

  expect(harness.approvalLog).toHaveLength(1);
  expect(harness.approvalLog[0].decision).toEqual({ behavior: 'deny', message: 'no approval handler configured' });
});
