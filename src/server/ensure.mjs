// Makes kaprek run without anyone having to remember to start it. Called
// from the SessionStart hook (see src/policy/hook-session-start.mjs), this
// checks whether an instance is already up for `dataDir` and, if not, spawns
// one detached and returns immediately — it never waits for the spawned
// process to finish coming up, because a session opening in a terminal must
// not be held up by kaprek starting (see the hook's own self-timeout).
//
// A second instance starting alongside a live one costs nothing: the
// instance lock (src/lib/instance-lock.mjs) refuses the second bind on its
// own, so this module does not need to be exactly right about "is it
// running" — it only needs to be fast and never throw. A false "not running"
// leads to a harmless extra spawn attempt; a false "running" just means the
// next SessionStart tries again.
import { spawn as nodeSpawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';

const LOCK_FILE = 'instance.lock';
const DEFAULT_TIMEOUT_MS = 300;

/**
 * The lock file's `{ pid, url }`, or null if the file is missing, unreadable,
 * or does not name a pid. `url` may be null (the narrow window between a
 * process acquiring the lock and learning its port — see
 * acquireInstanceLock() in instance-lock.mjs). Display-only file: this never
 * decides exclusivity, only whether it is worth probing before spawning.
 */
export function readInstanceLock(dataDir) {
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(dataDir, LOCK_FILE), 'utf8'));
    if (!parsed || typeof parsed.pid !== 'number') return null;
    const url = typeof parsed.url === 'string' && /^https?:\/\//.test(parsed.url) ? parsed.url : null;
    return { pid: parsed.pid, url };
  } catch {
    return null;
  }
}

/**
 * TCP-connects to `url`'s port on 127.0.0.1 as a liveness probe. kaprek has
 * no unauthenticated health route — every API route requires the instance
 * token (src/server/token.mjs) — so accepting the connection at all is what
 * "something is listening here" means; the socket is destroyed immediately
 * either way. Resolves false on a bad url, a refused connection, or a
 * timeout; never rejects.
 */
export function defaultIsAlive(url, timeoutMs = DEFAULT_TIMEOUT_MS) {
  return new Promise((resolve) => {
    let port;
    try {
      port = Number(new URL(url).port);
    } catch {
      resolve(false);
      return;
    }
    if (!Number.isInteger(port) || port <= 0) {
      resolve(false);
      return;
    }
    let settled = false;
    const socket = net.connect({ port, host: '127.0.0.1' });
    const finish = (value) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(value);
    };
    const timer = setTimeout(() => finish(false), timeoutMs);
    timer.unref?.();
    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
  });
}

/**
 * Ensures a kaprek server is running for `dataDir`, spawning one detached if
 * not. Never throws and never awaits the spawned server actually coming up.
 *
 * `cliPath` must be the absolute path to this package's own `bin/cli.mjs` —
 * callers resolve it relative to their own module (see
 * hook-session-start.mjs) rather than this module guessing a relative path
 * from itself, which would break the moment either file moves.
 *
 * Opt-out: `KAPREK_NO_AUTOSTART=1` skips everything, including the aliveness
 * check, and returns `{ skipped: true }`.
 */
export async function ensureServerRunning({
  dataDir,
  spawn = nodeSpawn,
  execPath = process.execPath,
  cliPath,
  isAlive = defaultIsAlive,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  env = process.env,
}) {
  if (env.KAPREK_NO_AUTOSTART === '1') return { skipped: true };

  const lock = readInstanceLock(dataDir);
  if (lock && lock.url) {
    let alive = false;
    try {
      alive = await isAlive(lock.url, timeoutMs);
    } catch {
      alive = false;
    }
    if (alive) return { running: true, url: lock.url };
  }

  try {
    const child = spawn(execPath, [cliPath, '--no-open'], { detached: true, stdio: 'ignore', windowsHide: true });
    child.unref();
    return { started: true, pid: child.pid };
  } catch {
    // A failed spawn attempt is not this caller's problem to surface — see
    // the module header on why "fast and never throw" matters more here
    // than "always right".
    return { skipped: true };
  }
}
