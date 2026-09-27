// Tests for the GLM (ZCode) peer driver. Run: npx vitest run src/harness/peers/glm.test.mjs
//
// No real CLI is ever spawned: a peer turn costs a Coding Plan turn and needs
// an account, so every test here drives a node script standing in for
// zcode.cjs, the same way grok.test.mjs fakes the grok binary.
import { test, expect, vi, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { EventEmitter } from 'node:events';
import { spawn } from 'node:child_process';
import {
  GLM_ATTACHMENT_MAX_BYTES,
  GLM_ATTACHMENT_MIN_BYTES,
  GLM_DISALLOWED_TOOLS,
  GLM_MAX_PROMPT_BYTES,
  GLM_TOOL_AUDIT_SKIP_ENV,
  buildGlmArgs,
  buildGlmInstruction,
  chunkPromptForZcode,
  defaultZcodeCjsPath,
  effectiveDisallowedTools,
  glmDriver,
  killTree,
  parseGlmStdout,
  providerConfigPathFor,
  resolveZcodeCli,
  runGlmTurn,
} from './glm.mjs';
import { PEER_MAX_STDOUT_BYTES, PEER_OUTPUT_SCHEMA, parsePeerAnswer } from './driver.mjs';

const dirs = [];
function tmpDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kaprek-peer-test-'));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // Windows releases a killed process's handles a moment after the kill,
      // so a directory that held one can still be EBUSY here. It is a temp
      // directory: the OS will get it. Failing the test over it would report
      // a platform quirk as a defect in the code under test.
    }
  }
});

/** Stands in for the ZCode CLI: a node script that gets the same argv the real one would. */
function fakeCli(script) {
  // The driver's args go after `--` so node hands them to the script instead
  // of trying to interpret --attach as one of its own options.
  return (_command, args, options) =>
    spawn(process.execPath, ['-e', script, '--', ...args], { ...options, shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
}

const envelope = (status, message, extra = {}) =>
  JSON.stringify({ response: JSON.stringify({ status, message }), usage: { inputTokens: 5, outputTokens: 7, totalTokens: 12 }, sessionId: 'sess_x', turnId: 1, ...extra });

/** A base env for tests that only care about the happy path, not the post-turn tool audit — see the dedicated audit describe block below for that. */
function happyEnv(dir, extra = {}) {
  return { ...process.env, KAPREK_ZCODE_PATH: path.join(dir, 'zcode.cjs'), [GLM_TOOL_AUDIT_SKIP_ENV]: '1', ...extra };
}

function writeSessionLog(dir, lines, { date = new Date() } = {}) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  const filePath = path.join(dir, `zcode-${y}-${m}-${d}.jsonl`);
  fs.writeFileSync(filePath, `${lines.map((line) => JSON.stringify(line)).join('\n')}\n`, 'utf8');
  return filePath;
}

test('the -p instruction carries the schema, and the prompt travels as attachments, never on the instruction line', () => {
  const args = buildGlmArgs({ instruction: buildGlmInstruction(PEER_OUTPUT_SCHEMA, 2), attachmentPaths: ['C:/tmp/a1.txt', 'C:/tmp/a2.txt'], cwd: 'C:/work' });
  expect(args[0]).toBe('-p');
  expect(args[1]).toContain(JSON.stringify(PEER_OUTPUT_SCHEMA));
  const attachIndexes = args.reduce((acc, arg, idx) => (arg === '--attach' ? [...acc, idx] : acc), []);
  expect(attachIndexes.map((idx) => args[idx + 1])).toEqual(['C:/tmp/a1.txt', 'C:/tmp/a2.txt']);
});

test('the flag line pins plan mode, json output, and the full disallowed-tools list — never yolo', () => {
  const args = buildGlmArgs({ instruction: 'go', cwd: 'C:/work' });
  const flag = (name) => args[args.indexOf(name) + 1];
  expect(flag('--mode')).toBe('plan');
  expect(args).toContain('--json');
  for (const tool of GLM_DISALLOWED_TOOLS.split(' ')) {
    expect(flag('--disallowed-tools').split(' ')).toContain(tool);
  }
  expect(flag('--cwd')).toBe('C:/work');
  expect(args.join(' ')).not.toMatch(/yolo/);
});

test('effectiveDisallowedTools extends the base list from KAPREK_GLM_EXTRA_DISALLOWED, space-separated', () => {
  expect(effectiveDisallowedTools({ KAPREK_GLM_EXTRA_DISALLOWED: 'mcp__foo__bar mcp__baz__qux' })).toBe(`${GLM_DISALLOWED_TOOLS} mcp__foo__bar mcp__baz__qux`);
  expect(effectiveDisallowedTools({})).toBe(GLM_DISALLOWED_TOOLS);
  expect(effectiveDisallowedTools({ KAPREK_GLM_EXTRA_DISALLOWED: '  ' })).toBe(GLM_DISALLOWED_TOOLS);
});

// ---- chunking (point 7) ----

test('chunkPromptForZcode packs the prompt into headered parts that fit the attachment cap', () => {
  const lines = [];
  for (let i = 0; i < 2000; i += 1) lines.push(`line ${i} `.repeat(50));
  const prompt = lines.join('\n');
  const parts = chunkPromptForZcode(prompt);
  expect(parts.length).toBeGreaterThan(1);
  for (const part of parts) expect(Buffer.byteLength(part, 'utf8')).toBeLessThanOrEqual(GLM_ATTACHMENT_MAX_BYTES);
  parts.forEach((part, idx) => expect(part.startsWith(`[Teil ${idx + 1} von ${parts.length}]\n`)).toBe(true));
  const rebuilt = parts.map((part) => part.slice(part.indexOf('\n') + 1)).join('');
  expect(rebuilt).toBe(prompt);
});

test('a single line longer than the attachment cap is hard-split, never dropped', () => {
  const longLine = 'x'.repeat(GLM_ATTACHMENT_MAX_BYTES * 2 + 500);
  const prompt = `intro\n${longLine}\noutro`;
  const parts = chunkPromptForZcode(prompt);
  expect(parts.length).toBeGreaterThan(1);
  for (const part of parts) expect(Buffer.byteLength(part, 'utf8')).toBeLessThanOrEqual(GLM_ATTACHMENT_MAX_BYTES);
  const rebuilt = parts.map((part) => part.slice(part.indexOf('\n') + 1)).join('');
  expect(rebuilt).toBe(prompt);
});

test('a prompt that fits in one attachment is not split needlessly', () => {
  const parts = chunkPromptForZcode('short prompt\nwith two lines');
  expect(parts).toEqual(['[Teil 1 von 1]\nshort prompt\nwith two lines']);
});

test('an attachment cap below the minimum is refused rather than risking a stuck or corrupt chunk', () => {
  expect(() => chunkPromptForZcode('hello', { attachmentMaxBytes: GLM_ATTACHMENT_MIN_BYTES - 1 })).toThrow(new RegExp(String(GLM_ATTACHMENT_MIN_BYTES)));
  expect(() => chunkPromptForZcode('hello', { attachmentMaxBytes: 100 })).toThrow(new RegExp(String(GLM_ATTACHMENT_MIN_BYTES)));
  expect(() => chunkPromptForZcode('hello', { attachmentMaxBytes: GLM_ATTACHMENT_MIN_BYTES })).not.toThrow();
});

test('supplementary-plane characters (emoji) survive exactly even when they land on a chunk boundary', () => {
  const emoji = '😀🚀🔥🎉👍';
  const line = 'a'.repeat(50) + emoji.repeat(4000);
  const parts = chunkPromptForZcode(line, { attachmentMaxBytes: 2048 });
  expect(parts.length).toBeGreaterThan(1);
  for (const part of parts) expect(Buffer.byteLength(part, 'utf8')).toBeLessThanOrEqual(2048);
  const rebuilt = parts.map((part) => part.slice(part.indexOf('\n') + 1)).join('');
  expect(rebuilt).toBe(line);
  expect(rebuilt).not.toContain('\uFFFD');
});

test('CRLF line endings round-trip exactly, each \\r staying attached to its own line', () => {
  const prompt = ['line one', 'line two', 'line three'].join('\r\n');
  const parts = chunkPromptForZcode(prompt);
  const rebuilt = parts.map((part) => part.slice(part.indexOf('\n') + 1)).join('');
  expect(rebuilt).toBe(prompt);
});

test('dense short lines pack right up to the boundary without ever splitting one in half', () => {
  const lines = Array.from({ length: 5000 }, (_, i) => `L${i}`);
  const prompt = lines.join('\n');
  const parts = chunkPromptForZcode(prompt, { attachmentMaxBytes: GLM_ATTACHMENT_MIN_BYTES });
  expect(parts.length).toBeGreaterThan(1);
  for (const part of parts) expect(Buffer.byteLength(part, 'utf8')).toBeLessThanOrEqual(GLM_ATTACHMENT_MIN_BYTES);
  const rebuilt = parts.map((part) => part.slice(part.indexOf('\n') + 1)).join('');
  expect(rebuilt).toBe(prompt);
  parts.slice(0, -1).forEach((part) => {
    const body = part.slice(part.indexOf('\n') + 1);
    expect(body.endsWith('\n')).toBe(true);
  });
});

// ---- CLI resolution ----

test('resolveZcodeCli spawns node against the resolved entry unless the override is an .exe', () => {
  expect(resolveZcodeCli({ KAPREK_ZCODE_PATH: 'C:/tools/zcode/resources/glm/zcode.cjs' })).toEqual({
    command: process.execPath,
    argsPrefix: ['C:/tools/zcode/resources/glm/zcode.cjs'],
    entryPath: 'C:/tools/zcode/resources/glm/zcode.cjs',
  });
  expect(resolveZcodeCli({ KAPREK_ZCODE_PATH: 'C:/tools/zcode/resources/glm/zcode.exe' })).toEqual({
    command: 'C:/tools/zcode/resources/glm/zcode.exe',
    argsPrefix: [],
    entryPath: 'C:/tools/zcode/resources/glm/zcode.exe',
  });
});

test('the default entry path is built from LOCALAPPDATA, falling back rather than throwing when it is missing', () => {
  expect(defaultZcodeCjsPath({ LOCALAPPDATA: 'C:/Users/x/AppData/Local' })).toBe(path.join('C:/Users/x/AppData/Local', 'Programs', 'ZCode', 'resources', 'glm', 'zcode.cjs'));
  expect(() => defaultZcodeCjsPath({})).not.toThrow();
});

test('the provider config path sits next to the entry, one level up from resources/glm', () => {
  expect(providerConfigPathFor('C:/x/resources/glm/zcode.cjs')).toBe(path.join('C:/x/resources/glm', '..', 'config', 'provider', 'zcode-builtin.json'));
});

// ---- happy path / wiring ----

test('a well-formed turn comes back as status, message, usage and a null (never zero) cost', async () => {
  const dir = tmpDir();
  const result = await runGlmTurn({
    cwd: dir,
    prompt: 'write something',
    logDir: dir,
    env: happyEnv(dir),
    spawnFn: fakeCli(`process.stdout.write(${JSON.stringify(envelope('handoff', 'here is the draft'))})`),
  });

  expect(result).toMatchObject({ status: 'handoff', message: 'here is the draft', costUsd: null });
  expect(result.usage).toEqual({ inputTokens: 5, outputTokens: 7, totalTokens: 12 });
  expect(result.durationMs).toBeGreaterThanOrEqual(0);
  expect(result.sessionId).toBeUndefined(); // internal bookkeeping only, never leaked into the PeerTurnResult
  expect(fs.readFileSync(result.rawLogPath, 'utf8')).toContain('--- stdout ---');
});

test('the attachment files are cleaned up, so a draft does not linger in temp — the raw log is kept', async () => {
  const dir = tmpDir();
  const result = await runGlmTurn({
    cwd: dir,
    prompt: 'secret draft',
    logDir: dir,
    env: happyEnv(dir),
    spawnFn: fakeCli(`process.stdout.write(${JSON.stringify(envelope('done', 'ok'))})`),
  });
  const turnDir = path.dirname(result.rawLogPath);
  expect(fs.readdirSync(turnDir).filter((name) => name.startsWith('glm-prompt-'))).toEqual([]);
  expect(fs.existsSync(result.rawLogPath)).toBe(true);
});

test('the provider config env var is injected for the child unless the caller already set one', async () => {
  const dir = tmpDir();
  const script = `process.stdout.write(JSON.stringify({ response: JSON.stringify({ status: 'done', message: process.env.ZCODE_BUILTIN_PROVIDER_CONFIG_FILE || '' }), sessionId: 'sess_x' }));`;
  const entryPath = 'C:/fake/resources/glm/zcode.cjs';
  const result = await runGlmTurn({
    cwd: dir,
    prompt: 'go',
    logDir: dir,
    env: happyEnv(dir, { KAPREK_ZCODE_PATH: entryPath }),
    spawnFn: fakeCli(script),
  });
  expect(result.message).toBe(providerConfigPathFor(entryPath));
});

test('an env var the caller already set is never overwritten', async () => {
  const dir = tmpDir();
  const script = `process.stdout.write(JSON.stringify({ response: JSON.stringify({ status: 'done', message: process.env.ZCODE_BUILTIN_PROVIDER_CONFIG_FILE || '' }), sessionId: 'sess_x' }));`;
  const result = await runGlmTurn({
    cwd: dir,
    prompt: 'go',
    logDir: dir,
    env: happyEnv(dir, { KAPREK_ZCODE_PATH: 'C:/fake/resources/glm/zcode.cjs', ZCODE_BUILTIN_PROVIDER_CONFIG_FILE: 'C:/already/set.json' }),
    spawnFn: fakeCli(script),
  });
  expect(result.message).toBe('C:/already/set.json');
});

test('the actual spawned argv pins plan mode, json, the full disallowed-tools list and a fresh --cwd — the caller\'s cwd is ignored', async () => {
  const dir = tmpDir();
  let seenArgs = null;
  let seenOptions = null;
  const spawnFn = (command, args, options) => {
    seenArgs = args;
    seenOptions = options;
    return fakeCli(`process.stdout.write(${JSON.stringify(envelope('done', 'ok'))})`)(command, args, options);
  };
  await runGlmTurn({
    cwd: 'C:/some/mission/tree',
    prompt: 'go',
    logDir: dir,
    env: happyEnv(dir),
    spawnFn,
  });

  expect(seenArgs[seenArgs.indexOf('--mode') + 1]).toBe('plan');
  expect(seenArgs).toContain('--json');
  expect(seenArgs[seenArgs.indexOf('--disallowed-tools') + 1]).toBe(GLM_DISALLOWED_TOOLS);
  expect(seenArgs.join(' ')).not.toMatch(/yolo/);

  const cwdIdx = seenArgs.indexOf('--cwd');
  expect(cwdIdx).toBeGreaterThan(-1);
  const scratchCwd = seenArgs[cwdIdx + 1];
  expect(scratchCwd).not.toBe('C:/some/mission/tree');
  expect(seenOptions.cwd).toBe(scratchCwd);
  expect(path.dirname(scratchCwd)).toBe(dir);
  expect(fs.existsSync(scratchCwd)).toBe(true);
});

test('KAPREK_GLM_EXTRA_DISALLOWED reaches the actual argv', async () => {
  const dir = tmpDir();
  let seenArgs = null;
  const spawnFn = (command, args, options) => {
    seenArgs = args;
    return fakeCli(`process.stdout.write(${JSON.stringify(envelope('done', 'ok'))})`)(command, args, options);
  };
  await runGlmTurn({
    cwd: dir,
    prompt: 'go',
    logDir: dir,
    env: happyEnv(dir, { KAPREK_GLM_EXTRA_DISALLOWED: 'mcp__foo__bar' }),
    spawnFn,
  });
  expect(seenArgs[seenArgs.indexOf('--disallowed-tools') + 1]).toBe(`${GLM_DISALLOWED_TOOLS} mcp__foo__bar`);
});

test('a multibyte character split across two data events decodes correctly instead of corrupting at the boundary', async () => {
  const dir = tmpDir();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const child = new EventEmitter();
  child.stdout = stdout;
  child.stderr = stderr;
  child.pid = 4242;
  child.kill = () => {};

  const message = 'emoji: \u{1F600} done';
  const full = Buffer.from(envelope('done', message), 'utf8');
  const text = full.toString('utf8');
  const emojiByteIndex = Buffer.byteLength(text.slice(0, text.indexOf('\u{1F600}')), 'utf8');
  // Splits INSIDE the emoji's 4-byte UTF-8 sequence — the exact case naive
  // Buffer-to-string concatenation corrupts.
  const splitAt = emojiByteIndex + 2;

  const pending = runGlmTurn({
    cwd: dir,
    prompt: 'go',
    logDir: dir,
    env: happyEnv(dir),
    spawnFn: () => child,
  });

  stdout.write(full.subarray(0, splitAt));
  stdout.write(full.subarray(splitAt));
  stdout.end();
  stderr.end();
  await new Promise((resolve) => stdout.on('end', resolve));
  child.emit('close', 0);

  const result = await pending;
  expect(result.message).toBe(message);
});

// ---- envelope parsing (point 6) ----

test('stdout is read via a balanced-brace scan, so a log line ahead of the JSON envelope does not break the parse', () => {
  const stdout = `ZCode Built-in skipped (not-due)\n${envelope('done', 'ignored the log line')}`;
  const parsed = parseGlmStdout(stdout);
  expect(parsed).toMatchObject({ status: 'done', message: 'ignored the log line' });
});

test('a brace inside a log line (not starting the line) does not derail the parse', () => {
  const stdout = `Warning: token cache miss for key {abc}\n${envelope('done', 'real answer')}`;
  const parsed = parseGlmStdout(stdout);
  expect(parsed).toMatchObject({ status: 'done', message: 'real answer' });
});

test('a diagnostic JSON line without a "response" field is skipped in favor of the real envelope', () => {
  const diagnostic = JSON.stringify({ type: 'diagnostic', level: 'info', dueAt: null });
  const stdout = `${diagnostic}\n${envelope('handoff', 'the real answer')}`;
  const parsed = parseGlmStdout(stdout);
  expect(parsed).toMatchObject({ status: 'handoff', message: 'the real answer' });
});

test('a trailing line after the envelope does not break the parse', () => {
  const stdout = `${envelope('done', 'answer before the trailing noise')}\nZCode Built-in: session saved`;
  const parsed = parseGlmStdout(stdout);
  expect(parsed).toMatchObject({ status: 'done', message: 'answer before the trailing noise' });
});

test('a fenced ```json answer is unwrapped before it is parsed', () => {
  const fenced = '```json\n{"status":"done","message":"fenced"}\n```';
  const parsed = parseGlmStdout(JSON.stringify({ response: fenced, usage: null }));
  expect(parsed).toMatchObject({ status: 'done', message: 'fenced' });
});

test('a missing cost stays null, and the CLI never reports one to pass through', () => {
  const parsed = parseGlmStdout(JSON.stringify({ response: JSON.stringify({ status: 'done', message: 'ok' }) }));
  expect(parsed.costUsd).toBeNull();
});

test('an answer that ignores the schema fails the turn rather than being guessed at', () => {
  expect(() => parseGlmStdout(JSON.stringify({ response: '{"message":"no status here"}' }))).toThrow(/status/);
  expect(() => parseGlmStdout('no JSON here at all')).toThrow(/did not print JSON/);
  expect(() => parseGlmStdout('')).toThrow(/did not print JSON/);
  expect(() => parseGlmStdout('garbled {not json')).toThrow(/did not print JSON/);
});

test('a non-validating (council) parse takes the response as-is instead of enforcing the relay shape', () => {
  const parsed = parseGlmStdout(JSON.stringify({ response: '{"verdict":"agree","summary":"looks fine"}' }), { validate: false });
  expect(parsed.status).toBe('done');
  expect(parsed.message).toBe('{"verdict":"agree","summary":"looks fine"}');
});

// ---- resource limits ----

test('stdout past the cap ends the turn cleanly instead of buffering a runaway CLI', async () => {
  const dir = tmpDir();
  const script = `process.stdout.write('x'.repeat(2 * 1024 * 1024)); setInterval(() => {}, 1000);`;
  await expect(runGlmTurn({ cwd: dir, prompt: 'go', logDir: dir, env: happyEnv(dir), spawnFn: fakeCli(script) })).rejects.toThrow(
    new RegExp(`more than ${PEER_MAX_STDOUT_BYTES} bytes`),
  );
});

test('a peer that never answers is killed at the timeout rather than held forever', async () => {
  const dir = tmpDir();
  await expect(
    runGlmTurn({ cwd: dir, prompt: 'go', timeoutMs: 1_000, logDir: dir, env: happyEnv(dir), spawnFn: fakeCli('setInterval(() => {}, 1000)') }),
  ).rejects.toThrow(/did not answer within 1000ms/);
});

test('an abort signal ends the turn at once', async () => {
  const dir = tmpDir();
  const controller = new AbortController();
  const pending = runGlmTurn({
    cwd: dir,
    prompt: 'go',
    logDir: dir,
    signal: controller.signal,
    env: happyEnv(dir),
    spawnFn: fakeCli('setTimeout(() => {}, 30000)'),
  });
  controller.abort();
  await expect(pending).rejects.toThrow(/stopped/);
});

test('an already-aborted signal is refused before any scratch directory is created or anything is spawned', async () => {
  const dir = tmpDir();
  const controller = new AbortController();
  controller.abort();
  const spawnFn = () => {
    throw new Error('must not spawn');
  };
  await expect(runGlmTurn({ cwd: dir, prompt: 'go', logDir: dir, signal: controller.signal, env: happyEnv(dir), spawnFn })).rejects.toThrow(/stopped/);
  expect(fs.readdirSync(dir)).toEqual([]);
});

test('a non-zero exit is reported with what the CLI said on stderr', async () => {
  const dir = tmpDir();
  await expect(
    runGlmTurn({ cwd: dir, prompt: 'go', logDir: dir, env: happyEnv(dir), spawnFn: fakeCli('process.stderr.write("not authenticated"); process.exit(3)') }),
  ).rejects.toThrow(/exited with code 3.*not authenticated/s);
});

test('an empty prompt is refused before anything is spawned', async () => {
  await expect(runGlmTurn({ cwd: tmpDir(), prompt: '   ' })).rejects.toThrow(/needs a prompt/);
});

test('a prompt above the limit is refused before anything is spawned', async () => {
  const spawnFn = () => {
    throw new Error('must not spawn');
  };
  await expect(runGlmTurn({ cwd: tmpDir(), prompt: 'p'.repeat(GLM_MAX_PROMPT_BYTES + 1), spawnFn })).rejects.toThrow(/GLM_MAX_PROMPT_BYTES/);
});

test('available() is a file check, never a spawn', () => {
  const dir = tmpDir();
  const realEntry = path.join(dir, 'zcode.cjs');
  fs.writeFileSync(realEntry, '// stand-in\n', 'utf8');
  expect(glmDriver.available({ KAPREK_ZCODE_PATH: realEntry })).toBe(true);
  expect(glmDriver.available({ KAPREK_ZCODE_PATH: path.join(dir, 'does-not-exist.cjs') })).toBe(false);
});

test('the driver declares the same prompt limit consult.mjs trims to, mirroring the grok mechanism', () => {
  expect(glmDriver.maxPromptBytes).toBe(GLM_MAX_PROMPT_BYTES);
  expect(glmDriver.id).toBe('glm');
});

// ---- killTree order (point 1) ----

test.skipIf(process.platform !== 'win32')('killTree runs taskkill BEFORE child.kill(), windowsHide, and awaits it', async () => {
  const order = [];
  const child = { pid: 4242, kill: () => order.push('child.kill') };
  const taskkillChild = new EventEmitter();
  const spawnFn = (command, args, options) => {
    order.push('taskkill.spawn');
    expect(command).toBe('taskkill');
    expect(args).toEqual(['/pid', '4242', '/t', '/f']);
    expect(options.windowsHide).toBe(true);
    setImmediate(() => taskkillChild.emit('close', 0));
    return taskkillChild;
  };
  await killTree(child, { spawnFn });
  expect(order).toEqual(['taskkill.spawn', 'child.kill']);
});

test.skipIf(process.platform !== 'win32')('killTree still calls child.kill() when the taskkill helper fails to start', async () => {
  const child = { pid: 4242, kill: vi.fn() };
  const spawnFn = () => {
    throw new Error('taskkill.exe not found');
  };
  await killTree(child, { spawnFn });
  expect(child.kill).toHaveBeenCalled();
});

test.skipIf(process.platform !== 'win32')('killTree still calls child.kill() when the taskkill helper itself errors out', async () => {
  const child = { pid: 4242, kill: vi.fn() };
  const taskkillChild = new EventEmitter();
  const spawnFn = () => {
    setImmediate(() => taskkillChild.emit('error', new Error('ENOENT')));
    return taskkillChild;
  };
  await killTree(child, { spawnFn });
  expect(child.kill).toHaveBeenCalled();
});

// ---- post-turn tool audit (point 9B) ----

test('a clean session (log has no toolName for it) passes the post-turn audit', async () => {
  const dir = tmpDir();
  const logDir = tmpDir();
  writeSessionLog(logDir, [
    { sessionId: 'sess_clean', event: 'turn.start' },
    { sessionId: 'sess_other', toolName: 'Bash' }, // a different session's tool call must not taint this one
  ]);
  const result = await runGlmTurn({
    cwd: dir,
    prompt: 'go',
    logDir: dir,
    zcodeLogDir: logDir,
    env: { ...process.env, KAPREK_ZCODE_PATH: path.join(dir, 'zcode.cjs') },
    spawnFn: fakeCli(`process.stdout.write(${JSON.stringify(envelope('done', 'ok', { sessionId: 'sess_clean' }))})`),
  });
  expect(result.status).toBe('done');
});

test('a session whose log shows a tool call fails the turn — the answer is discarded', async () => {
  const dir = tmpDir();
  const logDir = tmpDir();
  writeSessionLog(logDir, [
    { sessionId: 'sess_bad', toolName: 'Bash' },
    { sessionId: 'sess_bad', toolName: 'ExitPlanMode' },
  ]);
  await expect(
    runGlmTurn({
      cwd: dir,
      prompt: 'go',
      logDir: dir,
      zcodeLogDir: logDir,
      env: { ...process.env, KAPREK_ZCODE_PATH: path.join(dir, 'zcode.cjs') },
      spawnFn: fakeCli(`process.stdout.write(${JSON.stringify(envelope('done', 'ok', { sessionId: 'sess_bad' }))})`),
    }),
  ).rejects.toThrow(/invoked tools: Bash, ExitPlanMode/);
});

test('a missing session log fails the turn closed rather than trusting the answer', async () => {
  const dir = tmpDir();
  const logDir = tmpDir(); // empty — no log file for any nearby day
  await expect(
    runGlmTurn({
      cwd: dir,
      prompt: 'go',
      logDir: dir,
      zcodeLogDir: logDir,
      env: { ...process.env, KAPREK_ZCODE_PATH: path.join(dir, 'zcode.cjs') },
      spawnFn: fakeCli(`process.stdout.write(${JSON.stringify(envelope('done', 'ok', { sessionId: 'sess_missing' }))})`),
    }),
  ).rejects.toThrow(/session log was not found/);
});

test('an envelope with no sessionId fails the turn closed', async () => {
  const dir = tmpDir();
  const logDir = tmpDir();
  const envelopeWithoutSessionId = JSON.stringify({ response: JSON.stringify({ status: 'done', message: 'ok' }) });
  await expect(
    runGlmTurn({
      cwd: dir,
      prompt: 'go',
      logDir: dir,
      zcodeLogDir: logDir,
      env: { ...process.env, KAPREK_ZCODE_PATH: path.join(dir, 'zcode.cjs') },
      spawnFn: fakeCli(`process.stdout.write(${JSON.stringify(envelopeWithoutSessionId)})`),
    }),
  ).rejects.toThrow(/no sessionId/);
});

test('KAPREK_GLM_SKIP_TOOL_AUDIT=1 bypasses the audit entirely', async () => {
  const dir = tmpDir();
  const logDir = tmpDir(); // still empty — would fail closed otherwise
  const result = await runGlmTurn({
    cwd: dir,
    prompt: 'go',
    logDir: dir,
    zcodeLogDir: logDir,
    env: { ...process.env, KAPREK_ZCODE_PATH: path.join(dir, 'zcode.cjs'), [GLM_TOOL_AUDIT_SKIP_ENV]: '1' },
    spawnFn: fakeCli(`process.stdout.write(${JSON.stringify(envelope('done', 'ok', { sessionId: 'sess_whatever' }))})`),
  });
  expect(result.status).toBe('done');
});

test('a session logged under yesterday\'s file (a midnight boundary) is still found', async () => {
  const dir = tmpDir();
  const logDir = tmpDir();
  const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000);
  writeSessionLog(logDir, [{ sessionId: 'sess_y', event: 'ok' }], { date: yesterday });
  const result = await runGlmTurn({
    cwd: dir,
    prompt: 'go',
    logDir: dir,
    zcodeLogDir: logDir,
    env: { ...process.env, KAPREK_ZCODE_PATH: path.join(dir, 'zcode.cjs') },
    spawnFn: fakeCli(`process.stdout.write(${JSON.stringify(envelope('done', 'ok', { sessionId: 'sess_y' }))})`),
  });
  expect(result.status).toBe('done');
});
