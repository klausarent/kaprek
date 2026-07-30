// Tests for the trigger daily run/cost cap. Run: npx vitest run src/triggers/limits.test.mjs
import { test, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { appendRun } from '../orchestrator/runs.mjs';
import { checkLimits } from './limits.mjs';

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
  expect(result).toEqual({ allowed: true, runsToday: 0, costToday: 0 });
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

test('costUsd: null counts as a run but contributes 0 to costToday', () => {
  runFor('t1', TODAY_NOON, { costUsd: null });
  runFor('t1', TODAY_NOON, { costUsd: null });
  const result = checkLimits({ dataDir: tmpDir, trigger: trigger({ limits: { maxRunsPerDay: 24, maxCostPerDay: 1.0 } }), now: TODAY_NOON });
  expect(result.runsToday).toBe(2);
  expect(result.costToday).toBe(0);
  expect(result.allowed).toBe(true);

  // ... but still counts toward maxRunsPerDay, so a low run cap still trips
  // even when every logged run reported no cost — the cap can't be evaded
  // just because a harness omits cost data.
  const capped = checkLimits({ dataDir: tmpDir, trigger: trigger({ limits: { maxRunsPerDay: 2, maxCostPerDay: 1.0 } }), now: TODAY_NOON });
  expect(capped.allowed).toBe(false);
  expect(capped.reason).toMatch(/daily run limit/);
});

test("runs from a previous day don't count toward today's cap", () => {
  for (let i = 0; i < 30; i += 1) runFor('t1', YESTERDAY_NOON, { costUsd: 0.9 });
  const result = checkLimits({ dataDir: tmpDir, trigger: trigger(), now: TODAY_NOON });
  expect(result).toEqual({ allowed: true, runsToday: 0, costToday: 0 });
});

test('runs from a different trigger id are never counted', () => {
  for (let i = 0; i < 30; i += 1) runFor('other-trigger', TODAY_NOON, { costUsd: 0.9 });
  const result = checkLimits({ dataDir: tmpDir, trigger: trigger(), now: TODAY_NOON });
  expect(result).toEqual({ allowed: true, runsToday: 0, costToday: 0 });
});

test('a plain user-originated run (no triggerId) is never counted', () => {
  appendRun(tmpDir, { ts: new Date(TODAY_NOON).toISOString(), origin: 'user', triggerId: null, costUsd: 0.9 });
  const result = checkLimits({ dataDir: tmpDir, trigger: trigger(), now: TODAY_NOON });
  expect(result).toEqual({ allowed: true, runsToday: 0, costToday: 0 });
});
