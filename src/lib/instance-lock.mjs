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
// ONE DATA DIR, ONE ADDRESS, NO FALLBACK. That is the whole protocol, and the
// reason it is this short is that the fourth round of review found three
// separate ways to end up with two holders — and all three lived in the
// fallback walk that existed for the rare case of somebody else sitting on
// our address: a probe that reached a different IP stack than the holder had
// bound, a scan that stepped over a busy holder, and a time-of-check /
// time-of-use hole where two starters landed on different ports and neither
// looked where the other was. Every one of them was a special path for a rare
// case, which is the same shape as the file lease's takeover dance.
//
// So there is no walk. The address for a data dir is derived, and it is the
// only address that data dir ever uses:
//
//   Windows -> a named pipe, `\\.\pipe\kaprek-<dataDirHash>`. libuv creates
//   the first instance with FILE_FLAG_FIRST_PIPE_INSTANCE, so a second bind
//   of the same name gets EADDRINUSE; the name has no port, so it cannot
//   collide with the ephemeral range (49152-65535 on Windows) where an
//   outbound connection's source port could otherwise sit on our lock port.
//   Verified on this machine, Node 22.22.0 / libuv 1.51.0: second listen
//   EADDRINUSE in-process and cross-process, name free again immediately
//   after the holder is SIGKILLed, unserved name answers ENOENT.
//
//   POSIX -> TCP on 127.0.0.1, port derived from the data dir path inside
//   23000-31999: above the well-known ports, below the Linux ephemeral range
//   that starts at 32768. libuv sets SO_REUSEADDR there, which still does not
//   let two sockets listen on one address (that would need SO_REUSEPORT,
//   which listen() below turns off explicitly rather than trusting a
//   default). NOT MEASURED ON A REAL POSIX KERNEL: the TCP path is exercised
//   on Windows through the injectable `platform` option, and libuv does not
//   set SO_REUSEADDR there, so those green runs do not prove the POSIX
//   semantics. The first two tests in instance-lock.test.mjs are ungated and
//   will produce that proof on the first Linux/macOS run. Until then this
//   paragraph is a documented assumption, not a measurement.
//
// Deliberately NOT a Unix domain socket with a filesystem path: the socket
// file survives SIGKILL, which brings staleness detection — and with it the
// whole takeover problem — straight back. Abstract sockets would avoid that
// but exist only on Linux.
//
// WHY TWO CONCURRENT STARTS CANNOT BOTH WIN. Both contend for one address.
// The OS grants exactly one bind, and binding IS the decision — there is no
// second step to interleave with, and no other address either of them could
// have taken instead. The loser's bind fails, it asks who is there, and it
// either learns it is us (already running) or refuses to start. That property
// is what the walk destroyed: with a fallback, "is anyone else here" becomes
// a question about a moving set of addresses, answered at a time that is
// already in the past by the moment anybody binds.
//
// WHAT AN OCCUPIED ADDRESS MEANS — three outcomes, and the line between them
// is whether anything was actually said:
//
//   1. A valid greeting naming OUR dataDirHash -> that is our own instance,
//      already running. Report it with its pid and url.
//   2. Anything else that is actually SAID — another kaprek's greeting for a
//      different data dir, an HTTP banner, a flood of bytes. Somebody else
//      owns the address. We do not move: refuse the start and say so.
//   3. NOTHING is said — a timeout, an empty close, a reset, a half line that
//      never finishes — then nothing is proven. That is also exactly what a
//      live holder looks like while its event loop is blocked, its GC is
//      running, or a virus scanner has it pinned. Re-ask a few times on the
//      SAME address, then refuse.
//
// KNOWN LIMITS, deliberately not papered over:
//   - On Windows libuv sets neither SO_REUSEADDR nor SO_EXCLUSIVEADDRUSE, and
//     a named pipe's ACL still allows a same-user process to interfere. Any
//     local program can also squat the derived port or pipe name and stay
//     silent, which blocks every start for that data dir. This lock stops
//     accidental double starts — a second double-click, a second launcher, a
//     shortcut left in Autostart. It is not a defence against hostile local
//     code, which is the same boundary the instance token already lives on
//     (src/server/token.mjs). Do not promise more than that in the README.
//   - The pipe namespace is machine-wide, not per-user. If two Windows
//     accounts point KAPREK_DATA_DIR at the same directory, the second one's
//     probe can be refused by the pipe ACL (EPERM); the refusal message names
//     that possibility rather than blaming a busy holder.
//   - Two data dirs whose paths hash to the same port block each other on
//     POSIX (roughly 1 in LOCK_PORT_RANGE for any given pair). The second one
//     refuses to start and says why. That is the price of having no fallback,
//     and the remedy is the same as for any other occupied address: use a
//     different data directory path.
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
 * The identity two starts have to agree on.
 *
 * `realpathSync.native` is what makes that agreement hold for the same
 * physical directory reached by different names: it resolves junctions,
 * symlinks, 8.3 short names (`C:\Users\SOMEBO~1\...`, which is what
 * os.tmpdir() hands back on some Windows setups) and `subst` drives through
 * the OS itself, and it returns the on-disk casing. Without it, a launcher
 * shortcut using the short name and a session using the long one derive two
 * different locks for one directory and both start — reproduced in review.
 *
 * The lowercase pass is kept for win32 on top of that, because the fallback
 * below can still return a lexical path. It is deliberately NOT applied on
 * darwin: the default APFS volume is case-insensitive, but case-sensitive
 * ones exist, and realpath already reports the true on-disk casing wherever
 * the directory exists. NFC normalization is applied everywhere, because
 * macOS hands out NFD-encoded paths that compare unequal to the NFC spelling
 * of the same name.
 *
 * The ENOENT fallback covers callers asking about a directory that does not
 * exist yet — `lockPortFor()` as a diagnostic, mostly. In production
 * `ensureAppDir()` (src/lib/appdir.mjs) has already created it, so the
 * canonical form is always available on the path that matters. Any other
 * realpath failure propagates rather than silently degrading the identity.
 */
function normalizeDataDir(dataDir) {
  const resolved = path.resolve(dataDir);
  let canonical;
  try {
    canonical = fsSync.realpathSync.native(resolved);
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
    canonical = resolved;
  }
  const normalized = canonical.normalize('NFC');
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

function digestFor(dataDir) {
  return crypto.createHash('sha256').update(normalizeDataDir(dataDir)).digest();
}

/** The TCP port an instance on `dataDir` claims — the only one it ever claims. */
export function lockPortFor(dataDir) {
  return LOCK_PORT_BASE + (digestFor(dataDir).readUInt32BE(0) % LOCK_PORT_RANGE);
}

/** The Windows pipe name an instance on `dataDir` claims. */
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

// What a probe can establish. OURS and SPOKEN are answers; REFUSED proves
// nobody is listening; SILENT is the absence of an answer.
const PROBE_OURS = 'ours';
const PROBE_SPOKEN = 'spoken';
const PROBE_REFUSED = 'refused';
const PROBE_SILENT = 'silent';

/**
 * Binds `server` to `target`, or reports why not.
 *
 * EADDRINUSE means someone is there and we get to ask who. EACCES usually
 * means the OS reserved the address and nobody may bind it: Windows hands
 * whole blocks of the dynamic port range to Hyper-V/WinNAT, and hardened
 * POSIX systems can raise `ip_unprivileged_port_start` or refuse binds by
 * policy. Anything else is unexpected and propagates: refusing to start beats
 * guessing.
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

// Not unref'd, and that is load-bearing. An unref'd timer here empties the
// event loop while a start is still deciding: the lock server is unref'd, the
// probe sockets are gone, and bin/cli.mjs's main() is a floating promise — so
// the process exited 0 with no output instead of finishing its attempts and
// refusing loudly. A silent, success-looking death is not fail-closed. This
// timer only ever runs inside an in-flight acquire, so keeping it referenced
// cannot hold a process open any longer than the acquire itself.
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Classifies something that was actually said. Only a greeting naming our own
 * hash is OURS; everything else that arrived as data belongs to somebody
 * else, whether it is another kaprek's greeting or an HTTP banner.
 *
 * Callers must not route silence through here — "no bytes at all" proves
 * nothing and stays SILENT.
 *
 * `kaprek: 1` is a protocol version, and versions meet across upgrades: while
 * one is installed over another, a running holder can be older than the
 * starter asking. A future bump must therefore EXTEND this greeting rather
 * than replace the field — a v1 starter facing a `kaprek: 2` holder would
 * land in SPOKEN here and refuse with "a program that is not kaprek", which
 * is fail-closed but a lie. Keep `kaprek: 1` and add alongside it.
 */
function classifySpokenData(raw, dataDirHash) {
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { kind: PROBE_SPOKEN };
  }
  if (!parsed || parsed.kaprek !== 1 || typeof parsed.dataDirHash !== 'string') {
    return { kind: PROBE_SPOKEN };
  }
  if (parsed.dataDirHash !== dataDirHash) return { kind: PROBE_SPOKEN, otherDataDir: true };
  // version/startedAt arrived with P2's update verification. An older holder
  // does not send them (see the protocol-version note above), and that is
  // fine: the caller reports "unknown version" instead of guessing. Same
  // extension rule as `kaprek: 1` itself — add alongside, never replace.
  return {
    kind: PROBE_OURS,
    pid: parsed.pid,
    url: typeof parsed.url === 'string' ? parsed.url : null,
    version: typeof parsed.version === 'string' ? parsed.version : undefined,
    startedAt: typeof parsed.startedAt === 'string' ? parsed.startedAt : undefined,
  };
}

/**
 * Asks whoever holds `target` who they are, once.
 *
 * The host is pinned to LOCK_HOST for TCP rather than left to Node's default.
 * `net.connect({ port })` defaults to 'localhost', which resolves to ::1
 * first on Windows and on RFC-6724-sorting glibc alike — so the probe would
 * interview whatever sits on [::1]:port while the holder is bound to
 * 127.0.0.1:port. Review reproduced exactly that: a healthy holder read as a
 * stranger because an unrelated IPv6-only dev server answered instead.
 *
 * ECONNREFUSED (TCP) and ENOENT (pipe) are the one negative answer that
 * proves something rather than merely failing to prove anything: nothing is
 * listening. A line that arrives complete, or a peer that says something and
 * then closes cleanly, is a statement and gets classified. A timeout is not,
 * even with half a line buffered: an answer cut off mid-sentence is no
 * evidence about who is speaking.
 */
function probeOnce(target, dataDirHash, timeoutMs) {
  return new Promise((resolve) => {
    const socket = net.connect(target.path ? target : { ...target, host: LOCK_HOST });
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
    const timer = setTimeout(() => finish({ kind: PROBE_SILENT }), timeoutMs);
    timer.unref();

    socket.on('data', (chunk) => {
      buffer += chunk;
      const newline = buffer.indexOf('\n');
      if (newline !== -1) finish(classifySpokenData(buffer.slice(0, newline), dataDirHash));
      // Our greeting is one short line. Anything still talking past this is a
      // service with something else to say.
      else if (buffer.length > MAX_GREETING_BYTES) finish({ kind: PROBE_SPOKEN });
    });
    socket.on('end', () => {
      finish(buffer.length > 0 ? classifySpokenData(buffer, dataDirHash) : { kind: PROBE_SILENT });
    });
    socket.on('error', (err) => {
      const nothingThere = err.code === 'ECONNREFUSED' || err.code === 'ENOENT';
      // EPERM/EACCES on connect: the address exists but this account may not
      // talk to it — see the multi-user note in the module header. The code is
      // carried through so the refusal can name the real reason.
      finish({ kind: nothingThere ? PROBE_REFUSED : PROBE_SILENT, code: err.code });
    });
    socket.on('close', () => finish({ kind: PROBE_SILENT }));
  });
}

/**
 * Asks the instance holding `dataDir`'s lock address who it is — one question,
 * one answer, outside of any start.
 *
 * This is the SAME loopback path the start path uses (probeOnce against the
 * derived pipe/port, same greeting classification); it exists so code that is
 * not starting a server — `kaprek update` wanting to know which version is
 * still running — can ask without growing a second transport. A refusal or
 * silence means nothing is proven, which here simply means: no instance to
 * report. A stranger on the address is likewise not our instance.
 *
 * @returns {Promise<{running: boolean, pid?: number, url?: ?string, version?: string, startedAt?: string}>}
 */
export async function askInstance({
  dataDir,
  platform = process.platform,
  timeoutMs = GREETING_TIMEOUT_MS,
}) {
  const digest = digestFor(dataDir);
  const dataDirHash = digest.toString('hex');
  const target = usesPipe(platform)
    ? { path: `${PIPE_PREFIX}${dataDirHash}` }
    : { port: LOCK_PORT_BASE + (digest.readUInt32BE(0) % LOCK_PORT_RANGE) };
  const answer = await probeOnce(target, dataDirHash, timeoutMs);
  if (answer.kind !== PROBE_OURS) return { running: false };
  return { running: true, pid: answer.pid, url: answer.url, version: answer.version, startedAt: answer.startedAt };
}

/**
 * Acquires the single-instance lock for `dataDir`, throwing
 * InstanceLockHeldError if another kaprek already holds it. `dataDir` should
 * already exist (see src/lib/appdir.mjs) — this module neither resolves nor
 * creates it, it only canonicalizes the path for hashing.
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
  version,
  platform = process.platform,
  greetingTimeoutMs = GREETING_TIMEOUT_MS,
}) {
  const digest = digestFor(dataDir);
  const dataDirHash = digest.toString('hex');
  const lockPath = path.join(dataDir, LOCK_FILE);
  const startedAt = new Date().toISOString();
  const target = usesPipe(platform)
    ? { path: `${PIPE_PREFIX}${dataDirHash}` }
    : { port: LOCK_PORT_BASE + (digest.readUInt32BE(0) % LOCK_PORT_RANGE) };
  const address = describeTarget(target);
  let currentPort = port;
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
    // The greeting EXTENDS rather than replaces: an older starter facing this
    // holder must still read it as OURS (see classifySpokenData). version is
    // omitted entirely when unknown so a pre-P2 starter sees exactly the old
    // shape; startedAt is always present.
    socket.end(
      `${JSON.stringify({
        kaprek: 1,
        dataDirHash,
        pid: process.pid,
        url: urlFor(currentPort),
        ...(version !== undefined ? { version } : {}),
        startedAt,
      })}\n`,
    );
  });
  server.unref();

  function shutdownServer() {
    for (const socket of sockets) socket.destroy();
    sockets.clear();
    return new Promise((resolve) => server.close(() => resolve()));
  }

  function refuse(reason) {
    return new Error(
      `Refusing to start: ${address} is the instance lock for this data directory, and ${reason} ` +
        'Starting a second kaprek on the same data directory would corrupt its state, so this start is ' +
        'refused rather than moved elsewhere. Stop whatever holds the address, or start kaprek against ' +
        'a different data directory.',
    );
  }

  /**
   * Claims the one address for this data dir, or explains why it could not.
   *
   * The retry re-runs listen() as well as the probe, which is what makes the
   * transient cases self-heal: a holder that exits between our failed bind
   * and our probe leaves EADDRINUSE followed by ECONNREFUSED/ENOENT, and the
   * next round simply binds. REFUSED has its own budget for that reason —
   * counting it against the silence budget would turn "the holder shut down
   * while we were asking" into a refusal on an address that is free.
   */
  async function claim() {
    let silentRounds = 0;
    let refusedRounds = 0;
    // Remembered across rounds, not read off the last one: the rounds can
    // disagree. Two EPERM answers followed by a plain timeout would otherwise
    // print the generic message and drop the one detail that explains it.
    let sawAccessDenied = false;

    while (refusedRounds < GREETING_ATTEMPTS) {
      const failure = await tryListen(server, target);
      if (failure === null) return;

      const answer = await probeOnce(target, dataDirHash, greetingTimeoutMs);

      if (answer.kind === PROBE_OURS) throw new InstanceLockHeldError(answer);

      if (answer.kind === PROBE_SPOKEN) {
        throw refuse(
          answer.otherDataDir
            ? 'another kaprek instance running on a different data directory answers there (two data ' +
              'directory paths can derive the same port).'
            : 'a program that is not kaprek answers there.',
        );
      }

      if (answer.kind === PROBE_REFUSED) {
        // Nothing is listening. With EACCES that is the OS holding the
        // address against everyone; without it, the holder went away between
        // our bind attempt and our question, so try to bind again.
        if (failure === 'EACCES') {
          throw refuse('the operating system has reserved that address, so no process may bind it.');
        }
        refusedRounds += 1;
        await delay(GREETING_RETRY_DELAY_MS);
        continue;
      }

      silentRounds += 1;
      if (answer.code === 'EPERM' || answer.code === 'EACCES') sawAccessDenied = true;
      if (silentRounds >= GREETING_ATTEMPTS) {
        throw refuse(
          sawAccessDenied
            ? 'something holds it that this user account may not talk to — most likely another account ' +
              'on this machine running kaprek against the same data directory.'
            : `something holds it that did not answer in ${GREETING_ATTEMPTS} attempts. That is what a ` +
              'running kaprek looks like while it is blocked or overloaded, and also what another ' +
              "kaprek's own HTTP server looks like if it was started with --port set to this port.",
        );
      }
      await delay(GREETING_RETRY_DELAY_MS);
    }

    throw refuse('it kept flipping between occupied and free while we were asking.');
  }

  try {
    await claim();
  } catch (err) {
    // Covers every exit above. Nothing here binds and then throws today, but
    // a start that refuses must never leave the address claimed either way.
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
      lockAddress: address,
      startedAt,
      note: 'display only; exclusivity is held by the lockAddress handle, see src/lib/instance-lock.mjs',
    };
    await fs.writeFile(lockPath, JSON.stringify(state)).catch(() => {});
  }

  await writeLockFile();

  return {
    /** The TCP port actually claimed, or null on the pipe transport. Diagnostics only. */
    lockPort: target.port ?? null,
    /** Human-readable form of whatever handle is held. Diagnostics only, never a decision. */
    lockAddress: address,

    /** Records the real server port, which is what the greeting reports from here on. */
    async updatePort(newPort) {
      if (released) return;
      currentPort = newPort;
      await writeLockFile();
      // Checked again on the far side of the await: release() can run to
      // completion while that write is in flight, and its unlink then happens
      // before our write lands. The file would come back as a corpse naming a
      // pid that has stopped holding anything. It decides nothing either way
      // (see the module header), so this is tidiness, not safety.
      if (released) await fs.unlink(lockPath).catch(() => {});
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
