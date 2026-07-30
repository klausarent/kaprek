// Single-instance lock, one per `dataDir` — held by a bound loopback socket.
//
// Without this, a second double-click of the launcher silently falls back to
// basePort+1 (see bin/cli.mjs::startWithPortRetry) and ends up with two
// servers pointed at the same ~/.kaprek: two separate `pendingApprovals`
// maps, duplicate file-watch triggers, and trigger caps that only read a
// shared runs.jsonl and so do not hold under the race.
//
// WHY a socket and not a lock file. The first three attempts at this module
// were file leases (`fs.open(..., 'wx')` plus mtime staleness, a pid probe, a
// heartbeat, and a rename-based takeover for abandoned locks). Each review
// round closed one race and opened the next — see task-1-review.md,
// task-1-rereview.md, task-1-rereview2.md under
// .superpowers/sdd/2026-07-30-tag4-unbeaufsichtigt/. They share one root
// cause: a file outlives the process that made it, so something has to decide
// when it is abandoned, so there has to be a takeover, and a takeover built
// from several non-atomic filesystem steps always has a window in the middle.
//
// A listening socket has no such window. It dies with the process — SIGKILL,
// power loss, a debugger detaching, all the same — so there is no staleness
// clock, no heartbeat, no takeover, and nothing to clean up afterwards. The
// OS refuses the second bind for us. Empirically verified on this repo's
// Node 22.22.0/Windows and asserted on every run by the first two tests in
// instance-lock.test.mjs (in-process and cross-process): the second listen()
// on the same 127.0.0.1 address gets EADDRINUSE. libuv does not set
// SO_REUSEADDR on Windows at all, and on POSIX SO_REUSEADDR still does not
// let two sockets listen on one address (that would need SO_REUSEPORT).
//
// `instance.lock` is still written, but it is DISPLAY ONLY: something for a
// human to open when they wonder what is running. No decision about
// exclusivity reads it, and nothing here trusts it. Do not hang logic on it
// again — every failure this module has had came from that direction.
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import net from 'node:net';
import path from 'node:path';

/** Start of the IANA dynamic/private port range — nothing registered lives here. */
export const LOCK_PORT_BASE = 49152;
/** Width of the derived-port space. 49152+16000 leaves headroom below 65535 for the walk below. */
export const LOCK_PORT_RANGE = 16000;
/** How many candidate ports may be occupied by foreign software before we give up. */
export const LOCK_PORT_ATTEMPTS = 20;
/** How far the walk may reach in total, including ports the OS reserved (see EACCES below). */
export const LOCK_PORT_WINDOW = 256;
/** Read budget for the holder's greeting. Foreign software that accepts but never speaks must not stall a start. */
export const GREETING_TIMEOUT_MS = 500;
/** Anything longer than this without a newline is not our greeting; stop reading. */
export const MAX_GREETING_BYTES = 4096;

const LOCK_HOST = '127.0.0.1';
const LOCK_FILE = 'instance.lock';

export class InstanceLockHeldError extends Error {
  constructor({ pid, url }) {
    super(`kaprek is already running (pid ${pid}${url ? `, ${url}` : ''})`);
    this.name = 'InstanceLockHeldError';
    this.pid = pid;
    this.url = url;
  }
}

function urlFor(port) {
  return typeof port === 'number' ? `http://127.0.0.1:${port}` : null;
}

/**
 * The identity two starts have to agree on. `path.resolve` collapses `..`,
 * relative paths and trailing separators; Windows paths are additionally
 * lowercased because `C:\Users\x` and `c:\users\x` are the same directory
 * there and must not derive two different ports.
 */
function normalizeDataDir(dataDir) {
  const resolved = path.resolve(dataDir);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function digestFor(dataDir) {
  return crypto.createHash('sha256').update(normalizeDataDir(dataDir)).digest();
}

/** The first port an instance on `dataDir` tries to claim. Pure — no filesystem access. */
export function lockPortFor(dataDir) {
  return LOCK_PORT_BASE + (digestFor(dataDir).readUInt32BE(0) % LOCK_PORT_RANGE);
}

/**
 * Binds `server` to `port`, or reports why not.
 *
 * EADDRINUSE means someone is there and we get to ask who. EACCES means the
 * OS reserved the port and nobody can bind it: Windows hands whole blocks of
 * the dynamic range to Hyper-V/WinNAT, and `netsh int ipv4 show
 * excludedportrange protocol=tcp` on this machine lists five such blocks
 * inside 49152-65151, up to 100 ports wide. A reserved port is neither free
 * nor held, so the walk steps over it without spending one of the
 * LOCK_PORT_ATTEMPTS. Both processes see the same reservations, so the walk
 * stays deterministic. Anything else is unexpected and propagates: refusing
 * to start beats guessing.
 */
function tryListen(server, port) {
  return new Promise((resolve, reject) => {
    function onError(err) {
      server.removeListener('listening', onListening);
      if (err.code === 'EADDRINUSE' || err.code === 'EACCES') {
        resolve(err.code);
        return;
      }
      reject(err);
    }
    function onListening() {
      server.removeListener('error', onError);
      resolve(null);
    }
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(port, LOCK_HOST);
  });
}

function parseGreeting(raw, dataDirHash) {
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || parsed.kaprek !== 1 || parsed.dataDirHash !== dataDirHash) return null;
  return { pid: parsed.pid, url: typeof parsed.url === 'string' ? parsed.url : null };
}

/**
 * Asks whoever holds `port` whether they are a kaprek on OUR dataDir.
 *
 * Returns the holder's `{ pid, url }`, or null for everything else — no
 * answer, a timeout, garbage, or a greeting whose hash belongs to a different
 * data dir. Null means "not our lock", never "no lock": reporting "kaprek is
 * already running" because some unrelated program happens to sit on a port in
 * the dynamic range would be a lie the user cannot act on.
 */
function probeGreeting(port, dataDirHash, timeoutMs) {
  return new Promise((resolve) => {
    const socket = net.connect({ port, host: LOCK_HOST });
    socket.setEncoding('utf8');
    let buffer = '';
    let settled = false;

    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(value);
    };
    const timer = setTimeout(() => finish(null), timeoutMs);
    timer.unref();

    socket.on('data', (chunk) => {
      buffer += chunk;
      const newline = buffer.indexOf('\n');
      if (newline !== -1) finish(parseGreeting(buffer.slice(0, newline), dataDirHash));
      else if (buffer.length > MAX_GREETING_BYTES) finish(null);
    });
    // A holder that closed after writing its line without a trailing newline
    // still gave us everything it had.
    socket.on('end', () => finish(parseGreeting(buffer, dataDirHash)));
    socket.on('error', () => finish(null));
    socket.on('close', () => finish(null));
  });
}

/**
 * Acquires the single-instance lock for `dataDir`, throwing
 * InstanceLockHeldError if another kaprek already holds it. `dataDir` must
 * already exist (see src/lib/appdir.mjs) — this module neither resolves nor
 * creates it, it only normalizes the path for hashing.
 *
 * `port` may be undefined at call time: bin/cli.mjs acquires the lock before
 * it knows which port startWithPortRetry() will land on, then calls
 * `updatePort()` once the server is actually listening. Until then the
 * greeting carries `url: null`, and the CLI says "already starting" rather
 * than printing a URL that does not exist yet.
 */
export async function acquireInstanceLock({ dataDir, port, greetingTimeoutMs = GREETING_TIMEOUT_MS }) {
  const digest = digestFor(dataDir);
  const dataDirHash = digest.toString('hex');
  const basePort = LOCK_PORT_BASE + (digest.readUInt32BE(0) % LOCK_PORT_RANGE);
  const lockPath = path.join(dataDir, LOCK_FILE);
  const startedAt = Date.now();
  let currentPort = port;
  let boundPort;
  let released = false;

  const sockets = new Set();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    // The lock must never be the reason this process stays alive, and a peer
    // that never closes its own half would otherwise keep a referenced handle
    // around forever.
    socket.unref();
    socket.on('error', () => {});
    socket.on('close', () => sockets.delete(socket));
    const linger = setTimeout(() => socket.destroy(), greetingTimeoutMs);
    linger.unref();
    socket.once('close', () => clearTimeout(linger));
    socket.end(
      `${JSON.stringify({ kaprek: 1, dataDirHash, pid: process.pid, url: urlFor(currentPort) })}\n`,
    );
  });
  server.unref();

  function shutdownServer() {
    for (const socket of sockets) socket.destroy();
    sockets.clear();
    return new Promise((resolve) => server.close(() => resolve()));
  }

  /**
   * Looks for a kaprek on OUR dataDir sitting ABOVE the port we just bound.
   *
   * It can happen: foreign software occupied the base port when the first
   * instance started, that instance settled on base+1, and by the time the
   * second start runs the foreign software is gone. Without this scan the
   * second start would bind the now-free base port and cheerfully run as a
   * second instance on the same data dir — the exact failure this module
   * exists to prevent, reached through the fallback that exists to avoid a
   * false "already running". Ports below ours cannot hold one: the walk
   * already asked each of them.
   */
  async function findHolderAbove(fromIndex) {
    const candidates = [];
    for (let i = fromIndex + 1; i <= fromIndex + LOCK_PORT_ATTEMPTS && i < LOCK_PORT_WINDOW; i += 1) {
      candidates.push(basePort + i);
    }
    // In parallel: on a healthy machine every one of these is a closed port
    // answering ECONNREFUSED in well under a millisecond, and the start path
    // should not pay for them one at a time.
    const holders = await Promise.all(
      candidates.map((candidate) => probeGreeting(candidate, dataDirHash, greetingTimeoutMs)),
    );
    return holders.find((holder) => holder !== null) ?? null;
  }

  let occupiedByOthers = 0;
  for (let index = 0; index < LOCK_PORT_WINDOW; index += 1) {
    if (occupiedByOthers >= LOCK_PORT_ATTEMPTS) break;
    const candidate = basePort + index;
    const failure = await tryListen(server, candidate);

    if (failure === 'EACCES') continue;

    if (failure === 'EADDRINUSE') {
      const holder = await probeGreeting(candidate, dataDirHash, greetingTimeoutMs);
      if (holder) throw new InstanceLockHeldError(holder);
      occupiedByOthers += 1;
      continue;
    }

    const holderAbove = await findHolderAbove(index);
    if (holderAbove) {
      await shutdownServer();
      throw new InstanceLockHeldError(holderAbove);
    }
    boundPort = candidate;
    break;
  }

  if (boundPort === undefined) {
    await shutdownServer();
    throw new Error(
      `Could not claim the kaprek instance lock: every candidate port from ${basePort} upwards is ` +
        `occupied by other software (${LOCK_PORT_ATTEMPTS} tried). Close whatever is using them, or ` +
        'start kaprek against a different data directory.',
    );
  }

  // Past this point the lock is held. Errors the socket reports afterwards
  // (a peer resetting mid-greeting, say) are not this process's problem and
  // must not take down a running server.
  server.on('error', () => {});

  /**
   * Display only — see the module header. Best-effort on purpose: a data dir
   * that cannot be written to is a real problem, but it is the server's
   * problem to report, and failing the start here would make a file that
   * decides nothing able to veto a start.
   */
  async function writeLockFile() {
    const state = {
      pid: process.pid,
      port: currentPort ?? null,
      url: urlFor(currentPort),
      lockPort: boundPort,
      startedAt,
      note: 'display only; exclusivity is held by the lockPort socket, see src/lib/instance-lock.mjs',
    };
    await fs.writeFile(lockPath, JSON.stringify(state)).catch(() => {});
  }

  await writeLockFile();

  return {
    /** The port actually claimed. Exposed for diagnostics and tests, not used for any decision. */
    lockPort: boundPort,

    /** Records the real server port, which is what the greeting reports from here on. */
    async updatePort(newPort) {
      if (released) return;
      currentPort = newPort;
      await writeLockFile();
    },

    async release() {
      if (released) return;
      released = true;
      await shutdownServer();
      // No ownership check needed: unlike the lease version, there is no
      // takeover that could have handed this path to someone else while we
      // held it, and the file decides nothing either way.
      await fs.unlink(lockPath).catch(() => {});
    },

    /**
     * Synchronous best-effort twin of release(), for process.on('exit') (see
     * bin/cli.mjs), where nothing can be awaited. server.close() only starts
     * the unbind here, which is fine: the process is on its way out, and the
     * OS closes the socket when it goes.
     */
    releaseSync() {
      if (released) return;
      released = true;
      for (const socket of sockets) socket.destroy();
      sockets.clear();
      server.close();
      try {
        fsSync.unlinkSync(lockPath);
      } catch {
        // best-effort, same reasoning as writeLockFile()
      }
    },
  };
}
