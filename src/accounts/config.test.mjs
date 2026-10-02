import { describe, it, expect, beforeEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadAccounts, parseEnvFile, resolveToken, accountsPath } from './config.mjs';

let dir;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kaprek-acc-'));
});

describe('loadAccounts', () => {
  it('returns one default /login account when accounts.json is missing', () => {
    expect(loadAccounts(dir)).toEqual({
      thresholds: { fiveHour: 90, sevenDay: 95, full: 99 },
      accounts: [{ id: 'konto1', label: 'Konto 1', tokenEnv: null }],
      configured: false,
    });
  });

  it('reads accounts and thresholds, dropping malformed entries and duplicate ids', () => {
    fs.writeFileSync(
      accountsPath(dir),
      JSON.stringify({
        thresholds: { fiveHour: 80 },
        accounts: [
          { id: 'konto1', label: 'Haupt', tokenEnv: null },
          { id: 'konto2', tokenEnv: 'CLAUDE_TOKEN_KONTO2' },
          { id: 'konto2', tokenEnv: 'DUP' },
          { id: 'bad id!', tokenEnv: 'X' },
          { label: 'no id' },
          { id: 'konto3', tokenEnv: 'lower-case is not an env name' },
        ],
      }),
    );
    const out = loadAccounts(dir);
    expect(out.configured).toBe(true);
    expect(out.thresholds).toEqual({ fiveHour: 80, sevenDay: 95, full: 99 });
    expect(out.accounts).toEqual([
      { id: 'konto1', label: 'Haupt', tokenEnv: null },
      { id: 'konto2', label: 'konto2', tokenEnv: 'CLAUDE_TOKEN_KONTO2' },
    ]);
  });

  it('falls back to the default on broken JSON', () => {
    fs.writeFileSync(accountsPath(dir), '{');
    expect(loadAccounts(dir).configured).toBe(false);
  });
});

describe('parseEnvFile', () => {
  it('reads KEY=VALUE lines, strips CRLF, quotes and comments', () => {
    const text = '# c\r\nCLAUDE_TOKEN_KONTO2="sk-ant-oat01-abc"\r\nexport OTHER=1\r\nEMPTY=\r\nBROKEN LINE\r\n';
    expect(parseEnvFile(text)).toEqual({ CLAUDE_TOKEN_KONTO2: 'sk-ant-oat01-abc', OTHER: '1', EMPTY: '' });
  });
});

describe('resolveToken', () => {
  it('null tokenEnv means the /login credential: no token, but usable', () => {
    expect(resolveToken({ tokenEnv: null }, { env: {}, envFile: null })).toEqual({ usable: true, token: null });
  });

  it('prefers the process env, then the .env file, and trims', () => {
    const envFile = path.join(dir, '.env');
    fs.writeFileSync(envFile, 'CLAUDE_TOKEN_KONTO2=from-file\r\n');
    expect(resolveToken({ tokenEnv: 'CLAUDE_TOKEN_KONTO2' }, { env: { CLAUDE_TOKEN_KONTO2: ' from-env\r' }, envFile })).toEqual({ usable: true, token: 'from-env' });
    expect(resolveToken({ tokenEnv: 'CLAUDE_TOKEN_KONTO2' }, { env: {}, envFile })).toEqual({ usable: true, token: 'from-file' });
  });

  it('a named but missing token makes the account unusable', () => {
    expect(resolveToken({ tokenEnv: 'CLAUDE_TOKEN_KONTO3' }, { env: {}, envFile: path.join(dir, 'missing.env') })).toEqual({ usable: false, token: null });
  });
});
