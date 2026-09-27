// Tests for the GLM (ZCode) peer driver. Run: npx vitest run src/harness/peers/glm.test.mjs
//
// No real CLI is ever spawned: a peer turn costs a Coding Plan turn and needs
// an account, so every test here drives a node script standing in for
// zcode.cjs, the same way grok.test.mjs fakes the grok binary.
import { test, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import {
  GLM_ATTACHMENT_MAX_BYTES,
  GLM_DISALLOWED_TOOLS,
  GLM_MAX_PROMPT_BYTES,
  buildGlmArgs,
  buildGlmInstruction,
  chunkPromptForZcode,
  defaultZcodeCjsPath,
  glmDriver,
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

test('the -p instruction carries the schema, and the prompt travels as attachments, never on the instruction line', () => {
  const args = buildGlmArgs({ instruction: buildGlmInstruction(PEER_OUTPUT_SCHEMA, 2), attachmentPaths: ['C:/tmp/a1.txt', 'C:/tmp/a2.txt'], cwd: 'C:/work' });
  expect(args[0]).toBe('-p');
  // The schema is spelled out in the instruction text, not just documented —
  // the dispatcher acts on `status`, so the model needs to be told the shape.
  expect(args[1]).toContain(JSON.stringify(PEER_OUTPUT_SCHEMA));
  const attachIndexes = args.reduce((acc, arg, idx) => (arg === '--attach' ? [...acc, idx] : acc), []);
  expect(attachIndexes.map((idx) => args[idx + 1])).toEqual(['C:/tmp/a1.txt', 'C:/tmp/a2.txt']);
});

test('the flag line pins plan mode and strips the tool-capable set', () => {
  const args = buildGlmArgs({ instruction: 'go', cwd: 'C:/work' });
  const flag = (name) => args[args.indexOf(name) + 1];
  // -p defaults to permission mode "yolo" (verified live) — this is never
  // optional, belt and braces even if a tool slipped into the set.
  expect(flag('--mode')).toBe('plan');
  expect(args).toContain('--json');
  for (const tool of GLM_DISALLOWED_TOOLS.split(' ')) {
    expect(flag('--disallowed-tools').split(' ')).toContain(tool);
  }
  expect(flag('--cwd')).toBe('C:/work');
});

test('chunkPromptForZcode packs the prompt into headered parts that fit the attachment cap', () => {
  const lines = [];
  for (let i = 0; i < 2000; i += 1) lines.push(`line ${i} `.repeat(50));
  const prompt = lines.join('\n');
  const parts = chunkPromptForZcode(prompt);
  expect(parts.length).toBeGreaterThan(1);
  for (const part of parts) expect(Buffer.byteLength(part, 'utf8')).toBeLessThanOrEqual(GLM_ATTACHMENT_MAX_BYTES);
  parts.forEach((part, idx) => expect(part.startsWith(`[Teil ${idx + 1} von ${parts.length}]\n`)).toBe(true));
  // Stripping the headers and rejoining the bodies must reproduce the prompt
  // byte for byte — chunking must never lose, reorder or duplicate a
  // character, only decide where the file boundaries fall.
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

test('a well-formed turn comes back as status, message, usage and a null (never zero) cost', async () => {
  const dir = tmpDir();
  const result = await runGlmTurn({
    cwd: dir,
    prompt: 'write something',
    logDir: dir,
    env: { ...process.env, KAPREK_ZCODE_PATH: path.join(dir, 'zcode.cjs') },
    spawnFn: fakeCli(`process.stdout.write(${JSON.stringify(envelope('handoff', 'here is the draft'))})`),
  });

  expect(result).toMatchObject({ status: 'handoff', message: 'here is the draft', costUsd: null });
  expect(result.usage).toEqual({ inputTokens: 5, outputTokens: 7, totalTokens: 12 });
  expect(result.durationMs).toBeGreaterThanOrEqual(0);
  expect(fs.readFileSync(result.rawLogPath, 'utf8')).toContain('--- stdout ---');
});

test('the attachment files are cleaned up, so a draft does not linger in temp', async () => {
  const dir = tmpDir();
  await runGlmTurn({
    cwd: dir,
    prompt: 'secret draft',
    logDir: dir,
    env: { ...process.env, KAPREK_ZCODE_PATH: path.join(dir, 'zcode.cjs') },
    spawnFn: fakeCli(`process.stdout.write(${JSON.stringify(envelope('done', 'ok'))})`),
  });
  expect(fs.readdirSync(dir).filter((name) => name.startsWith('glm-prompt-'))).toEqual([]);
});

test('the provider config env var is injected for the child unless the caller already set one', async () => {
  const dir = tmpDir();
  const script = `process.stdout.write(JSON.stringify({ response: JSON.stringify({ status: 'done', message: process.env.ZCODE_BUILTIN_PROVIDER_CONFIG_FILE || '' }) }));`;
  const entryPath = 'C:/fake/resources/glm/zcode.cjs';
  const result = await runGlmTurn({
    cwd: dir,
    prompt: 'go',
    logDir: dir,
    env: { ...process.env, KAPREK_ZCODE_PATH: entryPath },
    spawnFn: fakeCli(script),
  });
  expect(result.message).toBe(providerConfigPathFor(entryPath));
});

test('an env var the caller already set is never overwritten', async () => {
  const dir = tmpDir();
  const script = `process.stdout.write(JSON.stringify({ response: JSON.stringify({ status: 'done', message: process.env.ZCODE_BUILTIN_PROVIDER_CONFIG_FILE || '' }) }));`;
  const result = await runGlmTurn({
    cwd: dir,
    prompt: 'go',
    logDir: dir,
    env: { ...process.env, KAPREK_ZCODE_PATH: 'C:/fake/resources/glm/zcode.cjs', ZCODE_BUILTIN_PROVIDER_CONFIG_FILE: 'C:/already/set.json' },
    spawnFn: fakeCli(script),
  });
  expect(result.message).toBe('C:/already/set.json');
});

test('stdout is read from the first "{", so a log line ahead of the JSON envelope does not break the parse', () => {
  const stdout = `ZCode Built-in skipped (not-due)\n${envelope('done', 'ignored the log line')}`;
  const parsed = parseGlmStdout(stdout);
  expect(parsed).toMatchObject({ status: 'done', message: 'ignored the log line' });
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

test('stdout past the cap ends the turn cleanly instead of buffering a runaway CLI', async () => {
  const dir = tmpDir();
  const script = `process.stdout.write('x'.repeat(2 * 1024 * 1024)); setInterval(() => {}, 1000);`;
  await expect(
    runGlmTurn({ cwd: dir, prompt: 'go', logDir: dir, env: { ...process.env, KAPREK_ZCODE_PATH: path.join(dir, 'zcode.cjs') }, spawnFn: fakeCli(script) }),
  ).rejects.toThrow(new RegExp(`more than ${PEER_MAX_STDOUT_BYTES} bytes`));
});

test('a peer that never answers is killed at the timeout rather than held forever', async () => {
  const dir = tmpDir();
  await expect(
    runGlmTurn({
      cwd: dir,
      prompt: 'go',
      timeoutMs: 1_000,
      logDir: dir,
      env: { ...process.env, KAPREK_ZCODE_PATH: path.join(dir, 'zcode.cjs') },
      spawnFn: fakeCli('setInterval(() => {}, 1000)'),
    }),
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
    env: { ...process.env, KAPREK_ZCODE_PATH: path.join(dir, 'zcode.cjs') },
    spawnFn: fakeCli('setTimeout(() => {}, 30000)'),
  });
  controller.abort();
  await expect(pending).rejects.toThrow(/stopped/);
});

test('a non-zero exit is reported with what the CLI said on stderr', async () => {
  const dir = tmpDir();
  await expect(
    runGlmTurn({
      cwd: dir,
      prompt: 'go',
      logDir: dir,
      env: { ...process.env, KAPREK_ZCODE_PATH: path.join(dir, 'zcode.cjs') },
      spawnFn: fakeCli('process.stderr.write("not authenticated"); process.exit(3)'),
    }),
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
