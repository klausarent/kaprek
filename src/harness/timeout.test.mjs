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

// Peer-review note (see task-2-report.md's Bedenken): with the brief's own
// default constants (ACTIVE_TOTAL_MS=35min < ABSOLUTE_MS=60min), and both
// clocks measuring the exact same "elapsed active time" quantity,
// active-total always fires first — the absolute clock only becomes
// reachable when a caller raises/disables active-total relative to it, as
// this test does explicitly.
test('createTurnClocks: with active-total disabled, the absolute clock is independently reachable', () => {
  const t = fakeClock();
  const c = createTurnClocks({ idleMs: 1000, toolLeaseMs: 10_000, activeTotalMs: 0, absoluteMs: 5000, nowFn: t.now });
  for (let i = 0; i < 12; i += 1) { c.onProgress('assistant-message'); t.advance(500); }
  expect(c.check()).toMatchObject({ clock: 'absolute' });
});

test('createTurnClocks: a non-finite or non-positive budget disables that clock entirely', () => {
  const t = fakeClock();
  const c = createTurnClocks({ idleMs: 0, toolLeaseMs: Infinity, activeTotalMs: -1, absoluteMs: Number.NaN, nowFn: t.now });
  c.onProgress('assistant-message');
  t.advance(10 * 365 * 24 * 60 * 60_000); // 10 years — still nothing should ever fire
  expect(c.check()).toBeNull();
});
