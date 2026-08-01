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
import { buildGrokArgs, parseGrokStdout, resolveGrokCli, runGrokTurn } from './grok.mjs';
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
  expect(resolveGrokCli({ KAPREK_GROK_PATH: 'C:/tools/grok.cmd' })).toEqual({ command: 'C:/tools/grok.cmd', useShell: true });
  expect(resolveGrokCli({ KAPREK_GROK_PATH: '/usr/local/bin/grok' })).toEqual({ command: '/usr/local/bin/grok', useShell: false });
});
