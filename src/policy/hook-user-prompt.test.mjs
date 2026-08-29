import { test, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { openMissions } from '../missions/store.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const HOOK_PATH = path.join(__dirname, 'hook-user-prompt.mjs');
const DATA_DIR_ENV = 'KAPREK_DATA_DIR';
// Same reasoning as hook-session-end.test.mjs: a lone process spawn already
// costs tens of ms, and the full suite running in parallel adds more on top
// of that. 800 ms stays comfortably below SELF_TIMEOUT_MS (1000 ms) while
// leaving room to actually see the fast path (unchanged cwd) come in well
// under the slow path (directory changed, stores loaded) without flaking.
const SMOKE_BUDGET_MS = 800;

let dataDir;
let cwdA;
let cwdB;

beforeEach(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kaprek-hookprompt-'));
  cwdA = fs.mkdtempSync(path.join(os.tmpdir(), 'kaprek-hookprompt-cwd-a-'));
  cwdB = fs.mkdtempSync(path.join(os.tmpdir(), 'kaprek-hookprompt-cwd-b-'));
});

afterEach(() => {
  fs.rmSync(dataDir, { recursive: true, force: true });
  fs.rmSync(cwdA, { recursive: true, force: true });
  fs.rmSync(cwdB, { recursive: true, force: true });
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

function payload({ sessionId = 's', cwd, promptId = 'p1' } = {}) {
  return JSON.stringify({ session_id: sessionId, cwd, transcript_path: 'x', hook_event_name: 'UserPromptSubmit', prompt_id: promptId, user_input: 'hi' });
}

function stateFile(sessionId) {
  return path.join(dataDir, 'context', `${sessionId}.json`);
}

test('first prompt with no state yet, in a mission directory, gets the mission as additionalContext', async () => {
  openMissions(dataDir).create({ title: 'Prompt me', goal: 'prove the prompt hook', cwd: cwdA });
  const { code, stdout, stderr } = await runHook(payload({ sessionId: 's-first', cwd: cwdA }));
  expect(code).toBe(0);
  expect(stderr).toBe('');
  const parsed = JSON.parse(stdout);
  expect(parsed.hookSpecificOutput.hookEventName).toBe('UserPromptSubmit');
  expect(parsed.hookSpecificOutput.additionalContext).toContain('mission "Prompt me"');
  const state = JSON.parse(fs.readFileSync(stateFile('s-first'), 'utf8'));
  expect(state.cwd).toBe(cwdA);
});

test('same directory as last time: no output, and measurably fast (fast path, no store import)', async () => {
  openMissions(dataDir).create({ title: 'Prompt me', goal: 'g', cwd: cwdA });
  await runHook(payload({ sessionId: 's-same', cwd: cwdA })); // sets state
  const { code, stdout, elapsedMs } = await runHook(payload({ sessionId: 's-same', cwd: cwdA }));
  expect(code).toBe(0);
  expect(stdout).toBe('');
  expect(elapsedMs).toBeLessThan(SMOKE_BUDGET_MS);
});

test('directory change: the new directory\'s context is sent, even though the old one had already been seen', async () => {
  openMissions(dataDir).create({ title: 'Old place', goal: 'g1', cwd: cwdA });
  openMissions(dataDir).create({ title: 'New place', goal: 'g2', cwd: cwdB });
  await runHook(payload({ sessionId: 's-switch', cwd: cwdA }));
  const { code, stdout } = await runHook(payload({ sessionId: 's-switch', cwd: cwdB }));
  expect(code).toBe(0);
  const parsed = JSON.parse(stdout);
  expect(parsed.hookSpecificOutput.additionalContext).toContain('mission "New place"');
});

test('unknown directory: no output, but the state is still recorded so the next same-directory prompt takes the fast path', async () => {
  const { code, stdout } = await runHook(payload({ sessionId: 's-unknown', cwd: cwdA }));
  expect(code).toBe(0);
  expect(stdout).toBe('');
  expect(fs.existsSync(stateFile('s-unknown'))).toBe(true);
  const state = JSON.parse(fs.readFileSync(stateFile('s-unknown'), 'utf8'));
  expect(state.cwd).toBe(cwdA);
});

test('malformed stdin, empty stdin, and a corrupt state file all produce silence with exit 0', async () => {
  fs.mkdirSync(path.join(dataDir, 'context'), { recursive: true });
  fs.writeFileSync(stateFile('s-corrupt'), '{not json', 'utf8');

  for (const inputCase of ['{not json', '', payload({ sessionId: 's-corrupt', cwd: cwdA })]) {
    const { code, stdout } = await runHook(inputCase);
    expect(code).toBe(0);
    expect(stdout).toBe('');
  }
});

test('missing cwd or session_id: exit 0, no output, no state written', async () => {
  for (const inputCase of [JSON.stringify({ session_id: 's-nocwd' }), JSON.stringify({ cwd: cwdA })]) {
    const { code, stdout } = await runHook(inputCase);
    expect(code).toBe(0);
    expect(stdout).toBe('');
  }
  expect(fs.existsSync(stateFile('s-nocwd'))).toBe(false);
});

test('never exits with code 2, even on a directory change that produces context', async () => {
  openMissions(dataDir).create({ title: 'M', goal: 'g', cwd: cwdA });
  const { code } = await runHook(payload({ sessionId: 's-never-2', cwd: cwdA }));
  expect(code).not.toBe(2);
  expect(code).toBe(0);
});

test('a directory change sweeps context state files older than 7 days, leaving fresh ones alone', async () => {
  fs.mkdirSync(path.join(dataDir, 'context'), { recursive: true });
  const oldFile = path.join(dataDir, 'context', 'old-session.json');
  const freshFile = path.join(dataDir, 'context', 'fresh-session.json');
  fs.writeFileSync(oldFile, JSON.stringify({ cwd: cwdA, ts: new Date().toISOString() }), 'utf8');
  fs.writeFileSync(freshFile, JSON.stringify({ cwd: cwdA, ts: new Date().toISOString() }), 'utf8');
  const eightDaysAgo = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
  fs.utimesSync(oldFile, eightDaysAgo, eightDaysAgo);

  // Any directory change (first prompt with no state for this session)
  // exercises the slow path, which is where the sweep runs.
  await runHook(payload({ sessionId: 's-sweep-trigger', cwd: cwdA }));

  expect(fs.existsSync(oldFile)).toBe(false);
  expect(fs.existsSync(freshFile)).toBe(true);
});
