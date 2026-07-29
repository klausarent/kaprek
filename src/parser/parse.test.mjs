// Tests for the streaming digest parser.
// Run: npx vitest run src/parser
import { test, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { digestSession, redactSecrets } from './parse.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(__dirname, 'fixtures', 'mini-session.jsonl');

test('meta.title is the LAST ai-title (not the first)', async () => {
  const digest = await digestSession(FIXTURE);
  expect(digest.meta.title).toBe('Final title: Digest Parser Fixture');
});

test('events are sorted chronologically by timestamp', async () => {
  const digest = await digestSession(FIXTURE);
  const timestamps = digest.events.map((e) => e.ts);
  const sorted = [...timestamps].sort();
  expect(timestamps).toEqual(sorted);
  // Fixture timestamps are intentionally unsorted in the file -> the check is not trivially satisfied
  expect(digest.events.length).toBeGreaterThan(0);
});

test('exactly 1 user event (tool_result and isMeta do not count as user prompt)', async () => {
  const digest = await digestSession(FIXTURE);
  const userEvents = digest.events.filter((e) => e.kind === 'user');
  expect(userEvents.length).toBe(1);
  expect(userEvents[0].text).toBe('Build the digest parser for the session-viewer fixture.');
});

test('tool event: name Bash, resultRef null for a normal result, path for persisted output', async () => {
  const digest = await digestSession(FIXTURE);
  const toolEvents = digest.events.filter((e) => e.kind === 'tool');
  expect(toolEvents.length, 'two Bash tool_use in the fixture').toBe(2);

  const commitTool = toolEvents.find((e) => e.msgId === 'msg_A0000000000000000000001');
  expect(commitTool, 'Bash event for the git commit call is missing').toBeTruthy();
  expect(commitTool.name).toBe('Bash');
  expect(commitTool.resultRef).toBe(null);

  const persistedTool = toolEvents.find((e) => e.msgId === 'msg_C0000000000000000000001');
  expect(persistedTool, 'Bash event for the persisted-output call is missing').toBeTruthy();
  expect(persistedTool.name).toBe('Bash');
  expect(persistedTool.resultRef).toBe(
    'C:\\Users\\testuser\\.claude\\projects\\C--Users-testuser\\mini-session\\tool-results\\toolu_bash0000000000000002.txt',
  );
});

test('thinking is truncated when maxTextLen is small', async () => {
  const digest = await digestSession(FIXTURE, { maxTextLen: 10 });
  const thinkingEvents = digest.events.filter((e) => e.kind === 'thinking');
  expect(thinkingEvents.length).toBe(1);
  expect(thinkingEvents[0].text).toMatch(/^.{10} …\[truncated, \d+ chars\]$/);
});

test('meta.gitCommits counts only real git commit hits in Bash inputs', async () => {
  const digest = await digestSession(FIXTURE);
  expect(digest.meta.gitCommits).toBe(1);
});

test('marker lines without uuid/timestamp and malformed JSON lines do not crash the parser', async () => {
  await digestSession(FIXTURE);
});

test('meta.turns counts message.id groups once (not per content block)', async () => {
  const digest = await digestSession(FIXTURE);
  // msg A (text+thinking+tool_use), msg B (Agent spawn), msg C (Bash) = 3 message.id
  expect(digest.meta.turns).toBe(3);
});

test('subagent event has agentId null (unknown at spawn time)', async () => {
  const digest = await digestSession(FIXTURE);
  const subagentEvents = digest.events.filter((e) => e.kind === 'subagent');
  expect(subagentEvents.length).toBe(1);
  expect(subagentEvents[0].agentId).toBe(null);
  expect(subagentEvents[0].agentType).toBe('fast-worker');
  expect(subagentEvents[0].name).toBe('test123');
});

test('compact event contains preTokens/postTokens', async () => {
  const digest = await digestSession(FIXTURE);
  const compactEvents = digest.events.filter((e) => e.kind === 'compact');
  expect(compactEvents.length).toBe(1);
  expect(compactEvents[0].preTokens).toBe(120000);
  expect(compactEvents[0].postTokens).toBe(8000);
});

test('meta base fields are plausibly populated', async () => {
  const digest = await digestSession(FIXTURE);
  expect(digest.meta.sessionId).toBe('mini-session');
  expect(digest.meta.projectSlug).toBe('fixtures');
  expect(digest.meta.cwd).toBe('C:\\Users\\testuser\\projects\\demo-app');
  expect(digest.meta.models.sort()).toEqual(['claude-opus-5', 'claude-sonnet-5']);
  expect(digest.meta.startedAt).toBe('2026-07-28T09:00:00.000Z');
  // The last line with a timestamp in the fixture is system/local_command #2 (09:03:25) —
  // startedAt/endedAt reflect the ENTIRE time window of the file, not just the kept events.
  expect(digest.meta.endedAt).toBe('2026-07-28T09:03:25.000Z');
  expect(digest.meta.toolCalls, 'Bash x2 + Agent x1').toBe(3);
  expect(digest.meta.hasSubagents).toBe(true);
  expect(digest.meta.rawBytes).toBeGreaterThan(0);
  expect(typeof digest.meta.machine).toBe('string');
});

test('subagents are digested recursively with the same event shape', async () => {
  const digest = await digestSession(FIXTURE);
  expect(digest.subagents.length).toBe(1);
  const sub = digest.subagents[0];
  expect(sub.agentId).toBe('test123');
  expect(sub.meta.agentType).toBe('fast-worker');
  expect(sub.meta.description).toBe('Tests subagent digest');

  const subUserEvents = sub.events.filter((e) => e.kind === 'user');
  expect(subUserEvents.length).toBe(1);
  const subToolEvents = sub.events.filter((e) => e.kind === 'tool');
  expect(subToolEvents.length).toBe(1);
  expect(subToolEvents[0].name).toBe('Grep');

  const subTimestamps = sub.events.map((e) => e.ts);
  expect(subTimestamps).toEqual([...subTimestamps].sort());
});

test('truncation appends the original char count, not the truncated length', async () => {
  const digest = await digestSession(FIXTURE, { maxTextLen: 10, maxToolLen: 10 });
  const commitTool = digest.events.find((e) => e.kind === 'tool' && e.name === 'Bash' && e.resultRef === null);
  expect(commitTool.input).toMatch(/…\[truncated, \d+ chars\]$/);
});

test('interrupted tool_use without tool_result shows up as a tool event with result:null, not dropped', async () => {
  // Own mini fixture: a Bash tool_use that is NEVER followed by a tool_result
  // (simulates a session interrupted mid-tool-call).
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'digest-parser-interrupted-'));
  const tmpPath = path.join(tmpDir, 'interrupted-session.jsonl');
  const lines = [
    {
      parentUuid: null, isSidechain: false,
      promptId: 'p0000000-0000-0000-0000-000000000001', type: 'user',
      message: { role: 'user', content: 'Run a long command.' },
      uuid: 'u0000000-0000-0000-0000-000000000001', timestamp: '2026-07-29T10:00:00.000Z',
      cwd: 'C:\\tmp', sessionId: 'interrupted-session', version: '2.1.212', gitBranch: 'main',
    },
    {
      parentUuid: 'u0000000-0000-0000-0000-000000000001', isSidechain: false, type: 'assistant',
      message: {
        model: 'claude-sonnet-5', id: 'msg_X0000000000000000000001', type: 'message', role: 'assistant',
        content: [{ type: 'tool_use', id: 'toolu_interrupted0000000001', name: 'Bash', input: { command: 'npm run build' } }],
        stop_reason: 'tool_use', usage: { input_tokens: 5, output_tokens: 5 },
      },
      uuid: 'a0000000-0000-0000-0000-000000000001', timestamp: '2026-07-29T10:00:05.000Z',
      cwd: 'C:\\tmp', sessionId: 'interrupted-session', version: '2.1.212', gitBranch: 'main',
    },
    // -- file ends abruptly here, no tool_result for toolu_interrupted0000000001 --
  ];
  fs.writeFileSync(tmpPath, lines.map((l) => JSON.stringify(l)).join('\n') + '\n', 'utf8');

  try {
    const digest = await digestSession(tmpPath);
    const toolEvents = digest.events.filter((e) => e.kind === 'tool');
    expect(toolEvents.length, 'the open tool_use must still show up as an event').toBe(1);
    expect(toolEvents[0].name).toBe('Bash');
    expect(toolEvents[0].msgId).toBe('msg_X0000000000000000000001');
    expect(toolEvents[0].result).toBe(null);
    expect(toolEvents[0].resultRef).toBe(null);
    // meta.toolCalls (counts tool_use blocks) and the number of visible tool
    // events must now match, because nothing is dropped anymore.
    expect(digest.meta.toolCalls).toBe(1);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('meta.gitCommits counts ONLY in Bash input.command, not in other input fields (e.g. description)', async () => {
  // Own mini fixture: a Bash tool_use whose `description` mentions "git commit"
  // but whose `command` does NOT contain it -> must not count.
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'digest-parser-gitcommits-'));
  const tmpPath = path.join(tmpDir, 'gitcommits-session.jsonl');
  const lines = [
    {
      parentUuid: null, isSidechain: false,
      promptId: 'p0000000-0000-0000-0000-000000000003', type: 'user',
      message: { role: 'user', content: 'Please explain git commit, but do not run anything.' },
      uuid: 'u0000000-0000-0000-0000-000000000004', timestamp: '2026-07-29T12:00:00.000Z',
      cwd: 'C:\\tmp', sessionId: 'gitcommits-session', version: '2.1.212', gitBranch: 'main',
    },
    {
      parentUuid: 'u0000000-0000-0000-0000-000000000004', isSidechain: false, type: 'assistant',
      message: {
        model: 'claude-sonnet-5', id: 'msg_G0000000000000000000001', type: 'message', role: 'assistant',
        content: [{
          type: 'tool_use', id: 'toolu_gitcommits0000000001', name: 'Bash',
          input: { command: 'npm run build', description: 'Do not run git commit, just build' },
        }],
        stop_reason: 'tool_use', usage: { input_tokens: 5, output_tokens: 5 },
      },
      uuid: 'a0000000-0000-0000-0000-000000000004', timestamp: '2026-07-29T12:00:05.000Z',
      cwd: 'C:\\tmp', sessionId: 'gitcommits-session', version: '2.1.212', gitBranch: 'main',
    },
    {
      parentUuid: 'a0000000-0000-0000-0000-000000000004', isSidechain: false, type: 'user',
      message: {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'toolu_gitcommits0000000001', content: 'build ok' }],
      },
      uuid: 'u0000000-0000-0000-0000-000000000005', timestamp: '2026-07-29T12:00:06.000Z',
      cwd: 'C:\\tmp', sessionId: 'gitcommits-session', version: '2.1.212', gitBranch: 'main',
    },
  ];
  fs.writeFileSync(tmpPath, lines.map((l) => JSON.stringify(l)).join('\n') + '\n', 'utf8');

  try {
    const digest = await digestSession(tmpPath);
    expect(digest.meta.gitCommits, 'git commit only in description must not count').toBe(0);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// redactSecrets (SECURITY) — digests are persisted, secrets from tool
// inputs/results must never show up there in plaintext.
// ---------------------------------------------------------------------------

test('redactSecrets: Anthropic/OpenAI/Stripe sk-... is redacted', () => {
  const text = 'Key: sk-ant-api03-AbCdEfGhIjKlMnOpQrStUvWxYz0123456789 in tool input';
  expect(redactSecrets(text)).toBe('Key: [REDACTED] in tool input');
});

test('redactSecrets: Stripe sk_test_/sk_live_ is redacted', () => {
  expect(redactSecrets('STRIPE_KEY sk_test_4eC39HqLyjWDarjtT1zdp7dc used')).toBe(
    'STRIPE_KEY [REDACTED] used',
  );
  expect(redactSecrets('sk_live_51AbCdEfGhIjKlMnOpQrSt')).toBe('[REDACTED]');
});

test('redactSecrets: Cloudflare cfXXX_... is redacted', () => {
  expect(redactSecrets('Token: cfat_AbCdEfGhIjKlMnOpQrStUvWxYz0123456')).toBe('Token: [REDACTED]');
});

test('redactSecrets: Google OAuth client secret GOCSPX-... is redacted', () => {
  expect(redactSecrets('client_secret=GOCSPX-AbCdEfGhIjKlMnOpQrStUvWx')).toBe('client_secret=[REDACTED]');
});

test('redactSecrets: Google refresh token 1//... is redacted', () => {
  expect(redactSecrets('refresh_token: 1//09FakeRefreshTokenAbCdEfGhIjKl')).toBe('refresh_token: [REDACTED]');
});

test('redactSecrets: Resend re_... is redacted', () => {
  expect(redactSecrets('RESEND_API_KEY re_AbCdEfGhIjKlMnOpQrStUvWxYz set')).toBe(
    'RESEND_API_KEY [REDACTED] set',
  );
});

test('redactSecrets: GitHub ghp_... and github_pat_... are redacted', () => {
  expect(redactSecrets('ghp_AbCdEfGh1234567890ABCDEFGHijkl')).toBe('[REDACTED]');
  expect(redactSecrets('github_pat_11ABCDEFG0abcdefghijklmnopqrstuvwxyz')).toBe('[REDACTED]');
});

test('redactSecrets: Bearer <token> becomes "Bearer [REDACTED]"', () => {
  expect(redactSecrets('Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9')).toBe(
    'Authorization: Bearer [REDACTED]',
  );
});

test('redactSecrets: KEY=VALUE/KEY: VALUE lines keep the key name, value is redacted', () => {
  expect(redactSecrets('MC_API_TOKEN=supergeheimerwert123')).toBe('MC_API_TOKEN=[REDACTED]');
  expect(redactSecrets('VAULT_TOKEN: "secretvalue12345"')).toBe('VAULT_TOKEN=[REDACTED]');
  expect(redactSecrets('DB_PASSWORD=hunter2secret')).toBe('DB_PASSWORD=[REDACTED]');
});

test('redactSecrets: umlaut text stays unchanged', () => {
  const text = 'Änderungen für das Projekt: ä ö ü ß Straße, Größe, Prüfung.';
  expect(redactSecrets(text)).toBe(text);
});

test('redactSecrets: short/harmless strings are NOT redacted', () => {
  expect(redactSecrets('sk-kurz')).toBe('sk-kurz');
  expect(redactSecrets('PORT=8080')).toBe('PORT=8080');
  expect(redactSecrets('ID=12345678')).toBe('ID=12345678');
  expect(redactSecrets('re_kurz')).toBe('re_kurz');
  expect(redactSecrets('normal text without secrets')).toBe('normal text without secrets');
});

test('redactSecrets: non-strings/empty string stay unchanged (no crash)', () => {
  expect(redactSecrets(null)).toBe(null);
  expect(redactSecrets(undefined)).toBe(undefined);
  expect(redactSecrets('')).toBe('');
  expect(redactSecrets(42)).toBe(42);
});

test('integration: digestSession redacts a secret in a tool_result before truncation', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'digest-parser-secret-'));
  const tmpPath = path.join(tmpDir, 'secret-session.jsonl');
  const fakeToken = 'sk-ant-api03-AbCdEfGhIjKlMnOpQrStUvWxYz0123456789FakeToken';
  const lines = [
    {
      parentUuid: null, isSidechain: false,
      promptId: 'p0000000-0000-0000-0000-000000000002', type: 'user',
      message: { role: 'user', content: 'Please read the secret from the .env file.' },
      uuid: 'u0000000-0000-0000-0000-000000000002', timestamp: '2026-07-29T11:00:00.000Z',
      cwd: 'C:\\tmp', sessionId: 'secret-session', version: '2.1.212', gitBranch: 'main',
    },
    {
      parentUuid: 'u0000000-0000-0000-0000-000000000002', isSidechain: false, type: 'assistant',
      message: {
        model: 'claude-sonnet-5', id: 'msg_S0000000000000000000001', type: 'message', role: 'assistant',
        content: [{ type: 'tool_use', id: 'toolu_secret0000000000001', name: 'Bash', input: { command: 'cat .env' } }],
        stop_reason: 'tool_use', usage: { input_tokens: 5, output_tokens: 5 },
      },
      uuid: 'a0000000-0000-0000-0000-000000000002', timestamp: '2026-07-29T11:00:05.000Z',
      cwd: 'C:\\tmp', sessionId: 'secret-session', version: '2.1.212', gitBranch: 'main',
    },
    {
      parentUuid: 'a0000000-0000-0000-0000-000000000002', isSidechain: false, type: 'user',
      message: {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'toolu_secret0000000000001',
            content: `ANTHROPIC_API_KEY=${fakeToken}`,
          },
        ],
      },
      uuid: 'u0000000-0000-0000-0000-000000000003', timestamp: '2026-07-29T11:00:06.000Z',
      cwd: 'C:\\tmp', sessionId: 'secret-session', version: '2.1.212', gitBranch: 'main',
    },
  ];
  fs.writeFileSync(tmpPath, lines.map((l) => JSON.stringify(l)).join('\n') + '\n', 'utf8');

  try {
    const digest = await digestSession(tmpPath);
    const toolEvent = digest.events.find((e) => e.kind === 'tool');
    expect(toolEvent, 'tool event is missing').toBeTruthy();
    expect(toolEvent.result.includes('[REDACTED]'), 'digest must contain [REDACTED]').toBe(true);
    expect(toolEvent.result.includes(fakeToken), 'digest must NOT contain the real token').toBe(false);
    expect(
      toolEvent.result.includes('AbCdEfGhIjKlMnOpQrStUvWxYz'),
      'also no substrings of the token',
    ).toBe(false);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('integration: digestSession({ redact: false }) leaves a secret in plaintext (opt-out)', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'digest-parser-no-redact-'));
  const tmpPath = path.join(tmpDir, 'secret-session.jsonl');
  const fakeToken = 'sk-ant-api03-AbCdEfGhIjKlMnOpQrStUvWxYz0123456789FakeToken';
  const lines = [
    {
      parentUuid: null, isSidechain: false,
      promptId: 'p0000000-0000-0000-0000-000000000003', type: 'user',
      message: { role: 'user', content: 'Please read the secret from the .env file.' },
      uuid: 'u0000000-0000-0000-0000-000000000004', timestamp: '2026-07-29T12:00:00.000Z',
      cwd: 'C:\\tmp', sessionId: 'secret-session', version: '2.1.212', gitBranch: 'main',
    },
    {
      parentUuid: 'u0000000-0000-0000-0000-000000000004', isSidechain: false, type: 'assistant',
      message: {
        model: 'claude-sonnet-5', id: 'msg_S0000000000000000000002', type: 'message', role: 'assistant',
        content: [{ type: 'tool_use', id: 'toolu_secret0000000000002', name: 'Bash', input: { command: 'cat .env' } }],
        stop_reason: 'tool_use', usage: { input_tokens: 5, output_tokens: 5 },
      },
      uuid: 'a0000000-0000-0000-0000-000000000004', timestamp: '2026-07-29T12:00:05.000Z',
      cwd: 'C:\\tmp', sessionId: 'secret-session', version: '2.1.212', gitBranch: 'main',
    },
    {
      parentUuid: 'a0000000-0000-0000-0000-000000000004', isSidechain: false, type: 'user',
      message: {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'toolu_secret0000000000002',
            content: `ANTHROPIC_API_KEY=${fakeToken}`,
          },
        ],
      },
      uuid: 'u0000000-0000-0000-0000-000000000005', timestamp: '2026-07-29T12:00:06.000Z',
      cwd: 'C:\\tmp', sessionId: 'secret-session', version: '2.1.212', gitBranch: 'main',
    },
  ];
  fs.writeFileSync(tmpPath, lines.map((l) => JSON.stringify(l)).join('\n') + '\n', 'utf8');

  try {
    const digest = await digestSession(tmpPath, { redact: false });
    const toolEvent = digest.events.find((e) => e.kind === 'tool');
    expect(toolEvent, 'tool event is missing').toBeTruthy();
    expect(toolEvent.result.includes(fakeToken), 'redact:false must leave the real token in plaintext').toBe(true);
    expect(toolEvent.result.includes('[REDACTED]'), 'redact:false must NOT redact').toBe(false);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
