import { test, expect, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  acquireInstanceLock,
  InstanceLockHeldError,
  GREETING_ATTEMPTS,
  LOCK_PORT_ATTEMPTS,
  LOCK_PORT_BASE,
  LOCK_PORT_RANGE,
  LOCK_PORT_WINDOW,
  MAX_GREETING_BYTES,
  PIPE_PREFIX,
  lockPipePathFor,
  lockPortFor,
} from './instance-lock.mjs';

const MODULE_URL = pathToFileURL(fileURLToPath(new URL('./instance-lock.mjs', import.meta.url))).href;

// Short enough that the "accepts but never speaks" cases below cost
// milliseconds instead of GREETING_TIMEOUT_MS each.
const FAST_GREETING_MS = 60;

// The lock speaks TCP on POSIX and a named pipe on Windows, so the platform
// is injectable and the shared behaviour below runs against every transport
// this machine can host. The pipe namespace only exists on Windows; the TCP
// path runs everywhere, which is the point of injecting it.
const TCP = { name: 'tcp', platform: 'linux' };
const PIPE = { name: 'pipe', platform: 'win32' };
const TRANSPORTS = process.platform === 'win32' ? [TCP, PIPE] : [TCP];

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

async function acquire(dataDir, opts = {}) {
  const lock = await acquireInstanceLock({
    greetingTimeoutMs: FAST_GREETING_MS,
    platform: TCP.platform,
    ...opts,
    dataDir,
  });
  locks.push(lock);
  return lock;
}

/**
 * `target` is either a pipe name or `{ port }`.
 *
 * The host goes INSIDE the options object: `listen({ port }, '127.0.0.1', cb)`
 * silently drops the host and binds the wildcard, and a wildcard bind does not
 * conflict with a 127.0.0.1 bind on Windows — which quietly turned several of
 * these tests into no-ops until they were caught.
 */
function listenOnce(target) {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(listenTarget(target), () => resolve(server));
  });
}

function listenTarget(target) {
  return typeof target === 'string' ? { path: target } : { ...target, host: '127.0.0.1' };
}

function closeServer(server) {
  return new Promise((resolve) => server.close(resolve));
}

/** True if this process can actually bind `target` right now. */
async function isBindable(target) {
  try {
    const server = await listenOnce(target);
    await closeServer(server);
    return true;
  } catch {
    return false;
  }
}

/**
 * A temp data dir whose first `count` candidate ports are genuinely free.
 *
 * An OS can reserve blocks inside the derived range (see the module header),
 * and a busy machine may simply have something on the port a random temp name
 * derives. Retrying with a different name is cheaper and more honest than
 * teaching every test about that.
 */
async function tmpDataDirWithFreePorts(count = 2) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const dir = await tmpDataDir();
    const base = lockPortFor(dir);
    const ports = Array.from({ length: count }, (_, i) => ({ port: base + i }));
    const free = await Promise.all(ports.map(isBindable));
    if (free.every(Boolean)) return dir;
  }
  throw new Error('could not find a temp data dir with free candidate ports');
}

/** Binds a server that is NOT kaprek, to stand in for whatever else may hold the address. */
async function listenForeign(target, onConnection) {
  const server = await new Promise((resolve, reject) => {
    const s = net.createServer(onConnection);
    s.once('error', reject);
    s.listen(listenTarget(target), () => resolve(s));
  });
  servers.push(server);
  return server;
}

/** The greeting a kaprek on some OTHER data dir would send. */
function foreignGreeting() {
  return `${JSON.stringify({ kaprek: 1, dataDirHash: 'f'.repeat(64), pid: 4242, url: 'http://127.0.0.1:9999' })}\n`;
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

function acquireInChild(dataDir, { port, platform, after = 'setInterval(() => {}, 1000);' }) {
  return `
import { acquireInstanceLock } from ${JSON.stringify(MODULE_URL)};
const lock = await acquireInstanceLock({
  dataDir: ${JSON.stringify(dataDir)},
  port: ${port},
  platform: ${JSON.stringify(platform)},
});
process.stdout.write(JSON.stringify({ pid: process.pid, lockPort: lock.lockPort, lockAddress: lock.lockAddress }) + '\\n');
${after}
`;
}

/** A child that holds the lock and then stays alive until killed. */
function holderSource(dataDir, port, platform) {
  return acquireInChild(dataDir, { port, platform });
}

/**
 * A holder that reports ready and then jams its event loop for `blockMs`.
 *
 * Atomics.wait, not a spin loop: it blocks the thread outright, so the lock
 * handle accepts nothing and answers nothing — the same shape as a real
 * holder stuck in a synchronous scan or starved on a loaded machine.
 */
function jammedHolderSource(dataDir, port, platform, blockMs) {
  return acquireInChild(dataDir, {
    port,
    platform,
    after: `
setTimeout(() => {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ${blockMs});
}, 30);
setInterval(() => {}, 1000);
`,
  });
}

// ---------------------------------------------------------------------------
// The platform assumptions the whole design rests on.
// ---------------------------------------------------------------------------

test('two listen() calls on the same loopback address: the second gets EADDRINUSE', async () => {
  const first = await listenOnce({ port: 0 });
  const port = first.address().port;
  try {
    await expect(listenOnce({ port })).rejects.toMatchObject({ code: 'EADDRINUSE' });
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
  await expect(listenOnce({ port: message.port })).rejects.toMatchObject({ code: 'EADDRINUSE' });
});

test.skipIf(process.platform !== 'win32')(
  'two listen() calls on the same pipe name: the second gets EADDRINUSE',
  async () => {
    // libuv creates the first instance of a named pipe with
    // FILE_FLAG_FIRST_PIPE_INSTANCE; without that flag Windows would happily
    // hand out further instances of the same name, and the Windows transport
    // would hold nothing at all.
    const name = `${PIPE_PREFIX}test-${process.pid}-${Date.now()}`;
    const first = await listenOnce(name);
    try {
      await expect(listenOnce(name)).rejects.toMatchObject({ code: 'EADDRINUSE' });
    } finally {
      await closeServer(first);
    }
  },
);

test.skipIf(process.platform !== 'win32')(
  'a pipe name is free again the moment its holder is SIGKILLed',
  async () => {
    // This is the property that replaces staleness detection: no file, no
    // socket path, nothing left behind to decide about.
    const name = `${PIPE_PREFIX}test-kill-${process.pid}-${Date.now()}`;
    const source = `
import net from 'node:net';
const server = net.createServer();
server.listen(${JSON.stringify(name)}, () => process.stdout.write('{"ready":1}\\n'));
setInterval(() => {}, 1000);
`;
    const { child } = await spawnChild(source);
    await expect(listenOnce(name)).rejects.toMatchObject({ code: 'EADDRINUSE' });
    const exited = new Promise((resolve) => child.on('exit', resolve));
    child.kill('SIGKILL');
    await exited;
    const reclaimed = await listenOnce(name);
    await closeServer(reclaimed);
  },
);

// ---------------------------------------------------------------------------
// Exclusivity, on every transport this machine can host.
// ---------------------------------------------------------------------------

for (const transport of TRANSPORTS) {
  const on = (title) => `[${transport.name}] ${title}`;
  const platform = transport.platform;

  test(on('a second acquire on the same dataDir throws InstanceLockHeldError naming the holder'), async () => {
    const dataDir = await tmpDataDir();
    await acquire(dataDir, { port: 4711, platform });
    await expect(acquire(dataDir, { port: 4712, platform })).rejects.toMatchObject({
      name: 'InstanceLockHeldError',
      pid: process.pid,
      url: 'http://127.0.0.1:4711',
    });
  });

  test(on('the holder is reported across processes, with the real pid and url of the other process'), async () => {
    const dataDir = await tmpDataDir();
    const { message } = await spawnChild(holderSource(dataDir, 4811, platform));
    await expect(acquire(dataDir, { port: 4812, platform })).rejects.toMatchObject({
      name: 'InstanceLockHeldError',
      pid: message.pid,
      url: 'http://127.0.0.1:4811',
    });
    expect(message.pid).not.toBe(process.pid);
  });

  test(on('after release() the next acquire succeeds immediately, with no waiting period'), async () => {
    const dataDir = await tmpDataDir();
    const first = await acquire(dataDir, { port: 4711, platform });
    await first.release();
    const startedAt = Date.now();
    const second = await acquire(dataDir, { port: 4712, platform });
    // The file lease this replaced could only reclaim a lock after
    // LOCK_STALE_MS (15s). A closed handle is free the instant it closes.
    expect(Date.now() - startedAt).toBeLessThan(1000);
    expect(second.lockAddress).toBe(first.lockAddress);
  });

  test(on('a holder killed with SIGKILL blocks nothing: the next acquire succeeds immediately'), async () => {
    const dataDir = await tmpDataDir();
    const { child, message } = await spawnChild(holderSource(dataDir, 4911, platform));
    const exited = new Promise((resolve) => child.on('exit', resolve));
    child.kill('SIGKILL');
    await exited;

    const startedAt = Date.now();
    const lock = await acquire(dataDir, { port: 4912, platform });
    // No staleness clock, no heartbeat, no takeover: the OS closed the
    // crashed process's handle for us, so this is a plain successful bind.
    expect(Date.now() - startedAt).toBeLessThan(1000);
    expect(lock.lockAddress).toBe(message.lockAddress);
  });

  test(on('a live but jammed holder is never bypassed — the second start refuses'), async () => {
    const dataDir = await tmpDataDir();
    // The regression this guards: a holder whose event loop is blocked looks
    // exactly like an unresponsive stranger. Reading that as "foreign
    // software, move to the next port" would put two kaprek instances on one
    // data dir, which is the whole failure this module exists to prevent.
    const { message } = await spawnChild(jammedHolderSource(dataDir, 4611, platform, 5000));
    // The child reports ready, then jams on a short timer. Waiting past that
    // timer is what makes this test about a jammed holder rather than a race
    // with one that is still answering.
    await new Promise((resolve) => setTimeout(resolve, 200));
    await expect(acquire(dataDir, { port: 4612, platform })).rejects.toThrow(
      /did not answer with a valid kaprek greeting|is held by something that is not/i,
    );
    if (transport === TCP) {
      // And it did not quietly settle one port over.
      expect(await isBindable({ port: message.lockPort + 1 })).toBe(true);
    }
  });

  test(on('two different dataDirs do not block each other'), async () => {
    const a = await tmpDataDir();
    const b = await tmpDataDir();
    const lockA = await acquire(a, { port: 4711, platform });
    const lockB = await acquire(b, { port: 4712, platform });
    expect(lockA.lockAddress).not.toBe(lockB.lockAddress);
  });

  test(on('different spellings of the same directory derive the same lock and block each other'), async () => {
    const dataDir = await tmpDataDir();
    const spellings = [
      `${dataDir}${path.sep}`,
      path.join(dataDir, 'sub', '..'),
      ...(process.platform === 'win32' ? [dataDir.toUpperCase(), dataDir.toLowerCase()] : []),
    ];
    for (const spelling of spellings) {
      expect(lockPortFor(spelling)).toBe(lockPortFor(dataDir));
      expect(lockPipePathFor(spelling)).toBe(lockPipePathFor(dataDir));
    }

    await acquire(dataDir, { port: 4711, platform });
    for (const spelling of spellings) {
      await expect(acquire(spelling, { port: 4712, platform })).rejects.toMatchObject({
        name: 'InstanceLockHeldError',
      });
    }
  });

  test(on('updatePort() is what the greeting reports once the real server port is known'), async () => {
    const dataDir = await tmpDataDir();
    const lock = await acquire(dataDir, { port: undefined, platform });
    await expect(acquire(dataDir, { platform })).rejects.toMatchObject({
      name: 'InstanceLockHeldError',
      url: null,
    });
    await lock.updatePort(4713);
    await expect(acquire(dataDir, { platform })).rejects.toMatchObject({
      url: 'http://127.0.0.1:4713',
    });
  });

  test(on('acquireInstanceLock throws an InstanceLockHeldError instance, for instanceof checks in bin/cli.mjs'), async () => {
    const dataDir = await tmpDataDir();
    await acquire(dataDir, { port: 4711, platform });
    await expect(acquire(dataDir, { port: 4712, platform })).rejects.toBeInstanceOf(InstanceLockHeldError);
  });
}

// ---------------------------------------------------------------------------
// What an occupied address means — one test per case, plus the line between
// case 3 and case 4, which is whether anything was actually said.
// ---------------------------------------------------------------------------

test('case 2: a greeting naming another data dir moves us to the next port', async () => {
  const dataDir = await tmpDataDirWithFreePorts();
  const basePort = lockPortFor(dataDir);
  // Two data dirs whose hashes collide on one port: the other instance proves
  // ownership by naming its own hash, so stepping aside is safe.
  await listenForeign({ port: basePort }, (socket) => socket.end(foreignGreeting()));
  const lock = await acquire(dataDir, { port: 4711 });
  expect(lock.lockPort).toBe(basePort + 1);
});

test('case 3: a service that says something other than a greeting moves us to the next port', async () => {
  const dataDir = await tmpDataDirWithFreePorts();
  const basePort = lockPortFor(dataDir);
  // Provable because a kaprek writes its greeting as the first statement of
  // its connection handler: whatever can talk to us at all talks kaprek.
  await listenForeign({ port: basePort }, (socket) => socket.end('HTTP/1.1 200 OK\r\n\r\n<html>hi</html>'));
  const lock = await acquire(dataDir, { port: 4711 });
  expect(lock.lockPort).toBe(basePort + 1);
});

test('case 3: a peer that will not stop talking is a service too', async () => {
  const dataDir = await tmpDataDirWithFreePorts();
  const basePort = lockPortFor(dataDir);
  // Our greeting is one short line; a flood is somebody else's protocol.
  await listenForeign({ port: basePort }, (socket) => socket.write('x'.repeat(MAX_GREETING_BYTES + 100)));
  const lock = await acquire(dataDir, { port: 4711 });
  expect(lock.lockPort).toBe(basePort + 1);
});

test('case 4: something that accepts but never speaks refuses the start', async () => {
  const dataDir = await tmpDataDirWithFreePorts();
  const basePort = lockPortFor(dataDir);
  // Silence is exactly what a blocked kaprek holder produces, so it proves
  // nothing and must never read as "someone else's port".
  await listenForeign({ port: basePort }, () => {});
  await expect(acquire(dataDir, { port: 4711 })).rejects.toThrow(/did not answer with a valid kaprek greeting/);
  // And it did not settle one port over.
  expect(await isBindable({ port: basePort + 1 })).toBe(true);
});

test('case 4: a greeting that arrives too late refuses the start, it does not count as a stranger', async () => {
  const dataDir = await tmpDataDirWithFreePorts();
  const basePort = lockPortFor(dataDir);
  // The holder answers correctly, just later than the read budget — the shape
  // of a real instance under load. Reading that as "foreign" is precisely the
  // two-holder bug this rule exists to prevent.
  await listenForeign({ port: basePort }, (socket) => {
    const timer = setTimeout(() => socket.end(foreignGreeting()), FAST_GREETING_MS * 20);
    socket.on('close', () => clearTimeout(timer));
  });
  await expect(acquire(dataDir, { port: 4711 })).rejects.toThrow(/did not answer with a valid kaprek greeting/);
  expect(await isBindable({ port: basePort + 1 })).toBe(true);
});

test('case 4: an answer cut off mid-line is not evidence about who is speaking', async () => {
  const dataDir = await tmpDataDirWithFreePorts();
  const basePort = lockPortFor(dataDir);
  // Half a line and then silence: the peer never finished its sentence, so
  // there is nothing to classify. Note the difference to case 3, where the
  // peer said its piece and closed.
  await listenForeign({ port: basePort }, (socket) => socket.write('{"kaprek":1,"dataDirHa'));
  await expect(acquire(dataDir, { port: 4711 })).rejects.toThrow(/did not answer with a valid kaprek greeting/);
});

test('case 4 is re-asked on the same address before the start is refused', async () => {
  const dataDir = await tmpDataDirWithFreePorts();
  const basePort = lockPortFor(dataDir);
  let connections = 0;
  // Silent until the last permitted attempt, then answers — the shape of a
  // holder that was blocked and got its turn back. The retry has to actually
  // re-ask, or this stays a refusal.
  await listenForeign({ port: basePort }, (socket) => {
    connections += 1;
    if (connections >= GREETING_ATTEMPTS) socket.end(foreignGreeting());
  });
  const lock = await acquire(dataDir, { port: 4711 });
  expect(connections).toBe(GREETING_ATTEMPTS);
  expect(lock.lockPort).toBe(basePort + 1);
});

test('an already-running kaprek on a fallback port is found even when its base port has since freed up', async () => {
  const dataDir = await tmpDataDirWithFreePorts();
  const basePort = lockPortFor(dataDir);
  const blocker = await listenForeign({ port: basePort }, (socket) => socket.end(foreignGreeting()));
  const first = await acquire(dataDir, { port: 4711 });
  expect(first.lockPort).toBe(basePort + 1);

  // The other data dir's instance goes away. A naive "bind the base port,
  // done" would now hand out a second lock for the same data dir.
  await closeServer(blocker);
  servers = servers.filter((s) => s !== blocker);

  await expect(acquire(dataDir, { port: 4712 })).rejects.toMatchObject({
    name: 'InstanceLockHeldError',
    url: 'http://127.0.0.1:4711',
  });
});

test('every candidate port owned by other data dirs: acquire fails loudly', async () => {
  const dataDir = await tmpDataDir();
  const basePort = lockPortFor(dataDir);
  const blocked = [];
  for (let offset = 0; blocked.length < LOCK_PORT_ATTEMPTS && offset < LOCK_PORT_WINDOW; offset += 1) {
    try {
      blocked.push(await listenForeign({ port: basePort + offset }, (socket) => socket.end(foreignGreeting())));
    } catch (err) {
      // A port reserved by the OS (EACCES, see the module header) cannot be
      // occupied here, and acquire() steps over it without spending one of
      // its attempts. So this loop must not count it either, or a base port
      // near a reserved block leaves acquire() a free port above the ones
      // this test blocked.
      if (err.code !== 'EACCES') throw err;
    }
  }
  expect(blocked).toHaveLength(LOCK_PORT_ATTEMPTS);
  await expect(acquire(dataDir, { port: 4711 })).rejects.toThrow(/could not claim/i);
});

test.skipIf(process.platform !== 'win32')(
  'the pipe transport has no fallback name: a silent stranger on the name refuses the start',
  async () => {
    const dataDir = await tmpDataDir();
    await listenForeign(lockPipePathFor(dataDir), () => {});
    await expect(acquire(dataDir, { port: 4711, platform: PIPE.platform })).rejects.toThrow(
      /did not answer with a valid kaprek greeting/,
    );
  },
);

test.skipIf(process.platform !== 'win32')(
  'on the pipe there is no next name, so even a provable stranger refuses the start',
  async () => {
    const dataDir = await tmpDataDir();
    // The same answer that would mean "take the next port" on TCP has nowhere
    // to go here: the name is derived from our own hash.
    await listenForeign(lockPipePathFor(dataDir), (socket) => socket.end(foreignGreeting()));
    await expect(acquire(dataDir, { port: 4711, platform: PIPE.platform })).rejects.toThrow(
      /is held by something that is not this data directory's kaprek/,
    );
  },
);

// ---------------------------------------------------------------------------
// Port derivation.
// ---------------------------------------------------------------------------

test('the derived port stays inside the documented range, clear of both ephemeral ranges', async () => {
  for (let i = 0; i < 200; i += 1) {
    const port = lockPortFor(path.join(os.tmpdir(), `kaprek-port-spread-${i}`));
    expect(port).toBeGreaterThanOrEqual(LOCK_PORT_BASE);
    expect(port).toBeLessThan(LOCK_PORT_BASE + LOCK_PORT_RANGE);
    // Below Linux's ephemeral floor (32768) and far below Windows' (49152),
    // so an outbound connection's source port can never land on a lock port.
    expect(port + LOCK_PORT_WINDOW + LOCK_PORT_ATTEMPTS).toBeLessThan(32768);
  }
});

test('the pipe name carries the hash, not the path', async () => {
  const dataDir = await tmpDataDir();
  const name = lockPipePathFor(dataDir);
  expect(name.startsWith(PIPE_PREFIX)).toBe(true);
  expect(name.slice(PIPE_PREFIX.length)).toMatch(/^[0-9a-f]{64}$/);
  // A pipe name is world-visible on Windows; the data dir path is not going
  // into it.
  expect(name).not.toContain(path.basename(dataDir));
});

// ---------------------------------------------------------------------------
// OS-reserved port ranges (Hyper-V/WinNAT on Windows), read from the machine
// this runs on. The derived range was moved to 23000-31999 partly to get away
// from them, so on many machines this finds nothing and skips.
// ---------------------------------------------------------------------------

/** First reserved TCP range inside the derived range that this process genuinely cannot bind, or undefined. */
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
    // netsh also lists "managed" exclusions (marked `*`), and those turn out
    // to be bindable anyway. The listing is a shortlist; the EACCES counts.
    if (!(await isBindable({ port: start }))) return { start, end };
  }
  return undefined;
}

test('a base port inside an OS-reserved range is stepped over, not treated as a holder', async () => {
  const range = await reservedRange();
  if (!range) {
    // No reserved range inside the derived range on this machine (or not
    // Windows) — nothing to prove here.
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
// The lock file, which decides nothing.
// ---------------------------------------------------------------------------

test('the lock file is written for humans to read, and removed on release', async () => {
  const dataDir = await tmpDataDir();
  const lockPath = path.join(dataDir, 'instance.lock');
  const lock = await acquire(dataDir, { port: 4711 });
  const state = JSON.parse(await fs.readFile(lockPath, 'utf8'));
  expect(state).toMatchObject({ pid: process.pid, port: 4711, url: 'http://127.0.0.1:4711' });
  expect(state.lockAddress).toBe(lock.lockAddress);
  await lock.release();
  await expect(fs.stat(lockPath)).rejects.toMatchObject({ code: 'ENOENT' });
});

test('a stale lock file left behind by a crash does not block acquiring', async () => {
  const dataDir = await tmpDataDirWithFreePorts(1);
  // The file is display only. Whatever it says, only the handle decides.
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

test('releaseSync() frees the lock for the next acquire', async () => {
  const dataDir = await tmpDataDir();
  const first = await acquire(dataDir, { port: 4711 });
  first.releaseSync();
  // releaseSync() exists for process.on('exit'), where nothing can be
  // awaited; the close it starts still has to actually unbind.
  await new Promise((resolve) => setTimeout(resolve, 50));
  const second = await acquire(dataDir, { port: 4712 });
  expect(second.lockAddress).toBe(first.lockAddress);
});
