import { test, expect, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import {
  acquireInstanceLock,
  InstanceLockHeldError,
  LOCK_HEARTBEAT_MS,
  LOCK_STALE_MS,
} from './instance-lock.mjs';

let tmpDirs = [];

afterEach(async () => {
  await Promise.all(tmpDirs.map((dir) => fs.rm(dir, { recursive: true, force: true })));
  tmpDirs = [];
});

async function tmpDataDir() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'kaprek-instance-lock-'));
  tmpDirs.push(dir);
  return dir;
}

function writeLockFile(dataDir, state) {
  return fs.writeFile(path.join(dataDir, 'instance.lock'), JSON.stringify(state));
}

function setLockMtime(dataDir, mtimeMs) {
  const date = new Date(mtimeMs);
  return fs.utimes(path.join(dataDir, 'instance.lock'), date, date);
}

/**
 * Spawns a node process that exits immediately and waits for it to actually
 * be gone, then returns its PID — a real dead PID, not a guessed number that
 * might collide with something still running.
 */
function deadPid() {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' });
    child.on('error', reject);
    child.on('exit', () => resolve(child.pid));
  });
}

test('acquireInstanceLock: a second acquire on the same dataDir throws InstanceLockHeldError naming the live holder', async () => {
  const dataDir = await tmpDataDir();
  const first = await acquireInstanceLock({ dataDir, port: 4711 });
  await expect(acquireInstanceLock({ dataDir, port: 4712 }))
    .rejects.toMatchObject({ name: 'InstanceLockHeldError', port: 4711, pid: process.pid });
  await first.release();
});

test('acquireInstanceLock: takes over a lock whose pid is dead AND whose mtime is stale', async () => {
  const dataDir = await tmpDataDir();
  const pid = await deadPid();
  await writeLockFile(dataDir, { pid, port: 4711, nonce: 'x', startedAt: 0 });
  await setLockMtime(dataDir, Date.now() - LOCK_STALE_MS - 1000);
  const lock = await acquireInstanceLock({ dataDir, port: 4712 });
  await lock.release();
});

test('acquireInstanceLock: refuses a stale-mtime lock whose pid is still alive', async () => {
  const dataDir = await tmpDataDir();
  await writeLockFile(dataDir, { pid: process.pid, port: 4711, nonce: 'x', startedAt: 0 });
  await setLockMtime(dataDir, Date.now() - LOCK_STALE_MS - 1000);
  await expect(acquireInstanceLock({ dataDir, port: 4712 }))
    .rejects.toMatchObject({ name: 'InstanceLockHeldError' });
});

test('acquireInstanceLock: refuses a fresh-mtime lock whose pid is dead', async () => {
  const dataDir = await tmpDataDir();
  const pid = await deadPid();
  await writeLockFile(dataDir, { pid, port: 4711, nonce: 'x', startedAt: 0 });
  await expect(acquireInstanceLock({ dataDir, port: 4712 }))
    .rejects.toMatchObject({ name: 'InstanceLockHeldError' });
});

test('acquireInstanceLock: a lock file that is not valid JSON is refused, never silently overwritten', async () => {
  const dataDir = await tmpDataDir();
  await fs.writeFile(path.join(dataDir, 'instance.lock'), '{not json');
  await expect(acquireInstanceLock({ dataDir, port: 4712 })).rejects.toThrow();
  // Fail-closed means untouched, not just rejected.
  const raw = await fs.readFile(path.join(dataDir, 'instance.lock'), 'utf8');
  expect(raw).toBe('{not json');
});

test('acquireInstanceLock: release() only deletes the lock if it still holds our nonce', async () => {
  const dataDir = await tmpDataDir();
  const lock = await acquireInstanceLock({ dataDir, port: 4711 });
  // Simulate a takeover that happened after our heartbeat lapsed: the file
  // on disk now belongs to someone else's nonce.
  await writeLockFile(dataDir, { pid: process.pid, port: 4712, nonce: 'someone-else', startedAt: 0 });
  await lock.release();
  const raw = await fs.readFile(path.join(dataDir, 'instance.lock'), 'utf8');
  expect(JSON.parse(raw).nonce).toBe('someone-else');
});

test('acquireInstanceLock: updatePort() rewrites the lock with the real port once known', async () => {
  const dataDir = await tmpDataDir();
  const lock = await acquireInstanceLock({ dataDir, port: undefined });
  await lock.updatePort(4713);
  const raw = await fs.readFile(path.join(dataDir, 'instance.lock'), 'utf8');
  const state = JSON.parse(raw);
  expect(state.port).toBe(4713);
  expect(state.url).toBe('http://127.0.0.1:4713');
  await lock.release();
});

test('acquireInstanceLock: heartbeat keeps the lock fresh so it is never mistaken for stale', async () => {
  const dataDir = await tmpDataDir();
  const lock = await acquireInstanceLock({ dataDir, port: 4711, heartbeatMs: 20 });
  await new Promise((resolve) => setTimeout(resolve, LOCK_HEARTBEAT_MS > 100 ? 100 : LOCK_HEARTBEAT_MS + 50));
  const stat = await fs.stat(path.join(dataDir, 'instance.lock'));
  expect(Date.now() - stat.mtimeMs).toBeLessThan(LOCK_STALE_MS);
  await lock.release();
});

test('acquireInstanceLock re-exports InstanceLockHeldError for instanceof checks', async () => {
  const dataDir = await tmpDataDir();
  const first = await acquireInstanceLock({ dataDir, port: 4711 });
  try {
    await acquireInstanceLock({ dataDir, port: 4712 });
    throw new Error('expected acquireInstanceLock to throw');
  } catch (err) {
    expect(err).toBeInstanceOf(InstanceLockHeldError);
  } finally {
    await first.release();
  }
});
