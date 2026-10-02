import { describe, it, expect, beforeEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { appendRequest, readRequests, writeQuota, readQuota, writePid, readPid, clearPid, isAlive, proxyDir } from './store.mjs';

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

  it('round-trips the pid file and knows this process is alive', () => {
    writePid(dir, { pid: process.pid, port: 4911 });
    expect(readPid(dir)).toMatchObject({ pid: process.pid, port: 4911 });
    expect(isAlive(process.pid)).toBe(true);
    clearPid(dir);
    expect(readPid(dir)).toBeNull();
  });
});
