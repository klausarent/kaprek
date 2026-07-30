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
//
// Panel review Fix-Runde 2, CRITICAL (testcausality): the ORIGINAL version
// of this test (result written at t=200ms, after a 150ms decision) passed
// even with clocks.onApprovalStart()/onApprovalEnd() deleted entirely from
// claude-code.mjs — the over-budget window (t=50..200ms) never contained a
// single check(): the control_request line returns before the per-event
// evaluateClocks() call, the result event's own evaluateClocks() is
// suppressed by the sawResult guard, and the first clockPollTimer tick
// (250ms) lands AFTER the turn already resolved at ~200ms. What the old test
// actually pinned was the sawResult race guard, not the exemption its title
// claimed. Fixed by making the approval span at least one 250ms poll tick
// WHILE STILL PENDING, using a synchronization promise (not a fixed sleep)
// so the result line is written the instant the decision is made, not after
// an independently-timed outer wait that could itself race the poll.
test('a pending approval exempts the active-total clock — deciding across a poll tick does not kill the turn', async () => {
  const child = makeControllableChild();
  let approvalDecided;
  const approvalDecidedPromise = new Promise((resolve) => { approvalDecided = resolve; });
  const onApprovalRequest = vi.fn(async () => {
    await new Promise((resolve) => setTimeout(resolve, 400)); // spans at least one CLOCK_POLL_INTERVAL_MS (250ms) tick while still pending
    approvalDecided();
    return { behavior: 'allow' };
  });

  const turn = startTurn({ cwd: '.', prompt: 'hi', onApprovalRequest, onEvent: () => {}, timeoutMs: 100, spawnFn: () => child });

  writeLine(child, { type: 'control_request', request_id: 'req-pause', request: { subtype: 'can_use_tool', tool_name: 'Bash', input: {} } });
  await approvalDecidedPromise; // the moment the decision is made, not a separately-timed guess at when it might be
  writeLine(child, RESULT_LINE);
  closeChild(child);

  const result = await turn;
  expect(result.stopReason).toBe('result'); // NOT 'timeout'
  // Panel review Fix-Runde 3, minor (corrects this comment's own prior,
  // factually wrong claim): a no-op-exemption mutant does NOT die at the
  // stopReason assertion above — the close handler's own mirror-race fix
  // (claude-code.mjs, see its doc comment) resolves a turn that already saw
  // a 'result' event as 'result' even if a clock fired and killed the child
  // first, so `stopReason` alone stays 'result' either way. It dies HERE:
  // under the mutant, the poll at t=250ms (activeElapsed>=100ms) requests a
  // kill and sets `child.killed = true`; with the exemption in place, no
  // kill is ever requested at all.
  expect(child.killed).toBeFalsy();
}, 5000);

// Companion to the test above (same panel finding, its own fixHint): proves
// the previous test is actually about the approval exemption, not about
// approvals suppressing checks in general — the identical wait WITHOUT a
// pending approval must still time out via active-total at the first poll
// tick.
test('the same wait WITHOUT a pending approval times out via active-total', async () => {
  const child = makeControllableChild();

  const turn = startTurn({ cwd: '.', prompt: 'hi', onEvent: () => {}, timeoutMs: 100, spawnFn: () => child });

  const result = await turn;
  expect(result.stopReason).toBe('timeout');
  expect(result.timeoutClock).toBe('active-total');
}, 5000);

// Panel review Fix-Runde 2, CRITICAL (testcausality) companion scenario: the
// wiring-level exemption was only ever proven for active-total, never for
// tool-lease — a SECOND, concurrent approval (e.g. a subagent's own tool
// call) pending while a FIRST tool is still genuinely running must not let
// that first tool's lease expire either, at the actual claude-code.mjs
// wiring level (not just timeout.mjs's own unit tests, see there for the
// pure-logic equivalent).
test('a pending approval exempts the tool-lease clock too — an open tool call survives an approval spanning a poll tick', async () => {
  const child = makeControllableChild();
  let approvalDecided;
  const approvalDecidedPromise = new Promise((resolve) => { approvalDecided = resolve; });
  const onApprovalRequest = vi.fn(async () => {
    await new Promise((resolve) => setTimeout(resolve, 400)); // spans at least one poll tick while still pending
    approvalDecided();
    return { behavior: 'allow' };
  });

  const turn = startTurn({ cwd: '.', prompt: 'hi', onApprovalRequest, onEvent: () => {}, toolLeaseMs: 100, spawnFn: () => child });

  // A tool is already running (ITS lease is what's under test)...
  writeLine(child, { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'toolu_lease', name: 'Bash', input: {} }] } });
  // ...while a SECOND, concurrent tool call needs a human decision.
  writeLine(child, { type: 'control_request', request_id: 'req-concurrent', request: { subtype: 'can_use_tool', tool_name: 'Read', input: {} } });
  await approvalDecidedPromise;
  writeLine(child, { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_lease', content: 'done' }] } });
  writeLine(child, RESULT_LINE);
  closeChild(child);

  const result = await turn;
  expect(result.stopReason).toBe('result'); // NOT 'timeout'/'tool-lease'
  // Panel review Fix-Runde 3, important: the stopReason assertion alone is
  // a tautology — under a mutant with clocks.onApprovalStart()/onApprovalEnd()
  // removed, tool-lease still fires at the 250ms poll and requests a kill,
  // but the close handler's own mirror-race fix resolves the turn as
  // 'result' anyway once the later result/close arrive, masking the kill.
  // This is the actual causal signal.
  expect(child.killed).toBeFalsy();
}, 5000);

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

// Fix-round (task-2 panel review, after this test was first rewritten to
// prove the opposite — see task-2-report.md's Fix-Runde): exempting
// approval-wait time from ALL FOUR clocks made 'absolute' unable to ever
// fire on its own (it degenerated into a second, always-later threshold on
// the exact same quantity 'active-total' already measures), which silently
// defeated the actual reason 'absolute' exists — see timeout.mjs's
// ABSOLUTE_MS doc comment: a backstop against a CHAIN of individually
// auto-denied approval round-trips, not against a single pending one.
// 'absolute' is now the ONE clock NOT exempted — a raw, never-paused wall
// clock — so this test's ORIGINAL property (task-6a's Codex review) is
// restored: it still kills a turn stuck on an approval that never resolves
// at all, even though 'active-total' (correctly, still approval-exempt)
// would stay paused forever and never fire on its own.
test('the absolute wall-clock cap fires even while an approval is indefinitely pending (never resolves), killing the turn regardless of the exempted active-total clock', async () => {
  const child = makeControllableChild();
  // Never resolves — active-total (approval-exempt) would stay paused
  // forever; only the raw wall-clock absolute clock can end this turn.
  const onApprovalRequest = vi.fn(() => new Promise(() => {}));

  const turn = startTurn({
    cwd: '.',
    prompt: 'hi',
    onApprovalRequest,
    onEvent: () => {},
    timeoutMs: 60_000, // large enough, and approval-exempt anyway, to prove it is NOT what fires here
    absoluteTimeoutMs: 50,
    killGraceMs: 30, // this fake child never emits 'close' on its own — no need to wait out the real default here
    spawnFn: () => child,
  });

  writeLine(child, { type: 'control_request', request_id: 'req-wall-clock', request: { subtype: 'can_use_tool', tool_name: 'Bash', input: {} } });

  const result = await turn;
  expect(result.stopReason).toBe('timeout');
  expect(result.timeoutClock).toBe('absolute');
  expect(child.killed).toBe(true);
}, 5000);

// --- Panel review Fix-Runde 2 regression tests -------------------------------

// CRITICAL: the sawResult guard in evaluateClocks() (see its own doc
// comment) fixes a real spurious-timeout race, but on its own trades a
// BOUNDED race for an UNBOUNDED hang if 'close' never arrives at all after
// 'result' — e.g. the CLI's own exit is fine, but a background process it
// started as a side effect (a dev server left running) inherited its
// stdout/stderr pipe, and Node only fires 'close' once EVERY inherited
// stdio stream also closes. Reproduced live against this harness before the
// fix (see task-2-report.md's Fix-Runde 2). This fake child models exactly
// that: it never reacts to stdin.end() and never emits 'close' or 'exit' on
// its own, unlike makeControllableChild()'s stub.
test('a result line with no close event ever (hung grandchild inheriting stdio) still resolves as result within a bounded grace period, not hung and not timed out', async () => {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.stdin = { write: () => true, end: () => {} }; // deliberately never reacts, no 'close'/'exit' ever
  child.kill = vi.fn();

  const turn = startTurn({ cwd: '.', prompt: 'hi', onEvent: () => {}, killGraceMs: 30, spawnFn: () => child });

  writeLine(child, RESULT_LINE);

  const result = await turn;
  expect(result.stopReason).toBe('result');
  expect(result.orphaned).toBe(true);
  expect(child.kill).toHaveBeenCalled();
}, 5000);

// IMPORTANT: brief step 9 required the stop reason to NAME the clock that
// fired, not just say 'timeout' — before this fix, no NormalizedEvent ever
// carried it (only TurnResult.timeoutClock did, which no production
// consumer downstream of the harness ever read, see task-2-report.md's
// Fix-Runde 2). requestKill() now emits a normalized 'error' event naming
// the clock, BEFORE the child is killed.
test('a clock-triggered timeout emits an error event naming which clock fired, before the child is killed', async () => {
  const child = makeControllableChild();
  const events = [];

  const turn = startTurn({ cwd: '.', prompt: 'hi', onEvent: (e) => events.push(e), timeoutMs: 50, killGraceMs: 30, spawnFn: () => child });

  const result = await turn;
  expect(result.stopReason).toBe('timeout');
  expect(result.timeoutClock).toBe('active-total');
  expect(events).toContainEqual({ type: 'error', message: 'turn timed out (active-total clock)' });
}, 5000);

// MINOR: a poll-tick requestKill() can race a result line the readline
// interface already delivered but this handler has not run for yet
// (killReason gets set, resolved stays false until 'close') — the line
// handler still processes that buffered line in full (sawResult=true, a
// normal 'result' event already emitted) before 'close' arrives. Resolving
// as 'timeout' in that case would contradict the result event a consumer
// already received.
test("a timeout kill racing a result line already read from the pipe resolves as 'result', not a spurious 'timeout'", async () => {
  const child = makeControllableChild();

  const turn = startTurn({ cwd: '.', prompt: 'hi', onEvent: () => {}, timeoutMs: 10, spawnFn: () => child });

  // Let the clockPollTimer fire requestKill('timeout', 'active-total')
  // BEFORE the result line is even written — the exact race this test targets.
  await new Promise((resolve) => setTimeout(resolve, 260)); // > CLOCK_POLL_INTERVAL_MS
  writeLine(child, RESULT_LINE);
  await new Promise((resolve) => setTimeout(resolve, 20)); // let the line handler process it before 'close'
  closeChild(child);

  const result = await turn;
  expect(result.stopReason).toBe('result');
  expect(result.timeoutClock).toBeUndefined();
  expect(child.killed).toBe(true); // the timeout kill still happened — it just didn't win the stopReason
});

// MINOR: an orphaned/duplicate tool_result (no matching open tool-start —
// same failure class the pendingApprovals dedup above already guards
// against for control_requests, just on the tool_result side) must not be
// mistaken for closing a DIFFERENT, still genuinely-running tool's own
// lease. idleMs is deliberately tiny here: under the old id-agnostic
// counting, the orphaned tool-end alone closed the lease and handed the
// turn to idle, which then killed it well within this test's own window.
test('an orphaned/duplicate tool-end (no matching open tool-start) does not close a different, still-genuinely-running tool\'s lease', async () => {
  const child = makeControllableChild();

  const turn = startTurn({ cwd: '.', prompt: 'hi', onEvent: () => {}, idleMs: 100, toolLeaseMs: 10_000, spawnFn: () => child });

  writeLine(child, { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'toolu_real', name: 'Bash', input: {} }] } });
  writeLine(child, { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_orphan', content: 'stray' }] } });
  await new Promise((resolve) => setTimeout(resolve, 300)); // > CLOCK_POLL_INTERVAL_MS and > idleMs, well under toolLeaseMs
  writeLine(child, { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_real', content: 'done' }] } });
  writeLine(child, RESULT_LINE);
  closeChild(child);

  const result = await turn;
  expect(result.stopReason).toBe('result'); // NOT 'timeout'
  // Panel review Fix-Runde 3, important: the stopReason assertion alone is
  // a tautology — under a mutant with the openToolUseIds id-gate removed
  // (id-agnostic counting, the exact pre-Fund-3-fix state), the orphaned
  // tool-end DOES prematurely close the lease, idle fires at the 250ms
  // poll and requests a kill, but the close handler's own mirror-race fix
  // resolves the turn as 'result' anyway once the later result/close
  // arrive, masking the kill. This is the actual causal signal.
  expect(child.killed).toBeFalsy();
}, 5000);

// IMPORTANT: an oversized (>MAX_LINE_BYTES) line desyncs the clocks' own
// bookkeeping exactly as much as an oversized can_use_tool request desyncs
// the approval channel (the existing test above this section) — the
// size-guard's compensation covers all four affected line shapes (a fifth
// test for the tool_use direction follows this block, see its own comment).
// Direction 1: a dropped tool_result must still close its own tool-lease —
// otherwise it stays open forever and eventually kills an actively-working
// turn. toolLeaseMs is deliberately tiny; if the lease leaks, tool-lease
// fires well within this test's own window regardless of activity.
test('a dropped (>8MB) tool_result line still closes its tool-lease via the size-guard\'s compensation, not left open forever', async () => {
  const child = makeControllableChild();
  const hugeContent = 'x'.repeat(9 * 1024 * 1024);
  const hugeLine = JSON.stringify({
    type: 'user',
    message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_big', content: hugeContent }] },
  });

  const turn = startTurn({ cwd: '.', prompt: 'hi', onEvent: () => {}, toolLeaseMs: 200, spawnFn: () => child });

  writeLine(child, { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'toolu_big', name: 'Read', input: {} }] } });
  child.stdout.write(`${hugeLine}\n`);
  await new Promise((resolve) => setTimeout(resolve, 300)); // > CLOCK_POLL_INTERVAL_MS and > toolLeaseMs — only survives if the compensation actually closed the lease
  writeLine(child, RESULT_LINE);
  closeChild(child);

  const result = await turn;
  expect(result.droppedLines).toBe(1);
  expect(result.stopReason).toBe('result'); // NOT 'timeout'/'tool-lease'
  // Panel review Fix-Runde 3, important: the stopReason assertion alone is
  // a tautology — remove the drop-path's clock compensation entirely (its
  // pre-fix state) and the lease leaks, tool-lease fires at the 250ms poll
  // and requests a kill, but the close handler's own mirror-race fix
  // resolves the turn as 'result' anyway once the later result/close
  // arrive, masking the kill. This is the actual causal signal.
  expect(child.killed).toBeFalsy();
}, 5000);

// Direction 2: a dropped tool_use must still open its own lease — a
// still-genuinely-running tool must not be judged by idle instead of its
// own (25-minute) tool-lease just because its own opening line was too big
// to parse. idleMs is deliberately tiny and toolLeaseMs left at its huge
// default; if the lease never opens, idle fires well within this test's
// own window regardless of activity.
test('a dropped (>8MB) assistant/tool_use line still opens its own tool-lease — a real, still-running tool is not judged by idle', async () => {
  const child = makeControllableChild();
  const hugeInput = 'x'.repeat(9 * 1024 * 1024);
  const hugeLine = JSON.stringify({
    type: 'assistant',
    message: { content: [{ type: 'tool_use', id: 'toolu_dropped_start', name: 'Write', input: { content: hugeInput } }] },
  });

  const turn = startTurn({ cwd: '.', prompt: 'hi', onEvent: () => {}, idleMs: 100, toolLeaseMs: 10_000, spawnFn: () => child });

  child.stdout.write(`${hugeLine}\n`);
  await new Promise((resolve) => setTimeout(resolve, 300)); // > CLOCK_POLL_INTERVAL_MS and > idleMs, well under toolLeaseMs — only survives if the drop actually opened the lease
  writeLine(child, { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_dropped_start', content: 'done' }] } });
  writeLine(child, RESULT_LINE);
  closeChild(child);

  const result = await turn;
  expect(result.droppedLines).toBe(1);
  expect(result.stopReason).toBe('result'); // NOT 'timeout'/'idle'
  // Same masking risk as the sibling tests in this section — assert the
  // actual causal signal, not just the mirror-race-reachable stopReason.
  expect(child.killed).toBeFalsy();
}, 5000);

// Direction 3: a dropped line that is neither a tool_use nor a tool_result
// (here: an oversized plain-text assistant message) must still count as
// generic progress for idle — the (a) compensation the other two directions
// build on, isolated from lease-opening/closing so it is tested on its own.
test('a dropped (>8MB) assistant/text line (no tool_use) still counts as progress for idle', async () => {
  const child = makeControllableChild();
  const hugeText = 'x'.repeat(9 * 1024 * 1024);
  const hugeLine = JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: hugeText }] } });

  const turn = startTurn({ cwd: '.', prompt: 'hi', onEvent: () => {}, idleMs: 200, spawnFn: () => child });

  writeLine(child, { type: 'assistant', message: { content: [{ type: 'text', text: 'starting' }] } });
  await new Promise((resolve) => setTimeout(resolve, 220)); // already past idleMs since the LAST successfully mapped event
  child.stdout.write(`${hugeLine}\n`); // the drop itself must still count as progress, or the next poll (t~250) kills the turn on stale info
  await new Promise((resolve) => setTimeout(resolve, 100)); // > CLOCK_POLL_INTERVAL_MS since the drop, well under idleMs since the drop
  writeLine(child, RESULT_LINE);
  closeChild(child);

  const result = await turn;
  expect(result.droppedLines).toBe(1);
  expect(result.stopReason).toBe('result'); // NOT 'timeout'/'idle'
  expect(child.killed).toBeFalsy();
}, 5000);

// Direction 4 (nebenbefund gleicher Wurzel): a dropped result line must not
// let the turn end as a misleadingly generic 'timeout' — costUsd/usage are
// genuinely unrecoverable, but endStdin() still lets the CLI's own eventual
// exit resolve the turn normally.
test('a dropped (>8MB) result line still ends the turn via endStdin() and the normal close path, not via a misleading timeout', async () => {
  const child = makeControllableChild();
  const hugeResultText = 'x'.repeat(9 * 1024 * 1024);
  const hugeLine = JSON.stringify({ type: 'result', session_id: 's1', total_cost_usd: 0.01, usage: {}, is_error: false, result: hugeResultText });

  const turn = startTurn({ cwd: '.', prompt: 'hi', onEvent: () => {}, timeoutMs: 100, spawnFn: () => child });

  child.stdout.write(`${hugeLine}\n`);
  await new Promise((resolve) => setTimeout(resolve, 20));
  // Panel review Fix-Runde 3, minor: the stopReason/warnings assertions
  // below stay identical with or without the drop path's endStdin() call
  // (this test's own timing closes the child itself well before the first
  // poll could ever turn a missing sawResult into a 'timeout' anyway) — the
  // ONLY signal that the compensation's endStdin() branch actually ran is
  // this flag.
  expect(child.stdinEnded).toBe(true);
  closeChild(child);

  const result = await turn;
  expect(result.droppedLines).toBe(1);
  expect(result.stopReason).not.toBe('timeout'); // the drop itself must not be misclassified as a clock timeout
  expect(result.warnings.some((w) => w.includes('result'))).toBe(true);
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
