import { describe, it, expect } from 'vitest';
import { pickAccount, accountLoad, AUTH_HOLD_MS } from './pick.mjs';

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

  it('a measured account with room goes before one nobody has measured (19.10.2026: unmeasured konto1 was at 100 %)', () => {
    const quotas = new Map([['konto1', snap('2026-10-02T11:00:00Z', 60, 70)]]);
    const r = pickAccount({ accounts: A, usable: all, quotas, thresholds: T, now: NOW });
    expect(r.account.id).toBe('konto1');
    expect(r.unmeasured).toBeUndefined();
  });

  it('an unmeasured account still goes before one over the thresholds, flagged', () => {
    const quotas = new Map([
      ['konto1', snap('t', 93, 20)],
      ['konto3', snap('t', 50, 97)],
    ]);
    expect(pickAccount({ accounts: A, usable: all, quotas, thresholds: T, now: NOW })).toMatchObject({ account: { id: 'konto2' }, unmeasured: true, overThreshold: false });
  });

  it('flags readings older than staleMs and missing ones as stale', () => {
    const quotas = new Map([
      ['konto1', snap('2026-10-02T11:50:00Z', 10, 10)],
      ['konto2', snap('2026-10-02T11:00:00Z', 10, 10)],
    ]);
    const { rows } = pickAccount({ accounts: A, usable: all, quotas, thresholds: T, now: NOW, staleMs: 30 * 60_000 });
    expect(rows.map((r) => [r.account.id, r.stale])).toEqual([['konto1', false], ['konto2', true], ['konto3', true]]);
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

describe('council fixes', () => {
  it('an account whose last answer was an auth error is skipped until it answers again', () => {
    const quotas = new Map([
      ['konto1', snap('2026-10-02T11:00:00Z', 50, 50)],
      ['konto2', { seenAt: '2026-10-02T11:30:00Z', authError: true, windows: {} }],
    ]);
    const r = pickAccount({ accounts: A.slice(0, 2), usable: all, quotas, thresholds: T, now: NOW });
    expect(r.account.id).toBe('konto1');
  });

  it('an auth error holds for AUTH_HOLD_MS, then the account gets another try (a renewed token must not stay locked out)', () => {
    const quotas = new Map([['konto2', { seenAt: '2026-10-02T09:00:00Z', authError: true, windows: {} }]]);
    const held = pickAccount({ accounts: [A[1]], usable: all, quotas, thresholds: T, now: Date.parse('2026-10-02T09:00:00Z') + AUTH_HOLD_MS - 1 });
    expect(held).toMatchObject({ account: null, reason: 'no-credential' });
    const retry = pickAccount({ accounts: [A[1]], usable: all, quotas, thresholds: T, now: Date.parse('2026-10-02T09:00:00Z') + AUTH_HOLD_MS });
    expect(retry).toMatchObject({ account: { id: 'konto2' }, unmeasured: true });
  });
});

describe('a rejected reading', () => {
  const rejected = (seenAt, windows = {}) => ({ seenAt, status: 'rejected', windows });
  it('counts as full while fresh, even with windows under the thresholds', () => {
    const quotas = new Map([
      ['konto2', rejected('2026-10-02T11:50:00Z', { '5h': { usedPercent: 40, resetsAt: '2026-10-02T14:00:00Z' } })],
      ['konto3', snap('2026-10-02T11:50:00Z', 60, 60)],
    ]);
    const p = pickAccount({ accounts: [A[1], A[2]], usable: all, quotas, thresholds: T, now: NOW });
    expect(p.account.id).toBe('konto3');
    expect(p.rows.find((r) => r.account.id === 'konto2')).toMatchObject({ full: true, eligible: false });
  });
  it('leaves nothing to start when it was the last account, free again once it goes stale', () => {
    const quotas = new Map([['konto2', rejected('2026-10-02T11:50:00Z')]]);
    const p = pickAccount({ accounts: [A[1]], usable: all, quotas, thresholds: T, now: NOW, staleMs: 30 * 60_000 });
    expect(p).toMatchObject({ account: null, exhausted: true, retryAt: '2026-10-02T12:20:00.000Z' });
  });
  it('an old rejection is just an old reading', () => {
    const quotas = new Map([['konto2', rejected('2026-10-02T10:00:00Z', { '5h': { usedPercent: 40, resetsAt: '2026-10-02T14:00:00Z' } })]]);
    const p = pickAccount({ accounts: [A[1]], usable: all, quotas, thresholds: T, now: NOW, staleMs: 30 * 60_000 });
    expect(p.account.id).toBe('konto2');
    expect(p.rows[0]).toMatchObject({ full: false, stale: true });
  });
});
