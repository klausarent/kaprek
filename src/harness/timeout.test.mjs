// Tests for timeout.mjs's pure clock logic — no real waiting anywhere in
// this file, everything runs through fakeClock() so the whole suite stays
// fast regardless of how large idleMs/toolLeaseMs/activeTotalMs/absoluteMs
// are. Complements claude-code.test.mjs/approval.test.mjs, which cover how
// claude-code.mjs actually WIRES these clocks to process events and an
// interval — this file is only about the clock math itself.
import { test, expect } from 'vitest';
import { createTurnClocks, IDLE_MS, TOOL_LEASE_MS, ACTIVE_TOTAL_MS, ABSOLUTE_MS } from './timeout.mjs';

/** A controllable time source: advance(ms) moves it forward, now() reads the current value. Starts at an arbitrary non-zero offset to catch any code that (wrongly) assumes t=0 at the epoch. */
function fakeClock(start = 1_000_000) {
  let now = start;
  return { now: () => now, advance: (ms) => { now += ms; } };
}

test('createTurnClocks: exported budgets match the brief\'s exact values', () => {
  expect(IDLE_MS).toBe(120_000);
  expect(TOOL_LEASE_MS).toBe(25 * 60_000);
  expect(ACTIVE_TOTAL_MS).toBe(35 * 60_000);
  expect(ABSOLUTE_MS).toBe(60 * 60_000);
});

test('createTurnClocks: an open tool lease survives past idleMs without any further events', () => {
  const t = fakeClock();
  const c = createTurnClocks({ idleMs: 1000, toolLeaseMs: 10_000, activeTotalMs: 60_000, absoluteMs: 120_000, nowFn: t.now });
  c.onProgress('tool-start');
  t.advance(5000);
  expect(c.check()).toBeNull();
  t.advance(6000);
  expect(c.check()).toMatchObject({ clock: 'tool-lease' });
});

test('createTurnClocks: with no tool open, silence past idleMs stops the turn', () => {
  const t = fakeClock();
  const c = createTurnClocks({ idleMs: 1000, toolLeaseMs: 10_000, activeTotalMs: 60_000, absoluteMs: 120_000, nowFn: t.now });
  c.onProgress('assistant-message');
  t.advance(1500);
  expect(c.check()).toMatchObject({ clock: 'idle' });
});

test('createTurnClocks: a chatty stream still dies at activeTotalMs', () => {
  const t = fakeClock();
  const c = createTurnClocks({ idleMs: 1000, toolLeaseMs: 10_000, activeTotalMs: 5000, absoluteMs: 120_000, nowFn: t.now });
  for (let i = 0; i < 20; i += 1) { c.onProgress('assistant-message'); t.advance(400); }
  expect(c.check()).toMatchObject({ clock: 'active-total' });
});

test('createTurnClocks: approval wait counts against neither idle nor active-total', () => {
  const t = fakeClock();
  const c = createTurnClocks({ idleMs: 1000, toolLeaseMs: 10_000, activeTotalMs: 5000, absoluteMs: 120_000, nowFn: t.now });
  c.onProgress('assistant-message');
  c.onApprovalStart();
  t.advance(60_000);
  c.onApprovalEnd();
  expect(c.check()).toBeNull();
});

// Task-2 brief step 5: a tool-lease that is open WHILE an approval is
// pending (e.g. a second, concurrent tool call from another subagent needs a
// human decision while the first tool call keeps running) must not expire
// due to the approval wait — only its own, non-paused running time counts.
test('createTurnClocks: an open tool lease does not expire due to approval wait time, only its own running time', () => {
  const t = fakeClock();
  const c = createTurnClocks({ idleMs: 1000, toolLeaseMs: 5000, activeTotalMs: 60_000, absoluteMs: 120_000, nowFn: t.now });
  c.onProgress('tool-start');
  t.advance(1000); // 1000ms of real lease time so far
  c.onApprovalStart();
  t.advance(20_000); // far past toolLeaseMs if this counted against the lease
  c.onApprovalEnd();
  expect(c.check()).toBeNull(); // still only 1000ms of non-paused lease time
  t.advance(4001); // pushes the lease's OWN elapsed time (1000 + 4001) past toolLeaseMs
  expect(c.check()).toMatchObject({ clock: 'tool-lease' });
});

// Two tool calls open at once (parallel tool_use blocks / concurrent
// subagents — see claude-code.mjs's own can_use_tool handling) — the
// interface's onProgress(kind) carries no id, so tool-lease is tracked as an
// open-lease COUNT: the window must stay open until every open tool has
// ended, not just the first one to finish.
test('createTurnClocks: two overlapping tool calls keep the lease open until BOTH have ended', () => {
  const t = fakeClock();
  const c = createTurnClocks({ idleMs: 1000, toolLeaseMs: 5000, activeTotalMs: 60_000, absoluteMs: 120_000, nowFn: t.now });
  c.onProgress('tool-start'); // tool A opens the lease window
  t.advance(2000);
  c.onProgress('tool-start'); // tool B opens while A is still running — window does NOT restart
  t.advance(2000);
  c.onProgress('tool-end'); // A finishes — B is still open, lease must stay open
  expect(c.check()).toBeNull(); // 4000ms elapsed since the window opened, under 5000ms
  t.advance(1001); // 5001ms since the window opened (still measured from A's tool-start)
  expect(c.check()).toMatchObject({ clock: 'tool-lease' });
});

// Fix-round (task-2 panel review): the first version of this module exempted
// approval-wait time from ALL FOUR clocks, which made `absolute` degenerate
// into a second, strictly-larger threshold on the exact same quantity
// `active-total` already measures — under the brief's own default constants
// (ACTIVE_TOTAL_MS=35min < ABSOLUTE_MS=60min), active-total would ALWAYS fire
// first and `absolute` could never fire at all. `absolute` is now a RAW wall
// clock instead (see ABSOLUTE_MS's own doc comment) — this test proves it
// fires entirely on its own, with active-total disabled, independent of
// approval activity.
test('createTurnClocks: with active-total disabled, the absolute clock is independently reachable', () => {
  const t = fakeClock();
  const c = createTurnClocks({ idleMs: 1000, toolLeaseMs: 10_000, activeTotalMs: 0, absoluteMs: 5000, nowFn: t.now });
  for (let i = 0; i < 12; i += 1) { c.onProgress('assistant-message'); t.advance(500); }
  expect(c.check()).toMatchObject({ clock: 'absolute' });
});

// The actual reason `absolute` exists (see ABSOLUTE_MS's doc comment): a
// backstop against a CHAIN of approval round-trips. The caller's own
// approval timeout (e.g. src/server/server.mjs's DEFAULT_APPROVAL_TIMEOUT_MS)
// only ever auto-denies ONE pending request — nothing stops the agent from
// immediately asking again, and a long enough chain of such round-trips
// would keep idle/tool-lease/active-total paused for nearly the entire
// wall-clock duration without ever tripping any of them. `absolute` alone
// keeps ticking through approval waits, so it is the one clock that can
// still end a turn stuck in such a chain.
test('createTurnClocks: approval-wait time counts fully against the absolute clock, even though it counts against none of the other three', () => {
  const t = fakeClock();
  const c = createTurnClocks({ idleMs: 1000, toolLeaseMs: 10_000, activeTotalMs: 60_000, absoluteMs: 5000, nowFn: t.now });
  c.onProgress('assistant-message');
  c.onApprovalStart();
  t.advance(5001); // entirely inside one long-running approval wait, past absoluteMs
  expect(c.check()).toMatchObject({ clock: 'absolute' });
  // Not a fluke of ordering: idle/tool-lease/active-total genuinely never
  // fire here — the entire elapsed time was approval-wait, which they all
  // exclude in full (see the 'approval wait counts against neither idle nor
  // active-total' test above).
});

// Panel review Fix-Runde 2, important (finding: "the core absolute scenario
// has no test anywhere"): the test above only ever exercises a single OPEN
// wait, where banked pausedMs is still 0 — a mutant computing
// `rawElapsed = now - startedAt - pausedMs` (exempting only CLOSED waits,
// still counting the currently-open one) passes it undetected. That mutant
// is a partial reintroduction of the exact pre-fix-round-1 defect, for the
// case ABSOLUTE_MS's own doc comment names as the actual reason the clock
// exists: a CHAIN of individually auto-denied (i.e. CLOSED) approval waits.
test('createTurnClocks: a chain of individually closed approval waits still dies at absoluteMs, even though each wait on its own is fully exempt', () => {
  const t = fakeClock();
  const c = createTurnClocks({ idleMs: 1000, toolLeaseMs: 10_000, activeTotalMs: 60_000, absoluteMs: 5000, nowFn: t.now });
  for (let i = 0; i < 6; i += 1) {
    c.onProgress('assistant-message');
    c.onApprovalStart();
    t.advance(900);
    c.onApprovalEnd();
  }
  // raw elapsed = 6*900 = 5400ms >= absoluteMs(5000); active-total and idle
  // both stay at 0 (every ms of it was banked, closed approval-wait time).
  expect(c.check()).toMatchObject({ clock: 'absolute' });
});

// Panel review Fix-Runde 2, important (finding: active-total/tool-lease
// exemption during a STILL-OPEN wait was untested at every level — every
// existing test closes the wait via onApprovalEnd() before the decisive
// check(), or only advances a short distance inside an open one). Mutant:
// activeElapsed = now - startedAt - pausedMs (i.e. honoring only banked/
// closed waits, ticking through the CURRENTLY open one) passes every
// existing scenario; this is the distinguishing sequence.
test('createTurnClocks: active-total stays exempt for the ENTIRE duration of a single still-open approval wait, however long', () => {
  const t = fakeClock();
  const c = createTurnClocks({ idleMs: 1000, toolLeaseMs: 10_000, activeTotalMs: 5000, absoluteMs: 120_000, nowFn: t.now });
  c.onProgress('assistant-message');
  c.onApprovalStart();
  t.advance(6000); // past activeTotalMs, entirely inside the still-open wait
  expect(c.check()).toBeNull();
});

// Same finding, tool-lease side: leaseElapsed = now - toolLeaseStartedAt -
// (pausedMs - pausedAtLeaseStart) with pausedMs (total, including the open
// wait) instead of the banked-only amount would also pass every existing
// scenario without this one.
test('createTurnClocks: tool-lease stays exempt for the ENTIRE duration of a single still-open approval wait, however long', () => {
  const t = fakeClock();
  const c = createTurnClocks({ idleMs: 1000, toolLeaseMs: 5000, activeTotalMs: 60_000, absoluteMs: 120_000, nowFn: t.now });
  c.onProgress('tool-start');
  c.onApprovalStart();
  t.advance(6000); // past toolLeaseMs, entirely inside the still-open wait
  expect(c.check()).toBeNull();
});

// Panel review Fix-Runde 2, minor (finding: the per-clock pause SNAPSHOT —
// pausedAtLastProgress/pausedAtLeaseStart, subtracting only the pause time
// since the clock's OWN reference point rather than the turn's total pause
// to date — is unobservable by the suite). Every existing test has all
// pause time occur AFTER the reference point, so snapshot and total pause
// are numerically identical; a mutant subtracting the TOTAL instead of the
// since-reference-point delta survives unnoticed. Distinguishing sequence:
// the wait happens and CLOSES, THEN the reference point is set.
test('createTurnClocks: idle only counts silence since its OWN last-progress reference point, not the turn\'s total approval-wait history', () => {
  const t = fakeClock();
  const c = createTurnClocks({ idleMs: 1000, toolLeaseMs: 10_000, activeTotalMs: 60_000, absoluteMs: 120_000, nowFn: t.now });
  c.onApprovalStart();
  t.advance(60_000); // a long wait that closes BEFORE any progress resets idle's own reference point
  c.onApprovalEnd();
  c.onProgress('assistant-message');
  t.advance(1500); // plain post-wait silence, well past idleMs on its own
  expect(c.check()).toMatchObject({ clock: 'idle' });
});

// Same finding, tool-lease side.
test('createTurnClocks: tool-lease only counts running time since its OWN open-lease reference point, not the turn\'s total approval-wait history', () => {
  const t = fakeClock();
  const c = createTurnClocks({ idleMs: 1000, toolLeaseMs: 5000, activeTotalMs: 60_000, absoluteMs: 120_000, nowFn: t.now });
  c.onApprovalStart();
  t.advance(60_000); // a long wait that closes BEFORE the tool-lease even opens
  c.onApprovalEnd();
  c.onProgress('tool-start');
  t.advance(5001); // plain post-wait running time, past toolLeaseMs on its own
  expect(c.check()).toMatchObject({ clock: 'tool-lease' });
});

test('createTurnClocks: a non-finite or non-positive budget disables that clock entirely', () => {
  const t = fakeClock();
  const c = createTurnClocks({ idleMs: 0, toolLeaseMs: Infinity, activeTotalMs: -1, absoluteMs: Number.NaN, nowFn: t.now });
  c.onProgress('assistant-message');
  t.advance(10 * 365 * 24 * 60 * 60_000); // 10 years — still nothing should ever fire
  expect(c.check()).toBeNull();
});
