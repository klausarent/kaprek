#!/usr/bin/env node
// loryme CLI entrypoint: parses flags, starts the local server, opens the
// default browser, and shuts down cleanly on Ctrl+C.
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { parseArgs } from '../src/cli/args.mjs';
import { startServer } from '../src/server/server.mjs';

const USAGE = `Usage: loryme [options]

Options:
  --port <n>    Port to listen on (default: 4900; if taken, tries up to 10 higher)
  --dir <path>  Root directory to scan for Claude Code sessions (default: ~/.claude/projects)
  --no-redact   Disable secret redaction in session digests
  --no-open     Do not open the default browser automatically
  -h, --help    Show this help message
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

async function main() {
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

  let started;
  try {
    started = await startWithPortRetry(opts.port, { rootDir: opts.dir, redact: opts.redact, webDist });
  } catch (err) {
    console.error(`Failed to start server: ${err.message}`);
    process.exitCode = 1;
    return;
  }

  const { server, url } = started;
  console.log(url);

  if (opts.open) {
    openBrowser(url);
  }

  process.on('SIGINT', () => {
    server.close(() => {
      process.exit(0);
    });
  });
}

main();
