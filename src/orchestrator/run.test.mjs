import { test, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runTurn } from './run.mjs';
import { readRuns } from './runs.mjs';
import { openChats } from '../chats/store.mjs';
import { createFakeHarness } from '../harness/fake.mjs';

let tmpDir;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kaprek-orchestrator-test-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('einfacher Turn schreibt user- und assistant-Events in den Store', async () => {
  const fakeHarness = createFakeHarness({
    script: [
      { type: 'init', sessionId: 's1', tools: [], model: 'm', permissionMode: 'default' },
      { type: 'text', text: 'Hello back' },
      { type: 'result', sessionId: 's1', costUsd: 0.001, usage: {}, isError: false },
    ],
  });

  const result = await runTurn({ dataDir: tmpDir, text: 'Hello there, how are you?', harness: fakeHarness, harnessName: 'fake' });

  expect(result.stopReason).toBe('result');
  expect(result.cliSessionId).toBe('s1');
  expect(result.error).toBeNull();

  const chats = openChats(tmpDir);
  expect(chats.get(result.chatId).title).toBe('Hello there, how are you?');

  const events = chats.events(result.chatId);
  expect(events).toHaveLength(2);
  expect(events[0]).toMatchObject({ kind: 'user', text: 'Hello there, how are you?' });
  expect(events[1]).toMatchObject({ kind: 'assistant', text: 'Hello back' });
});

test('Turn mit Tool schreibt EIN tool-Event mit input und result', async () => {
  const fakeHarness = createFakeHarness({
    script: [
      { type: 'init', sessionId: 's1', tools: ['Bash'], model: 'm', permissionMode: 'default' },
      { type: 'tool-start', id: 't1', name: 'Bash', input: { command: 'ls -la' } },
      { type: 'tool-end', id: 't1', result: 'file1\nfile2', isError: false },
      { type: 'text', text: 'done listing' },
      { type: 'result', sessionId: 's1', costUsd: 0.002, usage: {}, isError: false },
    ],
  });

  const result = await runTurn({ dataDir: tmpDir, text: 'list files', harness: fakeHarness });

  const events = openChats(tmpDir).events(result.chatId);
  const toolEvents = events.filter((e) => e.kind === 'tool');
  expect(toolEvents).toHaveLength(1);
  expect(toolEvents[0]).toMatchObject({
    kind: 'tool',
    name: 'Bash',
    input: { command: 'ls -la' },
    result: 'file1\nfile2',
  });
});

test('mehrere Tools in einem Turn ergeben je ein eigenes tool-Event', async () => {
  const fakeHarness = createFakeHarness({
    script: [
      { type: 'init', sessionId: 's1', tools: ['Bash', 'Read'], model: 'm', permissionMode: 'default' },
      { type: 'tool-start', id: 't1', name: 'Bash', input: { command: 'ls' } },
      { type: 'tool-start', id: 't2', name: 'Read', input: { path: 'foo.txt' } },
      { type: 'tool-end', id: 't1', result: 'ok-bash', isError: false },
      { type: 'tool-end', id: 't2', result: 'ok-read', isError: false },
      { type: 'result', sessionId: 's1', costUsd: 0.003, usage: {}, isError: false },
    ],
  });

  const result = await runTurn({ dataDir: tmpDir, text: 'run two tools', harness: fakeHarness });

  const toolEvents = openChats(tmpDir).events(result.chatId).filter((e) => e.kind === 'tool');
  expect(toolEvents).toHaveLength(2);
  expect(toolEvents.map((e) => e.name)).toEqual(['Bash', 'Read']);
  expect(toolEvents.map((e) => e.result)).toEqual(['ok-bash', 'ok-read']);
});

test('verwaister tool-start (kein tool-end) wird beim Turn-Ende mit result:null geschlossen', async () => {
  const fakeHarness = createFakeHarness({
    script: [
      { type: 'init', sessionId: 's1', tools: ['Bash'], model: 'm', permissionMode: 'default' },
      { type: 'tool-start', id: 't1', name: 'Bash', input: { command: 'long-running' } },
      { type: 'result', sessionId: 's1', costUsd: 0.001, usage: {}, isError: false },
    ],
  });

  const result = await runTurn({ dataDir: tmpDir, text: 'orphan tool', harness: fakeHarness });

  const toolEvents = openChats(tmpDir).events(result.chatId).filter((e) => e.kind === 'tool');
  expect(toolEvents).toHaveLength(1);
  expect(toolEvents[0]).toMatchObject({ name: 'Bash', input: { command: 'long-running' }, result: null });
});

test('tool-end ohne passenden tool-start wird trotzdem gespeichert statt verworfen', async () => {
  const fakeHarness = createFakeHarness({
    script: [
      { type: 'init', sessionId: 's1', tools: [], model: 'm', permissionMode: 'default' },
      { type: 'tool-end', id: 'ghost', result: 'late result', isError: false },
      { type: 'result', sessionId: 's1', costUsd: 0.001, usage: {}, isError: false },
    ],
  });

  const result = await runTurn({ dataDir: tmpDir, text: 'ghost tool-end', harness: fakeHarness });

  const toolEvents = openChats(tmpDir).events(result.chatId).filter((e) => e.kind === 'tool');
  expect(toolEvents).toHaveLength(1);
  expect(toolEvents[0]).toMatchObject({ name: 'unknown', input: null, result: 'late result' });
});

test('Folgeturn übergibt die gespeicherte cliSessionId an den Harness', async () => {
  const fakeHarness = createFakeHarness({
    script: [
      { type: 'init', sessionId: 'sess-1', tools: [], model: 'm', permissionMode: 'default' },
      { type: 'text', text: 'hi' },
      { type: 'result', sessionId: 'sess-1', costUsd: 0.001, usage: {}, isError: false },
    ],
  });
  const startTurnSpy = vi.spyOn(fakeHarness, 'startTurn');

  const first = await runTurn({ dataDir: tmpDir, text: 'first turn', harness: fakeHarness, harnessName: 'fake' });
  expect(first.cliSessionId).toBe('sess-1');
  expect(startTurnSpy.mock.calls[0][0].sessionId).toBeUndefined();

  await runTurn({ dataDir: tmpDir, chatId: first.chatId, text: 'second turn', harness: fakeHarness, harnessName: 'fake' });

  expect(startTurnSpy).toHaveBeenCalledTimes(2);
  expect(startTurnSpy.mock.calls[1][0].sessionId).toBe('sess-1');
});

test('Run-Log-Zeile enthält Kosten, Tokens und Modell', async () => {
  const fakeHarness = createFakeHarness({
    script: [
      { type: 'init', sessionId: 's1', tools: [], model: 'claude-x', permissionMode: 'default' },
      { type: 'text', text: 'hi' },
      { type: 'result', sessionId: 's1', costUsd: 0.0123, usage: { input_tokens: 10, output_tokens: 5 }, isError: false },
    ],
  });

  const result = await runTurn({ dataDir: tmpDir, text: 'cost check', harness: fakeHarness, harnessName: 'fake' });

  const runs = readRuns(tmpDir);
  expect(runs).toHaveLength(1);
  expect(runs[0]).toMatchObject({
    chatId: result.chatId,
    harness: 'fake',
    model: 'claude-x',
    costUsd: 0.0123,
    usage: { input_tokens: 10, output_tokens: 5 },
    tokens: 15,
    stopReason: 'result',
    error: null,
  });
  expect(typeof runs[0].durationMs).toBe('number');
  expect(typeof runs[0].ts).toBe('string');
});

test('Abbruch mitten im Stream schließt den offenen tool-start und lässt den Store konsistent', async () => {
  const controller = new AbortController();
  const fakeHarness = createFakeHarness({
    script: [
      { type: 'init', sessionId: 'sess-abort', tools: [], model: 'm', permissionMode: 'default' },
      { type: 'tool-start', id: 't1', name: 'Bash', input: { command: 'ls' } },
      { type: 'text', text: 'should never arrive' },
      { type: 'result', sessionId: 'sess-abort', costUsd: 0.01, usage: {}, isError: false },
    ],
  });

  const result = await runTurn({
    dataDir: tmpDir,
    text: 'run something',
    harness: fakeHarness,
    signal: controller.signal,
    onEvent: (event) => {
      if (event.type === 'tool-start') controller.abort();
    },
  });

  expect(result.stopReason).toBe('aborted');
  expect(result.cliSessionId).toBe('sess-abort'); // captured from the 'init' event before the abort

  const events = openChats(tmpDir).events(result.chatId);
  expect(events.some((e) => e.kind === 'assistant')).toBe(false); // 'text' never played back
  const toolEvents = events.filter((e) => e.kind === 'tool');
  expect(toolEvents).toHaveLength(1);
  expect(toolEvents[0]).toMatchObject({ name: 'Bash', result: null });

  const runs = readRuns(tmpDir);
  expect(runs[0].stopReason).toBe('aborted');
});

test('Adapter-Fehler ergibt error im Ergebnis, Store bleibt konsistent', async () => {
  const fakeHarness = createFakeHarness({
    script: [
      { type: 'init', sessionId: 's-err', tools: [], model: 'm', permissionMode: 'default' },
      { type: 'text', text: 'partial' },
      // no 'result' event -> fake harness resolves stopReason 'error'
    ],
  });

  const result = await runTurn({ dataDir: tmpDir, text: 'will fail', harness: fakeHarness, harnessName: 'fake' });

  expect(result.stopReason).toBe('error');
  expect(result.error).toBeTruthy();

  const events = openChats(tmpDir).events(result.chatId);
  expect(events.map((e) => e.kind)).toEqual(['user', 'assistant']);

  const runs = readRuns(tmpDir);
  expect(runs).toHaveLength(1);
  expect(runs[0].stopReason).toBe('error');
  expect(runs[0].error).toBeTruthy();
});

test('onEvent bekommt alle Adapter-Events durchgereicht, in Reihenfolge', async () => {
  const script = [
    { type: 'init', sessionId: 's-fwd', tools: [], model: 'm', permissionMode: 'default' },
    { type: 'thinking', text: 'hmm' },
    { type: 'tool-start', id: 't1', name: 'Bash', input: { command: 'ls' } },
    { type: 'tool-end', id: 't1', result: 'ok', isError: false },
    { type: 'text', text: 'done' },
    { type: 'rate-limit', info: { remaining: 10 } },
    { type: 'result', sessionId: 's-fwd', costUsd: 0.001, usage: {}, isError: false },
  ];
  const fakeHarness = createFakeHarness({ script });
  const seen = [];

  await runTurn({ dataDir: tmpDir, text: 'forward all', harness: fakeHarness, onEvent: (e) => seen.push(e) });

  expect(seen.map((e) => e.type)).toEqual(['init', 'thinking', 'tool-start', 'tool-end', 'text', 'rate-limit', 'result']);
  expect(seen).toEqual(script);
});
