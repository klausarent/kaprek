import { test, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runTurn } from './run.mjs';
import { readRuns } from './runs.mjs';
import { openChats } from '../chats/store.mjs';
import { createFakeHarness } from '../harness/fake.mjs';
import { ASK_TOOLS_CHAT, ASK_TOOLS_TRIGGER } from '../harness/settings.mjs';
import { readKnownTools } from '../harness/knownTools.mjs';

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
  // input is stored pre-stringified, matching src/parser/parse.mjs's digest
  // shape for a reloaded/historical tool event (see run.mjs::sanitizeToolInput()).
  expect(toolEvents[0]).toMatchObject({
    kind: 'tool',
    name: 'Bash',
    input: JSON.stringify({ command: 'ls -la' }),
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
  expect(toolEvents[0]).toMatchObject({ name: 'Bash', input: JSON.stringify({ command: 'long-running' }), result: null });
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

// SECURITY (P0-1): secrets from a live CLI turn must be redacted and
// oversized content truncated before landing in the chat store or on the
// SSE wire, exactly like a reloaded/historical digest (see
// src/parser/parse.mjs::redactSecrets/truncate and run.mjs's sanitize* helpers).
const SECRET_PATTERNS = {
  skAnt: 'sk-ant-api03-AbCdEfGhIjKlMnOpQrStUvWxYz0123456789',
  skProj: 'sk-proj-' + 'AbCdEfGhIjKlMnOpQrStUvWxYz0123456789',
  ghp: 'ghp_' + 'AbCdEfGh1234567890ABCDEFGHijkl',
  bearer: 'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9',
  keyValue: 'DB_PASSWORD=hunter2secretvalue',
};

test('Secrets in assistant-Text, thinking-Text, tool-input und tool-result werden im Store redigiert', async () => {
  const fakeHarness = createFakeHarness({
    script: [
      { type: 'init', sessionId: 's1', tools: ['Bash'], model: 'm', permissionMode: 'default' },
      { type: 'thinking', text: `secret in thinking: ${SECRET_PATTERNS.skAnt}` },
      { type: 'tool-start', id: 't1', name: 'Bash', input: { command: `curl -H "Authorization: ${SECRET_PATTERNS.bearer}"` } },
      { type: 'tool-end', id: 't1', result: `leaked token ${SECRET_PATTERNS.ghp}`, isError: false },
      { type: 'text', text: `here you go: ${SECRET_PATTERNS.skProj} and ${SECRET_PATTERNS.keyValue}` },
      { type: 'result', sessionId: 's1', costUsd: 0.001, usage: {}, isError: false },
    ],
  });

  const result = await runTurn({ dataDir: tmpDir, text: 'leak secrets', harness: fakeHarness });

  const events = openChats(tmpDir).events(result.chatId);
  const raw = JSON.stringify(events);
  for (const secret of Object.values(SECRET_PATTERNS)) {
    expect(raw, `${secret} must not leak into the chat store`).not.toContain(secret);
  }
  expect(raw).toContain('[REDACTED]');

  const thinkingEvent = events.find((e) => e.kind === 'thinking');
  expect(thinkingEvent.text).toBe('secret in thinking: [REDACTED]');

  const toolEvent = events.find((e) => e.kind === 'tool');
  expect(toolEvent.input).not.toContain(SECRET_PATTERNS.bearer);
  expect(toolEvent.result).toBe('leaked token [REDACTED]');
});

test('übergroßer Text wird im Store mit dem Truncation-Marker gekürzt', async () => {
  const oversized = 'x'.repeat(5000);
  const fakeHarness = createFakeHarness({
    script: [
      { type: 'init', sessionId: 's1', tools: [], model: 'm', permissionMode: 'default' },
      { type: 'text', text: oversized },
      { type: 'result', sessionId: 's1', costUsd: 0.001, usage: {}, isError: false },
    ],
  });

  const result = await runTurn({ dataDir: tmpDir, text: 'truncate me', harness: fakeHarness });

  const assistantEvent = openChats(tmpDir).events(result.chatId).find((e) => e.kind === 'assistant');
  expect(assistantEvent.text.length).toBeLessThan(oversized.length);
  expect(assistantEvent.text).toContain('…[truncated, 5000 chars]');
});

test('SSE-Events (onEvent) enthalten keine Klartext-Secrets, auch nicht im tool-start input', async () => {
  const fakeHarness = createFakeHarness({
    script: [
      { type: 'init', sessionId: 's1', tools: ['Bash'], model: 'm', permissionMode: 'default' },
      { type: 'tool-start', id: 't1', name: 'Bash', input: { command: `echo ${SECRET_PATTERNS.skAnt}` } },
      { type: 'tool-end', id: 't1', result: SECRET_PATTERNS.ghp, isError: false },
      { type: 'text', text: `token: ${SECRET_PATTERNS.keyValue}` },
      { type: 'result', sessionId: 's1', costUsd: 0.001, usage: {}, isError: false },
    ],
  });
  const seen = [];

  await runTurn({ dataDir: tmpDir, text: 'sse leak check', harness: fakeHarness, onEvent: (e) => seen.push(e) });

  const raw = JSON.stringify(seen);
  for (const secret of Object.values(SECRET_PATTERNS)) {
    if (secret === SECRET_PATTERNS.bearer || secret === SECRET_PATTERNS.skProj) continue; // not used in this script
    expect(raw, `${secret} must not leak over onEvent/SSE`).not.toContain(secret);
  }
  const toolStartEvent = seen.find((e) => e.type === 'tool-start');
  expect(JSON.stringify(toolStartEvent.input)).not.toContain(SECRET_PATTERNS.skAnt);
});

// SECURITY (P0-3): runTurn() must forward permissionMode/allowedTools to the
// harness verbatim — the caller (src/server/server.mjs::startServer()) owns
// the actual security-relevant default, this layer must not silently drop it.
test('permissionMode und allowedTools werden unverändert an harness.startTurn() durchgereicht', async () => {
  const fakeHarness = createFakeHarness({
    script: [
      { type: 'init', sessionId: 's1', tools: [], model: 'm', permissionMode: 'default' },
      { type: 'result', sessionId: 's1', costUsd: 0.001, usage: {}, isError: false },
    ],
  });
  const startTurnSpy = vi.spyOn(fakeHarness, 'startTurn');

  await runTurn({
    dataDir: tmpDir,
    text: 'check permission passthrough',
    harness: fakeHarness,
    permissionMode: 'acceptEdits',
    allowedTools: ['Read', 'Grep'],
  });

  expect(startTurnSpy.mock.calls[0][0]).toMatchObject({
    permissionMode: 'acceptEdits',
    allowedTools: ['Read', 'Grep'],
  });
});

test('permissionMode und allowedTools sind undefined, wenn runTurn() ohne sie aufgerufen wird', async () => {
  const fakeHarness = createFakeHarness({
    script: [
      { type: 'init', sessionId: 's1', tools: [], model: 'm', permissionMode: 'default' },
      { type: 'result', sessionId: 's1', costUsd: 0.001, usage: {}, isError: false },
    ],
  });
  const startTurnSpy = vi.spyOn(fakeHarness, 'startTurn');

  await runTurn({ dataDir: tmpDir, text: 'no permission options given', harness: fakeHarness });

  expect(startTurnSpy.mock.calls[0][0].permissionMode).toBeUndefined();
  expect(startTurnSpy.mock.calls[0][0].allowedTools).toBeUndefined();
});

// P1-B1: a failing tool call's isError must survive persistence, not just
// the live SSE frame (the store has no isError field of its own — see the
// comment on run.mjs's 'tool-end' handler for why a text prefix is used).
test('tool-end mit isError landet im Store mit [tool error]-Präfix, im SSE-Event bleibt isError erhalten', async () => {
  const fakeHarness = createFakeHarness({
    script: [
      { type: 'init', sessionId: 's1', tools: ['Bash'], model: 'm', permissionMode: 'default' },
      { type: 'tool-start', id: 't1', name: 'Bash', input: { command: 'rm /nonexistent' } },
      { type: 'tool-end', id: 't1', result: 'rm: cannot remove: No such file', isError: true },
      { type: 'result', sessionId: 's1', costUsd: 0.001, usage: {}, isError: false },
    ],
  });
  const seen = [];

  const result = await runTurn({
    dataDir: tmpDir,
    text: 'delete a missing file',
    harness: fakeHarness,
    onEvent: (e) => seen.push(e),
  });

  const toolEvent = openChats(tmpDir).events(result.chatId).find((e) => e.kind === 'tool');
  expect(toolEvent.result).toBe('[tool error] rm: cannot remove: No such file');

  const sseToolEnd = seen.find((e) => e.type === 'tool-end');
  expect(sseToolEnd.isError).toBe(true);
  expect(sseToolEnd.result).toBe('rm: cannot remove: No such file'); // SSE frame stays unprefixed
});

test('tool-end ohne isError bekommt keinen Präfix', async () => {
  const fakeHarness = createFakeHarness({
    script: [
      { type: 'init', sessionId: 's1', tools: ['Bash'], model: 'm', permissionMode: 'default' },
      { type: 'tool-start', id: 't1', name: 'Bash', input: { command: 'ls' } },
      { type: 'tool-end', id: 't1', result: 'file1\nfile2', isError: false },
      { type: 'result', sessionId: 's1', costUsd: 0.001, usage: {}, isError: false },
    ],
  });

  const result = await runTurn({ dataDir: tmpDir, text: 'list files', harness: fakeHarness });

  const toolEvent = openChats(tmpDir).events(result.chatId).find((e) => e.kind === 'tool');
  expect(toolEvent.result).toBe('file1\nfile2');
});

// P1-B2: runs.jsonl's `tokens` field must not go null just because a
// non-Anthropic harness names its usage fields differently.
test('Run-Log summiert Tokens für Anthropic-, OpenAI-artige und total_tokens-only Usage-Shapes', async () => {
  const shapes = [
    { usage: { input_tokens: 10, output_tokens: 5, cache_creation_input_tokens: 2, cache_read_input_tokens: 1 }, expected: 18 },
    { usage: { prompt_tokens: 7, completion_tokens: 3 }, expected: 10 },
    { usage: { total_tokens: 42 }, expected: 42 },
  ];

  for (const { usage, expected } of shapes) {
    const fakeHarness = createFakeHarness({
      script: [
        { type: 'init', sessionId: 's1', tools: [], model: 'm', permissionMode: 'default' },
        { type: 'result', sessionId: 's1', costUsd: 0.001, usage, isError: false },
      ],
    });
    const result = await runTurn({ dataDir: tmpDir, text: `usage shape ${expected}`, harness: fakeHarness, harnessName: 'fake' });
    const runs = readRuns(tmpDir);
    const run = runs.find((r) => r.chatId === result.chatId);
    expect(run.tokens, `usage ${JSON.stringify(usage)} should sum to ${expected}`).toBe(expected);
  }
});

// --- Approval chain (Task 6a) -------------------------------------------------

test('onApprovalRequest: request/decision are persisted as approval chat events; secrets in the tool input are redacted', async () => {
  const fakeHarness = createFakeHarness({
    script: [
      { type: 'init', sessionId: 's1', tools: ['Bash'], model: 'm', permissionMode: 'default' },
      {
        approval: {
          toolName: 'Bash',
          displayName: 'Bash',
          input: { command: `curl -H "Authorization: ${SECRET_PATTERNS.bearer}"` },
          description: 'run a curl command',
          agentId: 'agent-1',
          toolUseId: 'toolu_1',
          reasonType: 'rule',
          reason: 'ask',
        },
      },
      { type: 'result', sessionId: 's1', costUsd: 0.001, usage: {}, isError: false },
    ],
  });

  const seenByCaller = [];
  const onApprovalRequest = vi.fn(async (request) => {
    seenByCaller.push(request);
    return { behavior: 'allow' };
  });

  const result = await runTurn({ dataDir: tmpDir, text: 'approve me', harness: fakeHarness, onApprovalRequest });

  // The caller only ever sees the SANITIZED request — never the raw secret
  // (see run.mjs's onApprovalRequest wrapping doc comment: redaction before
  // ANY new write site, SSE included).
  expect(JSON.stringify(seenByCaller)).not.toContain(SECRET_PATTERNS.bearer);
  expect(seenByCaller[0]).toMatchObject({ toolName: 'Bash', agentId: 'agent-1', toolUseId: 'toolu_1' });

  const events = openChats(tmpDir).events(result.chatId);
  const approvalEvents = events.filter((e) => e.kind === 'approval');
  expect(approvalEvents.map((e) => e.phase)).toEqual(['requested', 'resolved']);
  expect(approvalEvents[0].toolName).toBe('Bash');
  expect(approvalEvents[0].input).not.toContain(SECRET_PATTERNS.bearer);
  expect(approvalEvents[0].input).toContain('[REDACTED]');
  expect(approvalEvents[1]).toMatchObject({ phase: 'resolved', behavior: 'allow' });
});

test('onApprovalRequest: a deny decision is persisted with its message', async () => {
  const fakeHarness = createFakeHarness({
    script: [
      { type: 'init', sessionId: 's1', tools: [], model: 'm', permissionMode: 'default' },
      { approval: { toolName: 'Write', input: { path: 'x' } } },
      { type: 'result', sessionId: 's1', costUsd: 0, usage: {}, isError: false },
    ],
  });
  const onApprovalRequest = vi.fn(async () => ({ behavior: 'deny', message: 'not allowed right now' }));

  const result = await runTurn({ dataDir: tmpDir, text: 'deny me', harness: fakeHarness, onApprovalRequest });

  const approvalEvents = openChats(tmpDir).events(result.chatId).filter((e) => e.kind === 'approval');
  expect(approvalEvents[1]).toMatchObject({ phase: 'resolved', behavior: 'deny', message: 'not allowed right now' });
});

test('onApprovalRequest: a throwing caller handler is persisted as an "error" resolution and does not kill the turn', async () => {
  const fakeHarness = createFakeHarness({
    script: [
      { type: 'init', sessionId: 's1', tools: [], model: 'm', permissionMode: 'default' },
      { approval: { toolName: 'Bash', input: {} } },
      { type: 'result', sessionId: 's1', costUsd: 0, usage: {}, isError: false },
    ],
  });
  const onApprovalRequest = vi.fn(async () => {
    throw new Error('handler boom');
  });

  const result = await runTurn({ dataDir: tmpDir, text: 'boom', harness: fakeHarness, onApprovalRequest });

  expect(result.stopReason).toBe('result'); // fake.mjs's own catch keeps playback going, same as claude-code.mjs
  const approvalEvents = openChats(tmpDir).events(result.chatId).filter((e) => e.kind === 'approval');
  expect(approvalEvents[1]).toMatchObject({ phase: 'resolved', behavior: 'error', message: 'handler boom' });
});

test('runTurn passes onApprovalRequest:undefined to the harness when the caller configured none (never a silent no-op wrapper)', async () => {
  const fakeHarness = createFakeHarness({
    script: [{ type: 'result', sessionId: 's1', costUsd: 0, usage: {}, isError: false }],
  });
  const startTurnSpy = vi.spyOn(fakeHarness, 'startTurn');

  await runTurn({ dataDir: tmpDir, text: 'no approvals configured', harness: fakeHarness });

  expect(startTurnSpy.mock.calls[0][0].onApprovalRequest).toBeUndefined();
});

test('runTurn wires mcpConfigPath (kaprek apps MCP server) and settingsPath (neutralized hooks) to the harness, then cleans the mcp-config file up', async () => {
  let mcpConfigPathUsed;
  let capturedMcpConfig;
  let capturedSettings;
  const harness = {
    async startTurn(options) {
      mcpConfigPathUsed = options.mcpConfigPath;
      capturedMcpConfig = JSON.parse(fs.readFileSync(options.mcpConfigPath, 'utf8'));
      capturedSettings = JSON.parse(fs.readFileSync(options.settingsPath, 'utf8'));
      return { sessionId: 's1', costUsd: 0, usage: {}, stopReason: 'result', error: null };
    },
  };

  const result = await runTurn({ dataDir: tmpDir, text: 'wire it up', harness });

  expect(result.stopReason).toBe('result');
  expect(capturedSettings).toEqual({ hooks: {}, permissions: { defaultMode: 'default', allow: [], deny: [], ask: ASK_TOOLS_CHAT } });
  expect(capturedMcpConfig.mcpServers['kaprek-apps'].command).toBe(process.execPath);
  expect(capturedMcpConfig.mcpServers['kaprek-apps'].env.KAPREK_DATA_DIR).toBe(tmpDir);

  // The mcp-config file is a per-turn temp file — must not accumulate.
  expect(fs.existsSync(mcpConfigPathUsed)).toBe(false);
});

// ------------------------------------------------------------- settings profile / ask-coverage (task-7a Fix-Runde 2)

test('a plain user turn (origin "user", the default) uses the "chat" settings profile: settings-chat.json, ASK_TOOLS_CHAT, strictAskCoverage:false', async () => {
  let captured;
  const harness = {
    async startTurn(options) {
      captured = options;
      return { sessionId: 's1', costUsd: 0, usage: {}, stopReason: 'result', error: null };
    },
  };

  await runTurn({ dataDir: tmpDir, text: 'plain chat turn', harness });

  expect(path.basename(captured.settingsPath)).toBe('settings-chat.json');
  expect(JSON.parse(fs.readFileSync(captured.settingsPath, 'utf8')).permissions.ask).toEqual(ASK_TOOLS_CHAT);
  expect(captured.requireAskCoverage).toEqual(ASK_TOOLS_CHAT);
  expect(captured.strictAskCoverage).toBe(false);
});

test('a trigger-originated turn uses the "trigger" settings profile: settings-trigger.json, ASK_TOOLS_TRIGGER, strictAskCoverage:true', async () => {
  let captured;
  const harness = {
    async startTurn(options) {
      captured = options;
      return { sessionId: 's1', costUsd: 0, usage: {}, stopReason: 'result', error: null };
    },
  };

  await runTurn({ dataDir: tmpDir, text: 'triggered turn', harness, origin: 'trigger', triggerId: 'heartbeat-1' });

  expect(path.basename(captured.settingsPath)).toBe('settings-trigger.json');
  expect(JSON.parse(fs.readFileSync(captured.settingsPath, 'utf8')).permissions.ask).toEqual(ASK_TOOLS_TRIGGER);
  expect(captured.requireAskCoverage).toEqual(ASK_TOOLS_TRIGGER);
  expect(captured.strictAskCoverage).toBe(true);
});

test('a chat turn and a trigger turn for the SAME dataDir get their own settings files, side by side', async () => {
  const harness = { async startTurn() { return { sessionId: 's1', costUsd: 0, usage: {}, stopReason: 'result', error: null }; } };

  await runTurn({ dataDir: tmpDir, text: 'chat one', harness });
  await runTurn({ dataDir: tmpDir, text: 'trigger one', harness, origin: 'trigger', triggerId: 't1' });

  const harnessDir = path.join(tmpDir, 'harness');
  expect(fs.existsSync(path.join(harnessDir, 'settings-chat.json'))).toBe(true);
  expect(fs.existsSync(path.join(harnessDir, 'settings-trigger.json'))).toBe(true);
});

// ------------------------------------------------------------- self-learning ask-coverage (task-7a Fix-Runde 3)

/**
 * A stub harness that plays claude-code.mjs's own coverage-gap protocol:
 * reports `tools` via an init event, and — mirroring what claude-code.mjs
 * actually does — calls the injected `learnUnknownTools` for any tool NOT
 * already in `options.requireAskCoverage`. Lets these tests exercise
 * run.mjs's WIRING (does the learned name actually reach knownTools.mjs
 * and come back on the next turn?) without needing a real CLI subprocess —
 * claude-code.test.mjs already covers the DETECTION logic itself.
 */
function coverageGapHarness(tools) {
  return {
    async startTurn(options) {
      options.onEvent?.({ type: 'init', sessionId: 's1', tools, model: 'm', permissionMode: 'default' });
      const unknown = tools.filter((t) => !options.requireAskCoverage.includes(t) && !t.startsWith('mcp__'));
      if (unknown.length > 0) options.learnUnknownTools?.(unknown);
      return { sessionId: 's1', costUsd: 0, usage: {}, stopReason: 'result', error: null };
    },
  };
}

test('an unknown tool reported by the CLI is learned for this dataDir', async () => {
  await runTurn({ dataDir: tmpDir, text: 'first trigger turn', harness: coverageGapHarness(['Bash', 'ScheduleWakeup']), origin: 'trigger', triggerId: 't1' });

  expect(readKnownTools(tmpDir)).toContain('ScheduleWakeup');
});

test('the NEXT trigger turn already covers a previously-learned tool — self-healing across turns', async () => {
  const captured = [];
  const harness = {
    async startTurn(options) {
      captured.push(options);
      return coverageGapHarness(['Bash', 'ScheduleWakeup']).startTurn(options);
    },
  };

  await runTurn({ dataDir: tmpDir, text: 'first', harness, origin: 'trigger', triggerId: 't1' });
  await runTurn({ dataDir: tmpDir, text: 'second', harness, origin: 'trigger', triggerId: 't1' });

  // First call's own requireAskCoverage did NOT yet know about it (that's
  // exactly what made it "unknown" and triggered learning); the second
  // call's DOES.
  expect(captured[0].requireAskCoverage).not.toContain('ScheduleWakeup');
  expect(captured[1].requireAskCoverage).toContain('ScheduleWakeup');
});

test('a learned tool lands in the settings file\'s ask array, never in allow', async () => {
  await runTurn({ dataDir: tmpDir, text: 'learn it', harness: coverageGapHarness(['Bash', 'ScheduleWakeup']), origin: 'trigger', triggerId: 't1' });

  let capturedSettingsPath;
  const harness = {
    async startTurn(options) {
      capturedSettingsPath = options.settingsPath;
      return { sessionId: 's1', costUsd: 0, usage: {}, stopReason: 'result', error: null };
    },
  };
  await runTurn({ dataDir: tmpDir, text: 'second, should include it now', harness, origin: 'trigger', triggerId: 't1' });

  const settings = JSON.parse(fs.readFileSync(capturedSettingsPath, 'utf8'));
  expect(settings.permissions.ask).toContain('ScheduleWakeup');
  expect(settings.permissions.allow).toEqual([]);
});

test('a missing/corrupt known-tools.json does not crash a turn — the static ASK_TOOLS_* floor is still used', async () => {
  fs.mkdirSync(path.join(tmpDir, 'harness'), { recursive: true });
  fs.writeFileSync(path.join(tmpDir, 'harness', 'known-tools.json'), '{ not valid json', 'utf8');

  let captured;
  const harness = {
    async startTurn(options) {
      captured = options;
      return { sessionId: 's1', costUsd: 0, usage: {}, stopReason: 'result', error: null };
    },
  };

  const result = await runTurn({ dataDir: tmpDir, text: 'still works', harness, origin: 'trigger', triggerId: 't1' });

  expect(result.stopReason).toBe('result');
  expect(captured.requireAskCoverage).toEqual(ASK_TOOLS_TRIGGER);
});

test('an mcp__ tool is never learned, even if a (misbehaving) harness reported it as unknown', async () => {
  // Bypasses coverageGapHarness's own filtering to exercise run.mjs's real
  // learnUnknownTools wiring end to end (it delegates straight to
  // knownTools.mjs::learnTools(), whose own mcp__ filter is unit-tested in
  // knownTools.test.mjs) — a genuinely well-behaved claude-code.mjs would
  // never call this for an mcp__ name in the first place (isKnownTool()
  // treats every mcp__… name as known), so this is defense in depth.
  const harness = {
    async startTurn(options) {
      options.learnUnknownTools?.(['mcp__kaprek-apps__notes.write']);
      return { sessionId: 's1', costUsd: 0, usage: {}, stopReason: 'result', error: null };
    },
  };
  await runTurn({ dataDir: tmpDir, text: 'mcp tool', harness, origin: 'trigger', triggerId: 't1' });

  expect(readKnownTools(tmpDir)).not.toContain('mcp__kaprek-apps__notes.write');
});

// Regression test for task-6a review Critical #2: the harness's OWN
// 'approval' NormalizedEvent (safeEmit'd by claude-code.mjs's
// handleApprovalRequest, carrying the RAW, unredacted request) used to fall
// into handleEvent()'s `default:` case and go straight to onEvent/SSE — a
// secret leak, and a SECOND, duplicate approval prompt alongside the
// sanitized one from wrappedOnApprovalRequest.
test('the raw harness approval NormalizedEvent is never forwarded via onEvent — no secret leak, no duplicate prompt', async () => {
  const fakeHarness = createFakeHarness({
    script: [
      { type: 'init', sessionId: 's1', tools: ['Bash'], model: 'm', permissionMode: 'default' },
      { type: 'approval', phase: 'requested', id: 'req-1', toolName: 'Bash', input: { command: `curl -H "Authorization: ${SECRET_PATTERNS.bearer}"` } },
      { type: 'approval', phase: 'resolved', id: 'req-1', toolName: 'Bash', behavior: 'allow' },
      { type: 'result', sessionId: 's1', costUsd: 0, usage: {}, isError: false },
    ],
  });

  const seen = [];
  await runTurn({ dataDir: tmpDir, text: 'raw approval event check', harness: fakeHarness, onEvent: (e) => seen.push(e) });

  const approvalFrames = seen.filter((e) => e.type === 'approval');
  expect(approvalFrames).toHaveLength(0);
  expect(JSON.stringify(seen)).not.toContain(SECRET_PATTERNS.bearer);
});

test('onApprovalRequest: exactly one sanitized approval frame per request reaches onEvent when a handler IS configured (via the wrapper, not the raw harness event)', async () => {
  const fakeHarness = createFakeHarness({
    script: [
      { type: 'init', sessionId: 's1', tools: ['Bash'], model: 'm', permissionMode: 'default' },
      { approval: { toolName: 'Bash', input: { command: `curl -H "Authorization: ${SECRET_PATTERNS.bearer}"` } } },
      { type: 'result', sessionId: 's1', costUsd: 0, usage: {}, isError: false },
    ],
  });

  const seen = [];
  const onApprovalRequest = vi.fn(async () => ({ behavior: 'allow' }));
  await runTurn({ dataDir: tmpDir, text: 'one frame check', harness: fakeHarness, onApprovalRequest, onEvent: (e) => seen.push(e) });

  // The wrapper forwards to the CALLER's onApprovalRequest, not through
  // onEvent — a browser client learns about an approval exclusively via the
  // caller (e.g. server.mjs's own SSE enqueue inside makeApprovalHandler),
  // so onEvent itself must see none of the 'approval' type at all here.
  expect(seen.filter((e) => e.type === 'approval')).toHaveLength(0);
  expect(onApprovalRequest).toHaveBeenCalledTimes(1);
});

// Regression test for task-6a review Important #7: `suggestions` derives
// from the tool call and can itself embed a secret (e.g. a suggested
// `Bash(curl -H "Authorization: Bearer …")` allow-rule) — it must go
// through the exact same redaction chain as `input`, not ride along
// unsanitized just because it isn't a plain string field.
test('onApprovalRequest: a secret embedded in permission_suggestions is redacted for both the caller and the chat store', async () => {
  const fakeHarness = createFakeHarness({
    script: [
      { type: 'init', sessionId: 's1', tools: ['Bash'], model: 'm', permissionMode: 'default' },
      {
        approval: {
          toolName: 'Bash',
          input: { command: 'curl something' },
          suggestions: [{ rule: `Bash(curl -H "Authorization: ${SECRET_PATTERNS.bearer}")` }],
        },
      },
      { type: 'result', sessionId: 's1', costUsd: 0, usage: {}, isError: false },
    ],
  });

  const seenByCaller = [];
  const onApprovalRequest = vi.fn(async (request) => {
    seenByCaller.push(request);
    return { behavior: 'allow' };
  });

  const result = await runTurn({ dataDir: tmpDir, text: 'suggestions redaction check', harness: fakeHarness, onApprovalRequest });

  expect(JSON.stringify(seenByCaller)).not.toContain(SECRET_PATTERNS.bearer);
  expect(JSON.stringify(seenByCaller)).toContain('[REDACTED]');

  const approvalEvents = openChats(tmpDir).events(result.chatId).filter((e) => e.kind === 'approval');
  expect(approvalEvents[0].suggestions).not.toContain(SECRET_PATTERNS.bearer);
  expect(approvalEvents[0].suggestions).toContain('[REDACTED]');
});

// Regression test for task-6a review Critical #3: a failed mcp-config/
// settings write must FAIL the turn (fail-closed), never let it proceed
// without --settings — see settings.mjs's own comment for why that matters
// (the CLI falls back to the user's own, potentially much more permissive
// ~/.claude/settings.json).
test('a failed mcp-config/settings write fails the turn instead of silently running without --settings (fail-closed, not fail-open)', async () => {
  // Forces writeMcpConfig()'s own fs.mkdirSync(<dataDir>/mcp, {recursive:true})
  // to throw by pre-occupying that exact path with a plain FILE instead of a
  // directory — deterministic, no fs mocking needed.
  fs.writeFileSync(path.join(tmpDir, 'mcp'), 'not a directory');

  const fakeHarness = createFakeHarness({ script: [{ type: 'result', sessionId: 's1', costUsd: 0, usage: {}, isError: false }] });
  const startTurnSpy = vi.spyOn(fakeHarness, 'startTurn');

  const result = await runTurn({ dataDir: tmpDir, text: 'should fail closed', harness: fakeHarness });

  expect(result.stopReason).toBe('error');
  expect(result.error.message).toMatch(/mcp-config|settings/i);
  // Never even reached the harness — fails BEFORE running with weaker security.
  expect(startTurnSpy).not.toHaveBeenCalled();

  // The failure is still logged to runs.jsonl, same as any other turn error.
  const runs = readRuns(tmpDir);
  expect(runs).toHaveLength(1);
  expect(runs[0].stopReason).toBe('error');
});

// ------------------------------------------------------------- origin/triggerId/silent passthrough (task 7a)

test('runTurn defaults to origin "user" with triggerId null on both the new chat and the runs.jsonl line', async () => {
  const fakeHarness = createFakeHarness({ script: [{ type: 'result', sessionId: 's1', costUsd: 0.001, usage: {}, isError: false }] });
  const result = await runTurn({ dataDir: tmpDir, text: 'a plain user turn', harness: fakeHarness, harnessName: 'fake' });

  const chat = openChats(tmpDir).get(result.chatId);
  expect(chat.origin).toBe('user');
  expect(chat.triggerId).toBeNull();
  expect(chat.silent).toBe(false);

  const runs = readRuns(tmpDir);
  expect(runs[0].origin).toBe('user');
  expect(runs[0].triggerId).toBeNull();
});

test('runTurn with origin "trigger" carries origin/triggerId/silent onto a NEWLY created chat and onto the runs.jsonl line', async () => {
  const fakeHarness = createFakeHarness({ script: [{ type: 'result', sessionId: 's1', costUsd: 0.002, usage: {}, isError: false }] });
  const result = await runTurn({
    dataDir: tmpDir,
    text: 'triggered turn',
    harness: fakeHarness,
    harnessName: 'fake',
    origin: 'trigger',
    triggerId: 'heartbeat-1',
    silent: true,
  });

  const chat = openChats(tmpDir).get(result.chatId);
  expect(chat.origin).toBe('trigger');
  expect(chat.triggerId).toBe('heartbeat-1');
  expect(chat.silent).toBe(true);

  const runs = readRuns(tmpDir);
  expect(runs[0].origin).toBe('trigger');
  expect(runs[0].triggerId).toBe('heartbeat-1');
});

test('runTurn resuming an EXISTING chatId does not change that chat\'s already-stored origin/triggerId/silent, but still logs this turn\'s own origin to runs.jsonl', async () => {
  const firstHarness = createFakeHarness({ script: [{ type: 'result', sessionId: 's1', costUsd: 0, usage: {}, isError: false }] });
  const first = await runTurn({ dataDir: tmpDir, text: 'first', harness: firstHarness, harnessName: 'fake' });

  const secondHarness = createFakeHarness({ script: [{ type: 'result', sessionId: 's1', costUsd: 0, usage: {}, isError: false }] });
  await runTurn({
    dataDir: tmpDir,
    chatId: first.chatId,
    text: 'second, resumed',
    harness: secondHarness,
    harnessName: 'fake',
    origin: 'trigger',
    triggerId: 'ignored-since-chat-already-exists',
  });

  // createChat() only ran once, for the first call — the chat's own origin
  // stays 'user' forever, only individual runs.jsonl lines vary per turn.
  const chat = openChats(tmpDir).get(first.chatId);
  expect(chat.origin).toBe('user');
  expect(chat.triggerId).toBeNull();

  const runs = readRuns(tmpDir);
  expect(runs).toHaveLength(2);
  expect(runs[0].origin).toBe('user');
  expect(runs[1].origin).toBe('trigger');
  expect(runs[1].triggerId).toBe('ignored-since-chat-already-exists');
});

// ------------------------------------------------------------- onChatResolved (task 7a fix round 1)

test('onChatResolved fires exactly once with the newly-created chatId, before the harness ever starts', async () => {
  const seen = [];
  const fakeHarness = createFakeHarness({ script: [{ type: 'result', sessionId: 's1', costUsd: 0, usage: {}, isError: false }] });
  const startTurnSpy = vi.spyOn(fakeHarness, 'startTurn');

  const result = await runTurn({
    dataDir: tmpDir,
    text: 'hello',
    harness: fakeHarness,
    harnessName: 'fake',
    onChatResolved: (chatId) => seen.push(chatId),
  });

  expect(seen).toEqual([result.chatId]);
  // Called before startTurn() was invoked — the only order that matters,
  // since a caller uses this to bind an approval handler BEFORE the harness
  // could possibly ask for one (see src/triggers/runner.mjs).
  expect(startTurnSpy.mock.invocationCallOrder[0]).toBeGreaterThan(0);
});

test('onChatResolved fires with the EXISTING chatId when resuming a chat, not a new one', async () => {
  const firstHarness = createFakeHarness({ script: [{ type: 'result', sessionId: 's1', costUsd: 0, usage: {}, isError: false }] });
  const first = await runTurn({ dataDir: tmpDir, text: 'first', harness: firstHarness, harnessName: 'fake' });

  const seen = [];
  const secondHarness = createFakeHarness({ script: [{ type: 'result', sessionId: 's1', costUsd: 0, usage: {}, isError: false }] });
  await runTurn({
    dataDir: tmpDir,
    chatId: first.chatId,
    text: 'second',
    harness: secondHarness,
    harnessName: 'fake',
    onChatResolved: (chatId) => seen.push(chatId),
  });

  expect(seen).toEqual([first.chatId]);
});

test('onChatResolved is never called for a caller-supplied chatId that does not exist (the turn throws first)', async () => {
  const fakeHarness = createFakeHarness({ script: [{ type: 'result', sessionId: 's1', costUsd: 0, usage: {}, isError: false }] });
  const seen = [];

  await expect(
    runTurn({
      dataDir: tmpDir,
      chatId: '00000000-0000-0000-0000-000000000000',
      text: 'hi',
      harness: fakeHarness,
      harnessName: 'fake',
      onChatResolved: (chatId) => seen.push(chatId),
    }),
  ).rejects.toThrow();
  expect(seen).toEqual([]);
});

test('an empty thinking event is streamed as activity but never persisted — the model redacts its thinking, the store must not fill with husks', async () => {
  const script = [
    { type: 'init', sessionId: 's-th', tools: [], model: 'm', permissionMode: 'default' },
    { type: 'thinking', text: '' },
    { type: 'thinking', text: '   ' },
    { type: 'thinking', text: 'real thought' },
    { type: 'text', text: 'answer' },
    { type: 'result', sessionId: 's-th', costUsd: null, usage: {}, isError: false },
  ];
  const seen = [];
  const { chatId } = await runTurn({ dataDir: tmpDir, text: 'think', harness: createFakeHarness({ script }), onEvent: (e) => seen.push(e) });

  // The stream still carries all three (the agent panel needs the activity signal)…
  expect(seen.filter((e) => e.type === 'thinking')).toHaveLength(3);
  // …but only the one with content reaches the store.
  const chats = openChats(tmpDir);
  const thinking = chats.events(chatId).filter((e) => e.kind === 'thinking');
  expect(thinking).toHaveLength(1);
  expect(thinking[0].text).toBe('real thought');
});

test('approvalMode auto runs the chat-auto profile and bypassPermissions; a trigger turn ignores it completely', async () => {
  const script = [
    { type: 'init', sessionId: 's-am', tools: [], model: 'm', permissionMode: 'bypassPermissions' },
    { type: 'result', sessionId: 's-am', costUsd: null, usage: {}, isError: false },
  ];
  const seenOptions = [];
  const harness = {
    startTurn: async (options) => {
      seenOptions.push(options);
      for (const e of script) options.onEvent(e);
      return { sessionId: 's-am', costUsd: null, usage: null, stopReason: 'result', error: null };
    },
  };

  await runTurn({ dataDir: tmpDir, text: 'go wild', harness, approvalMode: 'auto' });
  expect(seenOptions[0].permissionMode).toBe('bypassPermissions');
  expect(seenOptions[0].settingsPath).toContain('settings-chat-auto');
  const auto = JSON.parse(fs.readFileSync(seenOptions[0].settingsPath, 'utf8'));
  expect(auto.permissions.ask).toEqual([]);

  // Nobody watches a trigger turn — approvalMode must not weaken it.
  await runTurn({ dataDir: tmpDir, text: 'night run', harness, approvalMode: 'auto', origin: 'trigger' });
  expect(seenOptions[1].settingsPath).toContain('settings-trigger');
  expect(seenOptions[1].permissionMode).not.toBe('bypassPermissions');
});

test('approvalMode edits maps to acceptEdits with the edit tools free and everything else still asking', async () => {
  const seenOptions = [];
  const harness = {
    startTurn: async (options) => {
      seenOptions.push(options);
      options.onEvent({ type: 'result', sessionId: 's-ed', costUsd: null, usage: {}, isError: false });
      return { sessionId: 's-ed', costUsd: null, usage: null, stopReason: 'result', error: null };
    },
  };
  await runTurn({ dataDir: tmpDir, text: 'edit stuff', harness, approvalMode: 'edits' });
  expect(seenOptions[0].permissionMode).toBe('acceptEdits');
  const settings = JSON.parse(fs.readFileSync(seenOptions[0].settingsPath, 'utf8'));
  expect(settings.permissions.ask).not.toContain('Edit');
  expect(settings.permissions.ask).toContain('Bash');
});

test('a guided turn carries the mode into the harness and hands the quiz back', async () => {
  const quizText = ['I understood the goal. One thing to settle first.', '', '```kaprek-quiz', '{"questions": [{"id": "scope", "question": "What should it do first?", "options": [{"label": "One flow"}, {"label": "Everything"}]}]}', '```'].join('\n');
  let seenArgs = null;
  const harness = {
    startTurn: async (options) => {
      seenArgs = options;
      options.onEvent({ type: 'init', sessionId: 's1', tools: [], model: 'm', permissionMode: 'default' });
      options.onEvent({ type: 'text', text: quizText });
      return { sessionId: 's1', costUsd: null, usage: null, stopReason: 'result', error: null };
    },
  };

  const planPath = path.join(tmpDir, 'docs', 'plans', '2026-08-02-idea.md');
  const result = await runTurn({ dataDir: tmpDir, text: "let's build a small thing", harness, mode: 'brainstorm', planPath });

  expect(seenArgs.appendSystemPrompt).toContain('kaprek-quiz');
  expect(result.guided.quiz.questions[0].id).toBe('scope');
  // Nothing written yet, and that is the normal state mid-brainstorm.
  expect(result.guided.plan).toBeNull();
  expect(result.guided.protocolBroken).toBe(false);
});

test('a guided turn that wrote its plan registers it at the path kaprek chose', async () => {
  const planPath = path.join(tmpDir, 'docs', 'plans', '2026-08-02-idea.md');
  const harness = {
    startTurn: async (options) => {
      fs.mkdirSync(path.dirname(planPath), { recursive: true });
      fs.writeFileSync(planPath, '# The idea\n\n- [ ] First step\n', 'utf8');
      options.onEvent({ type: 'text', text: 'Written.' });
      return { sessionId: 's1', costUsd: null, usage: null, stopReason: 'result', error: null };
    },
  };

  const result = await runTurn({ dataDir: tmpDir, text: 'write the plan', harness, mode: 'plan', planPath });
  expect(result.guided.plan.path).toBe(path.resolve(planPath));
  expect(result.guided.plan.title).toBe('The idea');
  expect(result.guided.protocolBroken).toBe(false);
});

test('an agent that ignores the guided mode is reported, not silently tolerated', async () => {
  const harness = {
    startTurn: async (options) => {
      options.onEvent({ type: 'text', text: 'Sure, here are my three questions as prose. What is the goal?' });
      return { sessionId: 's1', costUsd: null, usage: null, stopReason: 'result', error: null };
    },
  };
  const result = await runTurn({ dataDir: tmpDir, text: "let's plan", harness, mode: 'brainstorm', planPath: path.join(tmpDir, 'docs', 'plans', 'p.md') });
  expect(result.guided.protocolBroken).toBe(true);
});

test('an unknown mode never reaches the harness as a guided turn', async () => {
  let seenArgs = null;
  const harness = {
    startTurn: async (options) => {
      seenArgs = options;
      return { sessionId: 's1', costUsd: null, usage: null, stopReason: 'result', error: null };
    },
  };
  const result = await runTurn({ dataDir: tmpDir, text: 'hi', harness, mode: 'freestyle' });
  expect(seenArgs.appendSystemPrompt).toBeUndefined();
  expect(result.guided).toBeNull();
});

test('a session id is only resumed by the harness that issued it', async () => {
  const seen = [];
  const harnessFor = (name) => ({
    startTurn: async (options) => {
      seen.push({ name, resumed: options.sessionId ?? null });
      options.onEvent({ type: 'text', text: 'ok' });
      return { sessionId: `${name}-session`, costUsd: null, usage: null, stopReason: 'result', error: null };
    },
  });

  const first = await runTurn({ dataDir: tmpDir, text: 'one', harness: harnessFor('claude-code'), harnessName: 'claude-code', cwd: tmpDir });
  // Same harness: resumes its own session.
  await runTurn({ dataDir: tmpDir, chatId: first.chatId, text: 'two', harness: harnessFor('claude-code'), harnessName: 'claude-code', cwd: tmpDir });
  // Different harness in the SAME chat — a relay recipe does this on purpose.
  // Handing it the other engine's thread id is how the live M2 run died with
  // "no rollout found for thread id".
  await runTurn({ dataDir: tmpDir, chatId: first.chatId, text: 'three', harness: harnessFor('codex'), harnessName: 'codex', cwd: tmpDir });

  expect(seen[0].resumed).toBeNull();
  expect(seen[1].resumed).toBe('claude-code-session');
  expect(seen[2].resumed).toBeNull();
});

test('a prompt that carries an <external> block gets the rule that explains it appended to the system prompt; one without stays untouched', async () => {
  const seen = [];
  const harness = {
    startTurn: async (options) => {
      seen.push(options);
      return { sessionId: 's1', costUsd: null, usage: null, stopReason: 'result', error: null };
    },
  };
  await runTurn({ dataDir: tmpDir, text: 'Look at this:\n<external source="clipboard">\nsome copied text\n</external>', harness });
  await runTurn({ dataDir: tmpDir, text: 'plain question', harness });

  expect(seen[0].appendSystemPrompt).toContain('<external source="...">');
  expect(seen[0].appendSystemPrompt).toContain('not orders');
  expect(seen[1].appendSystemPrompt).toBeUndefined();
});
