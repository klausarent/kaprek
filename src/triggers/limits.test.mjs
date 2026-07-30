// Tests for the trigger daily run/cost cap. Run: npx vitest run src/triggers/limits.test.mjs
import { test, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { appendRun } from '../orchestrator/runs.mjs';
import {
  checkLimits,
  checkGlobalTriggerLimits,
  UNKNOWN_COST_ESTIMATE_USD,
  MAX_TRIGGER_TURNS_PER_HOUR,
  MAX_TRIGGER_TURNS_PER_DAY,
} from './limits.mjs';

const TODAY_NOON = new Date(2026, 6, 30, 12, 0, 0).getTime(); // local time, matches startOfLocalDay()
const YESTERDAY_NOON = TODAY_NOON - 24 * 60 * 60 * 1000;

function trigger(overrides = {}) {
  return { id: 't1', limits: { maxRunsPerDay: 24, maxCostPerDay: 1.0 }, ...overrides };
}

let tmpDir;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kaprek-triggers-limits-test-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function runFor(triggerId, ts, overrides = {}) {
  appendRun(tmpDir, { ts: new Date(ts).toISOString(), triggerId, origin: 'trigger', costUsd: 0.01, ...overrides });
}

test('no runs yet: allowed with runsToday/costToday at 0', () => {
  const result = checkLimits({ dataDir: tmpDir, trigger: trigger(), now: TODAY_NOON });
  expect(result).toEqual({ allowed: true, runsToday: 0, costToday: 0, costEstimated: false });
});

test('the 24th run today is still allowed, the 25th is rejected (maxRunsPerDay: 24)', () => {
  for (let i = 0; i < 23; i += 1) runFor('t1', TODAY_NOON, { costUsd: 0 });
  const at24 = checkLimits({ dataDir: tmpDir, trigger: trigger(), now: TODAY_NOON });
  expect(at24.allowed).toBe(true);
  expect(at24.runsToday).toBe(23);

  runFor('t1', TODAY_NOON, { costUsd: 0 }); // 24th logged run
  const at25 = checkLimits({ dataDir: tmpDir, trigger: trigger(), now: TODAY_NOON });
  expect(at25.allowed).toBe(false);
  expect(at25.reason).toMatch(/daily run limit/);
  expect(at25.runsToday).toBe(24);
});

test('cost over the daily cap is rejected even with runsToday well under the run cap', () => {
  runFor('t1', TODAY_NOON, { costUsd: 0.6 });
  runFor('t1', TODAY_NOON, { costUsd: 0.5 });
  const result = checkLimits({ dataDir: tmpDir, trigger: trigger({ limits: { maxRunsPerDay: 24, maxCostPerDay: 1.0 } }), now: TODAY_NOON });
  expect(result.allowed).toBe(false);
  expect(result.reason).toMatch(/daily cost limit/);
  expect(result.costToday).toBeCloseTo(1.1, 5);
});

test('costUsd: null is charged at the named estimate, never at zero', () => {
  runFor('t1', TODAY_NOON, { costUsd: null });
  runFor('t1', TODAY_NOON, { costUsd: null });
  const result = checkLimits({ dataDir: tmpDir, trigger: trigger({ limits: { maxRunsPerDay: 24, maxCostPerDay: 1.0 } }), now: TODAY_NOON });
  expect(result.runsToday).toBe(2);
  // Two runs of unknown cost, no history to estimate from: 2 x the default.
  expect(result.costToday).toBeCloseTo(2 * UNKNOWN_COST_ESTIMATE_USD, 5);
  expect(result.costEstimated).toBe(true);
  expect(result.allowed).toBe(true);

  // ... and still counts toward maxRunsPerDay, so a low run cap trips too.
  const capped = checkLimits({ dataDir: tmpDir, trigger: trigger({ limits: { maxRunsPerDay: 2, maxCostPerDay: 1.0 } }), now: TODAY_NOON });
  expect(capped.allowed).toBe(false);
  expect(capped.reason).toMatch(/daily run limit/);
});

test('unknown cost cannot slip past the cost cap: enough estimated runs trip it', () => {
  for (let i = 0; i < 4; i += 1) runFor('t1', TODAY_NOON, { costUsd: null });
  const result = checkLimits({ dataDir: tmpDir, trigger: trigger({ limits: { maxRunsPerDay: 24, maxCostPerDay: 1.0 } }), now: TODAY_NOON });
  expect(result.allowed).toBe(false);
  expect(result.reason).toMatch(/daily cost limit/);
  expect(result.reason).toMatch(/partly estimated/);
});

test('a run of unknown cost is charged the MEDIAN of what this trigger cost before, when it has a history', () => {
  // Yesterday: 0.10 / 0.20 / 0.90 -> median 0.20, which is what today's
  // unknown run is charged (not the default, and not the mean).
  runFor('t1', YESTERDAY_NOON, { costUsd: 0.1 });
  runFor('t1', YESTERDAY_NOON, { costUsd: 0.2 });
  runFor('t1', YESTERDAY_NOON, { costUsd: 0.9 });
  runFor('t1', TODAY_NOON, { costUsd: null });
  const result = checkLimits({ dataDir: tmpDir, trigger: trigger(), now: TODAY_NOON });
  expect(result.costToday).toBeCloseTo(0.2, 5);
  expect(result.costEstimated).toBe(true);
});

test("another trigger's costs never feed this trigger's estimate", () => {
  runFor('other-trigger', YESTERDAY_NOON, { costUsd: 0.9 });
  runFor('t1', TODAY_NOON, { costUsd: null });
  const result = checkLimits({ dataDir: tmpDir, trigger: trigger(), now: TODAY_NOON });
  expect(result.costToday).toBeCloseTo(UNKNOWN_COST_ESTIMATE_USD, 5);
});

test('a known cost is used verbatim — the estimate only ever fills a gap', () => {
  runFor('t1', TODAY_NOON, { costUsd: 0.01 });
  const result = checkLimits({ dataDir: tmpDir, trigger: trigger(), now: TODAY_NOON });
  expect(result.costToday).toBeCloseTo(0.01, 5);
  expect(result.costEstimated).toBe(false);
});

test("runs from a previous day don't count toward today's cap", () => {
  for (let i = 0; i < 30; i += 1) runFor('t1', YESTERDAY_NOON, { costUsd: 0.9 });
  const result = checkLimits({ dataDir: tmpDir, trigger: trigger(), now: TODAY_NOON });
  expect(result).toEqual({ allowed: true, runsToday: 0, costToday: 0, costEstimated: false });
});

test('runs from a different trigger id are never counted', () => {
  for (let i = 0; i < 30; i += 1) runFor('other-trigger', TODAY_NOON, { costUsd: 0.9 });
  const result = checkLimits({ dataDir: tmpDir, trigger: trigger(), now: TODAY_NOON });
  expect(result).toEqual({ allowed: true, runsToday: 0, costToday: 0, costEstimated: false });
});

test('a plain user-originated run (no triggerId) is never counted', () => {
  appendRun(tmpDir, { ts: new Date(TODAY_NOON).toISOString(), origin: 'user', triggerId: null, costUsd: 0.9 });
  const result = checkLimits({ dataDir: tmpDir, trigger: trigger(), now: TODAY_NOON });
  expect(result).toEqual({ allowed: true, runsToday: 0, costToday: 0, costEstimated: false });
});

// ------------------------------------------------------------- global cap (all triggers together)

test('global cap: an empty log allows, and counts nothing', () => {
  expect(checkGlobalTriggerLimits({ dataDir: tmpDir, now: TODAY_NOON })).toEqual({ allowed: true, turnsLastHour: 0, turnsToday: 0 });
});

test('global cap: trigger turns from DIFFERENT triggers add up — this is the ceiling no per-trigger cap can see', () => {
  for (let i = 0; i < MAX_TRIGGER_TURNS_PER_HOUR - 1; i += 1) {
    runFor(i % 2 === 0 ? 'chain-a' : 'chain-b', TODAY_NOON - 60_000);
  }
  const under = checkGlobalTriggerLimits({ dataDir: tmpDir, now: TODAY_NOON });
  expect(under.allowed).toBe(true);
  expect(under.turnsLastHour).toBe(MAX_TRIGGER_TURNS_PER_HOUR - 1);

  runFor('chain-b', TODAY_NOON - 60_000);
  const over = checkGlobalTriggerLimits({ dataDir: tmpDir, now: TODAY_NOON });
  expect(over.allowed).toBe(false);
  expect(over.reason).toMatch(/global trigger cap reached/);
  expect(over.reason).toMatch(/last hour/);
});

test('global cap: turns older than an hour stop counting toward the hourly cap', () => {
  for (let i = 0; i < MAX_TRIGGER_TURNS_PER_HOUR; i += 1) runFor('chain-a', TODAY_NOON - 61 * 60_000);
  const result = checkGlobalTriggerLimits({ dataDir: tmpDir, now: TODAY_NOON });
  expect(result.allowed).toBe(true);
  expect(result.turnsLastHour).toBe(0);
  expect(result.turnsToday).toBe(MAX_TRIGGER_TURNS_PER_HOUR);
});

test('global cap: the daily ceiling holds even when every hour stayed under the hourly one', () => {
  // Spread across the day so no single hour trips first.
  for (let i = 0; i < MAX_TRIGGER_TURNS_PER_DAY; i += 1) {
    runFor('chain-a', TODAY_NOON - 11 * 60 * 60_000 + i * 6 * 60_000);
  }
  const result = checkGlobalTriggerLimits({ dataDir: tmpDir, now: TODAY_NOON });
  expect(result.allowed).toBe(false);
  expect(result.reason).toMatch(/today/);
  expect(result.turnsToday).toBe(MAX_TRIGGER_TURNS_PER_DAY);
});

test("global cap: a user's own chat turns are never throttled by it", () => {
  for (let i = 0; i < MAX_TRIGGER_TURNS_PER_DAY + 10; i += 1) {
    appendRun(tmpDir, { ts: new Date(TODAY_NOON).toISOString(), origin: 'user', triggerId: null, costUsd: 0.5 });
  }
  const result = checkGlobalTriggerLimits({ dataDir: tmpDir, now: TODAY_NOON });
  expect(result.allowed).toBe(true);
  expect(result.turnsToday).toBe(0);
});
