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
  LOCK_PORT_BASE,
  LOCK_PORT_RANGE,
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

function listenTarget(target) {
  return typeof target === 'string' ? { path: target } : { host: '127.0.0.1', ...target };
}

/**
 * `target` is either a pipe name or `{ port }` (plus an optional host).
 *
 * The host goes INSIDE the options object: `listen({ port }, '127.0.0.1', cb)`
 * silently drops the host and binds the wildcard, and a wildcard bind does not
 * conflict with a 127.0.0.1 bind on Windows — which quietly turned several of
 * these tests into no-ops until it was caught.
 */
function listenOnce(target) {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(listenTarget(target), () => resolve(server));
  });
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
 * A temp data dir whose derived port is genuinely free.
 *
 * There is no fallback port any more, so a busy machine (or an OS-reserved
 * block) would otherwise make a test fail for a reason it is not about.
 */
async function tmpDataDirWithFreePort() {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const dir = await tmpDataDir();
    if (await isBindable({ port: lockPortFor(dir) })) return dir;
  }
  throw new Error('could not find a temp data dir with a free derived port');
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

/** Runs a child to completion and collects its exit code and streams. */
function runChild(source) {
  const child = spawn(process.execPath, ['--input-type=module', '-e', source], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  children.push(child);
  return new Promise((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    child.on('error', reject);
    child.on('exit', (code) => resolve({ code, stdout, stderr }));
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

  test(on('concurrent acquires on one dataDir: exactly one wins, the rest are told who holds it'), async () => {
    const dataDir = await tmpDataDir();
    // There is one address and binding it is the decision, so there is no
    // interleaving to lose: whoever the OS grants the bind to is the holder,
    // and the others find that holder at the only place it can be. The
    // review's two-starter race lived entirely in the fallback walk, where
    // the losers landed on a different port and never looked back down.
    const results = await Promise.allSettled(
      Array.from({ length: 5 }, (_, i) =>
        acquireInstanceLock({ dataDir, port: 5000 + i, platform, greetingTimeoutMs: FAST_GREETING_MS }),
      ),
    );
    const won = results.filter((r) => r.status === 'fulfilled');
    expect(won).toHaveLength(1);
    for (const lost of results.filter((r) => r.status === 'rejected')) {
      expect(lost.reason).toBeInstanceOf(InstanceLockHeldError);
    }
    await won[0].value.release();
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
    // exactly like an unresponsive stranger. Reading that as "somebody else,
    // move along" would put two kaprek instances on one data dir.
    const { message } = await spawnChild(jammedHolderSource(dataDir, 4611, platform, 5000));
    // The child reports ready, then jams on a short timer. Waiting past that
    // timer is what makes this test about a jammed holder rather than a race
    // with one that is still answering.
    await new Promise((resolve) => setTimeout(resolve, 200));
    await expect(acquire(dataDir, { port: 4612, platform })).rejects.toThrow(/Refusing to start/);
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

  test(on('a refused start leaves the address free for whoever should have it'), async () => {
    const dataDir = await tmpDataDir();
    const target = transport === PIPE ? lockPipePathFor(dataDir) : { port: lockPortFor(dataDir) };
    const squatter = await listenForeign(target, () => {});
    await expect(acquire(dataDir, { port: 4711, platform })).rejects.toThrow(/Refusing to start/);

    // In the CLI the process exit hides this, but a library caller (or a test
    // like this one) would be left with the refusing process holding the very
    // address it just said it could not have.
    servers = servers.filter((s) => s !== squatter);
    await closeServer(squatter);
    expect(await isBindable(target)).toBe(true);
  });
}

// ---------------------------------------------------------------------------
// Who is on the address, and what that licenses. There is no next address, so
// every answer other than "our own instance" ends the start.
// ---------------------------------------------------------------------------

test('the probe talks to the same IP stack the holder bound, not to whatever answers on ::1', async () => {
  const dataDir = await tmpDataDirWithFreePort();
  const port = lockPortFor(dataDir);
  let ipv6;
  try {
    ipv6 = await listenForeign({ port, host: '::1' }, (socket) => socket.end('HTTP/1.1 200 OK\r\n\r\n'));
  } catch {
    return; // no IPv6 loopback on this machine, nothing to prove
  }
  expect(ipv6.address().address).toBe('::1');

  const holder = await acquire(dataDir, { port: 4711 });
  expect(holder.lockPort).toBe(port);

  // net.connect({ port }) without a host defaults to 'localhost', which
  // resolves ::1 first — the probe would have interviewed the stranger above
  // and declared our own healthy holder a foreign service.
  await expect(acquire(dataDir, { port: 4712 })).rejects.toMatchObject({
    name: 'InstanceLockHeldError',
    url: 'http://127.0.0.1:4711',
  });
});

test('a greeting naming another data dir ends the start, it does not move the lock', async () => {
  const dataDir = await tmpDataDirWithFreePort();
  const port = lockPortFor(dataDir);
  // Two data dir paths deriving one port used to send this start to port+1.
  // That fallback is what the two-holder races lived in, so a hash collision
  // is now a refusal with an explanation instead.
  await listenForeign({ port }, (socket) => socket.end(foreignGreeting()));
  await expect(acquire(dataDir, { port: 4711 })).rejects.toThrow(/different data directory/);
  expect(await isBindable({ port: port + 1 })).toBe(true);
});

test('a service that says something other than a greeting ends the start', async () => {
  const dataDir = await tmpDataDirWithFreePort();
  const port = lockPortFor(dataDir);
  await listenForeign({ port }, (socket) => socket.end('HTTP/1.1 200 OK\r\n\r\n<html>hi</html>'));
  await expect(acquire(dataDir, { port: 4711 })).rejects.toThrow(/not kaprek answers there/);
  expect(await isBindable({ port: port + 1 })).toBe(true);
});

test('a peer that will not stop talking is a service too', async () => {
  const dataDir = await tmpDataDirWithFreePort();
  const port = lockPortFor(dataDir);
  // Our greeting is one short line; a flood is somebody else's protocol.
  await listenForeign({ port }, (socket) => socket.write('x'.repeat(MAX_GREETING_BYTES + 100)));
  await expect(acquire(dataDir, { port: 4711 })).rejects.toThrow(/not kaprek answers there/);
});

test('something that accepts but never speaks ends the start after its retries', async () => {
  const dataDir = await tmpDataDirWithFreePort();
  const port = lockPortFor(dataDir);
  let connections = 0;
  // Silence is exactly what a blocked kaprek holder produces, so it proves
  // nothing — and the retries have to actually happen before refusing.
  await listenForeign({ port }, () => {
    connections += 1;
  });
  await expect(acquire(dataDir, { port: 4711 })).rejects.toThrow(/did not answer in/);
  expect(connections).toBe(GREETING_ATTEMPTS);
});

test('a greeting that arrives too late ends the start, it is not read as a stranger', async () => {
  const dataDir = await tmpDataDirWithFreePort();
  const port = lockPortFor(dataDir);
  await listenForeign({ port }, (socket) => {
    const timer = setTimeout(() => socket.end(foreignGreeting()), FAST_GREETING_MS * 20);
    socket.on('close', () => clearTimeout(timer));
  });
  await expect(acquire(dataDir, { port: 4711 })).rejects.toThrow(/did not answer in/);
});

test('an answer cut off mid-line is not evidence about who is speaking', async () => {
  const dataDir = await tmpDataDirWithFreePort();
  const port = lockPortFor(dataDir);
  // Half a line and then silence: the peer never finished its sentence, so
  // there is nothing to classify. Note the difference to the service tests
  // above, where the peer said its piece and closed.
  await listenForeign({ port }, (socket) => socket.write('{"kaprek":1,"dataDirHa'));
  await expect(acquire(dataDir, { port: 4711 })).rejects.toThrow(/did not answer in/);
});

test('a squatter that goes away mid-question does not cost the start', async () => {
  const dataDir = await tmpDataDirWithFreePort();
  const port = lockPortFor(dataDir);
  const squatter = await listenForeign({ port }, () => {});
  // Frees the address while the first round is still asking. The retry
  // re-runs listen(), so "the holder shut down while we were asking" ends in
  // a successful bind instead of a refusal on a free address.
  setTimeout(() => {
    servers = servers.filter((s) => s !== squatter);
    squatter.close();
  }, FAST_GREETING_MS);
  const lock = await acquire(dataDir, { port: 4711 });
  expect(lock.lockPort).toBe(port);
});

test.skipIf(process.platform !== 'win32')(
  'the pipe transport refuses the same way, with no second name to try',
  async () => {
    const dataDir = await tmpDataDir();
    await listenForeign(lockPipePathFor(dataDir), (socket) => socket.end(foreignGreeting()));
    await expect(acquire(dataDir, { port: 4711, platform: PIPE.platform })).rejects.toThrow(
      /different data directory/,
    );
  },
);

// ---------------------------------------------------------------------------
// A refusal has to be loud. The CLI runs without a test runner holding its
// event loop open, so this one needs a real child process.
// ---------------------------------------------------------------------------

test('a refused acquire exits non-zero with its message instead of dying silently', async () => {
  const dataDir = await tmpDataDirWithFreePort();
  const port = lockPortFor(dataDir);
  // Everything the acquire owns is unref'd — the lock server, the probe
  // sockets — so an unref'd retry timer used to empty the event loop between
  // attempts. The process then exited 0 with no output, in the middle of a
  // fail-closed decision. Under vitest the runner's own loop hides that,
  // hence a real child.
  const source = `
import net from 'node:net';
import { acquireInstanceLock } from ${JSON.stringify(MODULE_URL)};
const squatter = net.createServer((socket) => socket.unref());
squatter.unref();
squatter.listen({ port: ${port}, host: '127.0.0.1' }, async () => {
  try {
    await acquireInstanceLock({ dataDir: ${JSON.stringify(dataDir)}, platform: 'linux' });
    process.stdout.write('ACQUIRED\\n');
  } catch (err) {
    process.stderr.write('REFUSED: ' + err.message + '\\n');
    process.exitCode = 1;
  }
});
`;
  const { code, stderr } = await runChild(source);
  expect(stderr).toContain('Refusing to start');
  expect(code).toBe(1);
});

// ---------------------------------------------------------------------------
// Address derivation and path identity.
// ---------------------------------------------------------------------------

test('the derived port stays inside the documented range, clear of both ephemeral ranges', async () => {
  const parent = await tmpDataDir();
  for (let i = 0; i < 100; i += 1) {
    const dir = path.join(parent, `spread-${i}`);
    await fs.mkdir(dir);
    const port = lockPortFor(dir);
    expect(port).toBeGreaterThanOrEqual(LOCK_PORT_BASE);
    // Below Linux's ephemeral floor (32768) and far below Windows' (49152),
    // so an outbound connection's source port can never land on a lock port.
    expect(port).toBeLessThan(Math.min(LOCK_PORT_BASE + LOCK_PORT_RANGE, 32768));
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

test.skipIf(process.platform !== 'win32')(
  'a junction to the same directory derives the same lock and blocks it',
  async () => {
    const dataDir = await tmpDataDir();
    const link = path.join(await tmpDataDir(), 'link');
    try {
      execFileSync('cmd', ['/c', 'mklink', '/J', link, dataDir], { stdio: 'ignore' });
    } catch {
      return; // junctions not creatable here, nothing to prove
    }
    // Two names for one physical directory used to derive two locks and let
    // both start — a launcher shortcut using the short name is enough.
    expect(lockPortFor(link)).toBe(lockPortFor(dataDir));
    expect(lockPipePathFor(link)).toBe(lockPipePathFor(dataDir));
    await acquire(dataDir, { port: 4711 });
    await expect(acquire(link, { port: 4712 })).rejects.toBeInstanceOf(InstanceLockHeldError);
  },
);

// 8.3 short names and `subst` drives are deliberately NOT tested separately:
// both are resolved by the same realpathSync.native call the junction test
// above exercises, and every way of producing one in a test either depends on
// per-volume 8.3 generation being enabled or leaves machine state behind. A
// test that quietly skips itself is worse than an honest note here.

// ---------------------------------------------------------------------------
// OS-reserved addresses. With no fallback, a reserved port is a refusal with
// its own reason rather than something to step over.
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

test('a lock port the OS has reserved is refused with that as the reason', async () => {
  const range = await reservedRange();
  if (!range) {
    // No reserved range inside 23000-31999 on this machine (the range was
    // chosen partly to avoid them), so there is nothing to exercise here.
    return;
  }
  const parent = await tmpDataDir();
  let dataDir;
  for (let i = 0; i < 2_000_000 && !dataDir; i += 1) {
    const candidate = path.join(parent, `d${i}`);
    await fs.mkdir(candidate);
    if (lockPortFor(candidate) === range.start) dataDir = candidate;
    else await fs.rm(candidate, { recursive: true, force: true });
  }
  expect(dataDir, 'no directory name hashed onto the reserved port').toBeDefined();
  await expect(acquire(dataDir, { port: 4711 })).rejects.toThrow(/operating system has reserved/);
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
  const dataDir = await tmpDataDirWithFreePort();
  // The file is display only. Whatever it says, only the handle decides.
  await fs.writeFile(
    path.join(dataDir, 'instance.lock'),
    JSON.stringify({ pid: process.pid, port: 4711, url: 'http://127.0.0.1:4711' }),
  );
  const lock = await acquire(dataDir, { port: 4712 });
  expect(lock.lockPort).toBe(lockPortFor(dataDir));
});

test('a corrupt lock file does not block acquiring either', async () => {
  const dataDir = await tmpDataDirWithFreePort();
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
