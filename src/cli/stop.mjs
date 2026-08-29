// `kaprek stop` — the other half of the lifecycle that autostart introduced
// (see src/server/ensure.mjs): a server that starts itself needs a plain way
// to end it too, since there is no longer a terminal window with Ctrl+C in
// it. Dependencies are injected so this is testable without a real process
// to kill; bin/cli.mjs passes the real lock reader, `process.kill`, and the
// port-liveness probe ensure.mjs already has.
const POLL_INTERVAL_MS = 100;
const POLL_TIMEOUT_MS = 2000;

export const STOP_USAGE = `Usage: kaprek stop

Stops the kaprek server running for this data directory, if any:
reads its instance lock, ends the process, and waits up to 2 seconds
for it to actually let go before removing the lock file.

Not running? Prints that and exits 0 — stopping something that is
already stopped is not an error.
`;

/** Whether `pid` still answers, via `kill(pid, 0)` — throws means gone. */
function pidAlive(kill, pid) {
  try {
    kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Whether the server is still up: the port if we know it, the pid otherwise. */
async function stillRunning({ pid, url }, { kill, isAlive }) {
  if (url) {
    try {
      return await isAlive(url);
    } catch {
      return false;
    }
  }
  return pidAlive(kill, pid);
}

/**
 * `kaprek stop`. `deps.readLock()` returns `{ pid, url }` or null/undefined
 * (see src/server/ensure.mjs::readInstanceLock, which bin/cli.mjs binds
 * here). `deps.kill` mirrors `process.kill(pid, signal?)` — called with
 * signal `0` to probe, with no signal to actually end the process (on
 * win32 that terminates unconditionally, same as `process.kill(pid)`
 * always has). `deps.isAlive` mirrors ensure.mjs's TCP probe.
 */
export async function runStopCommand(
  argv,
  {
    readLock,
    kill,
    isAlive,
    unlink,
    sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    now = Date.now,
    stdout = (line) => console.log(line),
    stderr = (line) => console.error(line),
  },
) {
  if (argv[0] === '-h' || argv[0] === '--help') {
    stdout(STOP_USAGE);
    return 0;
  }
  if (argv.length > 0) {
    stderr(`unknown argument: ${argv[0]}`);
    stderr(STOP_USAGE);
    return 1;
  }

  const lock = readLock();
  if (!lock || typeof lock.pid !== 'number') {
    stdout('kaprek is not running');
    return 0;
  }

  if (!pidAlive(kill, lock.pid)) {
    stdout('kaprek is not running');
    try {
      unlink();
    } catch {
      // a corpse lock file naming a dead pid is not worth failing over
    }
    return 0;
  }

  try {
    kill(lock.pid);
  } catch (err) {
    stderr(`could not stop kaprek (pid ${lock.pid}): ${err.message}`);
    return 1;
  }

  const deadline = now() + POLL_TIMEOUT_MS;
  while (now() < deadline) {
    if (!(await stillRunning(lock, { kill, isAlive }))) break;
    await sleep(POLL_INTERVAL_MS);
  }

  try {
    unlink();
  } catch {
    // best-effort, same as everywhere else the lock file is touched
    // (see src/lib/instance-lock.mjs) — it decides nothing on its own
  }
  stdout(`stopped kaprek (pid ${lock.pid})`);
  return 0;
}
