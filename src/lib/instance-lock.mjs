// Single-instance lock, one per `dataDir` — held by an OS handle that dies
// with the process.
//
// Without this, a second double-click of the launcher silently falls back to
// basePort+1 (see bin/cli.mjs::startWithPortRetry) and ends up with two
// servers pointed at the same ~/.kaprek: two separate `pendingApprovals`
// maps, duplicate file-watch triggers, and trigger caps that only read a
// shared runs.jsonl and so do not hold under the race.
//
// WHY not a lock file. The first three attempts at this module were file
// leases (`fs.open(..., 'wx')` plus mtime staleness, a pid probe, a heartbeat,
// and a rename-based takeover for abandoned locks). Each review round closed
// one race and opened the next — see task-1-review.md, task-1-rereview.md,
// task-1-rereview2.md under .superpowers/sdd/2026-07-30-tag4-unbeaufsichtigt/.
// They share one root cause: a file outlives the process that made it, so
// something has to decide when it is abandoned, so there has to be a
// takeover, and a takeover built from several non-atomic filesystem steps
// always has a window in the middle.
//
// A bound listening handle has no such window. It dies with the process —
// SIGKILL, power loss, a debugger detaching, all the same — so there is no
// staleness clock, no heartbeat, no takeover, and nothing to clean up. The OS
// refuses the second bind for us.
//
// TWO TRANSPORTS, because the right handle differs per platform:
//
//   Windows -> a named pipe, `\\.\pipe\kaprek-<dataDirHash>`. libuv creates
//   the first instance with FILE_FLAG_FIRST_PIPE_INSTANCE, so a second bind
//   of the same name gets EADDRINUSE; the name has no port, so it cannot
//   collide with the ephemeral range (49152-65535 on Windows) where an
//   outbound connection's source port could otherwise sit on our lock port
//   and keep kaprek from starting. Verified on this machine, Node 22.22.0 /
//   libuv 1.51.0: second listen EADDRINUSE, cross-process EADDRINUSE, and the
//   name is free again immediately after the holder is SIGKILLed.
//
//   POSIX -> TCP on 127.0.0.1, port derived from the data dir path inside
//   23000-31999: above the well-known ports, below the Linux ephemeral range
//   that starts at 32768. libuv sets SO_REUSEADDR there, which still does not
//   let two sockets listen on one address (that would need SO_REUSEPORT,
//   which listen() below turns off explicitly rather than trusting a
//   default).
//
// Deliberately NOT a Unix domain socket with a filesystem path: the socket
// file survives SIGKILL, which brings staleness detection — and with it the
// whole takeover problem — straight back. Abstract sockets would avoid that
// but exist only on Linux.
//
// KNOWN LIMIT, deliberately not papered over: on Windows libuv sets neither
// SO_REUSEADDR nor SO_EXCLUSIVEADDRUSE, and a named pipe's ACL still allows a
// same-user process to interfere. This lock stops accidental double starts —
// a second double-click, a second launcher, a shortcut left in Autostart. It
// is not a defence against hostile local code, which is the same boundary the
// instance token already lives on (src/server/token.mjs). Do not promise more
// than that in the README.
//
// WHAT AN OCCUPIED ADDRESS MEANS — four cases, and the line between them is
// whether anything was actually said:
//
//   1. A valid greeting naming OUR dataDirHash -> that is our own instance,
//      already running. Report it with its pid and url.
//   2. A valid greeting naming a DIFFERENT hash -> another kaprek whose data
//      dir landed on the same derived port. Step aside, take the next port.
//   3. Data arrives that is not a kaprek greeting at all -> a foreign
//      service. This is provable because the holder writes its greeting as
//      the very first statement of its connection handler, with nothing
//      awaited before it: a kaprek that can talk to us at all talks kaprek.
//      Step aside, take the next port.
//   4. NOTHING is said — a timeout, an empty close, a reset, a half line that
//      never finishes — then nothing is proven. That is also exactly what a
//      live holder looks like while its event loop is blocked, its GC is
//      running, or a virus scanner has it pinned. Reading it as "foreign
//      software, move along" would hand a second lock for the same data dir
//      to a process that is merely busy, which is the failure the file leases
//      kept producing, reached through a new door. So case 4 is re-asked a
//      few times on the SAME address and then refuses the start. Never a
//      fallback.
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

/** First TCP port of the derived range: above the well-known ports, below Linux's ephemeral 32768. */
export const LOCK_PORT_BASE = 23000;
/** Width of the derived-port space. 23000+9000 stays clear of the ephemeral ranges on both platforms. */
export const LOCK_PORT_RANGE = 9000;
/** How many candidate ports may be proven to belong to another data dir before we give up. */
export const LOCK_PORT_ATTEMPTS = 20;
/** How far the walk may reach in total, including ports the OS reserved (see EACCES in tryListen). */
export const LOCK_PORT_WINDOW = 256;
/** Windows lock namespace. The hash goes in the name, so there is no port to collide with. */
export const PIPE_PREFIX = '\\\\.\\pipe\\kaprek-';
/** Read budget for one greeting. An address that accepts but never speaks must not stall a start indefinitely. */
export const GREETING_TIMEOUT_MS = 500;
/** How often an unclear answer is re-asked (bind included) before the start is refused. */
export const GREETING_ATTEMPTS = 3;
/** Pause between those attempts — long enough for a briefly blocked holder to get its turn. */
export const GREETING_RETRY_DELAY_MS = 150;
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
 * there and must not derive two different locks.
 */
function normalizeDataDir(dataDir) {
  const resolved = path.resolve(dataDir);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function digestFor(dataDir) {
  return crypto.createHash('sha256').update(normalizeDataDir(dataDir)).digest();
}

/** The first TCP port an instance on `dataDir` tries to claim. Pure — no filesystem access. */
export function lockPortFor(dataDir) {
  return LOCK_PORT_BASE + (digestFor(dataDir).readUInt32BE(0) % LOCK_PORT_RANGE);
}

/** The Windows pipe name an instance on `dataDir` claims. Pure — no filesystem access. */
export function lockPipePathFor(dataDir) {
  return `${PIPE_PREFIX}${digestFor(dataDir).toString('hex')}`;
}

/** True where the named pipe is the right handle. Injectable so the TCP path stays testable on Windows. */
function usesPipe(platform) {
  return platform === 'win32';
}

/** How an address is named in an error a user has to act on. */
function describeTarget(target) {
  return target.path ?? `${LOCK_HOST}:${target.port}`;
}

// The four things a probe can establish, matching the four cases in the
// module header. OURS and FOREIGN are answers; REFUSED proves nobody is
// listening; UNCLEAR is the absence of an answer, and it is the only one that
// refuses the start.
const PROBE_OURS = 'ours';
const PROBE_FOREIGN = 'foreign';
const PROBE_REFUSED = 'refused';
const PROBE_UNCLEAR = 'unclear';

/**
 * Binds `server` to `target`, or reports why not.
 *
 * EADDRINUSE means someone is there and we get to ask who. EACCES usually
 * means the OS reserved the address and nobody may bind it: Windows hands
 * whole blocks of the dynamic port range to Hyper-V/WinNAT (`netsh int ipv4
 * show excludedportrange protocol=tcp` listed five such blocks, up to 100
 * ports wide, on the machine this was built on — all above 47000, so outside
 * the range used here, but the derived range is not guaranteed clear of them
 * on every machine). Such a port is neither free nor held, so the walk steps
 * over it without spending one of the LOCK_PORT_ATTEMPTS — but only after a
 * probe confirms nothing is listening there, since EACCES can also come from
 * a foreign socket bound with SO_EXCLUSIVEADDRUSE. Anything else is
 * unexpected and propagates: refusing to start beats guessing.
 */
function tryListen(server, target) {
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
    // reusePort is off by default, but this lock's whole guarantee is that the
    // second bind fails, so the option that would turn that guarantee off is
    // stated rather than assumed. It is TCP-only, hence not passed for a pipe.
    server.listen(target.path ? { path: target.path } : { ...target, host: LOCK_HOST, reusePort: false });
  });
}

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms).unref());

/**
 * Classifies something that was actually said (cases 1-3 in the module
 * header). Only a greeting naming our own hash is OURS; everything else that
 * arrived as data belongs to somebody else, whether it is another kaprek's
 * greeting or an HTTP banner.
 *
 * Callers must not route silence through here — "no bytes at all" is case 4
 * and stays UNCLEAR.
 */
function classifySpokenData(raw, dataDirHash) {
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { kind: PROBE_FOREIGN };
  }
  if (!parsed || parsed.kaprek !== 1 || typeof parsed.dataDirHash !== 'string') {
    return { kind: PROBE_FOREIGN };
  }
  if (parsed.dataDirHash !== dataDirHash) return { kind: PROBE_FOREIGN };
  return { kind: PROBE_OURS, pid: parsed.pid, url: typeof parsed.url === 'string' ? parsed.url : null };
}

/**
 * Asks whoever holds `target` who they are, once.
 *
 * ECONNREFUSED (TCP) and ENOENT (pipe) are the one negative answer that
 * proves something rather than merely failing to prove anything: nothing is
 * listening. That is what an OS-reserved port answers, and the walk relies on
 * it to step over reserved blocks.
 *
 * A line that arrives complete, or a peer that says something and then closes
 * cleanly, is a statement and gets classified. A timeout is not, even with
 * half a line in the buffer: an answer we cut off mid-sentence is not
 * evidence about who is speaking.
 */
function probeOnce(target, dataDirHash, timeoutMs) {
  return new Promise((resolve) => {
    const socket = net.connect(target);
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
    const timer = setTimeout(() => finish({ kind: PROBE_UNCLEAR }), timeoutMs);
    timer.unref();

    socket.on('data', (chunk) => {
      buffer += chunk;
      const newline = buffer.indexOf('\n');
      if (newline !== -1) finish(classifySpokenData(buffer.slice(0, newline), dataDirHash));
      // Our greeting is one short line. Anything still talking past this is a
      // service with something else to say.
      else if (buffer.length > MAX_GREETING_BYTES) finish({ kind: PROBE_FOREIGN });
    });
    // A peer that closed after writing its line without a trailing newline
    // still gave us everything it had. An empty close said nothing at all.
    socket.on('end', () => {
      finish(buffer.length > 0 ? classifySpokenData(buffer, dataDirHash) : { kind: PROBE_UNCLEAR });
    });
    socket.on('error', (err) => {
      const nothingThere = err.code === 'ECONNREFUSED' || err.code === 'ENOENT';
      finish({ kind: nothingThere ? PROBE_REFUSED : PROBE_UNCLEAR });
    });
    socket.on('close', () => finish({ kind: PROBE_UNCLEAR }));
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
 *
 * `platform` selects the transport and defaults to the real one. Tests pass
 * it explicitly so the TCP path can be exercised on Windows too, where the
 * default is the named pipe.
 */
export async function acquireInstanceLock({
  dataDir,
  port,
  platform = process.platform,
  greetingTimeoutMs = GREETING_TIMEOUT_MS,
}) {
  const digest = digestFor(dataDir);
  const dataDirHash = digest.toString('hex');
  const lockPath = path.join(dataDir, LOCK_FILE);
  const startedAt = Date.now();
  let currentPort = port;
  let boundTarget;
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
    // First statement in the handler, nothing awaited before it: a caller
    // that has to wait on our event loop to schedule an async step before it
    // hears anything is a caller that may time out and refuse to start.
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
   * Settles one lock address: bound, proven to belong to another data dir,
   * reserved by the OS, or — when it stays unclear across GREETING_ATTEMPTS —
   * a refusal to start.
   *
   * The retry re-runs listen() as well as the probe, which is what makes the
   * one genuinely transient case self-heal: a holder that exits between our
   * failed bind and our probe leaves EADDRINUSE followed by
   * ECONNREFUSED/ENOENT, and the next round simply binds the address.
   */
  async function claimTarget(target) {
    for (let attempt = 1; attempt <= GREETING_ATTEMPTS; attempt += 1) {
      const failure = await tryListen(server, target);
      if (failure === null) return 'bound';

      const answer = await probeOnce(target, dataDirHash, greetingTimeoutMs);
      if (answer.kind === PROBE_OURS) throw new InstanceLockHeldError(answer);
      if (answer.kind === PROBE_FOREIGN) return 'foreign';
      // Nothing is listening and nobody may bind it: an OS-reserved address
      // (see tryListen). Decisive, so no retry — and it cannot be hiding a
      // kaprek, because a listening holder produces EADDRINUSE, not EACCES.
      if (answer.kind === PROBE_REFUSED && failure === 'EACCES') return 'reserved';

      if (attempt < GREETING_ATTEMPTS) await delay(GREETING_RETRY_DELAY_MS);
    }
    throw new Error(
      `Refusing to start: something holds ${describeTarget(target)}, the instance lock for this data ` +
        `directory, but did not answer with a valid kaprek greeting in ${GREETING_ATTEMPTS} attempts. ` +
        'That is also what a running kaprek looks like while it is blocked or overloaded, and starting ' +
        'a second one on the same data directory would corrupt its state. Stop whatever holds it, or ' +
        'start kaprek against a different data directory.',
    );
  }

  /**
   * Looks for a kaprek on OUR dataDir sitting ABOVE the port we just bound.
   *
   * It can happen: a kaprek on a different data dir held the base port when
   * the first instance started, that instance settled on base+1, and by the
   * time the second start runs the other one is gone. Without this scan the
   * second start would bind the now-free base port and cheerfully run as a
   * second instance on the same data dir — the exact failure this module
   * exists to prevent, reached through the fallback that exists to avoid a
   * false "already running". Ports below ours cannot hold one: the walk
   * already asked each of them.
   *
   * Best-effort on purpose, and this is the one place that is: an unclear
   * answer here is ignored rather than refusing the start. These are ports we
   * have no claim to, up to 20 of them on every single start, so letting any
   * slow-to-speak program on the machine block kaprek would trade a rare
   * failure for a frequent one. The fail-closed rule belongs on the walk,
   * where the address is actually ours to claim.
   */
  async function findHolderAbove(basePort, fromIndex) {
    const candidates = [];
    for (let i = fromIndex + 1; i <= fromIndex + LOCK_PORT_ATTEMPTS && i < LOCK_PORT_WINDOW; i += 1) {
      candidates.push({ port: basePort + i });
    }
    // In parallel: on a healthy machine every one of these is a closed port
    // answering ECONNREFUSED in well under a millisecond, and the start path
    // should not pay for them one at a time.
    const answers = await Promise.all(
      candidates.map((candidate) => probeOnce(candidate, dataDirHash, greetingTimeoutMs)),
    );
    return answers.find((answer) => answer.kind === PROBE_OURS) ?? null;
  }

  /** The Windows path: one name, no fallback, because the name already carries the hash. */
  async function claimPipe() {
    const target = { path: lockPipePathFor(dataDir) };
    const outcome = await claimTarget(target);
    if (outcome === 'bound') return target;
    // 'foreign' means a valid kaprek greeting naming a different data dir
    // arrived on a name that is derived from OUR hash, and 'reserved' means
    // the OS handed the name out to someone else. Neither is a state to walk
    // around: there is no second name to try.
    throw new Error(
      `Refusing to start: ${describeTarget(target)} is held by something that is not this data ` +
        "directory's kaprek. Stop whatever holds it, or start kaprek against a different data directory.",
    );
  }

  /** The POSIX path: walk upward from the derived port. */
  async function claimPort() {
    const basePort = lockPortFor(dataDir);
    let spokenFor = 0;

    for (let index = 0; index < LOCK_PORT_WINDOW; index += 1) {
      if (spokenFor >= LOCK_PORT_ATTEMPTS) break;
      const target = { port: basePort + index };
      const outcome = await claimTarget(target);

      if (outcome === 'reserved') continue;
      if (outcome === 'foreign') {
        spokenFor += 1;
        continue;
      }

      const holderAbove = await findHolderAbove(basePort, index);
      if (holderAbove) throw new InstanceLockHeldError(holderAbove);
      return target;
    }

    throw new Error(
      `Could not claim the kaprek instance lock: ${LOCK_PORT_ATTEMPTS} candidate ports from ` +
        `${basePort} upwards are all answered by other software or by kaprek instances running on ` +
        'other data directories. Stop one of them, or start kaprek against a different data directory.',
    );
  }

  try {
    boundTarget = usesPipe(platform) ? await claimPipe() : await claimPort();
  } catch (err) {
    // Covers every exit above, including the one where findHolderAbove()
    // rejects us after our own bind already succeeded.
    await shutdownServer();
    throw err;
  }

  // Past this point the lock is held. Errors the handle reports afterwards (a
  // peer resetting mid-greeting, say) are not this process's problem and must
  // not take down a running server.
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
      lockAddress: describeTarget(boundTarget),
      startedAt,
      note: 'display only; exclusivity is held by the lockAddress handle, see src/lib/instance-lock.mjs',
    };
    await fs.writeFile(lockPath, JSON.stringify(state)).catch(() => {});
  }

  await writeLockFile();

  return {
    /** The TCP port actually claimed, or null on the pipe transport. Diagnostics only. */
    lockPort: boundTarget.port ?? null,
    /** Human-readable form of whatever handle is held. Diagnostics only, never a decision. */
    lockAddress: describeTarget(boundTarget),

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
     * OS closes the handle when it goes.
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
