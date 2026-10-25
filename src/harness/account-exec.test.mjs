import { describe, it, expect, beforeEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { scanLine, quotaRecorder, execWithAccount } from './account-exec.mjs';
import { accountsPath } from '../accounts/config.mjs';
import { writeQuota, readQuotas } from '../proxy/store.mjs';

// claude-agent-acp's wire shapes (acp-agent.js 0.73, session-failure-extension.js)
const rateInfo = (status = 'allowed', u5 = 0.42, u7 = 0.7) => ({
  status,
  unifiedWindows: { five_hour: { utilization: u5, resetsAt: 1793000000 }, seven_day: { utilization: u7, resetsAt: 1793400000 } },
});
const usageUpdate = (info) =>
  JSON.stringify({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 's', update: { sessionUpdate: 'usage_update', used: 10, size: 200000, _meta: { '_claude/rateLimit': info } } } });
const failure = (category, actions, title = 'You have hit your limit') =>
  JSON.stringify({ jsonrpc: '2.0', id: 7, result: { stopReason: 'end_turn', _meta: { jetbrains: { air: { version: 1, sessionFailure: { id: 'x', revision: 1, category, severity: 'error', title, actions } } } } } });

describe('scanLine', () => {
  it('reads the windows claude-agent-acp forwards with a usage update', () => {
    expect(scanLine(usageUpdate(rateInfo()))).toEqual([{ type: 'rate', info: rateInfo() }]);
  });
  it('a limit failure without actions is the account\'s quota', () => {
    expect(scanLine(failure('limit', []))).toEqual([{ type: 'limit', title: 'You have hit your limit' }]);
  });
  it('a session budget, a context limit or a 429 is not the account\'s quota', () => {
    expect(scanLine(failure('limit', ['new_session']))).toEqual([]);
    expect(scanLine(failure('limit', ['retry']))).toEqual([]);
  });
  it('an access failure is an auth error', () => {
    expect(scanLine(failure('access', ['login'], 'Sign in'))).toEqual([{ type: 'auth', title: 'Sign in' }]);
  });
  it('ignores everything else, including model prose that mentions the markers', () => {
    expect(scanLine('{"jsonrpc":"2.0","method":"session/update","params":{"update":{"sessionUpdate":"agent_message_chunk"}}}')).toEqual([]);
    expect(scanLine('not json but says sessionFailure and _claude/rateLimit')).toEqual([]);
    expect(scanLine(JSON.stringify({ params: { text: 'sessionFailure' } }))).toEqual([]);
  });
});

describe('quotaRecorder', () => {
  let written, t;
  const write = (dir, snap, host, id) => written.push({ id, ...snap });
  beforeEach(() => {
    written = [];
    t = 1_000_000;
  });
  const rec = (read = () => new Map()) => quotaRecorder({ dataDir: 'd', accountId: 'konto2', now: () => t, write, read });

  it('files the first reading at once, later ones at most every 15 s, the last one on flush', () => {
    const r = rec();
    r.event({ type: 'rate', info: rateInfo('allowed', 0.1) });
    t += 5_000;
    r.event({ type: 'rate', info: rateInfo('allowed', 0.2) });
    expect(written.map((w) => w.windows['5h'].usedPercent)).toEqual([10]);
    r.flush();
    expect(written.map((w) => w.windows['5h'].usedPercent)).toEqual([10, 20]);
    expect(written[1]).toMatchObject({ id: 'konto2', source: 'exec', status: 'allowed' });
  });

  it('a limit failure files the account as rejected with the last windows it saw, and flush does not undo it', () => {
    const r = rec();
    r.event({ type: 'rate', info: rateInfo('allowed_warning', 0.97) });
    t += 1_000;
    r.event({ type: 'rate', info: rateInfo('allowed_warning', 0.98) });
    r.event({ type: 'limit', title: 'x' });
    r.flush();
    expect(written.at(-1)).toMatchObject({ status: 'rejected', source: 'exec', windows: { '5h': { usedPercent: 98 } } });
    expect(written).toHaveLength(2);
  });

  it('without a reading of its own, a limit failure keeps the windows already on file', () => {
    const r = rec(() => new Map([['konto2', { windows: { '7d': { usedPercent: 93, resetsAt: '2999-01-01T00:00:00Z' } } }]]));
    r.event({ type: 'limit', title: 'x' });
    expect(written[0]).toMatchObject({ status: 'rejected', windows: { '7d': { usedPercent: 93 } } });
  });

  it('a rejected reading is filed at once; an auth failure as auth-error', () => {
    const r = rec();
    r.event({ type: 'rate', info: rateInfo('rejected', 1, 0.5) });
    r.event({ type: 'auth', title: 'Sign in' });
    expect(written.map((w) => w.status)).toEqual(['rejected', 'auth-error']);
    expect(written[1]).toMatchObject({ authError: true });
  });
});

describe('kaprek accounts exec', () => {
  let dataDir, spawned, logs, stdin, stdout, out;
  const log = (l) => logs.push(l);
  function fakeSpawn(script) {
    return (command, args, opts) => {
      const child = new EventEmitter();
      child.stdin = new PassThrough();
      child.stdout = new PassThrough();
      child.kill = (sig) => {
        child.killedWith = sig;
        child.stdout.end();
        setImmediate(() => child.emit('close', null, sig));
      };
      spawned = { command, args, opts, child, input: '' };
      child.stdin.on('data', (c) => (spawned.input += c));
      setImmediate(() => script(child));
      return child;
    };
  }
  const finish = (child, code = 0) => {
    child.stdout.end();
    setImmediate(() => child.emit('close', code, null));
  };
  beforeEach(() => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kaprek-exec-'));
    fs.writeFileSync(accountsPath(dataDir), JSON.stringify({ accounts: [{ id: 'konto1', tokenEnv: 'CLAUDE_TOKEN_KONTO1' }, { id: 'konto2', tokenEnv: 'CLAUDE_TOKEN_KONTO2' }] }));
    writeQuota(dataDir, { seenAt: new Date().toISOString(), windows: { '5h': { usedPercent: 95, resetsAt: '2999-01-01T00:00:00Z' } } }, 'h', 'konto1');
    writeQuota(dataDir, { seenAt: new Date().toISOString(), windows: { '5h': { usedPercent: 20, resetsAt: '2999-01-01T00:00:00Z' } } }, 'h', 'konto2');
    logs = [];
    stdin = new PassThrough();
    stdout = new PassThrough();
    out = '';
    stdout.on('data', (c) => (out += c));
  });
  const env = { PATH: 'p', CLAUDE_TOKEN_KONTO1: 'tok1', CLAUDE_TOKEN_KONTO2: 'tok2', ANTHROPIC_API_KEY: 'key' };
  const run = (script, extra = {}) =>
    execWithAccount('node', ['agent.js', '--x'], { dataDir, env, envFile: null, loginOrg: null, spawnFn: fakeSpawn(script), stdin, stdout, log, parentPid: null, ...extra });

  it('starts the command on the emptiest account, relays stdio unchanged and passes the exit code through', async () => {
    const code = await run((child) => {
      stdin.write('{"jsonrpc":"2.0","id":1,"method":"initialize"}\n');
      setImmediate(() => {
        child.stdout.write('{"jsonrpc":"2.0","id":1,"result":{}}\n');
        finish(child, 3);
      });
    });
    expect(code).toBe(3);
    expect(spawned.command).toBe('node');
    expect(spawned.args).toEqual(['agent.js', '--x']);
    expect(spawned.opts.stdio).toEqual(['pipe', 'pipe', 'inherit']);
    expect(spawned.opts.shell).toBe(false);
    expect(spawned.opts.env).toMatchObject({ CLAUDE_CODE_OAUTH_TOKEN: 'tok2', KAPREK_ACCOUNT: 'konto2', PATH: 'p' });
    expect(spawned.opts.env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(spawned.opts.env.CLAUDE_TOKEN_KONTO1).toBeUndefined();
    expect(spawned.input).toBe('{"jsonrpc":"2.0","id":1,"method":"initialize"}\n');
    expect(out).toBe('{"jsonrpc":"2.0","id":1,"result":{}}\n');
    expect(logs.join('\n')).toMatch(/konto2/);
    expect(logs.join('\n')).not.toContain('tok2');
  });

  it('files the windows the run reports for the account it ran on', async () => {
    await run((child) => {
      // split mid-line on purpose: the relay must reassemble lines
      const line = usageUpdate(rateInfo('allowed', 0.33, 0.5)) + '\n';
      child.stdout.write(line.slice(0, 40));
      child.stdout.write(line.slice(40));
      finish(child);
    });
    const q = readQuotas(dataDir).get('konto2');
    expect(q).toMatchObject({ source: 'exec', windows: { '5h': { usedPercent: 33 }, '7d': { usedPercent: 50 } } });
    expect(out).toContain('_claude/rateLimit');
  });

  it('a run that dies on the limit files its account as rejected, so the retry goes elsewhere', async () => {
    await run((child) => {
      child.stdout.write(failure('limit', []) + '\n');
      finish(child, 1);
    });
    expect(readQuotas(dataDir).get('konto2')).toMatchObject({ status: 'rejected' });
    let next;
    await run((child) => {
      next = spawned.opts.env.KAPREK_ACCOUNT;
      finish(child);
    });
    expect(next).toBe('konto1');
  });

  it('every account full: starts anyway on the inherited environment (the /login)', async () => {
    writeQuota(dataDir, { seenAt: new Date().toISOString(), windows: { '5h': { usedPercent: 100, resetsAt: '2999-01-01T00:00:00Z' } } }, 'h', 'konto1');
    writeQuota(dataDir, { seenAt: new Date().toISOString(), windows: { '5h': { usedPercent: 100, resetsAt: '2999-01-01T00:00:00Z' } } }, 'h', 'konto2');
    const code = await run((child) => finish(child, 0));
    expect(code).toBe(0);
    expect(spawned.opts.env).toBe(env);
    expect(logs.join('\n')).toMatch(/alle Konten voll/);
  });

  it('a broken accounts.json does not stop the agent either', async () => {
    fs.writeFileSync(accountsPath(dataDir), '{kaputt');
    const code = await run((child) => finish(child, 0));
    expect(code).toBe(0);
    // kaprek falls back to the plain /login account
    expect(spawned.opts.env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
    expect(spawned.opts.env.PATH).toBe('p');
  });

  it('closes the agent\'s stdin when ours ends', async () => {
    let ended = false;
    await run((child) => {
      child.stdin.on('finish', () => {
        ended = true;
        finish(child, 0);
      });
      stdin.end();
    });
    expect(ended).toBe(true);
  });

  it('takes the agent down when whoever started us is gone', async () => {
    const code = await run(() => {}, { parentPid: 4242, alive: () => false, parentCheckMs: 10 });
    expect(spawned.child.killedWith).toBe('SIGTERM');
    expect(code).toBe(1);
  });

  it('.cmd shims start through the shell', async () => {
    await execWithAccount('C:\\x\\claude-agent-acp.cmd', [], { dataDir, env, envFile: null, loginOrg: null, spawnFn: fakeSpawn((c) => finish(c)), stdin, stdout, log, parentPid: null });
    expect(spawned.opts.shell).toBe(true);
  });
});
