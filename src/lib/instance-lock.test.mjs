import { test, expect, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import {
  acquireInstanceLock,
  InstanceLockHeldError,
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

test('acquireInstanceLock: heartbeat actually refreshes mtime over several ticks', async () => {
  const dataDir = await tmpDataDir();
  const lockPath = path.join(dataDir, 'instance.lock');
  const lock = await acquireInstanceLock({ dataDir, port: 4711, heartbeatMs: 20 });
  const before = (await fs.stat(lockPath)).mtimeMs;
  // A fixed 100ms wait (< LOCK_STALE_MS) proved nothing on its own — the file
  // is that fresh right after acquire() even with no heartbeat at all. Wait
  // for several heartbeat ticks and assert the mtime actually moved forward.
  await new Promise((resolve) => setTimeout(resolve, 100));
  const after = (await fs.stat(lockPath)).mtimeMs;
  expect(after).toBeGreaterThan(before);
  await lock.release();
});

test('acquireInstanceLock: heartbeat reclaims an mtime that was artificially aged, without touching content', async () => {
  const dataDir = await tmpDataDir();
  const lockPath = path.join(dataDir, 'instance.lock');
  const lock = await acquireInstanceLock({ dataDir, port: 4711, heartbeatMs: 20 });
  await setLockMtime(dataDir, Date.now() - LOCK_STALE_MS - 1000);
  await new Promise((resolve) => setTimeout(resolve, 100));
  const stat = await fs.stat(lockPath);
  expect(Date.now() - stat.mtimeMs).toBeLessThan(LOCK_STALE_MS);
  // The heartbeat must touch mtime only — content (and in particular JSON
  // validity) is untouched between acquire() and updatePort().
  const raw = await fs.readFile(lockPath, 'utf8');
  expect(JSON.parse(raw).pid).toBe(process.pid);
  await lock.release();
});

test('acquireInstanceLock: two concurrent acquires racing the same orphaned lock never both win', async () => {
  const dataDir = await tmpDataDir();
  const pid = await deadPid();
  await writeLockFile(dataDir, { pid, port: 4711, nonce: 'orphan', startedAt: 0 });
  await setLockMtime(dataDir, Date.now() - LOCK_STALE_MS - 1000);

  // No await between the two calls: both see the same orphaned lock and
  // both attempt the takeover. The old unlink-then-recreate mechanism let
  // the second unlink delete the first acquirer's freshly-created lock,
  // then win its own create too — two live holders. The rename-based steal
  // must leave exactly one winner.
  const results = await Promise.allSettled([
    acquireInstanceLock({ dataDir, port: 5001 }),
    acquireInstanceLock({ dataDir, port: 5002 }),
  ]);

  const fulfilled = results.filter((r) => r.status === 'fulfilled');
  const rejected = results.filter((r) => r.status === 'rejected');
  expect(fulfilled).toHaveLength(1);
  expect(rejected).toHaveLength(1);
  expect(rejected[0].reason).toMatchObject({ name: 'InstanceLockHeldError' });

  // Exactly one heartbeat is now writing this file — the pid on disk must
  // agree with the one lock handle that actually won.
  const raw = await fs.readFile(path.join(dataDir, 'instance.lock'), 'utf8');
  expect(JSON.parse(raw).pid).toBe(process.pid);

  await fulfilled[0].value.release();
});

test('acquireInstanceLock: updatePort() after release() does not resurrect the lock file', async () => {
  const dataDir = await tmpDataDir();
  const lock = await acquireInstanceLock({ dataDir, port: 4711 });
  await lock.release();
  await lock.updatePort(4712);
  await expect(fs.stat(path.join(dataDir, 'instance.lock'))).rejects.toThrow();
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
