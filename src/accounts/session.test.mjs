import { describe, it, expect, beforeEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { sessionEnv, chooseSession } from './session.mjs';
import { accountsPath } from './config.mjs';
import { writeQuota, writePid } from '../proxy/store.mjs';

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
