import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { snapshotFromRateLimit, probeAccount } from './probe-account.mjs';

const SEEN = '2026-10-24T12:15:00.000Z';
// The shape Claude Code 2.1.310 printed for konto3 on 24.10.2026.
const REJECTED = {
  status: 'rejected',
  resetsAt: 1792852200,
  rateLimitType: 'five_hour',
  unifiedWindows: {
    five_hour: { utilization: 1, resetsAt: 1792852200, status: 'rejected' },
    seven_day: { utilization: 0.67, resetsAt: 1793041200, status: 'allowed' },
  },
};

describe('snapshotFromRateLimit', () => {
  it('turns unifiedWindows into the proxy shape', () => {
    expect(snapshotFromRateLimit(REJECTED, { seenAt: SEEN, source: 'probe' })).toEqual({
      seenAt: SEEN,
      status: 'rejected',
      source: 'probe',
      windows: {
        '5h': { usedPercent: 100, resetsAt: new Date(1792852200 * 1000).toISOString() },
        '7d': { usedPercent: 67, resetsAt: new Date(1793041200 * 1000).toISOString() },
      },
    });
  });

  it('a rejection without windows marks the binding window full', () => {
    const snap = snapshotFromRateLimit({ status: 'rejected', rateLimitType: 'seven_day', resetsAt: 1792623600 }, { seenAt: SEEN });
    expect(snap.windows).toEqual({ '7d': { usedPercent: 100, resetsAt: new Date(1792623600 * 1000).toISOString() } });
  });

  it('no window, no snapshot', () => {
    expect(snapshotFromRateLimit({ status: 'allowed' })).toBeNull();
    expect(snapshotFromRateLimit(null)).toBeNull();
  });
});

describe('probeAccount', () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'kaprek-probe-test-'));
  const env = { PATH: '', KAPREK_CLAUDE_PATH: 'claude.exe', CLAUDE_CODE_OAUTH_TOKEN: 'tok' };
  const fake = (stdout, stderr = '') => {
    const calls = [];
    const fn = (command, args, options) => {
      calls.push({ command, args, options });
      return { status: 0, stdout, stderr };
    };
    return { fn, calls };
  };

  it('runs one bare haiku turn under the account env and reads its rate_limit_event', () => {
    const { fn, calls } = fake(['{"type":"system","subtype":"init"}', JSON.stringify({ type: 'rate_limit_event', rate_limit_info: REJECTED }), '{"type":"result"}'].join('\n'));
    const snap = probeAccount({ env, cwd, spawnFn: fn, now: () => Date.parse(SEEN) });
    expect(snap).toMatchObject({ seenAt: SEEN, status: 'rejected', source: 'probe', windows: { '5h': { usedPercent: 100 } } });
    const { args, options } = calls[0];
    expect(args).toEqual(expect.arrayContaining(['-p', '--model', 'haiku', '--no-session-persistence', '--strict-mcp-config']));
    // No settings files means no user hooks; no tools at all.
    expect(args[args.indexOf('--setting-sources') + 1]).toBe('project');
    expect(args[args.indexOf('--tools') + 1]).toBe('');
    expect(options.env.CLAUDE_CODE_OAUTH_TOKEN).toBe('tok');
    expect(options.cwd).toBe(cwd);
  });

  it('spells the empty tool list out when it goes through cmd.exe', () => {
    const { fn, calls } = fake('');
    probeAccount({ env: { ...env, KAPREK_CLAUDE_PATH: 'claude.cmd' }, cwd, spawnFn: fn });
    expect(calls[0].options.shell).toBe(true);
    expect(calls[0].args[calls[0].args.indexOf('--tools') + 1]).toBe('""');
  });

  it('an expired token comes back as an auth-error snapshot', () => {
    const { fn } = fake('{"type":"result","is_error":true,"result":"API Error: 401 OAuth token has expired"}');
    expect(probeAccount({ env, cwd, spawnFn: fn, now: () => Date.parse(SEEN) })).toEqual({ seenAt: SEEN, status: 'auth-error', authError: true, windows: {}, source: 'probe' });
  });

  it('nothing usable (CLI missing, network down): null, the old reading stays', () => {
    expect(probeAccount({ env, cwd, spawnFn: fake('', 'ENOTFOUND').fn })).toBeNull();
    expect(probeAccount({ env, cwd, spawnFn: () => { throw new Error('spawn ENOENT'); } })).toBeNull();
  });
});
