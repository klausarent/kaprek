import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { InvalidNotifyError, notify, notifyEnv, readNotify, writeNotify } from './notify.mjs';

let dataDir;

beforeEach(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kaprek-notify-'));
});

afterEach(() => {
  fs.rmSync(dataDir, { recursive: true, force: true });
});

/** A fake spawn that records how it was called and then exits. */
function fakeSpawn(calls, { fail = false, hang = false } = {}) {
  return (command, args, options) => {
    calls.push({ command, args, options });
    const child = new EventEmitter();
    // .on too: the real stream gets an error listener so an EPIPE from a
    // notifier that closed stdin early does not take the process down.
    child.stdin = { end: (value) => calls.push({ stdin: value }), on: () => {} };
    child.kill = () => calls.push({ killed: true });
    if (fail) queueMicrotask(() => child.emit('error', new Error('spawn ENOENT')));
    else if (!hang) queueMicrotask(() => child.emit('exit', 0));
    return child;
  };
}

describe('readNotify / writeNotify', () => {
  test('nothing configured is the default, not an error', () => {
    expect(readNotify(dataDir)).toEqual({ command: [], configured: false });
  });

  test('round-trips a command', () => {
    writeNotify(dataDir, ['ntfy', 'publish', 'my-topic']);
    expect(readNotify(dataDir)).toEqual({ command: ['ntfy', 'publish', 'my-topic'], configured: true });
  });

  test('refuses a shell string', () => {
    // Splitting a string means quoting rules, and quoting rules in something
    // that gets executed is how a config file becomes an injection point.
    expect(() => writeNotify(dataDir, 'ntfy publish my-topic')).toThrow(InvalidNotifyError);
  });

  test('refuses an empty command', () => {
    expect(() => writeNotify(dataDir, [])).toThrow(/at least the program/);
    expect(() => writeNotify(dataDir, ['   '])).toThrow(InvalidNotifyError);
  });

  test('a corrupt file reads as unconfigured rather than crashing a turn', () => {
    fs.writeFileSync(path.join(dataDir, 'notify.json'), '{not json', 'utf8');
    expect(readNotify(dataDir).configured).toBe(false);
  });
});

describe('notify', () => {
  test('does nothing when nothing is configured', async () => {
    const calls = [];
    const result = await notify({ dataDir, text: 'a question', spawnFn: fakeSpawn(calls) });
    expect(result.ran).toBe(false);
    expect(calls).toEqual([]);
  });

  test('runs the command with the question on stdin', async () => {
    writeNotify(dataDir, ['ntfy', 'publish', 'my-topic']);
    const calls = [];
    await notify({ dataDir, text: 'Codex wants to write NOTES.md', spawnFn: fakeSpawn(calls) });

    expect(calls[0].command).toBe('ntfy');
    expect(calls[0].args).toEqual(['publish', 'my-topic']);
    expect(calls.find((call) => call.stdin)?.stdin).toBe('Codex wants to write NOTES.md');
  });

  test('never through a shell', async () => {
    writeNotify(dataDir, ['notify-send']);
    const calls = [];
    await notify({ dataDir, text: 'x', spawnFn: fakeSpawn(calls) });
    // An agent picks the tool name that ends up in this text. Through a
    // shell, that would be a way to run commands by choosing what to call a
    // tool.
    expect(calls[0].options.shell).toBe(false);
  });

  test('passes the facts as environment variables', async () => {
    writeNotify(dataDir, ['thing']);
    const calls = [];
    await notify({ dataDir, text: 'x', context: { chatId: 'c1', toolName: 'Write', url: 'http://127.0.0.1:4900/#/approvals' }, spawnFn: fakeSpawn(calls) });

    expect(calls[0].options.env.KAPREK_CHAT_ID).toBe('c1');
    expect(calls[0].options.env.KAPREK_TOOL).toBe('Write');
    // Where to answer it — the whole point of being told.
    expect(calls[0].options.env.KAPREK_URL).toBe('http://127.0.0.1:4900/#/approvals');
  });

  test('a notifier that does not exist changes nothing about the question', async () => {
    writeNotify(dataDir, ['definitely-not-installed']);
    const result = await notify({ dataDir, text: 'x', spawnFn: fakeSpawn([], { fail: true }) });
    expect(result.ran).toBe(false);
    // No throw: the question is in the inbox either way, and that is what
    // matters.
  });

  test('a hanging notifier is killed rather than holding up the turn', async () => {
    writeNotify(dataDir, ['sleep-forever']);
    const calls = [];
    const result = await notify({ dataDir, text: 'x', spawnFn: fakeSpawn(calls, { hang: true }), timeoutMs: 10 });
    expect(result).toEqual({ ran: true, reason: 'timed out' });
    expect(calls.some((call) => call.killed)).toBe(true);
  });
});

describe('notifyEnv', () => {
  test('every variable exists, empty rather than missing', () => {
    // A shell script reading $KAPREK_TOOL should get an empty string, not
    // the word "undefined" and not a variable that is not there.
    expect(notifyEnv()).toEqual({ KAPREK_CHAT_ID: '', KAPREK_TOOL: '', KAPREK_SOURCE: '', KAPREK_URL: '' });
  });
});
