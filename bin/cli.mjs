#!/usr/bin/env node
// kaprek CLI entrypoint: parses flags, starts the local server, opens the
// default browser, and shuts down cleanly on Ctrl+C.
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { parseArgs } from '../src/cli/args.mjs';
import { startServer } from '../src/server/server.mjs';
import { encodeQr, qrToText } from '../src/server/qr.mjs';
import { fallbackAdvice, installKind, latestVersion, runInstall, updatePlan } from '../src/cli/update.mjs';
import * as autostart from '../src/cli/autostart.mjs';
import { install as installHook, uninstall as uninstallHook, status as hookStatus } from '../src/cli/hooks.mjs';
import { ensureAppDir, getAppDir } from '../src/lib/appdir.mjs';
import { runResumeCommand, RESUME_USAGE } from '../src/cli/resume.mjs';
import { runStopCommand, STOP_USAGE } from '../src/cli/stop.mjs';
import { readInstanceLock, defaultIsAlive } from '../src/server/ensure.mjs';
import { scanAll as scanResumeSessions, setCacheDir as setResumeCacheDir } from '../src/resume/scan.mjs';
import { resumeSession as launchResumeSession } from '../src/resume/launch.mjs';
import {
  acquireInstanceLock,
  InstanceLockHeldError,
  LOCK_PORT_BASE,
  LOCK_PORT_RANGE,
} from '../src/lib/instance-lock.mjs';
import { runCouncilCommand, COUNCIL_USAGE } from '../src/cli/council.mjs';
import { readCouncil } from '../src/council/config.mjs';
import { suggestAssignment, councilStatus } from '../src/council/roles.mjs';
import { availablePeerIds, makeAskPeer } from '../src/council/ask.mjs';
import { snapshotFiles } from '../src/council/snapshot.mjs';
import { consultPeers } from '../src/council/consult.mjs';
import { listEngines } from '../src/harness/registry.mjs';

// Same value as server.mjs's PEER_TURN_TIMEOUT_MS (not exported there — kept
// in sync by hand; see src/server/server.mjs around the council imports).
const PEER_TURN_TIMEOUT_MS = 9 * 60 * 1000;

const USAGE = `Usage: kaprek [options]
       kaprek stop
       kaprek update [--check]
       kaprek autostart <install|uninstall|status>
       kaprek hooks <install|uninstall|status>
       kaprek council "<q>"
       kaprek resume [key|--all]

Options:
  --port <n>    Port to listen on (default: 4900; if taken, tries up to 10 higher)
  --dir <path>  Root directory to scan for Claude Code sessions (default: ~/.claude/projects)
  --no-redact   Disable secret redaction in session digests
  --no-open     Do not open the default browser automatically
  --lan         Also listen on this machine's network address, and print a QR
                code for answering approvals from a phone. Off by default;
                the instance token stays required either way.
  -h, --help    Show this help message

Stop:
  stop           Stop the kaprek server running for this data directory, if any

Update:
  update         Check npm for a newer kaprek and install it if there is one
  update --check Only look; change nothing

Autostart (start kaprek when you log in — off unless you ask):
  autostart install    Write one file to this machine's startup folder
  autostart uninstall  Delete exactly that file
  autostart status     Show whether it is there, and print its path

Hooks subcommands (Claude Code Stop hook for the policy engine):
  hooks install    Add the kaprek Stop + SessionStart hooks to ~/.claude/settings.json
  hooks uninstall  Remove only the kaprek hook entries
  hooks status     Show whether the hooks are installed and the active policy mode

  council "<q>"      Ask the peers (codex, grok) blind and in parallel from the terminal
Resume (bring a session of claude/codex/grok/kimi back as a terminal tab):
  resume [key|--all]  List or reopen sessions of claude/codex/grok/kimi as
                       terminal tabs. Run \`kaprek resume --help\` for details.
`;

const HOOKS_USAGE = `Usage: kaprek hooks <install|uninstall|status>

Manages kaprek's Claude Code hooks: the Stop hook the policy engine uses to
gently enforce workflow rules (e.g. requiring a linked board task for
commits), and the SessionStart hook that tells a session opening in a
mission directory about the mission, its open questions, the rules a person
accepted, and what earlier sessions wrote down.

  install    Adds both kaprek hooks to ~/.claude/settings.json
             (backs up the existing file first; leaves other hooks intact)
  uninstall  Removes only the kaprek hook entries
  status     Shows whether the hooks are installed and the active policy mode
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
      console.log(`Installed Stop + SessionStart hooks -> ${result.settingsPath}`);
      if (result.backupPath) console.log(`Backup: ${result.backupPath}`);
      if (result.alreadyInstalled) console.log(result.added?.length ? `(Stop hook was already installed; added: ${result.added.join(', ')})` : '(already installed, left unchanged)');
    } else if (sub === 'uninstall') {
      const result = uninstallHook();
      if (result.uninstalled) {
        console.log(`Removed kaprek hooks from ${result.settingsPath}`);
        if (result.backupPath) console.log(`Backup: ${result.backupPath}`);
      } else {
        console.log(`No kaprek hooks found in ${result.settingsPath} (${result.reason ?? 'nothing to remove'})`);
      }
    } else if (sub === 'status') {
      const result = hookStatus();
      console.log(`Installed: ${result.installed ? 'yes' : 'no'} (Stop)${result.events?.SessionStart ? `, ${result.events.SessionStart.installed ? 'yes' : 'no'} (SessionStart)` : ''}`);
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

/**
 * `kaprek update` — the only command that talks to the internet, and it says
 * so before it does. Never throws: a failed update check must not look like
 * a broken install.
 */
async function runUpdateCommand(args) {
  const checkOnly = args.includes('--check');
  const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const current = JSON.parse(fs.readFileSync(path.join(packageRoot, 'package.json'), 'utf8')).version;
  const kind = installKind(packageRoot);

  console.log('Asking the npm registry which version is newest. (This is the one thing kaprek sends off this machine, and only when you ask for it.)');
  let latest;
  try {
    latest = await latestVersion();
  } catch (err) {
    // Not knowing whether there is an update is no reason to leave someone
    // stuck: the fallback fetches the newest version regardless.
    console.error(fallbackAdvice(err.message));
    process.exitCode = 1;
    return;
  }

  const plan = updatePlan({ kind, current, latest });
  console.log(plan.message);
  if (plan.action !== 'install') return;
  if (checkOnly) {
    console.log(`Run: ${plan.command.join(' ')}  (or kaprek update, without --check)`);
    return;
  }

  const code = await runInstall(plan.command);
  if (code === 0) {
    console.log(`kaprek ${latest} installed. Start it again to use it.`);
  } else {
    console.error(fallbackAdvice(`Update failed (npm exited ${code}). You can try it yourself: ${plan.command.join(' ')}`));
    process.exitCode = code;
  }
}

/** `kaprek autostart <install|uninstall|status>`. Never throws. */
function runAutostartCommand(args) {
  const sub = args[0];
  const scriptPath = fileURLToPath(import.meta.url);

  try {
    if (sub === 'install') {
      const result = autostart.install({ scriptPath });
      console.log(`kaprek will start when you log in. One file, and this is it:`);
      console.log(`  ${result.path}`);
      console.log('Delete that file (or run `kaprek autostart uninstall`) to stop it.');
    } else if (sub === 'uninstall') {
      const result = autostart.uninstall();
      console.log(result.removed ? `Removed ${result.path}` : `Nothing to remove (no file at ${result.path ?? 'this platform has no known autostart folder'})`);
    } else if (sub === 'status') {
      const result = autostart.status();
      if (!result.supported) {
        console.log(`kaprek does not know where autostart entries live on ${process.platform}.`);
        return;
      }
      console.log(`Autostart: ${result.installed ? 'on' : 'off'}`);
      console.log(`File: ${result.path}`);
      if (result.contents) {
        console.log('Contents:');
        for (const line of result.contents.trim().split(/\r?\n/)) console.log(`  ${line}`);
      }
    } else {
      console.error('Usage: kaprek autostart <install|uninstall|status>');
      process.exitCode = 1;
      return;
    }
    process.exitCode = 0;
  } catch (err) {
    console.error(`autostart ${sub} failed: ${err.message}`);
    process.exitCode = 1;
  }
}

async function main() {
  const argv = process.argv.slice(2);

  if (argv[0] === 'autostart') {
    runAutostartCommand(argv.slice(1));
    return;
  }

  if (argv[0] === 'update') {
    await runUpdateCommand(argv.slice(1));
    return;
  }

  if (argv[0] === 'council') {
    if (argv[1] === '-h' || argv[1] === '--help' || argv.length === 1) {
      console.log(COUNCIL_USAGE);
      return;
    }
    const dataDir = getAppDir();
    const peersFor = () => {
      const installed = availablePeerIds({ engineIds: listEngines().map((e) => e.id) });
      const saved = readCouncil(dataDir);
      const assignment = saved.configured ? saved.assignment : suggestAssignment(installed);
      return councilStatus(assignment);
    };
    process.exitCode = await runCouncilCommand(argv.slice(1), {
      dataDir,
      peersFor,
      snapshotFiles,
      consultPeers: (args) => consultPeers({ ...args, askPeer: makeAskPeer({ timeoutMs: PEER_TURN_TIMEOUT_MS }), timeoutMs: PEER_TURN_TIMEOUT_MS }),
    });
    return;
  }

  if (argv[0] === 'hooks') {
    runHooksCommand(argv.slice(1));
    return;
  }

  if (argv[0] === 'stop') {
    if (argv[1] === '-h' || argv[1] === '--help') {
      console.log(STOP_USAGE);
      return;
    }
    const dataDir = ensureAppDir();
    const lockPath = path.join(dataDir, 'instance.lock');
    process.exitCode = await runStopCommand(argv.slice(1), {
      readLock: () => readInstanceLock(dataDir),
      kill: (pid, signal) => process.kill(pid, signal),
      isAlive: (url) => defaultIsAlive(url),
      unlink: () => fs.unlinkSync(lockPath),
    });
    return;
  }

  if (argv[0] === 'resume') {
    if (argv[1] === '-h' || argv[1] === '--help') {
      console.log(RESUME_USAGE);
      return;
    }
    const dataDir = ensureAppDir();
    setResumeCacheDir(path.join(dataDir, 'resume-cache'));
    process.exitCode = await runResumeCommand(argv.slice(1), {
      scanAll: scanResumeSessions,
      resumeSession: (session, opts) => launchResumeSession(session, { ...opts, launchDir: path.join(dataDir, 'resume-cache', 'launch') }),
    });
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
      if (err.url) {
        // Already running is not an error a person needs to act on — it is
        // exactly what a second launch of an already-autostarted kaprek
        // should do: get the page in front of them. The served page injects
        // the instance token itself on a loopback request (see
        // src/server/token.mjs), so the bare url is enough here too.
        console.log(`kaprek is already running at ${err.url} (pid ${err.pid}) — opened it`);
        if (opts.open) openBrowser(err.url);
        process.exitCode = 0;
        return;
      }
      // err.url is null while the holder is between acquiring the lock and
      // calling updatePort() below — exactly the narrow double-click window
      // this whole module exists to close, so it needs its own honest
      // message rather than printing "at null", and nothing to open yet.
      console.error(`kaprek is already starting (pid ${err.pid}), no port yet`);
    } else {
      console.error(`Failed to acquire instance lock: ${err.message}`);
    }
    process.exitCode = 1;
    return;
  }

  let started;
  try {
    started = await startWithPortRetry(opts.port, { rootDir: opts.dir, redact: opts.redact, webDist, dataDir, lan: opts.lan });
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

  const { server, url, lanUrl, token, approvalToken } = started;
  await lock.updatePort(Number(new URL(url).port));
  console.log(url);

  // With --lan, say plainly what is now reachable and by whom, and print the
  // QR that carries the token. The token is on this screen either way; the
  // QR only saves typing it on a phone keyboard.
  if (opts.lan) {
    if (lanUrl) {
      console.log('');
      console.log(`Also reachable at ${lanUrl} — for answering questions, and only that.`);
      console.log('Scan this with your phone:');
      console.log('');
      // The QR carries a token that may read the inbox and answer one
      // question. Not the instance token: that authorises every route,
      // including the one whose job is to run a command. (Codex' review.)
      console.log(qrToText(encodeQr(`${lanUrl}/#/approvals?t=${approvalToken}`)));
      console.log('');
      console.log('That code lets a phone answer approvals. It cannot start chats,');
      console.log('change settings, or read your transcripts, and it is gone when');
      console.log('kaprek stops. Without --lan, kaprek listens on localhost only.');
      console.log('');
      // In LAN mode the page is served without the token (a proxy in front
      // of loopback would otherwise be handed it), so the browser on THIS
      // machine gets it here, in the fragment — which never leaves the
      // browser.
      console.log('On this computer, open kaprek with full access here:');
      console.log(`  ${url}/#/?t=${token}`);
    } else {
      console.log('');
      console.log('--lan was given, but this machine has no network address — still listening on localhost only.');
    }
  }

  if (opts.open) {
    // With --lan the page carries no token, so the local browser is opened
    // with it in the fragment; without --lan the served page still injects
    // it for loopback, so the bare url is right.
    openBrowser(lanUrl ? `${url}/#/?t=${token}` : url);
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
    // server.close() alone waits for open connections to drain, and kaprek
    // essentially always has one: SSE streams (chat, approvals) stay open
    // for hours. Without destroying them the close callback never runs, the
    // SIGINT handler has already swallowed the signal, and the process —
    // still holding the instance lock — can no longer be ended from the
    // keyboard at all (Codex day-4 review, finding 2). Destroy the
    // connections, and keep a short force-exit as the backstop for anything
    // that still refuses to drain; the 'exit' handler above releases the
    // lock synchronously on every one of these paths.
    server.close(() => {
      lock.release().finally(() => process.exit(0));
    });
    server.closeAllConnections?.();
    const force = setTimeout(() => process.exit(0), 2000);
    if (typeof force.unref === 'function') force.unref();
  }

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main();
