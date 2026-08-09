// Privacy proof (E2E): the real local server reads a fixture session with
// five different synthetic secret patterns and, by default, returns no
// plaintext key in the digest, only [REDACTED]. With the deliberate opt-out
// startServer({ redact: false }), the plaintext keys show up — proving that
// redaction is a deliberate decision, not an accident.
//
// Unlike src/parser/parse.test.mjs (which tests redactSecrets() in
// isolation), this test exercises the whole path: HTTP route ->
// digestSession() -> redactSecrets(), through a real server on a real
// loopback port.
import { test, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startServer } from './server/server.mjs';
import { TOKEN_HEADER } from './server/token.mjs';

let tmpDir;
let dataDir;
let servers = [];
let currentToken = null;

/** Adds the instance-token header to every request in this file (see src/server/token.mjs). */
const rawFetch = (...args) => globalThis.fetch(...args);
function fetch(input, init = {}) {
  return rawFetch(input, { ...init, headers: { ...(init.headers ?? {}), [TOKEN_HEADER]: currentToken ?? '' } });
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'redaction-e2e-'));
  // A per-test dataDir: startServer()'s default is the REAL app dir, which a
  // test must not write its instance token (or anything else) into.
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'redaction-e2e-data-'));
  servers = [];
  currentToken = null;
});

afterEach(async () => {
  for (const { server } of servers) {
    await new Promise((resolve) => server.close(resolve));
  }
  fs.rmSync(tmpDir, { recursive: true, force: true });
  fs.rmSync(dataDir, { recursive: true, force: true });
});

/** Starts a server for this test and registers it for teardown. */
async function boot(opts) {
  const started = await startServer({ port: 0, rootDir: tmpDir, dataDir, ...opts });
  servers.push(started);
  currentToken = started.token;
  return started;
}

// Five different, purely synthetic key patterns (testuser/0000/AAAA
// placeholders, no real values), modeled after the patterns in
// src/parser/parse.mjs (SECRET_PATTERNS / BEARER_RE / KEY_VALUE_RE).
const SECRETS = {
  anthropicStyle: 'sk-ant-' + 'api03-test0000000000000000000000AAAA',
  stripeProjStyle: 'sk-proj-' + 'test0000000000000000000000000AAAA',
  githubPat: 'ghp_' + 'test0000000000000000AAAA',
  bearerToken: 'test0000000000000000AAAA',
  keyValueLine: 'TEST_API_KEY=test1111111111111111BBBB',
};

/** Builds a synthetic session JSONL whose tool_result contains all 5 patterns. */
function buildFixtureSession() {
  const toolResultText = [
    `anthropic key: ${SECRETS.anthropicStyle}`,
    `project key: ${SECRETS.stripeProjStyle}`,
    `github token: ${SECRETS.githubPat}`,
    `Authorization: Bearer ${SECRETS.bearerToken}`,
    SECRETS.keyValueLine,
  ].join('\n');

  const lines = [
    JSON.stringify({ type: 'ai-title', aiTitle: 'Fixture: Redaction E2E', sessionId: 'e2e-secret' }),
    JSON.stringify({
      parentUuid: null,
      isSidechain: false,
      type: 'user',
      promptId: 'p2000000-0000-0000-0000-000000000001',
      message: { role: 'user', content: 'Zeig mir die Testdatei mit den Secrets.' },
      uuid: 'u2000000-0000-0000-0000-000000000001',
      timestamp: '2026-07-29T10:00:00.000Z',
      userType: 'external',
      entrypoint: 'cli',
      cwd: 'C:\\Users\\testuser\\Documents\\Software\\demo-project',
      sessionId: 'e2e-secret',
      version: '2.1.212',
      gitBranch: 'main',
    }),
    JSON.stringify({
      parentUuid: 'u2000000-0000-0000-0000-000000000001',
      isSidechain: false,
      type: 'assistant',
      message: {
        model: 'claude-sonnet-5',
        id: 'msg_E0000000000000000000001',
        type: 'message',
        role: 'assistant',
        content: [
          { type: 'tool_use', id: 'toolu_e2e0000000000001', name: 'Bash', input: { command: 'cat .env.test' } },
        ],
        stop_reason: 'tool_use',
        usage: { input_tokens: 5, output_tokens: 5 },
      },
      uuid: 'a2000000-0000-0000-0000-000000000001',
      timestamp: '2026-07-29T10:00:05.000Z',
      cwd: 'C:\\Users\\testuser\\Documents\\Software\\demo-project',
      sessionId: 'e2e-secret',
      version: '2.1.212',
      gitBranch: 'main',
    }),
    JSON.stringify({
      parentUuid: 'a2000000-0000-0000-0000-000000000001',
      isSidechain: false,
      promptId: 'p2000000-0000-0000-0000-000000000001',
      type: 'user',
      message: {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'toolu_e2e0000000000001', content: toolResultText }],
      },
      toolUseResult: { stdout: toolResultText, stderr: '', interrupted: false },
      uuid: 'u2000000-0000-0000-0000-000000000002',
      timestamp: '2026-07-29T10:00:10.000Z',
      cwd: 'C:\\Users\\testuser\\Documents\\Software\\demo-project',
      sessionId: 'e2e-secret',
      version: '2.1.212',
      gitBranch: 'main',
    }),
  ];
  return lines.join('\n') + '\n';
}

function writeFixtureProject() {
  const dir = path.join(tmpDir, 'proj-e2e');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 's1.jsonl'), buildFixtureSession(), 'utf8');
}

test('digest via real server redacts all 5 secret patterns by default', async () => {
  writeFixtureProject();
  const { url } = await boot({}); // redact defaults to true

  const res = await fetch(`${url}/api/session/proj-e2e/s1/digest`);
  expect(res.status).toBe(200);
  const digest = await res.json();
  const raw = JSON.stringify(digest);

  for (const [name, secret] of Object.entries(SECRETS)) {
    expect(raw, `${name} must not leak in redacted digest`).not.toContain(secret);
  }
  expect(raw).toContain('[REDACTED]');
});

test('digest via real server with startServer({ redact: false }) leaves all 5 secrets intact (opt-out)', async () => {
  writeFixtureProject();
  const { url } = await boot({ redact: false });

  const res = await fetch(`${url}/api/session/proj-e2e/s1/digest`);
  expect(res.status).toBe(200);
  const digest = await res.json();
  const raw = JSON.stringify(digest);

  for (const [name, secret] of Object.entries(SECRETS)) {
    expect(raw, `${name} must be present when redact is disabled`).toContain(secret);
  }
  expect(raw).not.toContain('[REDACTED]');
});
