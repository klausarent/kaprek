import { describe, it, expect, beforeEach } from 'vitest';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { launchClaude } from './launch-claude.mjs';
import { accountsPath } from '../accounts/config.mjs';
import { writeQuota } from '../proxy/store.mjs';

let dataDir, logs, spawned;
const log = (l) => logs.push(l);
function fakeSpawn(exitCode = 0) {
  return (command, args, opts) => {
    spawned = { command, args, opts };
    const child = new EventEmitter();
    setImmediate(() => child.emit('exit', exitCode));
    return child;
  };
}
beforeEach(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kaprek-launch-'));
  logs = [];
  spawned = null;
  fs.writeFileSync(accountsPath(dataDir), JSON.stringify({ accounts: [{ id: 'konto1', tokenEnv: null }, { id: 'konto2', tokenEnv: 'CLAUDE_TOKEN_KONTO2' }] }));
});

describe('kaprek claude', () => {
  it('starts claude with the chosen account, its args and the inherited terminal', async () => {
    writeQuota(dataDir, { seenAt: new Date().toISOString(), windows: { '5h': { usedPercent: 92, resetsAt: '2999-01-01T00:00:00Z' } } }, 'h', 'konto1');
    const code = await launchClaude(['--resume', 'abc'], { dataDir, env: { PATH: '', CLAUDE_TOKEN_KONTO2: 'tok2' }, envFile: null, spawnFn: fakeSpawn(0), log });
    expect(code).toBe(0);
    expect(spawned.args).toEqual(['--resume', 'abc']);
    expect(spawned.opts.stdio).toBe('inherit');
    expect(spawned.opts.env).toMatchObject({ CLAUDE_CODE_OAUTH_TOKEN: 'tok2', KAPREK_ACCOUNT: 'konto2' });
    expect(logs.join('\n')).toMatch(/konto2/);
    expect(logs.join('\n')).not.toContain('tok2');
  });

  it('passes the exit code of claude through', async () => {
    expect(await launchClaude([], { dataDir, env: { PATH: '' }, envFile: null, spawnFn: fakeSpawn(3), log })).toBe(3);
  });

  it('does not start when every account is full, and says until when', async () => {
    writeQuota(dataDir, { seenAt: 'x', windows: { '5h': { usedPercent: 100, resetsAt: '2999-01-01T00:00:00Z' } } }, 'h', 'konto1');
    const code = await launchClaude([], { dataDir, env: { PATH: '' }, envFile: null, spawnFn: fakeSpawn(0), log });
    expect(code).toBe(4);
    expect(spawned).toBeNull();
    expect(logs.join('\n')).toMatch(/2999-01-01/);
  });
});
