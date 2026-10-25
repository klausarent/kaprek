import { describe, it, expect, beforeEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { sessionEnv, chooseSession, refreshStale, acquireProbeLock, PROBE_LOCK_STALE_MS } from './session.mjs';
import { accountsPath } from './config.mjs';
import { writeQuota, writePid, proxyDir } from '../proxy/store.mjs';

describe('sessionEnv', () => {
  it('a token account gets the token, the tag and the proxy', () => {
    const env = sessionEnv({ base: { PATH: 'p' }, account: { id: 'konto2' }, token: 'tok', proxyPort: 4911 });
    expect(env).toMatchObject({ PATH: 'p', CLAUDE_CODE_OAUTH_TOKEN: 'tok', ANTHROPIC_CUSTOM_HEADERS: 'x-kaprek-account: konto2', ANTHROPIC_BASE_URL: 'http://127.0.0.1:4911', KAPREK_ACCOUNT: 'konto2' });
  });

  it('the /login account removes an inherited token, so it really runs on /login', () => {
    const env = sessionEnv({ base: { CLAUDE_CODE_OAUTH_TOKEN: 'inherited' }, account: { id: 'konto1' }, token: null, proxyPort: null });
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
    expect(env.ANTHROPIC_BASE_URL).toBeUndefined();
  });

  it('keeps other custom headers and replaces only an old kaprek tag', () => {
    const env = sessionEnv({ base: { ANTHROPIC_CUSTOM_HEADERS: 'X-Team: a\nx-kaprek-account: old' }, account: { id: 'konto3' }, token: null, proxyPort: null });
    expect(env.ANTHROPIC_CUSTOM_HEADERS).toBe('X-Team: a\nx-kaprek-account: konto3');
  });

  it('never overrides a base URL someone set on purpose', () => {
    const env = sessionEnv({ base: { ANTHROPIC_BASE_URL: 'http://gw' }, account: { id: 'konto1' }, token: null, proxyPort: 4911 });
    expect(env.ANTHROPIC_BASE_URL).toBe('http://gw');
  });
});

describe('chooseSession', () => {
  let dataDir;
  beforeEach(() => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kaprek-session-'));
    fs.writeFileSync(
      accountsPath(dataDir),
      JSON.stringify({ accounts: [{ id: 'konto1', tokenEnv: null }, { id: 'konto2', tokenEnv: 'CLAUDE_TOKEN_KONTO2' }, { id: 'konto3', tokenEnv: 'CLAUDE_TOKEN_KONTO3' }] }),
    );
  });

  it('picks the emptiest usable account and builds its env; accounts without token are skipped', () => {
    const now = Date.parse('2026-10-02T12:00:00Z');
    writeQuota(dataDir, { seenAt: '2026-10-02T11:59:00Z', windows: { '5h': { usedPercent: 95, resetsAt: '2026-10-02T14:00:00Z' } } }, 'h', 'konto1');
    writeQuota(dataDir, { seenAt: '2026-10-02T11:59:00Z', windows: { '5h': { usedPercent: 20, resetsAt: '2026-10-02T14:00:00Z' } } }, 'h', 'konto2');
    writePid(dataDir, { pid: process.pid, port: 4911 });
    const s = chooseSession({ dataDir, env: { CLAUDE_TOKEN_KONTO2: 'tok2' }, envFile: null, now });
    expect(s.pick.account.id).toBe('konto2');
    expect(s.env).toMatchObject({ CLAUDE_CODE_OAUTH_TOKEN: 'tok2', KAPREK_ACCOUNT: 'konto2', ANTHROPIC_BASE_URL: 'http://127.0.0.1:4911' });
    expect(s.unusable).toEqual(['konto3']);
  });

  it('all full: no env, the pick says until when', () => {
    const now = Date.parse('2026-10-02T12:00:00Z');
    writeQuota(dataDir, { seenAt: 'x', windows: { '5h': { usedPercent: 100, resetsAt: '2026-10-02T13:00:00Z' } } }, 'h', 'konto1');
    const s = chooseSession({ dataDir, env: {}, envFile: null, now });
    expect(s.env).toBeNull();
    expect(s.pick).toMatchObject({ exhausted: true, retryAt: '2026-10-02T13:00:00.000Z' });
  });

  it('with probe: old and missing readings are measured first, fresh and known-full ones are left alone', () => {
    // 24.10.2026: konto3 read 23 % from two hours before and was at 100 %.
    const now = Date.now();
    const iso = (msAgo) => new Date(now - msAgo).toISOString();
    const later = new Date(now + 3600_000).toISOString();
    writeQuota(dataDir, { seenAt: iso(60_000), windows: { '5h': { usedPercent: 100, resetsAt: later } } }, 'h', 'konto1');
    writeQuota(dataDir, { seenAt: iso(5 * 60_000), windows: { '5h': { usedPercent: 79, resetsAt: later } } }, 'h', 'konto2');
    writeQuota(dataDir, { seenAt: iso(2 * 3600_000), windows: { '5h': { usedPercent: 23, resetsAt: later } } }, 'h', 'konto3');
    const probedEnvs = [];
    const probeFn = ({ env }) => {
      probedEnvs.push(env);
      return { seenAt: new Date().toISOString(), status: 'rejected', windows: { '5h': { usedPercent: 100, resetsAt: later } }, source: 'probe' };
    };
    const s = chooseSession({ dataDir, env: { CLAUDE_TOKEN_KONTO2: 'tok2', CLAUDE_TOKEN_KONTO3: 'tok3' }, envFile: null, now, probe: true, probeFn });
    expect(s.probed).toEqual([{ id: 'konto3', result: 'ok' }]);
    expect(probedEnvs[0]).toMatchObject({ CLAUDE_CODE_OAUTH_TOKEN: 'tok3', KAPREK_ACCOUNT: 'konto3' });
    expect(probedEnvs[0].CLAUDE_TOKEN_KONTO2).toBeUndefined();
    expect(probedEnvs[0].ANTHROPIC_BASE_URL).toBeUndefined();
    // Without the probe this would have been konto3.
    expect(s.pick.account.id).toBe('konto2');
  });

  it('a probe that learns nothing keeps the old reading', () => {
    const now = Date.now();
    writeQuota(dataDir, { seenAt: new Date(now - 3 * 3600_000).toISOString(), windows: { '5h': { usedPercent: 40, resetsAt: null } } }, 'h', 'konto1');
    const probed = refreshStale({ dataDir, env: {}, envFile: null, now, probeFn: () => null });
    expect(probed).toEqual([{ id: 'konto1', result: 'none' }]);
    expect(chooseSession({ dataDir, env: {}, envFile: null, now }).pick.load).toEqual({ fiveHour: 40, sevenDay: null });
  });
});

describe('council fixes: foreign credentials', () => {
  it('drops API keys and the other accounts token variables from the child env', () => {
    const env = sessionEnv({
      base: { ANTHROPIC_API_KEY: 'k', ANTHROPIC_AUTH_TOKEN: 'a', CLAUDE_TOKEN_KONTO3: 'other', PATH: 'p' },
      account: { id: 'konto2' },
      token: 'tok',
      proxyPort: null,
      strip: ['CLAUDE_TOKEN_KONTO2', 'CLAUDE_TOKEN_KONTO3'],
    });
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(env.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
    expect(env.CLAUDE_TOKEN_KONTO3).toBeUndefined();
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBe('tok');
    expect(env.PATH).toBe('p');
  });
});

describe('probe lock', () => {
  let dataDir;
  beforeEach(() => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kaprek-lock-'));
    fs.writeFileSync(accountsPath(dataDir), JSON.stringify({ accounts: [{ id: 'konto2', tokenEnv: 'CLAUDE_TOKEN_KONTO2' }] }));
  });
  const lockFile = () => path.join(proxyDir(dataDir), 'probe.lock');

  it('is taken and given back', () => {
    const release = acquireProbeLock(dataDir);
    expect(fs.existsSync(lockFile())).toBe(true);
    expect(acquireProbeLock(dataDir, { waitMs: 0 })).toBeNull();
    release();
    expect(fs.existsSync(lockFile())).toBe(false);
  });

  it('a lock older than PROBE_LOCK_STALE_MS belongs to a crashed prober and is taken over', () => {
    fs.mkdirSync(proxyDir(dataDir), { recursive: true });
    fs.writeFileSync(lockFile(), '{}');
    const old = (Date.now() - PROBE_LOCK_STALE_MS - 60_000) / 1000;
    fs.utimesSync(lockFile(), old, old);
    const release = acquireProbeLock(dataDir, { waitMs: 0 });
    expect(release).toBeTypeOf('function');
    release();
  });

  it('while someone else probes, refreshStale waits and then measures only what is still stale', () => {
    let calls = 0;
    const lock = () => {
      // the other prober filed a fresh reading while we waited
      writeQuota(dataDir, { seenAt: new Date().toISOString(), windows: { '5h': { usedPercent: 10, resetsAt: '2999-01-01T00:00:00Z' } } }, 'h', 'konto2');
      return () => {};
    };
    const probed = refreshStale({ dataDir, env: { CLAUDE_TOKEN_KONTO2: 'tok2' }, envFile: null, probeFn: () => (calls++, null), lock });
    expect(probed).toEqual([]);
    expect(calls).toBe(0);
  });

  it('gives up probing when the lock never comes free', () => {
    let calls = 0;
    const probed = refreshStale({ dataDir, env: { CLAUDE_TOKEN_KONTO2: 'tok2' }, envFile: null, probeFn: () => (calls++, null), lock: () => null });
    expect(probed).toEqual([]);
    expect(calls).toBe(0);
  });

  it('nothing stale, no lock taken', () => {
    writeQuota(dataDir, { seenAt: new Date().toISOString(), windows: { '5h': { usedPercent: 10, resetsAt: '2999-01-01T00:00:00Z' } } }, 'h', 'konto2');
    let taken = false;
    refreshStale({ dataDir, env: { CLAUDE_TOKEN_KONTO2: 'tok2' }, envFile: null, probeFn: () => null, lock: () => ((taken = true), () => {}) });
    expect(taken).toBe(false);
  });
});
