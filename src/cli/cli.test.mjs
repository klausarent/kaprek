// Smoke tests for the CLI entrypoint (bin/cli.mjs), run as real child
// processes. Run: npx vitest run src/cli/cli.test.mjs
import { test, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { getPackageName } from '../lib/appdir.mjs';
import { acquireInstanceLock } from '../lib/instance-lock.mjs';
import { ensureInstanceToken, TOKEN_HEADER } from '../server/token.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI_PATH = path.join(__dirname, '..', '..', 'bin', 'cli.mjs');
// Points the spawned CLI's data dir at a temp directory (see
// src/lib/appdir.mjs) — a test must never write into the real app dir, and
// this is also how the test gets at the child's instance token.
const DATA_DIR_ENV = `${getPackageName().toUpperCase().replace(/-/g, '_')}_DATA_DIR`;

let children = [];
let tmpDir;
let childDataDir;

afterEach(() => {
  for (const child of children) {
    if (!child.killed) child.kill();
  }
  children = [];
  if (tmpDir) {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    tmpDir = undefined;
  }
  if (childDataDir) {
    fs.rmSync(childDataDir, { recursive: true, force: true });
    childDataDir = undefined;
  }
});

function runCli(args) {
  childDataDir = childDataDir ?? fs.mkdtempSync(path.join(os.tmpdir(), 'kaprek-cli-data-'));
  const child = spawn(process.execPath, [CLI_PATH, ...args], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, [DATA_DIR_ENV]: childDataDir },
  });
  children.push(child);
  return child;
}

/** Collects stdout/exit for a child that is expected to run to completion. */
function collectRun(child) {
  return new Promise((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    child.on('error', reject);
    child.on('exit', (code) => resolve({ code, stdout, stderr }));
  });
}

/** Resolves with the first stdout line matching `http://...`, for a long-running child. */
function waitForUrl(child, timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    let stdout = '';
    const timer = setTimeout(() => {
      reject(new Error(`Timed out waiting for server URL. stdout so far: ${stdout}`));
    }, timeoutMs);
    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
      const match = stdout.match(/https?:\/\/127\.0\.0\.1:\d+/);
      if (match) {
        clearTimeout(timer);
        resolve(match[0]);
      }
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`CLI exited early with code ${code} before printing a URL. stdout: ${stdout}`));
    });
  });
}

test('--help prints usage (including --no-redact) and exits 0', async () => {
  const child = runCli(['--help']);
  const { code, stdout } = await collectRun(child);
  expect(code).toBe(0);
  expect(stdout).toContain('--no-redact');
  expect(stdout).toContain('--no-open');
  expect(stdout).toContain('--port');
  expect(stdout).toContain('--dir');
});

test('starts a real server against an empty --dir and serves /api/projects', async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kaprek-cli-test-'));
  const port = 20000 + Math.floor(Math.random() * 20000);
  const child = runCli(['--no-open', '--port', String(port), '--dir', tmpDir]);

  const url = await waitForUrl(child);
  // The child created its instance token before it printed that URL, so
  // reading it here is a plain read, never a second generation (see
  // src/server/token.mjs). The CLI deliberately does not print it.
  const token = ensureInstanceToken(childDataDir);
  const res = await fetch(`${url}/api/projects`, { headers: { [TOKEN_HEADER]: token } });
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body).toEqual([]);

  child.kill();
});

test('a second start on the same dataDir reports the running instance and exits 0 instead of silently falling back to basePort+1', async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kaprek-cli-test-'));
  const port = 20000 + Math.floor(Math.random() * 20000);

  // Both calls share childDataDir: runCli() only mkdtemp's it once per test
  // (see the `childDataDir = childDataDir ?? ...` guard above).
  const first = runCli(['--no-open', '--port', String(port), '--dir', tmpDir]);
  const firstUrl = await waitForUrl(first);

  // --no-open on the second call too: this only checks the message and exit
  // code, not that a browser actually opened (see bin/cli.mjs's own
  // best-effort openBrowser(), which logs rather than throws on failure).
  const second = runCli(['--no-open', '--port', String(port), '--dir', tmpDir]);
  const { code, stdout } = await collectRun(second);

  expect(code).toBe(0);
  expect(stdout).toContain(firstUrl);
  expect(stdout).toContain('already running');

  // The pre-lock behavior (startWithPortRetry silently trying basePort+1 on
  // EADDRINUSE) must not have kicked in: nothing should be listening there.
  await expect(fetch(`http://127.0.0.1:${port + 1}/api/projects`)).rejects.toThrow();

  first.kill();
});

test('a failed startServer() releases the instance lock instead of leaving the port claimed', async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kaprek-cli-test-'));
  const port = 20000 + Math.floor(Math.random() * 20000);

  // Occupies every port startWithPortRetry() would try (MAX_PORT_ATTEMPTS in
  // bin/cli.mjs is 10; a wider range here so this test does not depend on
  // that exact value) so startServer() is guaranteed to exhaust its retries
  // and throw — the failure path this test is actually about.
  const blockers = [];
  for (let i = 0; i <= 20; i += 1) {
    const blocker = net.createServer();
    await new Promise((resolve, reject) => {
      blocker.once('error', reject);
      blocker.listen(port + i, '127.0.0.1', resolve);
    });
    blockers.push(blocker);
  }

  try {
    const child = runCli(['--no-open', '--port', String(port), '--dir', tmpDir]);
    const { code } = await collectRun(child);
    expect(code).not.toBe(0);

    const lockPath = path.join(childDataDir, 'instance.lock');
    expect(fs.existsSync(lockPath)).toBe(false);

    // The file assertion above is the one that carries release(): remove the
    // release from the catch path in bin/cli.mjs and it goes red.
    //
    // The re-acquire below deliberately claims less than it looks like. The
    // child is already gone by the time collectRun() resolves, and the OS
    // frees its handle with it — this suite proves that separately ("a pipe
    // name is free again the moment its holder is SIGKILLed"). So this cannot
    // detect a failure path that forgets to close the handle; after a process
    // exit nothing can. It is an end-to-end check that a dead failed start
    // blocks nothing, and that is all. The handle-closing case is covered
    // where it is observable: in a live process, in instance-lock.test.mjs
    // ("a refused start leaves the address free for whoever should have it").
    const relock = await acquireInstanceLock({ dataDir: childDataDir });
    await relock.release();
  } finally {
    await Promise.all(blockers.map((blocker) => new Promise((resolve) => blocker.close(resolve))));
  }
});

/**
 * Runs `hooks install` from `cliPath` against a temp CLAUDE_CONFIG_DIR, so the
 * real ~/.claude/settings.json is never read or written.
 */
function runHooksInstall(cliPath) {
  tmpDir = tmpDir ?? fs.mkdtempSync(path.join(os.tmpdir(), 'kaprek-cli-hooks-'));
  childDataDir = childDataDir ?? fs.mkdtempSync(path.join(os.tmpdir(), 'kaprek-cli-data-'));
  const configDir = path.join(tmpDir, 'claude-config');
  const child = spawn(process.execPath, [cliPath, 'hooks', 'install'], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, [DATA_DIR_ENV]: childDataDir, CLAUDE_CONFIG_DIR: configDir },
  });
  children.push(child);
  return collectRun(child).then((run) => ({ ...run, settingsPath: path.join(configDir, 'settings.json') }));
}

test('hooks install from a repo checkout prints no npx warning', async () => {
  const { code, stdout, stderr, settingsPath } = await runHooksInstall(CLI_PATH);
  expect(code).toBe(0);
  expect(stdout).toContain('Installed Stop + SessionStart + SessionEnd + UserPromptSubmit hooks');
  expect(stdout).toContain(settingsPath);
  expect(stderr).not.toContain('npx cache');
  expect(stderr).not.toContain('warning:');
});

test('hooks install from an npx cache copy warns once on stderr and still installs', async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kaprek-cli-hooks-'));
  // A copy of this package at the path shape npx unpacks into. kaprek has
  // no runtime dependencies, so bin/, src/ and package.json are enough.
  // Hard links, not copies: a real copy of src/ takes many seconds on
  // Windows, a link is instant. A hard link is its own path (unlike a
  // symlink or junction, Node never resolves it back to the repo), and
  // removing it in afterEach removes only the link. Falls back to copying
  // when the temp dir sits on another volume.
  const repoRoot = path.join(__dirname, '..', '..');
  const npxRoot = path.join(tmpDir, '_npx', 'abc123', 'node_modules', 'kaprek');
  const mirror = (rel) => {
    const source = path.join(repoRoot, rel);
    const target = path.join(npxRoot, rel);
    if (fs.statSync(source).isDirectory()) {
      fs.mkdirSync(target, { recursive: true });
      for (const entry of fs.readdirSync(source)) {
        if (entry.endsWith('.test.mjs') || entry === 'fixtures') continue;
        mirror(path.join(rel, entry));
      }
      return;
    }
    try {
      fs.linkSync(source, target);
    } catch {
      fs.copyFileSync(source, target);
    }
  };
  fs.mkdirSync(npxRoot, { recursive: true });
  for (const rel of ['package.json', 'bin', 'src']) mirror(rel);

  const { code, stdout, stderr, settingsPath } = await runHooksInstall(path.join(npxRoot, 'bin', 'cli.mjs'));
  expect(code).toBe(0);
  expect(stdout).toContain('Installed Stop + SessionStart + SessionEnd + UserPromptSubmit hooks');
  expect(stderr).toContain('npx cache');
  expect(stderr).toContain('npm i -g kaprek');
  expect(stderr).toContain(path.join(npxRoot, 'src', 'policy', 'hook-stop.mjs'));
  expect(stderr.match(/warning:/g)).toHaveLength(1);
  const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
  expect(Object.keys(settings.hooks).sort()).toEqual(['SessionEnd', 'SessionStart', 'Stop', 'UserPromptSubmit']);
}, 20000);
