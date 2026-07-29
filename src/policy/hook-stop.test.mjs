// E2E tests for hook-stop.mjs, run as a real child process (this is how
// Claude Code itself invokes it). Run: npx vitest run src/policy/hook-stop.test.mjs
import { test, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { openBoard } from '../board/store.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const HOOK_PATH = path.join(__dirname, 'hook-stop.mjs');
const PACKAGE_NAME = 'kaprek';
const DATA_DIR_ENV = `${PACKAGE_NAME.toUpperCase()}_DATA_DIR`;

let dataDir;

beforeEach(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kaprek-hookstop-test-'));
});

afterEach(() => {
  fs.rmSync(dataDir, { recursive: true, force: true });
});

function writePolicy(policy) {
  fs.writeFileSync(path.join(dataDir, 'policy.json'), JSON.stringify(policy), 'utf8');
}

function writeTranscript(sessionId, { withGitCommit = false } = {}) {
  const transcriptPath = path.join(dataDir, `${sessionId}.jsonl`);
  const lines = [JSON.stringify({ type: 'user', message: { role: 'user', content: 'hi' }, sessionId })];
  if (withGitCommit) {
    lines.push(
      JSON.stringify({
        type: 'assistant',
        sessionId,
        message: {
          role: 'assistant',
          content: [{ type: 'tool_use', name: 'Bash', input: { command: 'git commit -m "wip"' } }],
        },
      }),
    );
  }
  fs.writeFileSync(transcriptPath, `${lines.join('\n')}\n`, 'utf8');
  return transcriptPath;
}

/** Spawns hook-stop.mjs with `stdinPayload` written raw to stdin, pointing it at our temp dataDir. */
function runHook(stdinPayload, extraEnv = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [HOOK_PATH], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, [DATA_DIR_ENV]: dataDir, ...extraEnv },
    });

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

    child.stdin.write(stdinPayload);
    child.stdin.end();
  });
}

test('block case: writes {"decision":"block",...} JSON to stdout and exits 0', async () => {
  writePolicy({ mode: 'block' });
  const transcriptPath = writeTranscript('e2e-block', { withGitCommit: true });

  const { code, stdout } = await runHook(
    JSON.stringify({ transcript_path: transcriptPath, session_id: 'e2e-block' }),
  );

  expect(code).toBe(0);
  const parsed = JSON.parse(stdout);
  expect(parsed.decision).toBe('block');
  expect(typeof parsed.reason).toBe('string');
  expect(parsed.reason.length).toBeGreaterThan(0);
}, 10000);

test('second run for the same session after a block produces no output (once-marker) and exits 0', async () => {
  writePolicy({ mode: 'block' });
  const transcriptPath = writeTranscript('e2e-once', { withGitCommit: true });
  const stdinPayload = JSON.stringify({ transcript_path: transcriptPath, session_id: 'e2e-once' });

  const first = await runHook(stdinPayload);
  expect(first.code).toBe(0);
  expect(JSON.parse(first.stdout).decision).toBe('block');

  const second = await runHook(stdinPayload);
  expect(second.code).toBe(0);
  expect(second.stdout.trim()).toBe('');
}, 10000);

test('malformed stdin: exits 0 with no stdout output (fail-open)', async () => {
  const { code, stdout, stderr } = await runHook('not json at all {{{');
  expect(code).toBe(0);
  expect(stdout).toBe('');
  expect(stderr).toBe('');
}, 10000);

test('observe mode (default, no policy.json): exits 0 with no stdout output', async () => {
  const transcriptPath = writeTranscript('e2e-observe', { withGitCommit: true });
  const { code, stdout } = await runHook(
    JSON.stringify({ transcript_path: transcriptPath, session_id: 'e2e-observe' }),
  );
  expect(code).toBe(0);
  expect(stdout).toBe('');
}, 10000);

test('warn mode: exits 0, no stdout, but a warning is written to stderr', async () => {
  writePolicy({ mode: 'warn' });
  const transcriptPath = writeTranscript('e2e-warn', { withGitCommit: true });
  const { code, stdout, stderr } = await runHook(
    JSON.stringify({ transcript_path: transcriptPath, session_id: 'e2e-warn' }),
  );
  expect(code).toBe(0);
  expect(stdout).toBe('');
  expect(stderr).toMatch(/policy warning/);
}, 10000);

test('stop_hook_active guard: block mode still exits 0 with no output when stop_hook_active is true', async () => {
  writePolicy({ mode: 'block' });
  const transcriptPath = writeTranscript('e2e-stop-hook-active', { withGitCommit: true });

  const { code, stdout, stderr } = await runHook(
    JSON.stringify({
      transcript_path: transcriptPath,
      session_id: 'e2e-stop-hook-active',
      stop_hook_active: true,
    }),
  );

  expect(code).toBe(0);
  expect(stdout).toBe('');
  expect(stderr).toBe('');
}, 10000);

test('Stop hook preserves the ending session\'s scratchpad into dataDir/artifacts', async () => {
  const sessionId = 'e2e-artifacts';
  const transcriptPath = writeTranscript(sessionId);
  // projectSlug is derived by the hook from the transcript_path's parent
  // directory name — here that is dataDir itself, since writeTranscript()
  // writes `${dataDir}/${sessionId}.jsonl`.
  const projectSlug = path.basename(dataDir);
  const tmpRootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kaprek-hookstop-tmproot-'));
  const scratchpadDir = path.join(tmpRootDir, projectSlug, sessionId, 'scratchpad');
  fs.mkdirSync(scratchpadDir, { recursive: true });
  fs.writeFileSync(path.join(scratchpadDir, 'result.txt'), 'work product', 'utf8');

  try {
    const { code } = await runHook(JSON.stringify({ transcript_path: transcriptPath, session_id: sessionId }), {
      KAPREK_TMP_ROOT: tmpRootDir,
    });
    expect(code).toBe(0);

    const preservedPath = path.join(dataDir, 'artifacts', projectSlug, sessionId, 'result.txt');
    expect(fs.existsSync(preservedPath)).toBe(true);
    expect(fs.readFileSync(preservedPath, 'utf8')).toBe('work product');
  } finally {
    fs.rmSync(tmpRootDir, { recursive: true, force: true });
  }
}, 10000);

test('a broken/unusable tmpRoot never breaks the hook\'s fail-open contract (still exits 0, normal decision output)', async () => {
  writePolicy({ mode: 'block' });
  const sessionId = 'e2e-broken-tmproot';
  const transcriptPath = writeTranscript(sessionId, { withGitCommit: true });
  // A regular FILE (not a directory) as tmpRoot — any path built underneath
  // it for artifact preservation is unreachable, but must not throw.
  const brokenTmpRoot = path.join(dataDir, 'broken-tmproot-is-a-file');
  fs.writeFileSync(brokenTmpRoot, 'not a directory', 'utf8');

  const { code, stdout } = await runHook(
    JSON.stringify({ transcript_path: transcriptPath, session_id: sessionId }),
    { KAPREK_TMP_ROOT: brokenTmpRoot },
  );

  expect(code).toBe(0);
  // Normal policy behavior (block mode + a git commit + no linked task)
  // still fires — the broken tmpRoot only affects artifact preservation.
  const parsed = JSON.parse(stdout);
  expect(parsed.decision).toBe('block');
}, 10000);

test('block mode allows silently when the session is linked to a board task', async () => {
  writePolicy({ mode: 'block' });
  const board = openBoard(dataDir);
  const task = board.create({ title: 'Do the thing' });
  board.linkSession(task.id, { machine: 'm1', projectSlug: 'proj', sessionId: 'e2e-linked' });
  const transcriptPath = writeTranscript('e2e-linked', { withGitCommit: true });

  const { code, stdout } = await runHook(
    JSON.stringify({ transcript_path: transcriptPath, session_id: 'e2e-linked' }),
  );
  expect(code).toBe(0);
  expect(stdout).toBe('');
}, 10000);
