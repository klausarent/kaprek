import { describe, it, expect, beforeEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { appendRequest, readRequests, writeQuota, readQuota, readQuotas, learnOrg, readOrgMap, writePid, readPid, clearPid, isAlive, proxyDir } from './store.mjs';

let dir;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kaprek-proxy-'));
});

describe('proxy store', () => {
  it('appends and reads requests, skipping a torn last line', () => {
    appendRequest(dir, { ts: '2026-10-02T10:00:00.000Z', sessionId: 'a', outputTokens: 3 });
    fs.appendFileSync(path.join(proxyDir(dir), 'requests.jsonl'), '{"ts":"2026-10-02T10:0');
    expect(readRequests(dir)).toEqual([{ ts: '2026-10-02T10:00:00.000Z', sessionId: 'a', outputTokens: 3 }]);
  });

  it('filters by sinceMs', () => {
    appendRequest(dir, { ts: '2026-09-01T00:00:00.000Z' });
    appendRequest(dir, { ts: '2026-10-02T00:00:00.000Z' });
    expect(readRequests(dir, { sinceMs: Date.parse('2026-10-01T00:00:00Z') })).toHaveLength(1);
  });

  it('writes quota atomically and reads it back', () => {
    writeQuota(dir, { seenAt: 'x', status: 'allowed', representativeClaim: null, windows: { '5h': { usedPercent: 5, resetsAt: null } } });
    expect(readQuota(dir).windows['5h'].usedPercent).toBe(5);
    expect(fs.readdirSync(proxyDir(dir)).some((f) => f.endsWith('.tmp'))).toBe(false);
  });

  it('returns null quota when missing or broken', () => {
    expect(readQuota(dir)).toBeNull();
    fs.mkdirSync(proxyDir(dir), { recursive: true });
    fs.writeFileSync(path.join(proxyDir(dir), 'quota.json'), '{');
    expect(readQuota(dir)).toBeNull();
  });

  it('writes under its own host and reads every host (the data dir is synced between machines)', () => {
    appendRequest(dir, { ts: '2026-10-02T10:00:00.000Z', sessionId: 'laptop' }, 'laptop');
    appendRequest(dir, { ts: '2026-10-02T09:00:00.000Z', sessionId: 'server' }, 'strategiert-1');
    writeQuota(dir, { seenAt: '2026-10-02T09:00:00.000Z', windows: { '5h': { usedPercent: 1, resetsAt: null } } }, 'strategiert-1');
    writeQuota(dir, { seenAt: '2026-10-02T10:00:00.000Z', windows: { '5h': { usedPercent: 7, resetsAt: null } } }, 'laptop');
    expect(fs.existsSync(path.join(dir, 'proxy', 'laptop', 'requests.jsonl'))).toBe(true);
    expect(readRequests(dir).map((r) => r.sessionId)).toEqual(['server', 'laptop']);
    expect(readQuota(dir).windows['5h'].usedPercent).toBe(7);
  });

  it('keeps one snapshot per account and per host, newest per account wins', () => {
    writeQuota(dir, { seenAt: '2026-10-02T09:00:00.000Z', windows: { '5h': { usedPercent: 10, resetsAt: null } } }, 'laptop', 'konto1');
    writeQuota(dir, { seenAt: '2026-10-02T10:00:00.000Z', windows: { '5h': { usedPercent: 30, resetsAt: null } } }, 'strategiert-1', 'konto1');
    writeQuota(dir, { seenAt: '2026-10-02T08:00:00.000Z', windows: { '5h': { usedPercent: 50, resetsAt: null } } }, 'laptop', 'konto2');
    const q = readQuotas(dir);
    expect([...q.keys()].sort()).toEqual(['konto1', 'konto2']);
    expect(q.get('konto1')).toMatchObject({ account: 'konto1', windows: { '5h': { usedPercent: 30 } } });
    expect(fs.existsSync(path.join(dir, 'proxy', 'laptop', 'quota', 'konto2.json'))).toBe(true);
    expect(readQuota(dir).seenAt).toBe('2026-10-02T10:00:00.000Z');
  });

  it('learns which organization is which account, first answer wins, merged across hosts', () => {
    expect(learnOrg(dir, 'org-a', 'konto2', 'laptop')).toEqual({ learned: true, account: 'konto2' });
    expect(learnOrg(dir, 'org-a', 'konto3', 'laptop')).toEqual({ learned: false, account: 'konto2' });
    learnOrg(dir, 'org-b', 'konto3', 'strategiert-1');
    expect(readOrgMap(dir)).toEqual({ 'org-a': 'konto2', 'org-b': 'konto3' });
  });

  it('round-trips the pid file and knows this process is alive', () => {
    writePid(dir, { pid: process.pid, port: 4911 });
    expect(readPid(dir)).toMatchObject({ pid: process.pid, port: 4911 });
    expect(isAlive(process.pid)).toBe(true);
    clearPid(dir);
    expect(readPid(dir)).toBeNull();
  });
});
