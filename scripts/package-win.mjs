// Builds dist-zip/kaprek-win.zip: everything a stranger needs to unpack and
// double-click, and nothing else. Run: node scripts/package-win.mjs
//
// Zero dependencies, like the rest of the server. The zip itself is made with
// PowerShell's own Compress-Archive (and unpacked again with Expand-Archive),
// which is the dependency-free route to a zip on Windows — invoked through
// execFile with an argument array, never `shell: true`, so nothing in a path
// can be interpreted as a command.
//
// The last step is a real smoke test, not a checklist item: the zip is
// extracted into a temp directory, the server is started FROM THAT COPY on a
// free port, and two things are asserted about it — `GET /` serves the token
// meta tag, and `GET /api/triggers` without a token is a 401. Any failure exits
// non-zero.
import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import path from 'node:path';
import { execFile, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.join(__dirname, '..');
const WEB_DIR = path.join(REPO_ROOT, 'web');
const DIST_ZIP_DIR = path.join(REPO_ROOT, 'dist-zip');
const ZIP_PATH = path.join(DIST_ZIP_DIR, 'kaprek-win.zip');
const STAGING_DIR = path.join(DIST_ZIP_DIR, 'staging');

const SMOKE_TIMEOUT_MS = 30_000;

/** Files/directories copied into the zip, relative to the repo root. Mirrors package.json's `files`, plus the two start documents generated below. */
const INCLUDE = ['bin', 'src', 'apps', 'package.json', 'LICENSE', 'README.md', path.join('web', 'dist')];

/**
 * Never shipped: tests and their fixtures are dead weight in a release and
 * fixtures can carry sample transcripts. Matches the fixtures DIRECTORY itself
 * too, not only paths inside it — a trailing-slash-only check left three empty
 * `fixtures/` directories in the zip.
 */
function isExcluded(relPath) {
  const segments = relPath.split(path.sep);
  const name = segments[segments.length - 1];
  if (name === 'fixtures' || name === '__pycache__') return true;
  const normalized = segments.join('/');
  return normalized.endsWith('.test.mjs') || normalized.includes('/fixtures/') || normalized.includes('/__pycache__/');
}

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    execFile(command, args, { ...options, windowsHide: true }, (err, stdout, stderr) => {
      if (err) {
        err.message = `${command} ${args.join(' ')} failed: ${err.message}\n${stderr}`;
        reject(err);
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}

function copyTree(from, to) {
  const stat = fs.statSync(from);
  if (stat.isDirectory()) {
    fs.mkdirSync(to, { recursive: true });
    for (const entry of fs.readdirSync(from)) {
      const child = path.join(from, entry);
      if (isExcluded(path.relative(REPO_ROOT, child))) continue;
      copyTree(child, path.join(to, entry));
    }
    return;
  }
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.copyFileSync(from, to);
}

function dirSize(dir) {
  let total = 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    total += entry.isDirectory() ? dirSize(full) : fs.statSync(full).size;
  }
  return total;
}

/**
 * The launcher. Checks its two prerequisites and, when one is missing, says
 * which and where to get it — it never installs anything itself. `call` in front
 * of `claude` is not optional: `claude` on Windows is a .cmd shim, and running
 * one .cmd from another WITHOUT `call` transfers control and never comes back.
 */
const START_CMD = `@echo off
setlocal
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 goto no_node

rem Exits 1 when the Node major version is below 22. Deliberately arithmetic
rem rather than a comparison: cmd would read a bare < or > as a redirection.
node -e "process.exit(Math.min(1, Math.max(0, 22 - parseInt(process.versions.node, 10))))"
if errorlevel 1 goto old_node

call claude --version >nul 2>nul
if errorlevel 1 goto no_claude

echo Starting kaprek. Close this window to stop it.
node bin\\cli.mjs %*
goto end

:no_node
echo.
echo Node.js was not found.
echo kaprek needs Node.js 22 or newer. Install it from:
echo     https://nodejs.org/en/download
echo Then run this file again.
echo.
pause
exit /b 1

:old_node
echo.
echo Your Node.js is too old for kaprek, which needs version 22 or newer.
node --version
echo Get a current version from:
echo     https://nodejs.org/en/download
echo.
pause
exit /b 1

:no_claude
echo.
echo The Claude Code CLI was not found on your PATH.
echo kaprek runs your own local "claude" command; it never uses an API key.
echo Install it and sign in first:
echo     https://code.claude.com/docs
echo.
pause
exit /b 1

:end
endlocal
`;

const START_README = `# Starting kaprek

kaprek runs entirely on your own machine. It talks to the \`claude\` CLI you
already have installed and signed in — no API key, no account, no traffic to
anyone else's server.

## What you need

1. **Node.js 22 or newer** — https://nodejs.org/en/download
2. **The Claude Code CLI**, installed and signed in — https://code.claude.com/docs

\`start-kaprek.cmd\` checks both and tells you which one is missing. It never
installs anything for you.

## Start it

Double-click \`start-kaprek.cmd\`. It starts the local server and opens your
browser on it. The window stays open while kaprek runs; closing it stops the
server.

No \`npm install\` step: the server has no runtime dependencies, and the web UI
is already built inside this folder.

## Options

Run it from a terminal to pass flags:

    start-kaprek.cmd --port 5000
    start-kaprek.cmd --no-open

- \`--port <n>\` — port to listen on (default 4900; if taken, it tries the next
  ten)
- \`--dir <path>\` — where to look for Claude Code session transcripts (default
  \`%USERPROFILE%\\.claude\\projects\`)
- \`--no-open\` — do not open the browser
- \`--no-redact\` — show secrets in transcripts instead of redacting them

## Where your data lives

\`%USERPROFILE%\\.kaprek\` — chats, triggers, the board, the search index and the
instance token that keeps other local programs out of the API. Delete that
folder to reset kaprek completely. Nothing in it is ever uploaded.

## Anything can be stopped

Triggers are all disabled until you enable them, and each one has a daily cap on
runs and cost. The trigger page shows what each one has spent today.
`;

async function buildWeb() {
  const viteBin = path.join(WEB_DIR, 'node_modules', 'vite', 'bin', 'vite.js');
  if (!fs.existsSync(viteBin)) {
    throw new Error(`vite is not installed in web/ (expected ${viteBin}) — run "npm install" in web/ first`);
  }
  // process.execPath + vite's own entry, rather than `npm run build`: execFile
  // cannot launch npm.cmd without a shell, and a shell is exactly what this
  // script avoids.
  await run(process.execPath, [viteBin, 'build'], { cwd: WEB_DIR });
}

function stage() {
  fs.rmSync(STAGING_DIR, { recursive: true, force: true });
  fs.mkdirSync(STAGING_DIR, { recursive: true });
  for (const rel of INCLUDE) {
    const from = path.join(REPO_ROOT, rel);
    if (!fs.existsSync(from)) throw new Error(`missing from the build: ${rel}`);
    copyTree(from, path.join(STAGING_DIR, rel));
  }
  fs.writeFileSync(path.join(STAGING_DIR, 'start-kaprek.cmd'), START_CMD.replace(/\n/g, '\r\n'), 'utf8');
  fs.writeFileSync(path.join(STAGING_DIR, 'README-start.md'), START_README, 'utf8');
}

/**
 * Runs a PowerShell one-liner whose paths arrive through the ENVIRONMENT, never
 * interpolated into the `-Command` string.
 *
 * A path containing `'` would otherwise terminate the single-quoted string it
 * was pasted into. Reading `$env:…` inside PowerShell sidesteps quoting
 * entirely — the variable's value is data, never syntax.
 */
function powershell(command, env) {
  return run('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', command], {
    env: { ...process.env, ...env },
  });
}

/**
 * PowerShell's zip cmdlets go through its PATH provider, which treats `[` and
 * `]` as wildcard syntax. `Compress-Archive` at least has `-LiteralPath` for its
 * source, but neither cmdlet has a literal variant for `-DestinationPath` — so a
 * checkout (or temp dir) named `kaprek [2]` makes Expand-Archive fail to see the
 * directory it was pointed at and try to create it, and makes Compress-Archive
 * write to a path nobody asked for.
 *
 * `System.IO.Compression.ZipFile` takes plain filesystem paths with no glob
 * layer in between. It is part of the .NET Framework that ships with Windows, so
 * this is still the dependency-free route — just the one that treats a path as a
 * path. The assembly load is needed for Windows PowerShell 5.1, which
 * `powershell.exe` always is.
 */
const LOAD_ZIP_ASSEMBLY = 'Add-Type -AssemblyName System.IO.Compression.FileSystem;';

async function zip() {
  fs.rmSync(ZIP_PATH, { force: true });
  if (fs.readdirSync(STAGING_DIR).length === 0) throw new Error('staging directory is empty');
  // CreateFromDirectory packs the directory's CONTENTS with paths relative to
  // it, which is exactly the layout wanted: bin/, src/, start-kaprek.cmd at the
  // zip root, no extra wrapper directory.
  await powershell(
    `${LOAD_ZIP_ASSEMBLY} [System.IO.Compression.ZipFile]::CreateFromDirectory($env:KAPREK_PACK_SRC, $env:KAPREK_PACK_OUT)`,
    { KAPREK_PACK_SRC: STAGING_DIR, KAPREK_PACK_OUT: ZIP_PATH },
  );
  if (!fs.existsSync(ZIP_PATH)) throw new Error('zip creation reported success but produced no file');
}

async function unzipTo(target) {
  fs.mkdirSync(target, { recursive: true });
  // Two arguments only: the overwrite overload is .NET Core and up, and
  // powershell.exe is always .NET Framework. Nothing to overwrite anyway — the
  // caller always hands over a freshly created directory.
  await powershell(`${LOAD_ZIP_ASSEMBLY} [System.IO.Compression.ZipFile]::ExtractToDirectory($env:KAPREK_PACK_IN, $env:KAPREK_PACK_DEST)`, {
    KAPREK_PACK_IN: ZIP_PATH,
    KAPREK_PACK_DEST: target,
  });
}

/** Asks the OS for a free port and releases it again — the starting point, not a guarantee (see waitForServerUrl()). */
function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

/**
 * Waits for the URL the server PRINTS, rather than polling the port we asked
 * for. freePort() releases its port before the child claims it, and
 * bin/cli.mjs walks up to ten ports higher on EADDRINUSE — polling the original
 * port would then fail on a healthy build. The child's own stdout is the only
 * thing that knows where it actually landed.
 */
function waitForServerUrl(child, timeoutMs) {
  return new Promise((resolve, reject) => {
    let buffer = '';
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`server printed no URL within ${timeoutMs} ms; output so far:\n${buffer}`));
    }, timeoutMs);

    const onData = (chunk) => {
      buffer += chunk;
      const match = buffer.match(/http:\/\/127\.0\.0\.1:(\d+)/);
      if (!match) return;
      cleanup();
      resolve(match[0]);
    };
    const onExit = (code) => {
      cleanup();
      reject(new Error(`server exited with code ${code} before printing a URL; output:\n${buffer}`));
    };
    function cleanup() {
      clearTimeout(timer);
      child.stdout.off('data', onData);
      child.off('exit', onExit);
    }

    child.stdout.on('data', onData);
    child.once('exit', onExit);
  });
}

/**
 * Starts the unpacked copy and checks the two properties that decide whether
 * this zip is usable at all: the browser gets its instance token, and the API
 * refuses anyone who does not have it. A dedicated temp data dir
 * (KAPREK_DATA_DIR, see src/lib/appdir.mjs) keeps the smoke test out of the
 * real %USERPROFILE%\\.kaprek.
 */
async function smokeTest(extractedDir) {
  const port = await freePort();
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kaprek-smoke-data-'));
  const scanDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kaprek-smoke-scan-'));

  const child = spawn(process.execPath, [path.join('bin', 'cli.mjs'), '--port', String(port), '--no-open', '--dir', scanDir], {
    cwd: extractedDir,
    env: { ...process.env, KAPREK_DATA_DIR: dataDir },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });

  let childOutput = '';
  child.stdout.on('data', (chunk) => {
    childOutput += chunk;
  });
  child.stderr.on('data', (chunk) => {
    childOutput += chunk;
  });

  const exited = new Promise((resolve) => child.once('exit', (code) => resolve(code)));
  const failures = [];
  try {
    const base = await waitForServerUrl(child, SMOKE_TIMEOUT_MS);
    const index = await fetch(`${base}/`);
    if (index.status !== 200) failures.push(`GET / answered ${index.status}, expected 200`);
    const html = await index.text();
    if (!/<meta name="kaprek-token" content="[0-9a-f]{64}">/.test(html)) {
      failures.push('GET / did not carry a <meta name="kaprek-token"> tag with a 64-hex token');
    }

    const unauthorized = await fetch(`${base}/api/triggers`);
    if (unauthorized.status !== 401) {
      failures.push(`GET /api/triggers without a token answered ${unauthorized.status}, expected 401`);
    }
  } finally {
    child.kill();
    await exited;
    fs.rmSync(dataDir, { recursive: true, force: true });
    fs.rmSync(scanDir, { recursive: true, force: true });
  }

  if (failures.length > 0) {
    throw new Error(`smoke test failed:\n  - ${failures.join('\n  - ')}\nserver output:\n${childOutput}`);
  }
}

async function main() {
  if (process.platform !== 'win32') {
    console.error('package-win.mjs builds the Windows zip and needs PowerShell — run it on Windows.');
    process.exitCode = 1;
    return;
  }

  console.log('1/5 building the web UI…');
  await buildWeb();

  console.log('2/5 staging files…');
  fs.mkdirSync(DIST_ZIP_DIR, { recursive: true });
  stage();
  console.log(`      staged ${(dirSize(STAGING_DIR) / 1024 / 1024).toFixed(2)} MB`);

  console.log('3/5 creating the zip…');
  await zip();
  const zipBytes = fs.statSync(ZIP_PATH).size;
  console.log(`      ${ZIP_PATH} (${(zipBytes / 1024 / 1024).toFixed(2)} MB, ${zipBytes} bytes)`);

  console.log('4/5 extracting it again…');
  // The directory name deliberately contains an apostrophe and square brackets:
  // those are exactly the characters that broke an interpolated -Path (quote
  // escape, wildcard syntax), so every run now proves the -LiteralPath route
  // handles them — and that the server starts from such a path at all.
  const extractRoot = fs.mkdtempSync(path.join(os.tmpdir(), "kaprek smoke [o'brien] "));
  try {
    await unzipTo(extractRoot);
    console.log('5/5 smoke-testing the extracted copy…');
    await smokeTest(extractRoot);
  } finally {
    fs.rmSync(extractRoot, { recursive: true, force: true });
  }

  console.log(`OK — ${path.relative(REPO_ROOT, ZIP_PATH)} is ready (${zipBytes} bytes).`);
}

main().catch((err) => {
  console.error(err.message);
  process.exitCode = 1;
});
