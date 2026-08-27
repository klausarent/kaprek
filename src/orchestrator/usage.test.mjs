import { test, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { appendRun } from './runs.mjs';
import { latestRateLimits, summarizeRateLimit } from './usage.mjs';

let dataDir;
beforeEach(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kaprek-usage-'));
});
afterEach(() => {
  fs.rmSync(dataDir, { recursive: true, force: true });
});

test("Claude Code's rate_limit_info yields the window, its fill and its reset", () => {
  const summary = summarizeRateLimit({ status: 'allowed_warning', resetsAt: 1756300000, rateLimitType: 'five_hour', utilization: 0.62 });
  expect(summary).toEqual({ usedPercent: 62, resetsAt: new Date(1756300000 * 1000).toISOString(), window: 'five_hour', status: 'allowed_warning', plan: null });
});

test("codex's rateLimits yields the fuller of its two windows, and a relative reset becomes absolute", () => {
  const now = () => Date.parse('2026-08-27T12:00:00.000Z');
  const summary = summarizeRateLimit(
    { planType: 'plus', primary: { usedPercent: 15, windowDurationMins: 300, resetsInSeconds: 600 }, secondary: { usedPercent: 71, windowDurationMins: 10080, resetsAt: '2026-08-30T00:00:00.000Z' } },
    { now },
  );
  expect(summary).toEqual({ usedPercent: 71, resetsAt: '2026-08-30T00:00:00.000Z', window: '168h', status: null, plan: 'plus' });
  expect(summarizeRateLimit({ primary: { usedPercent: 1, windowDurationMins: 300, resetsInSeconds: 600 } }, { now }).resetsAt).toBe('2026-08-27T12:10:00.000Z');
});

test('an unknown or empty shape is nulls, never a throw', () => {
  expect(summarizeRateLimit(null)).toEqual({ usedPercent: null, resetsAt: null, window: null, status: null, plan: null });
  expect(summarizeRateLimit({ weird: true })).toMatchObject({ usedPercent: null, resetsAt: null });
  expect(summarizeRateLimit({ utilization: 140 })).toMatchObject({ usedPercent: 140 });
});

test('the latest signal per harness is read back from runs.jsonl, newest first, turns without a signal skipped', () => {
  appendRun(dataDir, { ts: '2026-08-27T09:00:00.000Z', harness: 'claude-code', chatId: 'c1', rateLimit: { utilization: 0.2, rateLimitType: 'five_hour' } });
  appendRun(dataDir, { ts: '2026-08-27T10:00:00.000Z', harness: 'claude-code', chatId: 'c2', rateLimit: null });
  appendRun(dataDir, { ts: '2026-08-27T11:00:00.000Z', harness: 'claude-code', chatId: 'c3', rateLimit: { utilization: 0.5, rateLimitType: 'five_hour', resetsAt: 1756310400 } });
  appendRun(dataDir, { ts: '2026-08-27T11:30:00.000Z', harness: 'codex', chatId: 'c4', rateLimit: { planType: 'plus', primary: { usedPercent: 9 } } });
  const latest = latestRateLimits(dataDir);
  expect(latest.map((e) => e.harness)).toEqual(['codex', 'claude-code']);
  expect(latest[1]).toMatchObject({ seenAt: '2026-08-27T11:00:00.000Z', chatId: 'c3', summary: { usedPercent: 50, window: 'five_hour' } });
  expect(latest[1].info).toEqual({ utilization: 0.5, rateLimitType: 'five_hour', resetsAt: 1756310400 });
  expect(latestRateLimits(path.join(dataDir, 'nowhere'))).toEqual([]);
});
