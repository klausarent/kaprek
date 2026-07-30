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

test('a second start on the same dataDir refuses instead of silently falling back to basePort+1', async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kaprek-cli-test-'));
  const port = 20000 + Math.floor(Math.random() * 20000);

  // Both calls share childDataDir: runCli() only mkdtemp's it once per test
  // (see the `childDataDir = childDataDir ?? ...` guard above).
  const first = runCli(['--no-open', '--port', String(port), '--dir', tmpDir]);
  const firstUrl = await waitForUrl(first);

  const second = runCli(['--no-open', '--port', String(port), '--dir', tmpDir]);
  const { code, stderr } = await collectRun(second);

  expect(code).not.toBe(0);
  expect(stderr).toContain(firstUrl);

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

    // What actually holds the lock is the socket, not that file (see
    // src/lib/instance-lock.mjs), so the file being gone proves nothing on
    // its own: the next acquire has to go through, or a failed start blocks
    // every retry with nothing running.
    const relock = await acquireInstanceLock({ dataDir: childDataDir });
    await relock.release();
  } finally {
    await Promise.all(blockers.map((blocker) => new Promise((resolve) => blocker.close(resolve))));
  }
});
