// codex-limits.test.mjs
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { latestCodexLimits } from './codex-limits.mjs';

function rollout(home, rel, lines) {
  const file = path.join(home, '.codex', 'sessions', rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, lines.map((l) => (typeof l === 'string' ? l : JSON.stringify(l))).join('\n') + '\n');
  return file;
}
const tc = (ts, primary, secondary) => ({ timestamp: ts, type: 'event_msg', payload: { type: 'token_count', rate_limits: { limit_id: 'codex', primary, secondary, plan_type: 'plus' } } });

describe('latestCodexLimits', () => {
  it('takes the newest non-null window from the newest rollout', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-'));
    const a = rollout(home, '2026/09/06/rollout-a.jsonl', [tc('2026-09-06T20:00:00Z', { used_percent: 1, window_minutes: 300, resets_at: 1788746121 }, null)]);
    fs.utimesSync(a, new Date('2026-09-06T20:00:00Z'), new Date('2026-09-06T20:00:00Z'));
    const b = rollout(home, '2026/10/01/rollout-b.jsonl', [
      tc('2026-10-01T08:00:00Z', { used_percent: 12, window_minutes: 300, resets_at: 1790715474 }, { used_percent: 40, window_minutes: 10080, resets_at: 1791000000 }),
      tc('2026-10-01T09:00:00Z', null, null),
      '{"torn',
    ]);
    fs.utimesSync(b, new Date(), new Date());
    const out = latestCodexLimits({ home });
    expect(out.seenAt).toBe('2026-10-01T08:00:00.000Z');
    expect(out.plan).toBe('plus');
    expect(out.limitId).toBe('codex');
    expect(out.windows).toEqual([
      { name: '5h', usedPercent: 12, resetsAt: new Date(1790715474 * 1000).toISOString(), windowMinutes: 300 },
      { name: '7d', usedPercent: 40, resetsAt: new Date(1791000000 * 1000).toISOString(), windowMinutes: 10080 },
    ]);
  });

  it('says so when codex logs only window-less limits (limit_id premium since 30.09.2026)', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-premium-'));
    const prem = { timestamp: '2026-10-02T09:00:00Z', type: 'event_msg', payload: { type: 'token_count', rate_limits: { limit_id: 'premium', primary: null, secondary: null, plan_type: null } } };
    rollout(home, '2026/10/02/rollout-p.jsonl', [prem]);
    expect(latestCodexLimits({ home })).toEqual({ seenAt: '2026-10-02T09:00:00.000Z', plan: null, limitId: 'premium', windows: [] });
  });

  it('returns null without a sessions dir', () => {
    expect(latestCodexLimits({ home: fs.mkdtempSync(path.join(os.tmpdir(), 'codex-empty-')) })).toBeNull();
  });
});
