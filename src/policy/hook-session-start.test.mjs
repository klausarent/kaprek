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

function runHook(stdinPayload) {
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
