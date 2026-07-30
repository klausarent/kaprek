import { test, expect, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  acquireInstanceLock,
  InstanceLockHeldError,
  LOCK_PORT_ATTEMPTS,
  LOCK_PORT_BASE,
  LOCK_PORT_RANGE,
  LOCK_PORT_WINDOW,
  lockPortFor,
} from './instance-lock.mjs';

const MODULE_URL = pathToFileURL(fileURLToPath(new URL('./instance-lock.mjs', import.meta.url))).href;

// Short enough that the "accepts but never speaks" cases below cost
// milliseconds instead of GREETING_TIMEOUT_MS each.
const FAST_GREETING_MS = 60;

let tmpDirs = [];
let locks = [];
let servers = [];
let children = [];

afterEach(async () => {
  await Promise.all(locks.map((lock) => lock.release().catch(() => {})));
  locks = [];
  for (const child of children) {
    if (child.exitCode === null && !child.killed) child.kill('SIGKILL');
  }
  children = [];
  await Promise.all(servers.map((server) => new Promise((resolve) => server.close(resolve))));
  servers = [];
  await Promise.all(tmpDirs.map((dir) => fs.rm(dir, { recursive: true, force: true })));
  tmpDirs = [];
});

async function tmpDataDir() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'kaprek-instance-lock-'));
  tmpDirs.push(dir);
  return dir;
}

/** True if this process can actually bind `port` right now. */
async function isBindable(port) {
  try {
    const server = await listenOnce(port);
    await closeServer(server);
    return true;
  } catch {
    return false;
  }
}

/**
 * A temp data dir whose first `count` candidate ports are genuinely free.
 *
 * Windows reserves whole blocks of the dynamic range (see the module header),
 * and a random temp name lands in one often enough to make a test that
 * hardcodes `basePort + 1` flaky. Retrying with a different name is cheaper
 * and more honest than teaching every test about reserved ranges.
 */
async function tmpDataDirWithFreePorts(count = 2) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const dir = await tmpDataDir();
    const base = lockPortFor(dir);
    const ports = Array.from({ length: count }, (_, i) => base + i);
    const free = await Promise.all(ports.map(isBindable));
    if (free.every(Boolean)) return dir;
  }
  throw new Error('could not find a temp data dir with free candidate ports');
}

async function acquire(dataDir, opts = {}) {
  const lock = await acquireInstanceLock({ greetingTimeoutMs: FAST_GREETING_MS, ...opts, dataDir });
  locks.push(lock);
  return lock;
}

/** Binds a plain TCP server that is NOT kaprek, to stand in for foreign software. */
function listenForeign(port, onConnection) {
  return new Promise((resolve, reject) => {
    const server = net.createServer(onConnection);
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      servers.push(server);
      resolve(server);
    });
  });
}

/**
 * Runs `source` as a real, separate node process — needed wherever the point
 * of the test is that the OS, not this process's bookkeeping, is what holds
 * the lock. Resolves once the child prints its first JSON line.
 */
function spawnChild(source) {
  const child = spawn(process.execPath, ['--input-type=module', '-e', source], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  children.push(child);
  return new Promise((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      reject(new Error(`child never reported ready. stdout: ${stdout} stderr: ${stderr}`));
    }, 10_000);
    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
      const nl = stdout.indexOf('\n');
      if (nl !== -1) {
        clearTimeout(timer);
        resolve({ child, message: JSON.parse(stdout.slice(0, nl)) });
      }
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`child exited with ${code} before reporting ready. stderr: ${stderr}`));
    });
  });
}

/** A child that holds the lock for `dataDir` and then stays alive until killed. */
function holderSource(dataDir, port) {
  return `
import { acquireInstanceLock } from ${JSON.stringify(MODULE_URL)};
const lock = await acquireInstanceLock({ dataDir: ${JSON.stringify(dataDir)}, port: ${port} });
process.stdout.write(JSON.stringify({ pid: process.pid, lockPort: lock.lockPort }) + '\\n');
setInterval(() => {}, 1000);
`;
}

function listenOnce(port) {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => resolve(server));
  });
}

function closeServer(server) {
  return new Promise((resolve) => server.close(resolve));
}

// ---------------------------------------------------------------------------
// 1. The platform assumption the whole design rests on.
// ---------------------------------------------------------------------------

test('two listen() calls on the same loopback address: the second gets EADDRINUSE', async () => {
  const first = await listenOnce(0);
  const port = first.address().port;
  try {
    await expect(listenOnce(port)).rejects.toMatchObject({ code: 'EADDRINUSE' });
  } finally {
    await closeServer(first);
  }
});

test('the EADDRINUSE guarantee holds across processes, not just within one', async () => {
  // The in-process case above could in principle be Node bookkeeping rather
  // than the OS refusing the bind. Exclusivity between two kaprek starts is
  // always cross-process, so prove it there too.
  const source = `
import net from 'node:net';
const server = net.createServer();
server.listen(0, '127.0.0.1', () => {
  process.stdout.write(JSON.stringify({ port: server.address().port }) + '\\n');
});
setInterval(() => {}, 1000);
`;
  const { message } = await spawnChild(source);
  await expect(listenOnce(message.port)).rejects.toMatchObject({ code: 'EADDRINUSE' });
});

// ---------------------------------------------------------------------------
// 2-4. Exclusivity, and the two ways it ends.
// ---------------------------------------------------------------------------

test('a second acquire on the same dataDir throws InstanceLockHeldError naming the holder', async () => {
  const dataDir = await tmpDataDir();
  await acquire(dataDir, { port: 4711 });
  await expect(acquire(dataDir, { port: 4712 })).rejects.toMatchObject({
    name: 'InstanceLockHeldError',
    pid: process.pid,
    url: 'http://127.0.0.1:4711',
  });
});

test('the holder is reported across processes, with the real pid and url of the other process', async () => {
  const dataDir = await tmpDataDir();
  const { message } = await spawnChild(holderSource(dataDir, 4811));
  await expect(acquire(dataDir, { port: 4812 })).rejects.toMatchObject({
    name: 'InstanceLockHeldError',
    pid: message.pid,
    url: 'http://127.0.0.1:4811',
  });
  expect(message.pid).not.toBe(process.pid);
});

test('after release() the next acquire succeeds immediately, with no waiting period', async () => {
  const dataDir = await tmpDataDir();
  const first = await acquire(dataDir, { port: 4711 });
  await first.release();
  const startedAt = Date.now();
  const second = await acquire(dataDir, { port: 4712 });
  // The file-lease version this replaced could only reclaim a lock after
  // LOCK_STALE_MS (15s). A closed socket is free the instant it closes.
  expect(Date.now() - startedAt).toBeLessThan(1000);
  expect(second.lockPort).toBe(first.lockPort);
});

test('a holder killed with SIGKILL blocks nothing: the next acquire succeeds immediately', async () => {
  const dataDir = await tmpDataDirWithFreePorts(1);
  const { child } = await spawnChild(holderSource(dataDir, 4911));
  const exited = new Promise((resolve) => child.on('exit', resolve));
  child.kill('SIGKILL');
  await exited;

  const startedAt = Date.now();
  const lock = await acquire(dataDir, { port: 4912 });
  // No staleness clock, no heartbeat, no takeover: the OS closed the crashed
  // process's socket for us, so this is a plain successful bind.
  expect(Date.now() - startedAt).toBeLessThan(1000);
  expect(lock.lockPort).toBe(lockPortFor(dataDir));
});

// ---------------------------------------------------------------------------
// 5-6. Foreign software sitting on the derived port.
// ---------------------------------------------------------------------------

test('foreign software that accepts but never speaks: acquire moves to the next port', async () => {
  const dataDir = await tmpDataDirWithFreePorts();
  const basePort = lockPortFor(dataDir);
  // Accepts the connection and holds it open without sending anything — the
  // case that would hang the start if the greeting read had no timeout.
  await listenForeign(basePort, () => {});
  const lock = await acquire(dataDir, { port: 4711 });
  expect(lock.lockPort).toBe(basePort + 1);
});

test('foreign software that sends garbage: acquire moves to the next port', async () => {
  const dataDir = await tmpDataDirWithFreePorts();
  const basePort = lockPortFor(dataDir);
  await listenForeign(basePort, (socket) => socket.end('HTTP/1.1 200 OK\r\n\r\n<html>hi</html>'));
  const lock = await acquire(dataDir, { port: 4711 });
  expect(lock.lockPort).toBe(basePort + 1);
});

test('a well-formed greeting for a DIFFERENT dataDir is not our holder either', async () => {
  const dataDir = await tmpDataDirWithFreePorts();
  const other = await tmpDataDir();
  const basePort = lockPortFor(dataDir);
  // Shape-valid, hash wrong: another kaprek data dir that happens to collide
  // on the derived port must not be mistaken for ours.
  await listenForeign(basePort, (socket) => {
    socket.end(`${JSON.stringify({ kaprek: 1, dataDirHash: 'a'.repeat(64), pid: 1, url: 'http://127.0.0.1:1' })}\n`);
  });
  expect(other).not.toBe(dataDir);
  const lock = await acquire(dataDir, { port: 4711 });
  expect(lock.lockPort).toBe(basePort + 1);
});

test('an already-running kaprek on a fallback port is found even when its base port has since freed up', async () => {
  const dataDir = await tmpDataDirWithFreePorts();
  const basePort = lockPortFor(dataDir);
  const blocker = await listenForeign(basePort, () => {});
  const first = await acquire(dataDir, { port: 4711 });
  expect(first.lockPort).toBe(basePort + 1);

  // The foreign software goes away. A naive "bind the base port, done"
  // would now hand out a second lock for the same dataDir.
  await closeServer(blocker);
  servers = servers.filter((s) => s !== blocker);

  await expect(acquire(dataDir, { port: 4712 })).rejects.toMatchObject({
    name: 'InstanceLockHeldError',
    url: 'http://127.0.0.1:4711',
  });
});

test('every candidate port occupied by silent foreign software: acquire fails loudly', async () => {
  const dataDir = await tmpDataDir();
  const basePort = lockPortFor(dataDir);
  const blocked = [];
  for (let offset = 0; blocked.length < LOCK_PORT_ATTEMPTS && offset < LOCK_PORT_WINDOW; offset += 1) {
    try {
      blocked.push(await listenForeign(basePort + offset, () => {}));
    } catch (err) {
      // A port reserved by the OS (EACCES, see the module header) cannot be
      // occupied here, and acquire() steps over it without spending one of
      // its attempts. So this loop must not count it either, or a base port
      // near a reserved block leaves acquire() a free port above the ones
      // this test blocked — which is how this test first failed.
      if (err.code !== 'EACCES') throw err;
    }
  }
  expect(blocked).toHaveLength(LOCK_PORT_ATTEMPTS);
  await expect(acquire(dataDir, { port: 4711 })).rejects.toThrow(/could not claim/i);
});

// ---------------------------------------------------------------------------
// 7-8. Which dataDir maps to which port.
// ---------------------------------------------------------------------------

test('two different dataDirs do not block each other', async () => {
  const a = await tmpDataDir();
  const b = await tmpDataDir();
  const lockA = await acquire(a, { port: 4711 });
  const lockB = await acquire(b, { port: 4712 });
  expect(lockA.lockPort).not.toBe(lockB.lockPort);
});

test('the derived port stays inside the documented private range', async () => {
  for (let i = 0; i < 200; i += 1) {
    const port = lockPortFor(path.join(os.tmpdir(), `kaprek-port-spread-${i}`));
    expect(port).toBeGreaterThanOrEqual(LOCK_PORT_BASE);
    expect(port).toBeLessThan(LOCK_PORT_BASE + LOCK_PORT_RANGE);
    // The walk must never need a port above 65535.
    expect(port + LOCK_PORT_WINDOW + LOCK_PORT_ATTEMPTS).toBeLessThanOrEqual(65535);
  }
});

test('different spellings of the same directory derive the same port and block each other', async () => {
  const dataDir = await tmpDataDir();
  const spellings = [
    `${dataDir}${path.sep}`,
    path.join(dataDir, 'sub', '..'),
    ...(process.platform === 'win32' ? [dataDir.toUpperCase(), dataDir.toLowerCase()] : []),
  ];
  for (const spelling of spellings) {
    expect(lockPortFor(spelling)).toBe(lockPortFor(dataDir));
  }

  await acquire(dataDir, { port: 4711 });
  for (const spelling of spellings) {
    await expect(acquire(spelling, { port: 4712 })).rejects.toMatchObject({
      name: 'InstanceLockHeldError',
    });
  }
});

// ---------------------------------------------------------------------------
// Windows reserved port ranges (Hyper-V/WinNAT), verified on this machine
// with `netsh int ipv4 show excludedportrange protocol=tcp`.
// ---------------------------------------------------------------------------

/**
 * First reserved TCP range inside the derived-port window that this process
 * genuinely cannot bind, or undefined.
 *
 * netsh also lists "managed" exclusions (marked with `*` in its output), and
 * those turn out to be bindable anyway — verified here on 50000-50059, which
 * binds fine. So the listing is only a shortlist; the EACCES is what counts.
 */
async function reservedRange() {
  if (process.platform !== 'win32') return undefined;
  let out;
  try {
    out = execFileSync('netsh', ['int', 'ipv4', 'show', 'excludedportrange', 'protocol=tcp'], {
      encoding: 'utf8',
    });
  } catch {
    return undefined;
  }
  for (const line of out.split(/\r?\n/)) {
    const match = line.trim().match(/^(\d+)\s+(\d+)/);
    if (!match) continue;
    const start = Number(match[1]);
    const end = Number(match[2]);
    if (start < LOCK_PORT_BASE || end >= LOCK_PORT_BASE + LOCK_PORT_RANGE) continue;
    if (!(await isBindable(start))) return { start, end };
  }
  return undefined;
}

test('a base port inside a Windows-reserved range is stepped over, not treated as a holder', async () => {
  const range = await reservedRange();
  if (!range) {
    // No reserved range on this machine (or not Windows) — nothing to prove.
    return;
  }
  // Find a directory name whose derived port lands exactly on the reserved
  // range's first port. Hashing is pure, so this costs no filesystem work.
  const parent = await tmpDataDir();
  let dataDir;
  for (let i = 0; i < 2_000_000 && !dataDir; i += 1) {
    const candidate = path.join(parent, `d${i}`);
    if (lockPortFor(candidate) === range.start) dataDir = candidate;
  }
  expect(dataDir, 'no directory name hashed onto the reserved port').toBeDefined();
  await fs.mkdir(dataDir, { recursive: true });

  const lock = await acquire(dataDir, { port: 4711 });
  // listen() on a reserved port fails with EACCES, which is neither "free"
  // nor "someone else holds the lock" — the walk has to keep going past the
  // whole reserved block, which can be 100 ports wide.
  expect(lock.lockPort).toBeGreaterThan(range.end);
});

// ---------------------------------------------------------------------------
// Handle surface.
// ---------------------------------------------------------------------------

test('updatePort() is what the greeting reports once the real server port is known', async () => {
  const dataDir = await tmpDataDir();
  const lock = await acquire(dataDir, { port: undefined });
  await expect(acquire(dataDir, {})).rejects.toMatchObject({
    name: 'InstanceLockHeldError',
    url: null,
  });
  await lock.updatePort(4713);
  await expect(acquire(dataDir, {})).rejects.toMatchObject({
    url: 'http://127.0.0.1:4713',
  });
});

test('the lock file is written for humans to read, and removed on release', async () => {
  const dataDir = await tmpDataDir();
  const lockPath = path.join(dataDir, 'instance.lock');
  const lock = await acquire(dataDir, { port: 4711 });
  const state = JSON.parse(await fs.readFile(lockPath, 'utf8'));
  expect(state).toMatchObject({ pid: process.pid, port: 4711, url: 'http://127.0.0.1:4711' });
  expect(state.lockPort).toBe(lock.lockPort);
  await lock.release();
  await expect(fs.stat(lockPath)).rejects.toMatchObject({ code: 'ENOENT' });
});

test('a stale lock file left behind by a crash does not block acquiring', async () => {
  const dataDir = await tmpDataDirWithFreePorts(1);
  // The file is display only. Whatever it says, only the socket decides.
  await fs.writeFile(
    path.join(dataDir, 'instance.lock'),
    JSON.stringify({ pid: process.pid, port: 4711, url: 'http://127.0.0.1:4711' }),
  );
  const lock = await acquire(dataDir, { port: 4712 });
  expect(lock.lockPort).toBe(lockPortFor(dataDir));
});

test('a corrupt lock file does not block acquiring either', async () => {
  const dataDir = await tmpDataDirWithFreePorts(1);
  await fs.writeFile(path.join(dataDir, 'instance.lock'), '{not json');
  const lock = await acquire(dataDir, { port: 4712 });
  expect(lock.lockPort).toBe(lockPortFor(dataDir));
});

test('release() is idempotent and updatePort() after release() does not resurrect the file', async () => {
  const dataDir = await tmpDataDir();
  const lockPath = path.join(dataDir, 'instance.lock');
  const lock = await acquire(dataDir, { port: 4711 });
  await lock.release();
  await lock.release();
  await lock.updatePort(4712);
  lock.releaseSync();
  await expect(fs.stat(lockPath)).rejects.toMatchObject({ code: 'ENOENT' });
});

test('releaseSync() frees the port for the next acquire', async () => {
  const dataDir = await tmpDataDir();
  const first = await acquire(dataDir, { port: 4711 });
  first.releaseSync();
  // releaseSync() exists for process.on('exit'), where nothing can be
  // awaited; the close it starts still has to actually unbind.
  await new Promise((resolve) => setTimeout(resolve, 50));
  const second = await acquire(dataDir, { port: 4712 });
  expect(second.lockPort).toBe(first.lockPort);
});

test('acquireInstanceLock throws an InstanceLockHeldError instance, for instanceof checks in bin/cli.mjs', async () => {
  const dataDir = await tmpDataDir();
  await acquire(dataDir, { port: 4711 });
  await expect(acquire(dataDir, { port: 4712 })).rejects.toBeInstanceOf(InstanceLockHeldError);
});
