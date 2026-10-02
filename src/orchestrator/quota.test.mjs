import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildQuotaReport } from './quota.mjs';
import { appendRequest, writeQuota } from '../proxy/store.mjs';

function tmp(p) {
  return fs.mkdtempSync(path.join(os.tmpdir(), p));
}

describe('buildQuotaReport', () => {
  it('uses the proxy snapshot for Claude and sums usage per project via the session ledger', () => {
    const dataDir = tmp('q-data-');
    const home = tmp('q-home-');
    writeQuota(dataDir, { seenAt: '2026-10-02T09:00:00.000Z', status: 'allowed', representativeClaim: 'five_hour', windows: { '7d': { usedPercent: 69, resetsAt: null }, '5h': { usedPercent: 5, resetsAt: null }, overage: { usedPercent: 0, resetsAt: null } } });
    fs.mkdirSync(path.join(dataDir, 'ledger'), { recursive: true });
    fs.writeFileSync(path.join(dataDir, 'ledger', 'sessions.jsonl'),JSON.stringify({ type: 'start', sessionId: 's1', cwd: 'C:\\Users\\karent\\Documents\\Software\\meoluna', ts: '2026-10-02T08:00:00Z' }) + '\n');
    appendRequest(dataDir, { ts: '2026-10-02T08:10:00.000Z', sessionId: 's1', inputTokens: 10, outputTokens: 20, cacheReadTokens: 100, cacheCreationTokens: 5 });
    appendRequest(dataDir, { ts: '2026-10-02T08:20:00.000Z', sessionId: 's1', inputTokens: 1, outputTokens: 2, cacheReadTokens: 0, cacheCreationTokens: 0 });
    appendRequest(dataDir, { ts: '2026-10-02T08:30:00.000Z', sessionId: 'unknown', inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheCreationTokens: 0 });

    const r = buildQuotaReport({ dataDir, home, now: () => Date.parse('2026-10-02T10:00:00Z') });
    const claude = r.providers.find((p) => p.id === 'claude');
    expect(claude.source).toBe('proxy');
    expect(claude.windows.map((w) => w.name)).toEqual(['5h', '7d', 'overage']);
    expect(r.projects[0]).toMatchObject({ project: 'meoluna', sessions: 1, requests: 2, inputTokens: 11, outputTokens: 22 });
    expect(r.projects.find((p) => p.project === 'unbekannt').requests).toBe(1);
    expect(r.proxy.lastRequestAt).toBe('2026-10-02T08:30:00.000Z');
  });

  it('with accounts.json: one Claude card per account, the next pick marked, missing tokens named', () => {
    const dataDir = tmp('q-acc-');
    fs.writeFileSync(
      path.join(dataDir, 'accounts.json'),
      JSON.stringify({ accounts: [{ id: 'konto1', label: 'Haupt', tokenEnv: null }, { id: 'konto2', tokenEnv: 'CLAUDE_TOKEN_KONTO2' }, { id: 'konto3', tokenEnv: 'CLAUDE_TOKEN_KONTO3' }] }),
    );
    const now = Date.parse('2026-10-02T12:00:00Z');
    writeQuota(dataDir, { seenAt: '2026-10-02T11:00:00Z', windows: { '5h': { usedPercent: 95, resetsAt: '2026-10-02T14:00:00Z' } } }, 'h', 'konto1');
    writeQuota(dataDir, { seenAt: '2026-10-02T11:00:00Z', windows: { '5h': { usedPercent: 20, resetsAt: '2026-10-02T14:00:00Z' } } }, 'h', 'konto2');
    writeQuota(dataDir, { seenAt: '2026-10-02T11:00:00Z', windows: { '5h': { usedPercent: 5, resetsAt: null } } }, 'h', 'org-abcdef12');
    const r = buildQuotaReport({ dataDir, home: tmp('q-h-'), now: () => now, env: { CLAUDE_TOKEN_KONTO2: 't' }, envFile: null });
    const claude = r.providers.filter((p) => p.id === 'claude');
    expect(claude.map((p) => [p.account, p.label, p.credential, p.next])).toEqual([
      ['konto1', 'Claude · Haupt', 'login', false],
      ['konto2', 'Claude · konto2', 'token', true],
      ['konto3', 'Claude · konto3', 'missing', false],
      ['org-abcdef12', 'Claude · org-abcdef12', null, false],
    ]);
    expect(claude[2].windows).toEqual([]);
  });

  it('passes codex limitId through when codex reports no windows', () => {
    const home = tmp('q-home3-');
    const file = path.join(home, '.codex', 'sessions', '2026', '10', '02', 'rollout-x.jsonl');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ timestamp: '2026-10-02T09:00:00Z', type: 'event_msg', payload: { type: 'token_count', rate_limits: { limit_id: 'premium', primary: null, secondary: null } } }) + '\n');
    const codex = buildQuotaReport({ dataDir: tmp('q-d3-'), home }).providers.find((p) => p.id === 'codex');
    expect(codex).toMatchObject({ source: 'rollouts', limitId: 'premium', windows: [], seenAt: '2026-10-02T09:00:00.000Z' });
  });

  it('falls back to runs.jsonl for Claude and reports none for a fresh machine', () => {
    const r = buildQuotaReport({ dataDir: tmp('q-empty-'), home: tmp('q-home2-') });
    expect(r.providers.map((p) => [p.id, p.source])).toEqual([['claude', 'none'], ['codex', 'none']]);
    expect(r.projects).toEqual([]);
  });
});
