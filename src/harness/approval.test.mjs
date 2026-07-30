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

// Regression test for task-6a review Critical #1: measured against the real
// CLI, `claude -p --input-format stream-json` does NOT exit on its own once
// it has written `result` — it keeps waiting on stdin for more turns until
// EOF. The old code only ever called endStdin() from finish(), which itself
// was only ever reached from child.on('close') — a circular wait: we wait
// for 'close', the (real) CLI waits for stdin EOF, neither happens first.
// This fake child mirrors that exact real behavior: it deliberately never
// emits 'close' on its own, only in reaction to its OWN stdin.end() being
// called — so this test can only pass if the harness closes stdin as soon
// as it has SEEN the result event, not once the process later exits.
test('stdin is closed as soon as a result event arrives, not only once the process later closes (regression: hung stdin blocks the CLI from ever exiting)', async () => {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  let stdinEnded = false;
  child.stdin = {
    write: () => true,
    end: () => {
      stdinEnded = true;
      // A well-behaved CLI only exits once stdin reaches EOF — simulated
      // here as a reaction to end(), never fired independently.
      queueMicrotask(() => child.emit('close', 0));
    },
  };
  child.kill = () => {};

  const turn = startTurn({ cwd: '.', prompt: 'hi', onEvent: () => {}, spawnFn: () => child });

  writeLine(child, RESULT_LINE);
  // Deliberately NOT calling closeChild()/emitting 'close' ourselves here —
  // see this test's own doc comment above.

  const result = await turn;
  expect(stdinEnded).toBe(true);
  expect(result.stopReason).toBe('result');
});

// Regression test for task-6a review Important #6, re-verified against the
// task-2 four-clock model (src/harness/timeout.mjs): timeoutMs now overrides
// the ACTIVE-TOTAL clock's budget (the closest match to what "the turn
// timeout" meant pre-task-2), but the property under test is unchanged —
// the separate approval-specific auto-deny (the CALLER's job, see
// src/server/server.mjs's approvalTimeoutMs, default 10 minutes) is meant to
// be the thing that actually times out a slow human decision, not this
// clock. Without excluding approval-wait time, the turn's own (much
// shorter) active-total budget would kill the process out from under a user
// who is still deciding, long before the approval's own, intentionally more
// generous timeout ever gets a chance to fire.
test('a pending approval exempts the active-total clock — deciding longer than timeoutMs does not kill the turn', async () => {
  const child = makeControllableChild();
  const onApprovalRequest = vi.fn(async () => {
    await new Promise((resolve) => setTimeout(resolve, 150));
    return { behavior: 'allow' };
  });

  const turn = startTurn({ cwd: '.', prompt: 'hi', onApprovalRequest, onEvent: () => {}, timeoutMs: 50, spawnFn: () => child });

  writeLine(child, { type: 'control_request', request_id: 'req-pause', request: { subtype: 'can_use_tool', tool_name: 'Bash', input: {} } });
  // Long enough to exceed timeoutMs (50ms) while the approval is still pending.
  await new Promise((resolve) => setTimeout(resolve, 200));
  writeLine(child, RESULT_LINE);
  closeChild(child);

  const result = await turn;
  expect(result.stopReason).toBe('result'); // NOT 'timeout'
  expect(child.killed).toBeFalsy();
});

test('the active-total clock keeps running once the last pending approval resolves — a turn that idles too long AFTER deciding still times out', async () => {
  const child = makeControllableChild();
  const onApprovalRequest = vi.fn(async () => ({ behavior: 'allow' }));

  const turn = startTurn({ cwd: '.', prompt: 'hi', onApprovalRequest, onEvent: () => {}, timeoutMs: 60, spawnFn: () => child });

  writeLine(child, { type: 'control_request', request_id: 'req-resume', request: { subtype: 'can_use_tool', tool_name: 'Bash', input: {} } });
  // Let the (near-instant) decision resolve and the approval-wait exemption
  // end, then idle well past timeoutMs WITHOUT ever sending a result — the
  // clock must still be able to fire once the exemption is over.
  await new Promise((resolve) => setTimeout(resolve, 200));

  const result = await turn;
  expect(result.stopReason).toBe('timeout');
  expect(result.timeoutClock).toBe('active-total');
}, 5000);

// This test's OLD property (a never-paused absolute backstop still kills a
// turn stuck on an approval that never resolves, per task-6a's Codex review)
// no longer holds under task-2's four-clock model, and deliberately so: see
// timeout.mjs's createTurnClocks() doc comment and task-2-report.md's
// Bedenken. All four clocks — including 'absolute' — now exclude
// approval-wait time, because task-3's overnight approval inbox needs a
// turn parked on a human decision to survive indefinitely; a backstop that
// still counted that wait would defeat it. What now bounds an approval that
// truly never gets answered is the CALLER's own approval timeout
// (src/server/server.mjs's DEFAULT_APPROVAL_TIMEOUT_MS, which resolves
// onApprovalRequest with an auto-deny), not a clock in this harness — so
// this test now proves the opposite of what it used to: neither clock
// fires while the approval is indefinitely pending, no matter how far past
// both of their (here deliberately tiny) budgets real time moves.
test('an indefinitely pending approval (never resolves) exempts BOTH the active-total and the absolute clock — only the caller\'s own approval timeout can end it', async () => {
  const child = makeControllableChild();
  // Never resolves — under the old model only absoluteTimeoutMs could end
  // this turn; under the new model NEITHER clock can, see this test's own
  // doc comment above.
  const onApprovalRequest = vi.fn(() => new Promise(() => {}));

  const turn = startTurn({
    cwd: '.',
    prompt: 'hi',
    onApprovalRequest,
    onEvent: () => {},
    timeoutMs: 50,
    absoluteTimeoutMs: 50,
    spawnFn: () => child,
  });

  writeLine(child, { type: 'control_request', request_id: 'req-wall-clock', request: { subtype: 'can_use_tool', tool_name: 'Bash', input: {} } });
  // Far past both (deliberately tiny) budgets, while the approval is still
  // pending — neither clock may have fired by the time the turn's own
  // result arrives.
  await new Promise((resolve) => setTimeout(resolve, 300));
  writeLine(child, RESULT_LINE);
  closeChild(child);

  const result = await turn;
  expect(result.stopReason).toBe('result'); // NOT 'timeout'
  expect(child.killed).toBeFalsy();
}, 5000);

// Regression test for task-6a review Important #5: `pendingApprovals` was
// written to but never read — a repeated control_request line for the SAME
// request_id (a duplicated stdout line, or a misbehaving CLI) would be
// processed twice, producing two control_response writes and, downstream,
// two approval prompts for the exact same request.
test('a duplicate control_request for the same request_id is answered only once', async () => {
  const child = makeControllableChild();
  const onApprovalRequest = vi.fn(async () => ({ behavior: 'allow' }));

  const turn = startTurn({ cwd: '.', prompt: 'hi', onApprovalRequest, onEvent: () => {}, spawnFn: () => child });

  const line = { type: 'control_request', request_id: 'req-dup', request: { subtype: 'can_use_tool', tool_name: 'Bash', input: {} } };
  writeLine(child, line);
  writeLine(child, line); // exact duplicate, same tick
  await new Promise((resolve) => setTimeout(resolve, 20));
  writeLine(child, RESULT_LINE);
  closeChild(child);

  await turn;

  expect(onApprovalRequest).toHaveBeenCalledTimes(1);
  const responses = child.stdinWrites.slice(1).map((w) => JSON.parse(w));
  expect(responses).toHaveLength(1);
});

// Regression test for task-6a review Minor (a): an oversized control_request
// (over MAX_LINE_BYTES) is dropped by the size guard before it is ever
// parsed — without an explicit fallback, the CLI is left waiting on a
// control_response that will never arrive, blocking the whole turn until
// timeoutMs. A short PREFIX of the line is still enough to recognize the
// shape and recover the request_id without ever JSON.parse'ing the full
// oversized payload.
test('an oversized can_use_tool control_request is answered with a fail-closed deny instead of leaving the CLI hanging', async () => {
  const child = makeControllableChild();
  const requestId = 'req-huge';
  const hugeInput = 'x'.repeat(9 * 1024 * 1024);
  const hugeLine = JSON.stringify({
    type: 'control_request',
    request_id: requestId,
    request: { subtype: 'can_use_tool', tool_name: 'Write', input: { content: hugeInput } },
  });

  const turn = startTurn({ cwd: '.', prompt: 'hi', onEvent: () => {}, spawnFn: () => child });

  child.stdout.write(`${hugeLine}\n`);
  await new Promise((resolve) => setTimeout(resolve, 20));
  writeLine(child, RESULT_LINE);
  closeChild(child);

  const result = await turn;
  expect(result.droppedLines).toBe(1);
  expect(result.stopReason).toBe('result');
  const responses = child.stdinWrites.slice(1).map((w) => JSON.parse(w));
  expect(responses).toEqual([
    { type: 'control_response', response: { subtype: 'success', request_id: requestId, response: { behavior: 'deny', message: 'request too large to process', interrupt: false } } },
  ]);
});

// Regression test for task-6a review Minor (b): answering with a missing/
// invalid request_id is worse than not answering — the CLI could never
// match such a response back to its own request anyway, so this must be a
// no-op (recorded as a warning), not a response with request_id:undefined.
test('a can_use_tool control_request with no request_id is ignored (recorded as a warning), never answered', async () => {
  const child = makeControllableChild();
  const onApprovalRequest = vi.fn(async () => ({ behavior: 'allow' }));

  const turn = startTurn({ cwd: '.', prompt: 'hi', onApprovalRequest, onEvent: () => {}, spawnFn: () => child });

  writeLine(child, { type: 'control_request', request: { subtype: 'can_use_tool', tool_name: 'Bash', input: {} } }); // no request_id at all
  await new Promise((resolve) => setTimeout(resolve, 20));
  writeLine(child, RESULT_LINE);
  closeChild(child);

  const result = await turn;
  expect(onApprovalRequest).not.toHaveBeenCalled();
  expect(child.stdinWrites).toHaveLength(1); // only the prompt line — no control_response at all
  expect(result.warnings.some((w) => w.includes('request_id'))).toBe(true);
});

// Regression test for task-6a review Minor (d): the argv positive case
// (both flags present together, WITH a handler configured) was previously
// only proven by omission — every existing argv test never passed
// onApprovalRequest/settingsPath, so their absence proved nothing about
// their presence when actually configured.
test('argv: --permission-prompt-tool stdio and --settings <path> are both added when onApprovalRequest/settingsPath are given', async () => {
  let capturedArgs;
  const child = makeControllableChild();
  const turn = startTurn({
    cwd: '.',
    prompt: 'hi',
    onApprovalRequest: async () => ({ behavior: 'deny', message: 'n/a' }),
    settingsPath: 'C:\\Users\\testuser\\.kaprek\\harness\\settings.json',
    onEvent: () => {},
    spawnFn: (command, args) => {
      capturedArgs = args;
      return child;
    },
  });

  writeLine(child, RESULT_LINE);
  closeChild(child);
  await turn;

  expect(capturedArgs).toContain('--permission-prompt-tool');
  expect(capturedArgs[capturedArgs.indexOf('--permission-prompt-tool') + 1]).toBe('stdio');
  expect(capturedArgs).toContain('--settings');
  expect(capturedArgs[capturedArgs.indexOf('--settings') + 1]).toBe('C:\\Users\\testuser\\.kaprek\\harness\\settings.json');
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
  // The actual non-serialization proof: req-b's control_response is WRITTEN
  // before req-a's, even though req-a's control_request line arrived first
  // — req-a's slower (40ms) decision never blocked req-b's faster one from
  // going out. Correlation alone (both eventually answered) would also pass
  // if the two were fully serialized behind one another; only the write
  // ORDER distinguishes the two.
  expect(responses.map((r) => r.response.request_id)).toEqual(['req-b', 'req-a']);
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
