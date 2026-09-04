// Tests for the Grok peer driver. Run: npx vitest run src/harness/peers/grok.test.mjs
//
// No real CLI is ever spawned: a peer turn costs money and needs an account,
// so every test here drives a node script standing in for grok, the same way
// claude-code.test.mjs fakes the claude CLI. The flag line itself is asserted
// against buildGrokArgs(), because "the prompt never goes through argv" is a
// property, not a comment.
import { test, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { GROK_MAX_PROMPT_BYTES, buildGrokArgs, grokDriver, parseGrokStdout, resolveGrokCli, runGrokTurn } from './grok.mjs';
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

/** Stands in for the grok binary: a node script that gets the same argv the real one would. */
function fakeCli(script) {
  // The driver's args go after `--` so node hands them to the script instead
  // of trying to interpret --prompt-file as one of its own options. The
  // script can still read them from process.argv, which is how the test
  // below checks that the prompt really reached the CLI through the file.
  return (_command, args, options) =>
    spawn(process.execPath, ['-e', script, '--', ...args], { ...options, shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
}

const answer = (status, message) => JSON.stringify({ text: JSON.stringify({ status, message }), usage: { total_tokens: 12 }, total_cost_usd: 0.02 });

test('the prompt travels in a FILE, never on the command line', () => {
  const args = buildGrokArgs({ promptPath: 'C:/tmp/p.txt', cwd: 'C:/work' });
  expect(args).toContain('--prompt-file');
  expect(args[args.indexOf('--prompt-file') + 1]).toBe('C:/tmp/p.txt');
  // Nothing in argv may carry prompt text: a relay prompt is whole drafts,
  // and argv has length and quoting limits that differ per platform.
  expect(args.some((arg) => arg.length > 2000)).toBe(false);
});

test('the flag line pins text-only: no tools, no web, no subagents, no memory, one turn', () => {
  const args = buildGrokArgs({ promptPath: 'p.txt', cwd: 'C:/work' });
  const flag = (name) => args[args.indexOf(name) + 1];

  expect(args).toContain('--disable-web-search');
  expect(args).toContain('--no-subagents');
  expect(args).toContain('--no-memory');
  expect(args).toContain('--tools');
  // An EMPTY tool set, not an omitted flag: omitting it would hand the peer
  // the CLI's default tools, which is the opposite of what it asks for.
  expect(flag('--tools')).toBe('');
  // …and the empty allowlist alone does not take (24 tools stay), so the
  // text-only turn also strips file, shell, web and task tools by name.
  for (const tool of ['read_file', 'run_terminal_cmd', 'run_terminal_command', 'grep', 'search_replace', 'web_fetch', 'task', 'Agent']) {
    expect(flag('--disallowed-tools').split(',')).toContain(tool);
  }
  // The prompt goes to the model as written — without --verbatim the CLI
  // offloads a long prompt into a file the model cannot read back.
  expect(args).toContain('--verbatim');
  expect(flag('--max-turns')).toBe('1');
  expect(flag('--permission-mode')).toBe('plan');
  // And the answer is schema-constrained, so `status` is data rather than
  // something read out of prose.
  expect(JSON.parse(flag('--json-schema'))).toEqual(PEER_OUTPUT_SCHEMA);
  expect(flag('--output-format')).toBe('json');
});

test('a well-formed turn comes back as status, message, usage and an ESTIMATED cost', async () => {
  const dir = tmpDir();
  const result = await runGrokTurn({
    cwd: dir,
    prompt: 'write something',
    logDir: dir,
    spawnFn: fakeCli(`process.stdout.write(${JSON.stringify(answer('handoff', 'here is the draft'))})`),
  });

  expect(result).toMatchObject({ status: 'handoff', message: 'here is the draft', costUsd: 0.02 });
  expect(result.usage).toEqual({ total_tokens: 12 });
  expect(result.durationMs).toBeGreaterThanOrEqual(0);
  // The raw log exists for the times the parsed answer does not explain what
  // happened.
  expect(fs.readFileSync(result.rawLogPath, 'utf8')).toContain('--- stdout ---');
});

test('a missing cost stays null and never becomes zero', () => {
  const parsed = parseGrokStdout(JSON.stringify({ text: JSON.stringify({ status: 'done', message: 'ok' }) }));
  // Zero would read as "this turn was free", which is a different and false
  // claim from "the CLI did not say".
  expect(parsed.costUsd).toBeNull();
});

test('an answer that ignores the schema fails the turn rather than being guessed at', () => {
  // The dispatcher acts on `status`. Inventing one from prose is how a relay
  // ends up in a loop nobody asked for.
  expect(() => parsePeerAnswer('{"message":"I think we are done here"}')).toThrow(/status/);
  expect(() => parsePeerAnswer('{"status":"maybe","message":"x"}')).toThrow(/status/);
  expect(() => parsePeerAnswer('not json at all')).toThrow(/not JSON/);
  expect(() => parseGrokStdout('Error: not logged in')).toThrow(/did not print JSON/);
  // The two failures need different fixes, so they say different things.
  expect(() => parseGrokStdout(JSON.stringify({ text: 'plain prose' }))).toThrow(/not JSON/);
});

test('stdout past the cap ends the turn cleanly instead of buffering a runaway CLI', async () => {
  const dir = tmpDir();
  // Written in one go and then held open: the cap has to bite on the data,
  // not on the process happening to exit first.
  const script = `process.stdout.write('x'.repeat(2 * 1024 * 1024)); setInterval(() => {}, 1000);`;
  await expect(runGrokTurn({ cwd: dir, prompt: 'go', logDir: dir, spawnFn: fakeCli(script) })).rejects.toThrow(
    new RegExp(`more than ${PEER_MAX_STDOUT_BYTES} bytes`),
  );
});

test('a peer that never answers is killed at the timeout rather than held forever', async () => {
  // The child here never exits on its own (an open interval keeps it alive),
  // so the only way this test can finish at all is the timeout firing and
  // killing it. That is the assertion; a wall-clock bound on top of it would
  // only measure how loaded the machine running the suite happens to be.
  const dir = tmpDir();
  await expect(
    runGrokTurn({ cwd: dir, prompt: 'go', timeoutMs: 1_000, logDir: dir, spawnFn: fakeCli('setInterval(() => {}, 1000)') }),
  ).rejects.toThrow(/did not answer within 1000ms/);
});

test('an abort signal ends the turn at once', async () => {
  const dir = tmpDir();
  const controller = new AbortController();
  const pending = runGrokTurn({
    cwd: dir,
    prompt: 'go',
    logDir: dir,
    signal: controller.signal,
    spawnFn: fakeCli('setTimeout(() => {}, 30000)'),
  });
  controller.abort();
  await expect(pending).rejects.toThrow(/stopped/);
});

test('a non-zero exit is reported with what the CLI said on stderr', async () => {
  const dir = tmpDir();
  await expect(
    runGrokTurn({
      cwd: dir,
      prompt: 'go',
      logDir: dir,
      spawnFn: fakeCli('process.stderr.write("not authenticated"); process.exit(3)'),
    }),
  ).rejects.toThrow(/exited with code 3.*not authenticated/s);
});

test('an empty prompt is refused before anything is spawned', async () => {
  await expect(runGrokTurn({ cwd: tmpDir(), prompt: '   ' })).rejects.toThrow(/needs a prompt/);
});

test('the CLI really receives the prompt as a readable file, not as text', async () => {
  // The end-to-end half of the argv test above: the file the driver names on
  // the command line exists when the CLI starts and contains exactly the
  // prompt.
  const dir = tmpDir();
  const script = `
    const fs = require('node:fs');
    const args = process.argv.slice(2);
    const promptPath = args[args.indexOf('--prompt-file') + 1];
    const seen = fs.readFileSync(promptPath, 'utf8');
    process.stdout.write(JSON.stringify({ text: JSON.stringify({ status: 'done', message: seen }) }));
  `;
  const result = await runGrokTurn({ cwd: dir, prompt: 'the whole draft, several lines\nand a second one', logDir: dir, spawnFn: fakeCli(script) });
  expect(result.message).toBe('the whole draft, several lines\nand a second one');
});

test('the prompt file is cleaned up, so a draft does not linger in temp', async () => {
  const dir = tmpDir();
  await runGrokTurn({ cwd: dir, prompt: 'secret draft', logDir: dir, spawnFn: fakeCli(`process.stdout.write(${JSON.stringify(answer('done', 'ok'))})`) });
  expect(fs.readdirSync(dir).filter((name) => name.startsWith('grok-prompt-'))).toEqual([]);
});

test('an explicit path override wins over the PATH walk', () => {
  // A .cmd override that cannot be resolved to a node entry keeps the old
  // shell:true behavior — last resort, not the happy path (see below).
  expect(resolveGrokCli({ KAPREK_GROK_PATH: 'C:/tools/grok.cmd' })).toEqual({ command: 'C:/tools/grok.cmd', argsPrefix: [], useShell: true });
  expect(resolveGrokCli({ KAPREK_GROK_PATH: '/usr/local/bin/grok' })).toEqual({ command: '/usr/local/bin/grok', argsPrefix: [], useShell: false });
});

// The two Windows spawn bugs from the tag-5 live acceptance (ledger,
// 01.08.): with shell:true node JOINS argv raw, so `--tools ''` (an empty
// string argument) vanishes entirely, and cmd.exe eats the quotes inside the
// --json-schema JSON. The fix is to never need shell:true: prefer a native
// .exe anywhere on PATH, and resolve an npm .cmd shim to the node script it
// wraps so argv arrives byte-exact.

/** Writes a real npm cmd-shim (the exact text `npm i -g` generates) plus the node entry it points at. */
function writeShim(dir, { withEntry = true } = {}) {
  const shimPath = path.join(dir, 'grok.cmd');
  fs.writeFileSync(
    shimPath,
    '@ECHO off\r\nGOTO start\r\n:find_dp0\r\nSET dp0=%~dp0\r\nEXIT /b\r\n:start\r\nSETLOCAL\r\nCALL :find_dp0\r\n\r\n' +
      'IF EXIST "%dp0%\\node.exe" (\r\n  SET "_prog=%dp0%\\node.exe"\r\n) ELSE (\r\n  SET "_prog=node"\r\n  SET PATHEXT=%PATHEXT:;.JS;=;%\r\n)\r\n\r\n' +
      'endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\node_modules\\@xai-official\\grok\\bin\\grok" %*\r\n',
    'utf8',
  );
  const entry = path.join(dir, 'node_modules', '@xai-official', 'grok', 'bin', 'grok');
  if (withEntry) {
    fs.mkdirSync(path.dirname(entry), { recursive: true });
    fs.writeFileSync(entry, '// grok cli entry\n', 'utf8');
  }
  return { shimPath, entry };
}

test('a native exe anywhere on PATH beats a cmd shim that comes earlier', () => {
  const shimDir = tmpDir();
  const exeDir = tmpDir();
  writeShim(shimDir);
  const exePath = path.join(exeDir, 'grok.exe');
  fs.writeFileSync(exePath, 'MZ', 'utf8');
  const env = { PATH: [shimDir, exeDir].join(path.delimiter) };
  expect(resolveGrokCli(env, { platform: 'win32' })).toEqual({ command: exePath, argsPrefix: [], useShell: false });
});

test('a cmd shim resolves to its node entry and spawns without a shell', () => {
  const shimDir = tmpDir();
  const { entry } = writeShim(shimDir);
  const env = { PATH: shimDir };
  expect(resolveGrokCli(env, { platform: 'win32' })).toEqual({ command: process.execPath, argsPrefix: [entry], useShell: false });
});

test('a shim without a resolvable entry falls back to shell:true rather than failing', () => {
  const shimDir = tmpDir();
  const { shimPath } = writeShim(shimDir, { withEntry: false });
  const env = { PATH: shimDir };
  expect(resolveGrokCli(env, { platform: 'win32' })).toEqual({ command: shimPath, argsPrefix: [], useShell: true });
});

// Needs the real platform: runGrokTurn resolves with process.platform, and on
// POSIX the PATH walk never looks at .cmd shims in the first place.
test.skipIf(process.platform !== 'win32')('a resolved shim really spawns node with the entry prepended to the argv', async () => {
  const dir = tmpDir();
  const shimDir = tmpDir();
  const { entry } = writeShim(shimDir);
  const seen = [];
  const spawnFn = (command, args, options) => {
    seen.push({ command, args, shell: options.shell });
    return spawn(process.execPath, ['-e', `process.stdout.write(${JSON.stringify(answer('done', 'ok'))})`], { stdio: ['ignore', 'pipe', 'pipe'] });
  };
  await runGrokTurn({ cwd: dir, prompt: 'hi', logDir: dir, spawnFn, env: { PATH: shimDir } });
  expect(seen).toHaveLength(1);
  expect(seen[0].shell).toBe(false);
  expect(seen[0].command).toBe(process.execPath);
  expect(seen[0].args[0]).toBe(entry);
  expect(seen[0].args).toContain('--tools');
});

test('a shell shim plus an empty tool list fails loudly before anything runs', async () => {
  // cmd.exe drops an empty '' argument when it joins the argv, so the
  // tool-free council turn would silently run with grok's default tools.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kaprek-grok-shim-'));
  const shim = path.join(dir, 'grok.cmd');
  fs.writeFileSync(shim, '@echo not-a-real-shim\r\n', 'utf8');
  let spawned = false;
  try {
    await expect(
      runGrokTurn({ cwd: dir, prompt: 'go', logDir: dir, env: { KAPREK_GROK_PATH: shim }, spawnFn: () => { spawned = true; throw new Error('must not spawn'); } }),
    ).rejects.toThrow(/KAPREK_GROK_PATH/);
    expect(spawned).toBe(false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the driver declares a prompt limit no larger than what was verified', () => {
  // Without --verbatim the CLI offloaded anything above ~24 KB (23,971 bytes
  // passed, 25,442 were offloaded, 0.2.117 and 1.0.13). With --verbatim the
  // largest prompt answered end to end was 155,574 bytes (1.0.13, 04.09.2026);
  // the cap must not outgrow what a live turn has proven.
  expect(GROK_MAX_PROMPT_BYTES).toBeLessThanOrEqual(155_574);
  expect(GROK_MAX_PROMPT_BYTES).toBeGreaterThanOrEqual(100_000);
  expect(grokDriver.maxPromptBytes).toBe(GROK_MAX_PROMPT_BYTES);
});

test('an explicit allowlist is not undone by the text-only denylist', () => {
  const args = buildGrokArgs({ promptPath: 'p.txt', cwd: 'C:/work', tools: 'read_file,grep' });
  expect(args[args.indexOf('--tools') + 1]).toBe('read_file,grep');
  expect(args).not.toContain('--disallowed-tools');
  expect(args).toContain('--verbatim');
});

test('a prompt above the limit is refused before anything is spawned', async () => {
  const spawnFn = () => { throw new Error('must not spawn'); };
  await expect(runGrokTurn({ cwd: tmpDir(), prompt: 'p'.repeat(GROK_MAX_PROMPT_BYTES + 1), spawnFn })).rejects.toThrow(/offloads/);
});
