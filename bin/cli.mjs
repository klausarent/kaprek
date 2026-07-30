#!/usr/bin/env node
// kaprek CLI entrypoint: parses flags, starts the local server, opens the
// default browser, and shuts down cleanly on Ctrl+C.
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { parseArgs } from '../src/cli/args.mjs';
import { startServer } from '../src/server/server.mjs';
import { install as installHook, uninstall as uninstallHook, status as hookStatus } from '../src/cli/hooks.mjs';
import { ensureAppDir } from '../src/lib/appdir.mjs';
import {
  acquireInstanceLock,
  InstanceLockHeldError,
  LOCK_PORT_BASE,
  LOCK_PORT_RANGE,
} from '../src/lib/instance-lock.mjs';

const USAGE = `Usage: kaprek [options]
       kaprek hooks <install|uninstall|status>

Options:
  --port <n>    Port to listen on (default: 4900; if taken, tries up to 10 higher)
  --dir <path>  Root directory to scan for Claude Code sessions (default: ~/.claude/projects)
  --no-redact   Disable secret redaction in session digests
  --no-open     Do not open the default browser automatically
  -h, --help    Show this help message

Hooks subcommands (Claude Code Stop hook for the policy engine):
  hooks install    Add the kaprek Stop hook to ~/.claude/settings.json
  hooks uninstall  Remove only the kaprek Stop hook entry
  hooks status     Show whether the hook is installed and the active policy mode
`;

const HOOKS_USAGE = `Usage: kaprek hooks <install|uninstall|status>

Manages the Claude Code Stop hook kaprek's policy engine uses to gently
enforce workflow rules (e.g. requiring a linked board task for commits).

  install    Adds the kaprek Stop hook to ~/.claude/settings.json
             (backs up the existing file first; leaves other hooks intact)
  uninstall  Removes only the kaprek Stop hook entry
  status     Shows whether the hook is installed and the active policy mode
`;

const MAX_PORT_ATTEMPTS = 10;

/** Resolves web/dist relative to the package root, or undefined if not built. */
function resolveWebDist() {
  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const webDist = path.join(__dirname, '..', 'web', 'dist');
  return fs.existsSync(webDist) ? webDist : undefined;
}

/** Opens `url` in the OS default browser. Best-effort — failures are logged, never fatal. */
function openBrowser(url) {
  try {
    let child;
    if (process.platform === 'win32') {
      child = spawn('cmd', ['/c', 'start', '""', url], { detached: true, stdio: 'ignore' });
    } else if (process.platform === 'darwin') {
      child = spawn('open', [url], { detached: true, stdio: 'ignore' });
    } else {
      child = spawn('xdg-open', [url], { detached: true, stdio: 'ignore' });
    }
    child.on('error', (err) => {
      console.error(`Could not open browser automatically: ${err.message}`);
    });
    child.unref();
  } catch (err) {
    console.error(`Could not open browser automatically: ${err.message}`);
  }
}

/** Tries basePort, then basePort+1 .. basePort+MAX_PORT_ATTEMPTS on EADDRINUSE. */
async function startWithPortRetry(basePort, serverOpts) {
  for (let attempt = 0; attempt <= MAX_PORT_ATTEMPTS; attempt += 1) {
    const port = basePort + attempt;
    try {
      return await startServer({ port, ...serverOpts });
    } catch (err) {
      if (err && err.code === 'EADDRINUSE') {
        continue;
      }
      throw err;
    }
  }
  throw new Error(
    `Could not find a free port in range ${basePort}-${basePort + MAX_PORT_ATTEMPTS} (all in use)`,
  );
}

/** Handles `kaprek hooks <install|uninstall|status>`. Never throws — errors are reported and turn into exitCode 1. */
function runHooksCommand(args) {
  const sub = args[0];

  if (sub === undefined || sub === '--help' || sub === '-h') {
    console.log(HOOKS_USAGE);
    process.exitCode = 0;
    return;
  }

  try {
    if (sub === 'install') {
      const result = installHook();
      console.log(`Installed Stop hook -> ${result.settingsPath}`);
      if (result.backupPath) console.log(`Backup: ${result.backupPath}`);
      if (result.alreadyInstalled) console.log('(already installed, left unchanged)');
    } else if (sub === 'uninstall') {
      const result = uninstallHook();
      if (result.uninstalled) {
        console.log(`Removed Stop hook from ${result.settingsPath}`);
        if (result.backupPath) console.log(`Backup: ${result.backupPath}`);
      } else {
        console.log(`No kaprek Stop hook found in ${result.settingsPath} (${result.reason ?? 'nothing to remove'})`);
      }
    } else if (sub === 'status') {
      const result = hookStatus();
      console.log(`Installed: ${result.installed ? 'yes' : 'no'}`);
      console.log(`Settings file: ${result.settingsPath}`);
      if (result.installed) {
        const staleNote = result.recordedPathMissing ? ' (WARNING: no file exists at this recorded path)' : '';
        console.log(`Recorded hook script: ${result.recordedPath ?? '(could not parse recorded command)'}${staleNote}`);
      }
      console.log(`Policy mode: ${result.mode}${result.policyError ? ` (fallback: ${result.policyError})` : ''}`);
      console.log(`Data dir: ${result.dataDir}`);
    } else {
      console.error(`Unknown hooks subcommand: ${sub}`);
      console.error(HOOKS_USAGE);
      process.exitCode = 1;
      return;
    }
    process.exitCode = 0;
  } catch (err) {
    console.error(`hooks ${sub} failed: ${err.message}`);
    process.exitCode = 1;
  }
}

async function main() {
  const argv = process.argv.slice(2);

  if (argv[0] === 'hooks') {
    runHooksCommand(argv.slice(1));
    return;
  }

  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(err.message);
    console.error(USAGE);
    process.exitCode = 1;
    return;
  }

  if (opts.help) {
    console.log(USAGE);
    process.exitCode = 0;
    return;
  }

  const webDist = resolveWebDist();
  console.log(`Scanning: ${path.resolve(opts.dir)}`);

  // The server port and the lock port come from different worlds: one is
  // chosen by the user, the other derived from the data dir path. They can
  // land on each other, and then this instance's own HTTP server is a silent
  // squatter on some other data dir's lock port — that data dir then refuses
  // to start with no visible connection to this flag. Cheap to say out loud,
  // expensive to diagnose later. Only relevant on POSIX; Windows locks a pipe
  // name, which has no port to collide with.
  const lockRangeEnd = LOCK_PORT_BASE + LOCK_PORT_RANGE;
  if (process.platform !== 'win32' && opts.port >= LOCK_PORT_BASE && opts.port < lockRangeEnd) {
    console.error(
      `Note: --port ${opts.port} is inside the range kaprek derives instance-lock ports from ` +
        `(${LOCK_PORT_BASE}-${lockRangeEnd - 1}). If another data directory's lock lands on this port, ` +
        'that other instance will refuse to start while this one runs.',
    );
  }

  // Resolved (and created) once, up front, so the lock and the server agree
  // on exactly which ~/.kaprek they mean — see src/lib/appdir.mjs.
  const dataDir = ensureAppDir();

  // Acquired BEFORE startWithPortRetry(), while the real port is still
  // unknown: that retry loop is exactly the silent EADDRINUSE fallback this
  // lock exists to stop (see src/lib/instance-lock.mjs header comment), so a
  // second instance must be refused here, before it ever gets a chance to
  // wander onto basePort+1. The port gets filled in below once startServer()
  // actually has one.
  let lock;
  try {
    lock = await acquireInstanceLock({ dataDir, port: undefined });
  } catch (err) {
    if (err instanceof InstanceLockHeldError) {
      // err.url is null while the holder is between acquiring the lock and
      // calling updatePort() below — exactly the narrow double-click window
      // this whole module exists to close, so it needs its own honest
      // message rather than printing "at null".
      console.error(
        err.url
          ? `kaprek is already running at ${err.url} (pid ${err.pid})`
          : `kaprek is already starting (pid ${err.pid}), no port yet`,
      );
    } else {
      console.error(`Failed to acquire instance lock: ${err.message}`);
    }
    process.exitCode = 1;
    return;
  }

  let started;
  try {
    started = await startWithPortRetry(opts.port, { rootDir: opts.dir, redact: opts.redact, webDist, dataDir });
  } catch (err) {
    console.error(`Failed to start server: ${err.message}`);
    // Otherwise this process keeps holding the lock handle although no server
    // is listening. Nothing reclaims it either: the lock lives and dies with
    // the process (see src/lib/instance-lock.mjs), so without this the only
    // way out would be killing a process that already gave up.
    await lock.release();
    process.exitCode = 1;
    return;
  }

  const { server, url } = started;
  await lock.updatePort(Number(new URL(url).port));
  console.log(url);

  if (opts.open) {
    openBrowser(url);
  }

  // Best-effort safety net for exit paths that never reach the SIGINT/SIGTERM
  // handlers below — e.g. kaprek holds SSE streams (approval/chat), so with a
  // browser tab left open server.close()'s callback there can hang instead of
  // ever running. 'exit' handlers must be synchronous, hence releaseSync()
  // (see src/lib/instance-lock.mjs) instead of release(). Idempotent with the
  // handlers below: whichever runs first marks the lock released, the other
  // becomes a no-op.
  process.on('exit', () => {
    lock.releaseSync();
  });

  function shutdown() {
    server.close(() => {
      lock.release().finally(() => process.exit(0));
    });
  }

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main();
