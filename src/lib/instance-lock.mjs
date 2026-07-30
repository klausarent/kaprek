// Single-instance lease lock, one per `dataDir`.
//
// Without this, a second double-click of the launcher silently falls back to
// basePort+1 (see bin/cli.mjs::startWithPortRetry) and ends up with two
// servers pointed at the same ~/.kaprek: two separate `pendingApprovals`
// maps, duplicate file-watch triggers, and trigger caps that only read a
// shared runs.jsonl and so do not hold under the race. This module makes
// "one kaprek per data dir" an enforced invariant instead of a README note.
//
// A bare PID check is not enough on Windows, where PIDs get reused quickly
// enough that "this pid is running" does not mean "this pid is still ME". So
// the holder re-writes the lock file's mtime every LOCK_HEARTBEAT_MS
// (setInterval(...).unref(), so the heartbeat itself never keeps the process
// alive) and a lock only counts as abandoned when BOTH the mtime is older
// than LOCK_STALE_MS AND process.kill(pid, 0) reports ESRCH. Either signal
// alone is unreliable on its own: a frozen-but-alive holder would otherwise
// get its own lock stolen from under it the moment its heartbeat is merely
// late.
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';

export const LOCK_HEARTBEAT_MS = 5_000;
export const LOCK_STALE_MS = 15_000;

const LOCK_FILE = 'instance.lock';

// Bounds the "lock file vanished between our EEXIST and our read" retry (a
// concurrent release(), not a takeover race — see readHolder()). Real
// contention resolves in one or two iterations; this only guards against a
// pathological loop, it is not expected to ever bind in practice.
const MAX_VANISH_RETRIES = 5;

export class InstanceLockHeldError extends Error {
  constructor({ pid, port, url, startedAt }) {
    super(`kaprek is already running (pid ${pid}${url ? `, ${url}` : ''})`);
    this.name = 'InstanceLockHeldError';
    this.pid = pid;
    this.port = port;
    this.url = url;
    this.startedAt = startedAt;
  }
}

function lockPathFor(dataDir) {
  return path.join(dataDir, LOCK_FILE);
}

function urlFor(port) {
  return typeof port === 'number' ? `http://127.0.0.1:${port}` : null;
}

/**
 * process.kill(pid, 0) sends no signal, it only probes existence. ESRCH means
 * "no such process" (dead). EPERM means it exists but belongs to another
 * user (alive). Anything else is treated as alive too — fail toward refusing
 * to steal a lock over guessing, since two live servers on one dataDir is the
 * failure this module exists to prevent.
 */
function isPidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code !== 'ESRCH';
  }
}

/**
 * Reads and validates the current lock holder's state plus the file's mtime
 * (the staleness clock, not a field inside the JSON — a copied or restored
 * file must not carry a stale timestamp forward as if it were fresh).
 *
 * Returns undefined if the file is gone by the time we get to read it (lost
 * to a concurrent release(), not evidence of anything to steal). Throws on
 * anything else unreadable: fail-closed per the "never silently overwrite a
 * lock we cannot make sense of" requirement.
 */
async function readHolder(lockPath) {
  let raw;
  let stat;
  try {
    raw = await fs.readFile(lockPath, 'utf8');
    stat = await fs.stat(lockPath);
  } catch (err) {
    if (err.code === 'ENOENT') return undefined;
    throw err;
  }

  let state;
  try {
    state = JSON.parse(raw);
  } catch {
    throw new Error(`Corrupt instance lock at ${lockPath}: not valid JSON`);
  }
  if (typeof state.pid !== 'number' || typeof state.nonce !== 'string') {
    throw new Error(`Corrupt instance lock at ${lockPath}: missing pid/nonce`);
  }
  return { state, mtimeMs: stat.mtimeMs };
}

/**
 * Acquires the single-instance lock for `dataDir`, throwing
 * InstanceLockHeldError if a live (or not-yet-provably-dead) holder already
 * has it. `dataDir` must already exist (see src/lib/appdir.mjs) — this
 * module does not resolve or create it.
 *
 * `port` may be omitted/undefined at call time: bin/cli.mjs acquires the
 * lock before it knows which port startWithPortRetry() will land on, then
 * calls the returned `updatePort()` once the server is actually listening.
 */
export async function acquireInstanceLock({ dataDir, port, nowFn = Date.now, heartbeatMs = LOCK_HEARTBEAT_MS }) {
  const lockPath = lockPathFor(dataDir);
  const nonce = crypto.randomUUID();
  const startedAt = nowFn();
  let currentPort = port;

  function ownState() {
    return { pid: process.pid, port: currentPort, nonce, startedAt, url: urlFor(currentPort) };
  }

  async function writeOwn() {
    await fs.writeFile(lockPath, JSON.stringify(ownState()));
  }

  // The heartbeat ONLY refreshes mtime, it never rewrites content. A content
  // rewrite (`fs.writeFile` truncates, then writes) opens a window where a
  // concurrent reader sees an empty file, JSON.parse('') throws, and a
  // perfectly healthy running server gets reported as "Corrupt instance
  // lock". Content only ever changes through updatePort(), which is rare
  // (once, right after startServer() resolves) — the heartbeat's only job is
  // proving liveness to LOCK_STALE_MS, and mtime alone does that.
  async function touch() {
    const now = new Date();
    await fs.utimes(lockPath, now, now);
  }

  function holderError(s) {
    return new InstanceLockHeldError({
      pid: s.pid,
      port: s.port,
      url: s.url ?? urlFor(s.port),
      startedAt: s.startedAt,
    });
  }

  /**
   * `canSteal` allows exactly one takeover per acquire call, per the design
   * doc: if the rename below loses the re-create race anyway, the winner's
   * lock is reported as a normal live holder rather than re-evaluated for
   * staleness a second time.
   */
  async function attempt(canSteal, vanishRetriesLeft) {
    try {
      const handle = await fs.open(lockPath, 'wx');
      try {
        await handle.writeFile(JSON.stringify(ownState()));
      } finally {
        await handle.close();
      }
      return;
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
    }

    const holder = await readHolder(lockPath);
    if (holder === undefined) {
      if (vanishRetriesLeft <= 0) {
        throw new Error(`Instance lock at ${lockPath} kept disappearing while acquiring`);
      }
      return attempt(canSteal, vanishRetriesLeft - 1);
    }

    const { state, mtimeMs } = holder;
    const orphaned = nowFn() - mtimeMs > LOCK_STALE_MS && !isPidAlive(state.pid);

    if (orphaned && canSteal) {
      // Takeover via an atomic rename, not unlink+recreate: two starters
      // racing the same orphaned lock could both `unlink` successfully (the
      // call does not check what it is deleting), so the second one would
      // delete the FIRST one's freshly-created lock and then win its own
      // `wx` too — two live holders. `fs.rename` gives exactly one winner
      // the destination for a given source path.
      //
      // The loser's rename does NOT reliably throw, though — verified with
      // an isolated `Promise.allSettled([fs.rename(src, destA),
      // fs.rename(src, destB)])` repro on this repo's Windows/Node 22: both
      // promises fulfilled, but only one of destA/destB actually existed
      // afterward. So "our rename resolved" is not proof we hold the file;
      // only a successful read of OUR OWN destination is.
      const stealPath = `${lockPath}.steal-${nonce}`;
      try {
        await fs.rename(lockPath, stealPath);
      } catch (err) {
        if (err.code === 'ENOENT') {
          // Beaten to the rename by another starter's steal (or a
          // concurrent release()) — not our takeover to finish. Retry with
          // no further steal rights, per "genau einmal übernehmen".
          return attempt(false, vanishRetriesLeft);
        }
        throw err;
      }

      // Confirm we actually moved the orphaned lock we verified above, not
      // a fresh one that a different starter wrote to lockPath between our
      // read and our rename (rename moves whatever is currently at the
      // path, it does not check content) — and confirm our rename actually
      // landed at all, per the platform quirk noted above.
      let stolenRaw;
      try {
        stolenRaw = await fs.readFile(stealPath, 'utf8');
      } catch (err) {
        if (err.code === 'ENOENT') {
          return attempt(false, vanishRetriesLeft);
        }
        throw err;
      }
      let stolenState;
      try {
        stolenState = JSON.parse(stolenRaw);
      } catch {
        stolenState = null;
      }

      if (stolenState?.nonce !== state.nonce) {
        // Wrong file — hand it back and report the holder we actually
        // grabbed (accurate and current), not the stale one we originally
        // read.
        await fs.rename(stealPath, lockPath);
        throw holderError(stolenState ?? state);
      }

      await fs.unlink(stealPath).catch((err) => {
        if (err.code !== 'ENOENT') throw err;
      });
      return attempt(false, vanishRetriesLeft);
    }

    throw holderError(state);
  }

  await attempt(true, MAX_VANISH_RETRIES);

  const timer = setInterval(() => {
    // Best-effort: a transient failure self-heals on the next tick, and a
    // permanent one (e.g. dataDir removed) surfaces as an orphaned lock to
    // the next starter, which is the correct fail-open-to-recovery outcome
    // rather than crashing an otherwise-healthy running server.
    touch().catch(() => {});
  }, heartbeatMs);
  timer.unref();

  let released = false;

  return {
    /** Rewrites the lock with the now-known real port. See the doc comment above on why port starts undefined. */
    async updatePort(newPort) {
      if (released) return;
      currentPort = newPort;
      await writeOwn();
    },
    /**
     * Only deletes the file if it still holds OUR nonce — otherwise a slow
     * release() racing a legitimate takeover (our heartbeat lapsed past
     * LOCK_STALE_MS while we were, say, blocked in I/O) could delete the
     * NEXT holder's lock instead of our own.
     */
    async release() {
      if (released) return;
      released = true;
      clearInterval(timer);
      let raw;
      try {
        raw = await fs.readFile(lockPath, 'utf8');
      } catch (err) {
        if (err.code === 'ENOENT') return;
        throw err;
      }
      let state;
      try {
        state = JSON.parse(raw);
      } catch {
        return;
      }
      if (state.nonce !== nonce) return;
      await fs.unlink(lockPath).catch((err) => {
        if (err.code !== 'ENOENT') throw err;
      });
    },
    /**
     * Synchronous best-effort twin of release(), for process.on('exit')
     * (see bin/cli.mjs): 'exit' handlers cannot await, so this uses the
     * fs sync API instead of fs/promises. Same nonce check, same
     * fail-silent-on-anything-unexpected posture — a swallowed error here
     * just leaves the lock for LOCK_STALE_MS to reclaim, never worse.
     */
    releaseSync() {
      if (released) return;
      released = true;
      clearInterval(timer);
      let raw;
      try {
        raw = fsSync.readFileSync(lockPath, 'utf8');
      } catch {
        return;
      }
      let state;
      try {
        state = JSON.parse(raw);
      } catch {
        return;
      }
      if (state.nonce !== nonce) return;
      try {
        fsSync.unlinkSync(lockPath);
      } catch {
        // best-effort
      }
    },
  };
}
