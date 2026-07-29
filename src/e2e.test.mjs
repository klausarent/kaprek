// End-to-end smoke test: proves the whole chain works together against a
// real server, not just each module in isolation.
//
// open a session -> create a board task -> link the session to it -> fill
// the 7-field completion doc -> move to done -> sign a receipt -> verify it.
// Each step is a real HTTP call through startServer(); nothing here mocks
// board/store.mjs, receipt/receipt.mjs, or the routes in server.mjs.
import { test, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startServer } from './server/server.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_SESSION = path.join(__dirname, 'parser', 'fixtures', 'mini-session.jsonl');

const APP_HEADERS = { 'x-app-request': '1' };
const APP_JSON_HEADERS = { ...APP_HEADERS, 'Content-Type': 'application/json' };

let rootDir;
let dataDir;
let servers = [];

beforeEach(() => {
  rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-root-'));
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-data-'));
  servers = [];
});

afterEach(async () => {
  for (const { server } of servers) {
    await new Promise((resolve) => server.close(resolve));
  }
  fs.rmSync(rootDir, { recursive: true, force: true });
  fs.rmSync(dataDir, { recursive: true, force: true });
});

async function boot(opts) {
  const started = await startServer({ port: 0, rootDir, dataDir, ...opts });
  servers.push(started);
  return started;
}

function postJson(url, body) {
  return fetch(url, { method: 'POST', headers: APP_JSON_HEADERS, body: JSON.stringify(body) });
}

function patchJson(url, body) {
  return fetch(url, { method: 'PATCH', headers: APP_JSON_HEADERS, body: JSON.stringify(body) });
}

/** A doc with all 7 fields present and each >= 20 chars (see DOC_FIELD_MIN_LENGTH in board/store.mjs). */
function fullDoc() {
  return {
    trigger: 'A session needed to be closed out with a documented board task.',
    outcome: 'The full chain from session to signed, verified receipt works end to end.',
    approach: 'Drove every step through the real HTTP API of a real running server.',
    course: 'No detours: each call succeeded on the first try against the fixture.',
    verification: 'Ran this exact test via npx vitest run and read the assertions passing.',
    effort: 'Roughly twenty minutes to wire up the fixture and the request chain.',
    open: 'Nothing left open — this was the last task of phase 1.',
  };
}

test('session -> task -> link -> doc -> done -> receipt -> verify (valid)', async () => {
  const projectSlug = 'e2e-project';
  const projectDir = path.join(rootDir, projectSlug);
  fs.mkdirSync(projectDir, { recursive: true });
  fs.copyFileSync(FIXTURE_SESSION, path.join(projectDir, 'mini-session.jsonl'));

  const { url } = await boot({});

  // 1. Open the session: list projects/sessions, then load its digest.
  const projectsRes = await fetch(`${url}/api/projects`);
  expect(projectsRes.status).toBe(200);
  const projects = await projectsRes.json();
  expect(projects.some((p) => p.projectSlug === projectSlug)).toBe(true);

  const sessionsRes = await fetch(`${url}/api/sessions?project=${projectSlug}`);
  expect(sessionsRes.status).toBe(200);
  const sessions = await sessionsRes.json();
  expect(sessions.some((s) => s.sessionId === 'mini-session')).toBe(true);

  const digestRes = await fetch(`${url}/api/session/${projectSlug}/mini-session/digest`);
  expect(digestRes.status).toBe(200);

  // 2. Create a board task.
  const createRes = await postJson(`${url}/api/board/tasks`, { title: 'Close out the e2e fixture session', project: projectSlug });
  expect(createRes.status).toBe(201);
  const task = await createRes.json();
  expect(task.status).toBe('backlog');

  // 3. Link the session to the task.
  const linkRes = await patchJson(`${url}/api/board/tasks/${task.id}`, {
    op: 'linkSession',
    session: { machine: 'test-machine', projectSlug, sessionId: 'mini-session' },
  });
  expect(linkRes.status).toBe(200);
  const linkedTask = await linkRes.json();
  expect(linkedTask.sessions).toEqual([{ machine: 'test-machine', projectSlug, sessionId: 'mini-session' }]);

  // 4. Fill the 7-field completion doc.
  const docRes = await patchJson(`${url}/api/board/tasks/${task.id}`, { op: 'setDoc', doc: fullDoc() });
  expect(docRes.status).toBe(200);

  // 5. Move to done — only possible because the doc is complete.
  const doneRes = await postJson(`${url}/api/board/tasks/${task.id}/status`, { status: 'done' });
  expect(doneRes.status).toBe(200);
  const doneTask = await doneRes.json();
  expect(doneTask.status).toBe('done');

  // 6. Sign a receipt.
  const receiptRes = await postJson(`${url}/api/board/tasks/${task.id}/receipt`, { agentName: 'e2e-test-agent' });
  expect(receiptRes.status).toBe(201);
  const { receipt } = await receiptRes.json();
  expect(receipt.alg).toBe('ed25519');
  expect(receipt.agent).toBe('e2e-test-agent');

  // 7. Verify it — must come back valid against the task's current state.
  const verifyRes = await fetch(`${url}/api/board/tasks/${task.id}/receipt/verify`);
  expect(verifyRes.status).toBe(200);
  const verifyResult = await verifyRes.json();
  expect(verifyResult).toEqual({ valid: true });
});
