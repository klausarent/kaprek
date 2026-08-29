import { test, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { openMissions } from '../missions/store.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const HOOK_PATH = path.join(__dirname, 'hook-session-start.mjs');
const DATA_DIR_ENV = 'KAPREK_DATA_DIR';

let dataDir;
let cwd;

beforeEach(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kaprek-hookstart-'));
  cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'kaprek-hookstart-cwd-'));
});

afterEach(() => {
  fs.rmSync(dataDir, { recursive: true, force: true });
  fs.rmSync(cwd, { recursive: true, force: true });
});

function runHook(stdinPayload, envOverrides = {}) {
  return new Promise((resolve, reject) => {
    // KAPREK_NO_AUTOSTART=1 always: without it a 'startup'/'resume' payload
    // below would make the hook actually spawn a detached kaprek server (see
    // src/server/ensure.mjs) — real processes have no place in this suite.
    // The call is still exercised (see the 'startup'/'resume' tests below),
    // just short-circuited before it can spawn anything; ensure.test.mjs
    // covers the spawn-or-not decision itself with a fake spawn.
    const env = { ...process.env, [DATA_DIR_ENV]: dataDir, KAPREK_NO_AUTOSTART: '1', ...envOverrides };
    const child = spawn(process.execPath, [HOOK_PATH], { stdio: ['pipe', 'pipe', 'pipe'], env });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr }));
    child.stdin.end(stdinPayload);
  });
}

test('a session in a mission directory gets the mission as additionalContext, in the hook output shape', async () => {
  openMissions(dataDir).create({ title: 'Hook me', goal: 'prove the hook', cwd });
  const { code, stdout } = await runHook(JSON.stringify({ session_id: 's', transcript_path: 'x', cwd, hook_event_name: 'SessionStart', source: 'startup' }));
  expect(code).toBe(0);
  const parsed = JSON.parse(stdout);
  expect(parsed.hookSpecificOutput.hookEventName).toBe('SessionStart');
  expect(parsed.hookSpecificOutput.additionalContext).toContain('mission "Hook me"');
  expect(parsed.hookSpecificOutput.additionalContext).toContain('prove the hook');
});

test('a directory kaprek knows nothing about, no cwd, and malformed input all produce silence with exit 0', async () => {
  for (const payload of [JSON.stringify({ session_id: 's', cwd }), JSON.stringify({ session_id: 's' }), '{not json', '']) {
    const { code, stdout } = await runHook(payload);
    expect(code).toBe(0);
    expect(stdout).toBe('');
  }
});

test('SessionStart writes a start event to the session ledger', async () => {
  const { code } = await runHook(JSON.stringify({ session_id: 'ledger-1', transcript_path: 'x', cwd, hook_event_name: 'SessionStart', source: 'startup' }));
  expect(code).toBe(0);
  const ledger = fs.readFileSync(path.join(dataDir, 'ledger', 'sessions.jsonl'), 'utf8');
  expect(ledger).toContain('"type":"start"');
  expect(ledger).toContain('"sessionId":"ledger-1"');
});

test('no cwd: no ledger event is written either (nothing to scope it to)', async () => {
  const { code } = await runHook(JSON.stringify({ session_id: 'ledger-2' }));
  expect(code).toBe(0);
  expect(fs.existsSync(path.join(dataDir, 'ledger', 'sessions.jsonl'))).toBe(false);
});

test('source startup/resume both exercise the autostart call (opted out here) without throwing or hanging; compact/clear/fork/missing all run fine too', async () => {
  for (const source of ['startup', 'resume', 'compact', 'clear', 'fork', undefined]) {
    const { code } = await runHook(JSON.stringify({ session_id: `s-${source}`, transcript_path: 'x', cwd, hook_event_name: 'SessionStart', source }));
    expect(code).toBe(0);
  }
});
