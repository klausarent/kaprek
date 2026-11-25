import { test, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const HOOK_PATH = path.join(__dirname, 'hook-session-end.mjs');
const DATA_DIR_ENV = 'KAPREK_DATA_DIR';
// The plan's target is "< 200 ms" for an isolated run; under the full suite's
// parallel test workers, process-spawn overhead alone can eat that (observed:
// a lone run of this file takes ~50-70ms per case, the full suite ~200ms+).
// 800 ms still leaves comfortable headroom below SELF_TIMEOUT_MS (1000 ms) —
// enough to prove this hook finishes on its own, not by hitting the
// self-timeout — without flaking under load. Same margin hook-stop.test.mjs
// uses for its own (3000 ms self-timeout, 2500 ms assertion) smoke test.
// The budget is measured ON TOP of a bare node start spawned the same way
// right before (bareNodeMs): SELF_TIMEOUT_MS only starts once node has
// booted, and under heavy CPU load the spawn + bootstrap alone took up to
// 750 ms on the server (KAP-100, 24.11.2026) — time the hook cannot influence.
const SMOKE_BUDGET_MS = 800;

function bareNodeMs() {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['-e', 'process.stdin.resume()'], { stdio: ['pipe', 'pipe', 'pipe'] });
    child.on('error', reject);
    child.on('close', () => resolve(Date.now() - start));
    child.stdin.end('{}');
  });
}

async function expectWithinBudget(elapsedMs) {
  const baselineMs = await bareNodeMs();
  expect(elapsedMs - baselineMs).toBeLessThan(SMOKE_BUDGET_MS);
}

let dataDir;

beforeEach(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kaprek-hookend-'));
});

afterEach(() => {
  fs.rmSync(dataDir, { recursive: true, force: true });
});

function runHook(stdinPayload) {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [HOOK_PATH], { stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, [DATA_DIR_ENV]: dataDir } });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr, elapsedMs: Date.now() - start }));
    child.stdin.end(stdinPayload);
  });
}

test('empty JSON object: exit 0, no output, no ledger event, well within budget', async () => {
  const { code, stdout, elapsedMs } = await runHook('{}');
  expect(code).toBe(0);
  expect(stdout).toBe('');
  expect(fs.existsSync(path.join(dataDir, 'ledger', 'sessions.jsonl'))).toBe(false);
  await expectWithinBudget(elapsedMs);
});

test('malformed JSON: exit 0, no output, fails open, well within budget', async () => {
  const { code, stdout, elapsedMs } = await runHook('{not json');
  expect(code).toBe(0);
  expect(stdout).toBe('');
  await expectWithinBudget(elapsedMs);
});

test('empty stdin: exit 0, no output, well within budget', async () => {
  const { code, stdout, elapsedMs } = await runHook('');
  expect(code).toBe(0);
  expect(stdout).toBe('');
  await expectWithinBudget(elapsedMs);
});

test('valid input: exit 0, no stdout, appends an "end" event with the reason, well within budget', async () => {
  const { code, stdout, elapsedMs } = await runHook(
    JSON.stringify({ session_id: 's1', transcript_path: 'C:\\t\\s1.jsonl', cwd: 'C:\\p', hook_event_name: 'SessionEnd', session_end_reason: 'clear' }),
  );
  expect(code).toBe(0);
  expect(stdout).toBe('');
  const ledger = fs.readFileSync(path.join(dataDir, 'ledger', 'sessions.jsonl'), 'utf8');
  expect(ledger).toContain('"type":"end"');
  expect(ledger).toContain('"sessionId":"s1"');
  expect(ledger).toContain('"reason":"clear"');
  await expectWithinBudget(elapsedMs);
});

test('no session_id: exit 0, no ledger event written', async () => {
  const { code } = await runHook(JSON.stringify({ cwd: 'C:\\p', hook_event_name: 'SessionEnd', session_end_reason: 'other' }));
  expect(code).toBe(0);
  expect(fs.existsSync(path.join(dataDir, 'ledger', 'sessions.jsonl'))).toBe(false);
});
