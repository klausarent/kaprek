// Smoke tests for the CLI entrypoint (bin/cli.mjs), run as real child
// processes. Run: npx vitest run src/cli/cli.test.mjs
import { test, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI_PATH = path.join(__dirname, '..', '..', 'bin', 'cli.mjs');

let children = [];
let tmpDir;

afterEach(() => {
  for (const child of children) {
    if (!child.killed) child.kill();
  }
  children = [];
  if (tmpDir) {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    tmpDir = undefined;
  }
});

function runCli(args) {
  const child = spawn(process.execPath, [CLI_PATH, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
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
  const res = await fetch(`${url}/api/projects`);
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body).toEqual([]);

  child.kill();
});
