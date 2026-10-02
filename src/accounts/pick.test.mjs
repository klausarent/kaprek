import { describe, it, expect } from 'vitest';
import { pickAccount, accountLoad } from './pick.mjs';

const NOW = Date.parse('2026-10-02T12:00:00Z');
const T = { fiveHour: 90, sevenDay: 95, full: 99 };
const A = [
  { id: 'konto1', label: 'Konto 1', tokenEnv: null },
  { id: 'konto2', label: 'Konto 2', tokenEnv: 'CLAUDE_TOKEN_KONTO2' },
  { id: 'konto3', label: 'Konto 3', tokenEnv: 'CLAUDE_TOKEN_KONTO3' },
];
const all = new Set(['konto1', 'konto2', 'konto3']);
const snap = (seenAt, w5, w7, r5 = '2026-10-02T14:00:00Z', r7 = '2026-10-07T00:00:00Z') => ({
  seenAt,
  windows: { '5h': { usedPercent: w5, resetsAt: r5 }, '7d': { usedPercent: w7, resetsAt: r7 } },
});

describe('accountLoad', () => {
  it('counts a window whose reset has passed as empty', () => {
    expect(accountLoad(snap('x', 97, 40, '2026-10-02T11:00:00Z'), NOW)).toEqual({ fiveHour: 0, sevenDay: 40 });
  });
  it('reads the five_hour/seven_day spelling of rate_limit_event too', () => {
    expect(accountLoad({ windows: { five_hour: { usedPercent: 12 }, seven_day: { usedPercent: 3 } } }, NOW)).toEqual({ fiveHour: 12, sevenDay: 3 });
  });
  it('no snapshot is no known load', () => {
    expect(accountLoad(null, NOW)).toEqual({ fiveHour: null, sevenDay: null });
  });
});

describe('pickAccount', () => {
  it('takes the emptiest account under both thresholds', () => {
    const quotas = new Map([
      ['konto1', snap('2026-10-02T11:59:00Z', 70, 20)],
      ['konto2', snap('2026-10-02T11:59:00Z', 10, 30)],
      ['konto3', snap('2026-10-02T11:59:00Z', 40, 10)],
    ]);
    const r = pickAccount({ accounts: A, usable: all, quotas, thresholds: T, now: NOW });
    // konto2 peaks at 30 %, konto3 at 40 % (its 5h window): the fuller window is what binds.
    expect(r.account.id).toBe('konto2');
    expect(r.exhausted).toBe(false);
  });

  it('switches before the limit: 91 % in 5h is out although 7d is low', () => {
    const quotas = new Map([
      ['konto1', snap('t', 91, 5)],
      ['konto2', snap('t', 60, 80)],
    ]);
    expect(pickAccount({ accounts: A.slice(0, 2), usable: all, quotas, thresholds: T, now: NOW }).account.id).toBe('konto2');
  });

  it('accounts nobody has seen yet go first, so they get measured', () => {
    const quotas = new Map([['konto1', snap('2026-10-02T11:00:00Z', 0, 0)]]);
    expect(pickAccount({ accounts: A, usable: all, quotas, thresholds: T, now: NOW }).account.id).toBe('konto2');
  });

  it('on equal load the account seen longest ago wins', () => {
    const quotas = new Map([
      ['konto1', snap('2026-10-02T11:59:00Z', 20, 20)],
      ['konto2', snap('2026-10-02T09:00:00Z', 20, 20)],
      ['konto3', snap('2026-10-02T10:00:00Z', 20, 20)],
    ]);
    expect(pickAccount({ accounts: A, usable: all, quotas, thresholds: T, now: NOW }).account.id).toBe('konto2');
  });

  it('skips accounts without a usable credential', () => {
    const r = pickAccount({ accounts: A, usable: new Set(['konto1']), quotas: new Map(), thresholds: T, now: NOW });
    expect(r.account.id).toBe('konto1');
  });

  it('over the thresholds but not full: still runs on the least loaded, flagged', () => {
    const quotas = new Map([
      ['konto1', snap('t', 50, 97)],
      ['konto2', snap('t', 93, 60)],
    ]);
    const r = pickAccount({ accounts: A.slice(0, 2), usable: all, quotas, thresholds: T, now: NOW });
    expect(r).toMatchObject({ account: { id: 'konto2' }, exhausted: false, overThreshold: true });
  });

  it('all full: no account to start on, with the earliest time one frees up', () => {
    const quotas = new Map([
      ['konto1', snap('t', 100, 50, '2026-10-02T15:00:00Z')],
      ['konto2', snap('t', 40, 99, '2026-10-02T14:00:00Z', '2026-10-04T00:00:00Z')],
    ]);
    const r = pickAccount({ accounts: A.slice(0, 2), usable: all, quotas, thresholds: T, now: NOW });
    expect(r).toMatchObject({ account: null, exhausted: true, retryAt: '2026-10-02T15:00:00.000Z' });
  });

  it('no usable account at all', () => {
    expect(pickAccount({ accounts: A, usable: new Set(), quotas: new Map(), thresholds: T, now: NOW })).toMatchObject({ account: null, exhausted: false, reason: 'no-credential' });
  });
});
