import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ensureServerRunning, readInstanceLock } from './ensure.mjs';

const CLI_PATH = '/fake/bin/cli.mjs';

let dataDir;

beforeEach(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kaprek-ensure-'));
});

afterEach(() => {
  fs.rmSync(dataDir, { recursive: true, force: true });
});

function fakeSpawn(calls) {
  return (...args) => {
    calls.push(args);
    return { unref: () => {}, pid: 4242 };
  };
}

function writeLock(pid, url) {
  fs.writeFileSync(path.join(dataDir, 'instance.lock'), JSON.stringify({ pid, port: 4900, url, lockAddress: 'x', startedAt: Date.now() }));
}

describe('ensureServerRunning', () => {
  it('no lock file: spawns detached with --no-open and unrefs the child', async () => {
    const calls = [];
    const result = await ensureServerRunning({
      dataDir,
      cliPath: CLI_PATH,
      execPath: 'node.exe',
      spawn: fakeSpawn(calls),
      isAlive: async () => true, // must not even be consulted without a lock
      env: {},
    });
    expect(result).toEqual({ started: true, pid: 4242 });
    expect(calls).toHaveLength(1);
    const [execPath, argv, opts] = calls[0];
    expect(execPath).toBe('node.exe');
    expect(argv).toEqual([CLI_PATH, '--no-open']);
    expect(opts).toMatchObject({ detached: true, stdio: 'ignore', windowsHide: true });
  });

  it('lock names a live instance: reports running, does not spawn', async () => {
    writeLock(123, 'http://127.0.0.1:4900');
    const calls = [];
    const result = await ensureServerRunning({
      dataDir,
      cliPath: CLI_PATH,
      spawn: fakeSpawn(calls),
      isAlive: async () => true,
      env: {},
    });
    expect(result).toEqual({ running: true, url: 'http://127.0.0.1:4900' });
    expect(calls).toHaveLength(0);
  });

  it('lock names a dead instance: spawns anyway', async () => {
    writeLock(123, 'http://127.0.0.1:4900');
    const calls = [];
    const result = await ensureServerRunning({
      dataDir,
      cliPath: CLI_PATH,
      spawn: fakeSpawn(calls),
      isAlive: async () => false,
      env: {},
    });
    expect(result).toEqual({ started: true, pid: 4242 });
    expect(calls).toHaveLength(1);
  });

  it('KAPREK_NO_AUTOSTART=1: does nothing, does not even read the lock', async () => {
    writeLock(123, 'http://127.0.0.1:4900');
    const calls = [];
    let isAliveCalled = false;
    const result = await ensureServerRunning({
      dataDir,
      cliPath: CLI_PATH,
      spawn: fakeSpawn(calls),
      isAlive: async () => {
        isAliveCalled = true;
        return true;
      },
      env: { KAPREK_NO_AUTOSTART: '1' },
    });
    expect(result).toEqual({ skipped: true });
    expect(calls).toHaveLength(0);
    expect(isAliveCalled).toBe(false);
  });

  it('isAlive throws: treated as not alive, spawns, never rejects', async () => {
    writeLock(123, 'http://127.0.0.1:4900');
    const calls = [];
    await expect(
      ensureServerRunning({
        dataDir,
        cliPath: CLI_PATH,
        spawn: fakeSpawn(calls),
        isAlive: async () => {
          throw new Error('boom');
        },
        env: {},
      }),
    ).resolves.toEqual({ started: true, pid: 4242 });
    expect(calls).toHaveLength(1);
  });

  it('a spawn that throws is swallowed rather than rejecting', async () => {
    const result = await ensureServerRunning({
      dataDir,
      cliPath: CLI_PATH,
      spawn: () => {
        throw new Error('ENOENT');
      },
      isAlive: async () => false,
      env: {},
    });
    expect(result).toEqual({ skipped: true });
  });
});

describe('readInstanceLock', () => {
  it('returns null for a missing file', () => {
    expect(readInstanceLock(dataDir)).toBeNull();
  });

  it('returns null for malformed JSON or a missing pid', () => {
    fs.writeFileSync(path.join(dataDir, 'instance.lock'), '{not json');
    expect(readInstanceLock(dataDir)).toBeNull();
    fs.writeFileSync(path.join(dataDir, 'instance.lock'), JSON.stringify({ url: 'http://127.0.0.1:4900' }));
    expect(readInstanceLock(dataDir)).toBeNull();
  });

  it('reads pid and url, and treats a non-http url as absent', () => {
    writeLock(7, 'http://127.0.0.1:4900');
    expect(readInstanceLock(dataDir)).toEqual({ pid: 7, url: 'http://127.0.0.1:4900' });
    writeLock(7, null);
    expect(readInstanceLock(dataDir)).toEqual({ pid: 7, url: null });
  });
});
