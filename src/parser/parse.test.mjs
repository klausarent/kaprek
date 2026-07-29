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

test('meta.title ist der LETZTE ai-title (nicht der erste)', async () => {
  const digest = await digestSession(FIXTURE);
  expect(digest.meta.title).toBe('Final title: Digest Parser Fixture');
});

test('events sind chronologisch nach timestamp sortiert', async () => {
  const digest = await digestSession(FIXTURE);
  const timestamps = digest.events.map((e) => e.ts);
  const sorted = [...timestamps].sort();
  expect(timestamps).toEqual(sorted);
  // Fixture timestamps are intentionally unsorted in the file -> the check is not trivially satisfied
  expect(digest.events.length).toBeGreaterThan(0);
});

test('genau 1 user-Event (tool_result und isMeta zaehlen nicht als user-Prompt)', async () => {
  const digest = await digestSession(FIXTURE);
  const userEvents = digest.events.filter((e) => e.kind === 'user');
  expect(userEvents.length).toBe(1);
  expect(userEvents[0].text).toBe('Build the digest parser for the session-viewer fixture.');
});

test('tool-Event: name Bash, resultRef null bei normalem Ergebnis, Pfad bei persisted-output', async () => {
  const digest = await digestSession(FIXTURE);
  const toolEvents = digest.events.filter((e) => e.kind === 'tool');
  expect(toolEvents.length, 'zwei Bash-tool_use in der Fixture').toBe(2);

  const commitTool = toolEvents.find((e) => e.msgId === 'msg_A0000000000000000000001');
  expect(commitTool, 'Bash-Event fuer git-commit-Aufruf fehlt').toBeTruthy();
  expect(commitTool.name).toBe('Bash');
  expect(commitTool.resultRef).toBe(null);

  const persistedTool = toolEvents.find((e) => e.msgId === 'msg_C0000000000000000000001');
  expect(persistedTool, 'Bash-Event fuer persisted-output-Aufruf fehlt').toBeTruthy();
  expect(persistedTool.name).toBe('Bash');
  expect(persistedTool.resultRef).toBe(
    'C:\\Users\\testuser\\.claude\\projects\\C--Users-testuser\\mini-session\\tool-results\\toolu_bash0000000000000002.txt',
  );
});

test('thinking wird bei kleinem maxTextLen gekürzt', async () => {
  const digest = await digestSession(FIXTURE, { maxTextLen: 10 });
  const thinkingEvents = digest.events.filter((e) => e.kind === 'thinking');
  expect(thinkingEvents.length).toBe(1);
  expect(thinkingEvents[0].text).toMatch(/^.{10} …\[truncated, \d+ chars\]$/);
});

test('meta.gitCommits zaehlt nur echte git-commit-Treffer in Bash-Inputs', async () => {
  const digest = await digestSession(FIXTURE);
  expect(digest.meta.gitCommits).toBe(1);
});

test('Marker-Zeilen ohne uuid/timestamp und kaputte JSON-Zeilen crashen den Parser nicht', async () => {
  await digestSession(FIXTURE);
});

test('meta.turns zaehlt message.id-Gruppen einmal (nicht pro Content-Block)', async () => {
  const digest = await digestSession(FIXTURE);
  // msg A (text+thinking+tool_use), msg B (Agent spawn), msg C (Bash) = 3 message.id
  expect(digest.meta.turns).toBe(3);
});

test('subagent-Event hat agentId null (unbekannt zum Spawn-Zeitpunkt)', async () => {
  const digest = await digestSession(FIXTURE);
  const subagentEvents = digest.events.filter((e) => e.kind === 'subagent');
  expect(subagentEvents.length).toBe(1);
  expect(subagentEvents[0].agentId).toBe(null);
  expect(subagentEvents[0].agentType).toBe('fast-worker');
  expect(subagentEvents[0].name).toBe('test123');
});

test('compact-Event enthaelt preTokens/postTokens', async () => {
  const digest = await digestSession(FIXTURE);
  const compactEvents = digest.events.filter((e) => e.kind === 'compact');
  expect(compactEvents.length).toBe(1);
  expect(compactEvents[0].preTokens).toBe(120000);
  expect(compactEvents[0].postTokens).toBe(8000);
});

test('meta-Basisfelder sind plausibel befuellt', async () => {
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

test('subagents werden rekursiv mit gleicher Event-Form gedigestet', async () => {
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

test('Kuerzung haengt Original-Zeichenzahl an, nicht die gekuerzte Länge', async () => {
  const digest = await digestSession(FIXTURE, { maxTextLen: 10, maxToolLen: 10 });
  const commitTool = digest.events.find((e) => e.kind === 'tool' && e.name === 'Bash' && e.resultRef === null);
  expect(commitTool.input).toMatch(/…\[truncated, \d+ chars\]$/);
});

test('unterbrochener tool_use ohne tool_result wird als tool-Event mit result:null sichtbar, nicht verworfen', async () => {
  // Own mini fixture: a Bash tool_use that is NEVER followed by a tool_result
  // (simulates a session interrupted mid-tool-call).
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'digest-parser-interrupted-'));
  const tmpPath = path.join(tmpDir, 'interrupted-session.jsonl');
  const lines = [
    {
      parentUuid: null, isSidechain: false,
      promptId: 'p0000000-0000-0000-0000-000000000001', type: 'user',
      message: { role: 'user', content: 'Starte einen langen Befehl.' },
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
    expect(toolEvents.length, 'der offene tool_use muss trotzdem als Event auftauchen').toBe(1);
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

test('meta.gitCommits zaehlt NUR im Bash-input.command, nicht in anderen Input-Feldern (z.B. description)', async () => {
  // Own mini fixture: a Bash tool_use whose `description` mentions "git commit"
  // but whose `command` does NOT contain it -> must not count.
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'digest-parser-gitcommits-'));
  const tmpPath = path.join(tmpDir, 'gitcommits-session.jsonl');
  const lines = [
    {
      parentUuid: null, isSidechain: false,
      promptId: 'p0000000-0000-0000-0000-000000000003', type: 'user',
      message: { role: 'user', content: 'Erklaer mir bitte git commit, aber fuehr nichts aus.' },
      uuid: 'u0000000-0000-0000-0000-000000000004', timestamp: '2026-07-29T12:00:00.000Z',
      cwd: 'C:\\tmp', sessionId: 'gitcommits-session', version: '2.1.212', gitBranch: 'main',
    },
    {
      parentUuid: 'u0000000-0000-0000-0000-000000000004', isSidechain: false, type: 'assistant',
      message: {
        model: 'claude-sonnet-5', id: 'msg_G0000000000000000000001', type: 'message', role: 'assistant',
        content: [{
          type: 'tool_use', id: 'toolu_gitcommits0000000001', name: 'Bash',
          input: { command: 'npm run build', description: 'Nicht git commit ausfuehren, nur bauen' },
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
    expect(digest.meta.gitCommits, 'git commit nur in description darf nicht zaehlen').toBe(0);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// redactSecrets (SECURITY) — digests are persisted, secrets from tool
// inputs/results must never show up there in plaintext.
// ---------------------------------------------------------------------------

test('redactSecrets: Anthropic/OpenAI/Stripe sk-... wird redigiert', () => {
  const text = 'Key: sk-ant-api03-AbCdEfGhIjKlMnOpQrStUvWxYz0123456789 im Tool-Input';
  expect(redactSecrets(text)).toBe('Key: [REDACTED] im Tool-Input');
});

test('redactSecrets: Stripe sk_test_/sk_live_ wird redigiert', () => {
  expect(redactSecrets('STRIPE_KEY sk_test_4eC39HqLyjWDarjtT1zdp7dc verwendet')).toBe(
    'STRIPE_KEY [REDACTED] verwendet',
  );
  expect(redactSecrets('sk_live_51AbCdEfGhIjKlMnOpQrSt')).toBe('[REDACTED]');
});

test('redactSecrets: Cloudflare cfXXX_... wird redigiert', () => {
  expect(redactSecrets('Token: cfat_AbCdEfGhIjKlMnOpQrStUvWxYz0123456')).toBe('Token: [REDACTED]');
});

test('redactSecrets: Google OAuth Client Secret GOCSPX-... wird redigiert', () => {
  expect(redactSecrets('client_secret=GOCSPX-AbCdEfGhIjKlMnOpQrStUvWx')).toBe('client_secret=[REDACTED]');
});

test('redactSecrets: Google Refresh Token 1//... wird redigiert', () => {
  expect(redactSecrets('refresh_token: 1//09FakeRefreshTokenAbCdEfGhIjKl')).toBe('refresh_token: [REDACTED]');
});

test('redactSecrets: Resend re_... wird redigiert', () => {
  expect(redactSecrets('RESEND_API_KEY re_AbCdEfGhIjKlMnOpQrStUvWxYz gesetzt')).toBe(
    'RESEND_API_KEY [REDACTED] gesetzt',
  );
});

test('redactSecrets: GitHub ghp_... und github_pat_... werden redigiert', () => {
  expect(redactSecrets('ghp_AbCdEfGh1234567890ABCDEFGHijkl')).toBe('[REDACTED]');
  expect(redactSecrets('github_pat_11ABCDEFG0abcdefghijklmnopqrstuvwxyz')).toBe('[REDACTED]');
});

test('redactSecrets: Bearer <token> wird zu "Bearer [REDACTED]"', () => {
  expect(redactSecrets('Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9')).toBe(
    'Authorization: Bearer [REDACTED]',
  );
});

test('redactSecrets: KEY=VALUE/KEY: VALUE-Zeilen behalten den Schlüsselnamen, Wert wird redigiert', () => {
  expect(redactSecrets('MC_API_TOKEN=supergeheimerwert123')).toBe('MC_API_TOKEN=[REDACTED]');
  expect(redactSecrets('ABLAGE_TOKEN: "geheimeswert12345"')).toBe('ABLAGE_TOKEN=[REDACTED]');
  expect(redactSecrets('DB_PASSWORD=hunter2geheim')).toBe('DB_PASSWORD=[REDACTED]');
});

test('redactSecrets: Umlaut-Text bleibt unverändert', () => {
  const text = 'Änderungen für Rückenwind-Eltern: ä ö ü ß Straße, Größe, Prüfung.';
  expect(redactSecrets(text)).toBe(text);
});

test('redactSecrets: kurze/harmlose Strings werden NICHT redigiert', () => {
  expect(redactSecrets('sk-kurz')).toBe('sk-kurz');
  expect(redactSecrets('PORT=8080')).toBe('PORT=8080');
  expect(redactSecrets('ID=12345678')).toBe('ID=12345678');
  expect(redactSecrets('re_kurz')).toBe('re_kurz');
  expect(redactSecrets('normaler Text ohne Secrets')).toBe('normaler Text ohne Secrets');
});

test('redactSecrets: Nicht-Strings/leerer String bleiben unverändert (kein Crash)', () => {
  expect(redactSecrets(null)).toBe(null);
  expect(redactSecrets(undefined)).toBe(undefined);
  expect(redactSecrets('')).toBe('');
  expect(redactSecrets(42)).toBe(42);
});

test('Integration: digestSession redigiert ein Secret in einem tool_result, bevor gekürzt wird', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'digest-parser-secret-'));
  const tmpPath = path.join(tmpDir, 'secret-session.jsonl');
  const fakeToken = 'sk-ant-api03-AbCdEfGhIjKlMnOpQrStUvWxYz0123456789FakeToken';
  const lines = [
    {
      parentUuid: null, isSidechain: false,
      promptId: 'p0000000-0000-0000-0000-000000000002', type: 'user',
      message: { role: 'user', content: 'Lies bitte das Secret aus der .env-Datei.' },
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
    expect(toolEvent, 'tool-Event fehlt').toBeTruthy();
    expect(toolEvent.result.includes('[REDACTED]'), 'Digest muss [REDACTED] enthalten').toBe(true);
    expect(toolEvent.result.includes(fakeToken), 'Digest darf den echten Token NICHT enthalten').toBe(false);
    expect(
      toolEvent.result.includes('AbCdEfGhIjKlMnOpQrStUvWxYz'),
      'auch keine Teilstrings des Tokens',
    ).toBe(false);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('Integration: digestSession({ redact: false }) lässt ein Secret im Klartext (Opt-out)', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'digest-parser-no-redact-'));
  const tmpPath = path.join(tmpDir, 'secret-session.jsonl');
  const fakeToken = 'sk-ant-api03-AbCdEfGhIjKlMnOpQrStUvWxYz0123456789FakeToken';
  const lines = [
    {
      parentUuid: null, isSidechain: false,
      promptId: 'p0000000-0000-0000-0000-000000000003', type: 'user',
      message: { role: 'user', content: 'Lies bitte das Secret aus der .env-Datei.' },
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
    expect(toolEvent, 'tool-Event fehlt').toBeTruthy();
    expect(toolEvent.result.includes(fakeToken), 'redact:false muss den echten Token im Klartext lassen').toBe(true);
    expect(toolEvent.result.includes('[REDACTED]'), 'redact:false darf NICHT redigieren').toBe(false);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
