import { describe, it, expect, beforeEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runAccountsCommand } from './accounts.mjs';
import { accountsPath } from '../accounts/config.mjs';
import { writeQuota } from '../proxy/store.mjs';

let dataDir, lines;
const log = (l) => lines.push(l);
beforeEach(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kaprek-acccli-'));
  lines = [];
  fs.writeFileSync(accountsPath(dataDir), JSON.stringify({ accounts: [{ id: 'konto1', label: 'Haupt', tokenEnv: null }, { id: 'konto2', tokenEnv: 'CLAUDE_TOKEN_KONTO2' }] }));
});

describe('kaprek accounts', () => {
  it('lists every account with its windows and marks the next pick', async () => {
    writeQuota(dataDir, { seenAt: new Date().toISOString(), windows: { '5h': { usedPercent: 42, resetsAt: null }, '7d': { usedPercent: 7, resetsAt: null } } }, 'h', 'konto1');
    const code = await runAccountsCommand([], { dataDir, env: {}, envFile: null, log });
    expect(code).toBe(0);
    const text = lines.join('\n');
    expect(text).toMatch(/konto1.*Haupt.*42 %.*7 %/);
    expect(text).toMatch(/konto2.*kein Token \(CLAUDE_TOKEN_KONTO2\)/);
    expect(text).toMatch(/Nächste Session: konto1/);
  });

  it('pick --json names the account and the token variable, never the token', async () => {
    // konto1 measured, konto2 never: the unmeasured one goes first.
    writeQuota(dataDir, { seenAt: new Date().toISOString(), windows: { '5h': { usedPercent: 1, resetsAt: null } } }, 'h', 'konto1');
    const code = await runAccountsCommand(['pick', '--json'], { dataDir, env: { CLAUDE_TOKEN_KONTO2: 'sk-ant-oat01-SECRET' }, envFile: null, log });
    expect(code).toBe(0);
    const out = JSON.parse(lines.join(''));
    expect(out).toMatchObject({ id: 'konto2', tokenEnv: 'CLAUDE_TOKEN_KONTO2', exhausted: false });
    expect(lines.join('')).not.toContain('SECRET');
  });

  it('pick --json exits 4 when every account is full', async () => {
    writeQuota(dataDir, { seenAt: 'x', windows: { '5h': { usedPercent: 100, resetsAt: '2999-01-01T00:00:00Z' } } }, 'h', 'konto1');
    const code = await runAccountsCommand(['pick', '--json'], { dataDir, env: {}, envFile: null, log });
    expect(code).toBe(4);
    expect(JSON.parse(lines.join(''))).toMatchObject({ id: null, exhausted: true, retryAt: '2999-01-01T00:00:00.000Z' });
  });
});

describe('pick --json reports how this machine reaches the account', () => {
  it('tokenEnv is null when the account is this machine\'s /login', async () => {
    fs.writeFileSync(accountsPath(dataDir), JSON.stringify({ accounts: [{ id: 'konto1', tokenEnv: 'CLAUDE_TOKEN_KONTO1', org: '1fc3f5a5' }] }));
    await runAccountsCommand(['pick', '--json'], { dataDir, env: {}, envFile: null, log, loginOrg: '1fc3f5a5-0000' });
    expect(JSON.parse(lines.join(''))).toMatchObject({ id: 'konto1', tokenEnv: null });
  });
});
