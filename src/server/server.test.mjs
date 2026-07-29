// Tests for the local HTTP API server. Run: npx vitest run src/server
//
// Exercises a real server on an ephemeral port (127.0.0.1) via the Node
// built-in fetch — no external network involved, no mocks for node:http.
import { test, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { startServer } from './server.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SECRET_FIXTURE = path.join(__dirname, 'fixtures', 'session-with-secret.jsonl');

const APP_HEADERS = { 'x-app-request': '1' };
const APP_JSON_HEADERS = { ...APP_HEADERS, 'Content-Type': 'application/json' };

let tmpDir;
let dataDir;
let servers = [];

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'server-test-'));
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'server-test-data-'));
  servers = [];
});

afterEach(async () => {
  for (const { server } of servers) {
    await new Promise((resolve) => server.close(resolve));
  }
  fs.rmSync(tmpDir, { recursive: true, force: true });
  fs.rmSync(dataDir, { recursive: true, force: true });
});

/** Starts a server for this test and registers it for teardown. Always uses
 * a per-test temp dataDir — never the real ~/.loryme app dir. */
async function boot(opts) {
  const started = await startServer({ port: 0, rootDir: tmpDir, dataDir, ...opts });
  servers.push(started);
  return started;
}

/** Writes a project dir with the given session files ({ sessionId: content }). */
function writeProject(projectSlug, sessions) {
  const dir = path.join(tmpDir, projectSlug);
  fs.mkdirSync(dir, { recursive: true });
  for (const [sessionId, content] of Object.entries(sessions)) {
    fs.writeFileSync(path.join(dir, `${sessionId}.jsonl`), content, 'utf8');
  }
  return dir;
}

function aiTitleLine(title) {
  return JSON.stringify({ type: 'ai-title', aiTitle: title, sessionId: 'x' }) + '\n';
}

function postJson(url, body, headers = APP_JSON_HEADERS) {
  return fetch(url, { method: 'POST', headers, body: JSON.stringify(body) });
}

function patchJson(url, body, headers = APP_JSON_HEADERS) {
  return fetch(url, { method: 'PATCH', headers, body: JSON.stringify(body) });
}

/** A doc with all 7 fields present and each >= 20 chars (see DOC_FIELD_MIN_LENGTH in board/store.mjs). */
function fullDoc() {
  return {
    trigger: 'Something prompted this task to begin in the first place.',
    outcome: 'The board API and UI shipped exactly as scoped.',
    approach: 'Followed the existing server.mjs handler style closely.',
    course: 'No major detours were needed along the way this time.',
    verification: 'Ran the full server test suite and it stayed green.',
    effort: 'About two hours end to end, including tests.',
    open: 'No open items remain for this task right now.',
  };
}

/**
 * Sends a raw GET with a caller-controlled Host header. fetch() refuses to
 * let callers set the Host header at all (it's a forbidden header name per
 * the Fetch spec), so Host-header validation can only be exercised via
 * node:http directly.
 */
function rawGet(baseUrl, pathName, headers) {
  return new Promise((resolve, reject) => {
    const target = new URL(baseUrl);
    const req = http.request(
      { hostname: target.hostname, port: target.port, path: pathName, method: 'GET', headers },
      (res) => {
        res.resume();
        res.on('end', () => resolve(res.statusCode));
      },
    );
    req.on('error', reject);
    req.end();
  });
}

test('binds to 127.0.0.1 only, never a wildcard/public address', async () => {
  const { server } = await boot({});
  const addr = server.address();
  expect(addr.address).toBe('127.0.0.1');
});

test('DNS-rebinding hardening: a non-local Host header is rejected with 400', async () => {
  const { url } = await boot({});
  const status = await rawGet(url, '/api/projects', { Host: 'evil.example.com' });
  expect(status).toBe(400);
});

test('DNS-rebinding hardening: the correct 127.0.0.1:<port> Host header is accepted', async () => {
  const { url, server } = await boot({});
  const port = server.address().port;
  const status = await rawGet(url, '/api/projects', { Host: `127.0.0.1:${port}` });
  expect(status).toBe(200);
});

test('DNS-rebinding hardening: the correct localhost:<port> Host header is accepted too', async () => {
  const { url, server } = await boot({});
  const port = server.address().port;
  const status = await rawGet(url, '/api/projects', { Host: `localhost:${port}` });
  expect(status).toBe(200);
});

test('GET /api/projects lists project slugs as JSON', async () => {
  writeProject('proj-a', { s1: aiTitleLine('S1') });
  writeProject('proj-b', { s2: aiTitleLine('S2'), s3: aiTitleLine('S3') });
  const { url } = await boot({});

  const res = await fetch(`${url}/api/projects`);
  expect(res.status).toBe(200);
  expect(res.headers.get('content-type')).toContain('application/json');
  const body = await res.json();
  const bySlug = Object.fromEntries(body.map((p) => [p.projectSlug, p.sessionCount]));
  expect(bySlug['proj-a']).toBe(1);
  expect(bySlug['proj-b']).toBe(2);
});

test('GET /api/sessions?project=<slug> lists sessions with meta for that project', async () => {
  writeProject('proj-a', { s1: aiTitleLine('Erste Session') });
  const { url } = await boot({});

  const res = await fetch(`${url}/api/sessions?project=proj-a`);
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.length).toBe(1);
  expect(body[0].sessionId).toBe('s1');
  expect(body[0].title).toBe('Erste Session');
  expect(typeof body[0].sizeBytes).toBe('number');
});

test('GET /api/sessions?project=<slug> sorts sessions by mtime, most recent first', async () => {
  const dir = writeProject('proj-a', { older: aiTitleLine('Older'), newer: aiTitleLine('Newer') });
  const older = new Date('2026-01-01T00:00:00Z');
  const newer = new Date('2026-06-01T00:00:00Z');
  fs.utimesSync(path.join(dir, 'older.jsonl'), older, older);
  fs.utimesSync(path.join(dir, 'newer.jsonl'), newer, newer);
  const { url } = await boot({});

  const res = await fetch(`${url}/api/sessions?project=proj-a`);
  const body = await res.json();
  expect(body.map((s) => s.sessionId)).toEqual(['newer', 'older']);
});

test('GET /api/projects sorts projects by their most recent session mtime, newest first', async () => {
  const dirOld = writeProject('proj-old', { s1: aiTitleLine('S1') });
  const dirNew = writeProject('proj-new', { s1: aiTitleLine('S1') });
  const older = new Date('2026-01-01T00:00:00Z');
  const newer = new Date('2026-06-01T00:00:00Z');
  fs.utimesSync(path.join(dirOld, 's1.jsonl'), older, older);
  fs.utimesSync(path.join(dirNew, 's1.jsonl'), newer, newer);
  const { url } = await boot({});

  const res = await fetch(`${url}/api/projects`);
  const body = await res.json();
  expect(body.map((p) => p.projectSlug)).toEqual(['proj-new', 'proj-old']);
});

test('GET /api/sessions with unknown project returns 404', async () => {
  const { url } = await boot({});
  const res = await fetch(`${url}/api/sessions?project=does-not-exist`);
  expect(res.status).toBe(404);
});

test('digest route redacts secrets by default', async () => {
  writeProject('proj-secret', { s1: fs.readFileSync(SECRET_FIXTURE, 'utf8') });
  const { url } = await boot({}); // redact defaults to true

  const res = await fetch(`${url}/api/session/proj-secret/s1/digest`);
  expect(res.status).toBe(200);
  const digest = await res.json();
  const toolEvent = digest.events.find((e) => e.kind === 'tool');
  expect(toolEvent.result).toContain('[REDACTED]');
  expect(toolEvent.result).not.toContain('sk-test0000000000000000AAAA');
});

test('digest route leaves secrets intact when startServer({ redact: false })', async () => {
  writeProject('proj-secret', { s1: fs.readFileSync(SECRET_FIXTURE, 'utf8') });
  const { url } = await boot({ redact: false });

  const res = await fetch(`${url}/api/session/proj-secret/s1/digest`);
  expect(res.status).toBe(200);
  const digest = await res.json();
  const toolEvent = digest.events.find((e) => e.kind === 'tool');
  expect(toolEvent.result).toContain('sk-test0000000000000000AAAA');
  expect(toolEvent.result).not.toContain('[REDACTED]');
});

test('digest route on unknown session returns 404', async () => {
  writeProject('proj-a', { s1: aiTitleLine('S1') });
  const { url } = await boot({});
  const res = await fetch(`${url}/api/session/proj-a/does-not-exist/digest`);
  expect(res.status).toBe(404);
});

test('path traversal in slug or sessionId is rejected with 400, not resolved against disk', async () => {
  writeProject('proj-a', { s1: aiTitleLine('S1') });
  const { url } = await boot({});

  // A pure '..' path segment (or its %2e%2e encoding) is already collapsed
  // by the URL parser itself before the request ever reaches our routing —
  // that is a safe outcome (falls through to 404), but it means it does not
  // exercise our own guard. 'id..name' contains '..' without being an exact
  // dot-segment, so it survives URL normalization unchanged and must be
  // caught by our own isSafeId() check instead.
  const traversalSlug = await fetch(`${url}/api/session/sneaky..name/s1/digest`);
  expect(traversalSlug.status).toBe(400);

  const traversalSession = await fetch(`${url}/api/session/proj-a/sneaky..name/digest`);
  expect(traversalSession.status).toBe(400);

  // Query-string values are never touched by URL path dot-segment removal,
  // so a literal '..' reaches our handler unchanged and must be rejected.
  const traversalSessionsQuery = await fetch(`${url}/api/sessions?project=..`);
  expect(traversalSessionsQuery.status).toBe(400);

  // A backslash-embedded segment ('a\..\secrets') is not a pure dot-segment
  // either (Windows separator, not a URL separator) and must also be caught.
  const traversalBackslash = await fetch(`${url}/api/session/proj-a/a%5c..%5csecrets/digest`);
  expect(traversalBackslash.status).toBe(400);

  // A pure '..' segment: the URL parser collapses it before routing, so the
  // request never resolves to anything traversal-relevant — confirm this
  // safe (non-crashing, non-200) fallback explicitly too.
  const collapsedByUrlParser = await fetch(`${url}/api/session/%2e%2e/s1/digest`);
  expect(collapsedByUrlParser.status).not.toBe(200);
});

test('digest LRU cache holds at most 20 entries, evicting the oldest first', async () => {
  const dir = writeProject('proj-lru', { 'session-a': aiTitleLine('Original A') });
  const { url } = await boot({});

  // First fetch populates the cache for session-a.
  const first = await (await fetch(`${url}/api/session/proj-lru/session-a/digest`)).json();
  expect(first.meta.title).toBe('Original A');

  // Change the file on disk; while cached, the server must keep serving the
  // stale (cached) title rather than re-reading the file every time.
  fs.writeFileSync(path.join(dir, 'session-a.jsonl'), aiTitleLine('Changed A'), 'utf8');
  const stillCached = await (await fetch(`${url}/api/session/proj-lru/session-a/digest`)).json();
  expect(stillCached.meta.title).toBe('Original A');

  // Fill the cache with 20 more distinct sessions so session-a (the oldest
  // entry, not re-touched since the cache hit above) gets evicted.
  for (let i = 0; i < 20; i += 1) {
    const sessionId = `session-b${i}`;
    fs.writeFileSync(path.join(dir, `${sessionId}.jsonl`), aiTitleLine(`B${i}`), 'utf8');
    const digest = await (await fetch(`${url}/api/session/proj-lru/${sessionId}/digest`)).json();
    expect(digest.meta.title).toBe(`B${i}`);
  }

  // session-a should now be evicted, so this re-reads the (changed) file.
  const afterEviction = await (await fetch(`${url}/api/session/proj-lru/session-a/digest`)).json();
  expect(afterEviction.meta.title).toBe('Changed A');
});

test('SPA fallback serves a plain status page at / when no webDist is configured', async () => {
  const { url } = await boot({});
  const res = await fetch(`${url}/`);
  expect(res.status).toBe(200);
  expect(res.headers.get('content-type')).toContain('text/plain');
  const text = await res.text();
  expect(text).toContain('loryme');
});

test('SPA fallback serves index.html for unknown non-API routes when webDist is configured', async () => {
  const webDist = fs.mkdtempSync(path.join(os.tmpdir(), 'server-test-webdist-'));
  fs.writeFileSync(path.join(webDist, 'index.html'), '<!doctype html><title>loryme</title>', 'utf8');
  const { url } = await boot({ webDist });

  const res = await fetch(`${url}/some/deep/client/route`);
  expect(res.status).toBe(200);
  expect(res.headers.get('content-type')).toContain('text/html');
  const text = await res.text();
  expect(text).toContain('loryme');

  fs.rmSync(webDist, { recursive: true, force: true });
});

test('GET /api/search with no q returns 400', async () => {
  const { url } = await boot({});
  const res = await fetch(`${url}/api/search`);
  expect(res.status).toBe(400);
});

test('GET /api/search with blank q returns 400', async () => {
  const { url } = await boot({});
  const res = await fetch(`${url}/api/search?q=%20%20`);
  expect(res.status).toBe(400);
});

test('GET /api/search before any index exists returns available:true with no results', async () => {
  writeProject('proj-a', { s1: aiTitleLine('Digest Parser Fixture') });
  const { url } = await boot({});
  const res = await fetch(`${url}/api/search?q=parser`);
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.available).toBe(true);
  expect(body.results).toEqual([]);
});

test('POST /api/search/reindex builds the index, then GET /api/search finds matches', async () => {
  writeProject('proj-a', { s1: aiTitleLine('Digest Parser Fixture') });
  const { url } = await boot({});

  const reindexRes = await fetch(`${url}/api/search/reindex`, { method: 'POST', headers: APP_HEADERS });
  expect(reindexRes.status).toBe(200);
  const reindexBody = await reindexRes.json();
  expect(reindexBody.available).toBe(true);
  expect(reindexBody.indexed).toBe(1);
  expect(reindexBody.skipped).toBe(0);

  const searchRes = await fetch(`${url}/api/search?q=parser`);
  const searchBody = await searchRes.json();
  expect(searchBody.available).toBe(true);
  expect(searchBody.results.length).toBe(1);
  expect(searchBody.results[0].sessionId).toBe('s1');
  expect(searchBody.results[0].projectSlug).toBe('proj-a');
});

test('POST /api/search/reindex is idempotent: a second call re-skips unchanged sessions', async () => {
  writeProject('proj-a', { s1: aiTitleLine('Digest Parser Fixture') });
  const { url } = await boot({});

  await fetch(`${url}/api/search/reindex`, { method: 'POST', headers: APP_HEADERS });
  const second = await (await fetch(`${url}/api/search/reindex`, { method: 'POST', headers: APP_HEADERS })).json();
  expect(second.indexed).toBe(0);
  expect(second.skipped).toBe(1);
});

test('GET /api/search/reindex (wrong method) returns 405', async () => {
  const { url } = await boot({});
  const res = await fetch(`${url}/api/search/reindex`);
  expect(res.status).toBe(405);
});

test('POST /api/search (wrong method) returns 405, once the CSRF app header is present', async () => {
  const { url } = await boot({});
  const res = await fetch(`${url}/api/search?q=x`, { method: 'POST', headers: APP_HEADERS });
  expect(res.status).toBe(405);
});

test('search routes report available:false when sqlite is unavailable, via importSqlite injection', async () => {
  const failingImport = () => Promise.reject(new Error('no sqlite here'));
  const { url } = await boot({ importSqlite: failingImport });

  const searchRes = await fetch(`${url}/api/search?q=anything`);
  expect(searchRes.status).toBe(200);
  const searchBody = await searchRes.json();
  expect(searchBody).toEqual({ available: false, reason: 'no sqlite here' });

  const reindexRes = await fetch(`${url}/api/search/reindex`, { method: 'POST', headers: APP_HEADERS });
  expect(reindexRes.status).toBe(200);
  const reindexBody = await reindexRes.json();
  expect(reindexBody).toEqual({ available: false, reason: 'no sqlite here' });
});

// --- CSRF hardening (custom app header) ---------------------------------

test('CSRF hardening: POST /api/search/reindex without x-app-request header is rejected with 403', async () => {
  const { url } = await boot({});
  const res = await fetch(`${url}/api/search/reindex`, { method: 'POST' });
  expect(res.status).toBe(403);
  const body = await res.json();
  expect(body.error).toBe('missing app header');
});

test('CSRF hardening: POST /api/board/tasks without x-app-request header is rejected with 403', async () => {
  const { url } = await boot({});
  const res = await fetch(`${url}/api/board/tasks`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: 'X' }),
  });
  expect(res.status).toBe(403);
});

test('CSRF hardening: with the x-app-request header present, writes go through normally', async () => {
  const { url } = await boot({});
  const res = await postJson(`${url}/api/board/tasks`, { title: 'X' });
  expect(res.status).toBe(201);
});

test('regression: POST /api/projects (GET-only route) still returns 405, not 403, once the app header is present', async () => {
  const { url } = await boot({});
  const res = await fetch(`${url}/api/projects`, { method: 'POST', headers: APP_HEADERS });
  expect(res.status).toBe(405);
});

test('regression: POST /api/sessions (GET-only route) still returns 405, not 403, once the app header is present', async () => {
  const { url } = await boot({});
  const res = await fetch(`${url}/api/sessions`, { method: 'POST', headers: APP_HEADERS });
  expect(res.status).toBe(405);
});

// --- Board API ------------------------------------------------------------

test('board: full CRUD cycle — create, list/filter, update, doc, status, session link', async () => {
  const { url } = await boot({});

  const createRes = await postJson(`${url}/api/board/tasks`, { title: 'Ship the board UI', project: 'loryme', tags: ['p1'] });
  expect(createRes.status).toBe(201);
  const task = await createRes.json();
  expect(task.title).toBe('Ship the board UI');
  expect(task.project).toBe('loryme');
  expect(task.tags).toEqual(['p1']);
  expect(task.status).toBe('backlog');

  const listRes = await fetch(`${url}/api/board/tasks`);
  expect(listRes.status).toBe(200);
  const listBody = await listRes.json();
  expect(listBody.tasks.map((t) => t.id)).toContain(task.id);

  const filteredRes = await fetch(`${url}/api/board/tasks?status=backlog&project=loryme`);
  const filteredBody = await filteredRes.json();
  expect(filteredBody.tasks.map((t) => t.id)).toContain(task.id);

  const emptyFilterRes = await fetch(`${url}/api/board/tasks?status=done`);
  const emptyFilterBody = await emptyFilterRes.json();
  expect(emptyFilterBody.tasks.map((t) => t.id)).not.toContain(task.id);

  const updateRes = await patchJson(`${url}/api/board/tasks/${task.id}`, {
    op: 'update',
    patch: { title: 'Ship the board UI (v2)' },
  });
  expect(updateRes.status).toBe(200);
  const updated = await updateRes.json();
  expect(updated.title).toBe('Ship the board UI (v2)');

  const docPartialRes = await patchJson(`${url}/api/board/tasks/${task.id}`, { op: 'setDoc', doc: { trigger: 'A teammate asked for a board.' } });
  expect(docPartialRes.status).toBe(200);
  const docPartial = await docPartialRes.json();
  expect(docPartial.doc.trigger).toBe('A teammate asked for a board.');

  const statusRes = await postJson(`${url}/api/board/tasks/${task.id}/status`, { status: 'in_progress' });
  expect(statusRes.status).toBe(200);
  expect((await statusRes.json()).status).toBe('in_progress');

  const linkRes = await patchJson(`${url}/api/board/tasks/${task.id}`, {
    op: 'linkSession',
    session: { projectSlug: 'loryme', sessionId: 's1', machine: 'desktop' },
  });
  expect(linkRes.status).toBe(200);
  const linked = await linkRes.json();
  expect(linked.sessions).toEqual([{ projectSlug: 'loryme', sessionId: 's1', machine: 'desktop' }]);

  const docFullRes = await patchJson(`${url}/api/board/tasks/${task.id}`, { op: 'setDoc', doc: fullDoc() });
  expect(docFullRes.status).toBe(200);

  const doneRes = await postJson(`${url}/api/board/tasks/${task.id}/status`, { status: 'done' });
  expect(doneRes.status).toBe(200);
  expect((await doneRes.json()).status).toBe('done');
});

test('board: moving to done without a complete doc returns 409 with the missing field list', async () => {
  const { url } = await boot({});
  const task = await (await postJson(`${url}/api/board/tasks`, { title: 'Incomplete' })).json();

  const res = await postJson(`${url}/api/board/tasks/${task.id}/status`, { status: 'done' });
  expect(res.status).toBe(409);
  const body = await res.json();
  expect(body.missing).toEqual(['trigger', 'outcome', 'approach', 'course', 'verification', 'effort', 'open']);
});

test('board: unknown (but well-formed) task id returns 404', async () => {
  const { url } = await boot({});
  const res = await patchJson(`${url}/api/board/tasks/00000000-0000-0000-0000-000000000000`, { op: 'update', patch: { title: 'X' } });
  expect(res.status).toBe(404);
});

test('board: malformed task id (not a UUID) is rejected with 400, not resolved against the store', async () => {
  const { url } = await boot({});
  // 'sneaky..name' contains '..' without being a pure dot-segment, so it
  // survives URL path normalization unchanged (see the equivalent session-id
  // traversal test above) and must be caught by isValidTaskId() instead.
  const res = await patchJson(`${url}/api/board/tasks/sneaky..name`, { op: 'update', patch: { title: 'X' } });
  expect(res.status).toBe(400);

  const statusRes = await postJson(`${url}/api/board/tasks/not-a-uuid/status`, { status: 'done' });
  expect(statusRes.status).toBe(400);
});

test('board: unknown op on PATCH returns 400', async () => {
  const { url } = await boot({});
  const task = await (await postJson(`${url}/api/board/tasks`, { title: 'X' })).json();
  const res = await patchJson(`${url}/api/board/tasks/${task.id}`, { op: 'bogus' });
  expect(res.status).toBe(400);
});

test('board: unknown doc field returns 400 with the offending field name', async () => {
  const { url } = await boot({});
  const task = await (await postJson(`${url}/api/board/tasks`, { title: 'X' })).json();
  const res = await patchJson(`${url}/api/board/tasks/${task.id}`, { op: 'setDoc', doc: { notAField: 'x' } });
  expect(res.status).toBe(400);
  const body = await res.json();
  expect(body.field).toBe('notAField');
});

test('board: creating a task with an empty title returns 400', async () => {
  const { url } = await boot({});
  const res = await postJson(`${url}/api/board/tasks`, { title: '' });
  expect(res.status).toBe(400);
});

test('board: PUT /api/board/tasks/<id> (wrong method) returns 405', async () => {
  const { url } = await boot({});
  const task = await (await postJson(`${url}/api/board/tasks`, { title: 'X' })).json();
  const res = await fetch(`${url}/api/board/tasks/${task.id}`, { method: 'PUT', headers: APP_JSON_HEADERS, body: '{}' });
  expect(res.status).toBe(405);
});

test('board: PUT /api/board/tasks (wrong method) returns 405', async () => {
  const { url } = await boot({});
  const res = await fetch(`${url}/api/board/tasks`, { method: 'PUT', headers: APP_JSON_HEADERS, body: '{}' });
  expect(res.status).toBe(405);
});

test('board: a non-JSON content type is rejected with 400', async () => {
  const { url } = await boot({});
  const res = await fetch(`${url}/api/board/tasks`, {
    method: 'POST',
    headers: { ...APP_HEADERS, 'Content-Type': 'text/plain' },
    body: 'title=X',
  });
  expect(res.status).toBe(400);
});

test('board: invalid JSON body is rejected with 400', async () => {
  const { url } = await boot({});
  const res = await fetch(`${url}/api/board/tasks`, {
    method: 'POST',
    headers: APP_JSON_HEADERS,
    body: '{not json',
  });
  expect(res.status).toBe(400);
});

// --- Board receipts --------------------------------------------------------

test('board receipt: full cycle — doc, done, sign, verify ok, edit doc, verify invalid', async () => {
  const { url } = await boot({});
  const task = await (await postJson(`${url}/api/board/tasks`, { title: 'Receipt me' })).json();

  await patchJson(`${url}/api/board/tasks/${task.id}`, { op: 'setDoc', doc: fullDoc() });
  await postJson(`${url}/api/board/tasks/${task.id}/status`, { status: 'in_progress' });
  await postJson(`${url}/api/board/tasks/${task.id}/status`, { status: 'done' });

  const signRes = await postJson(`${url}/api/board/tasks/${task.id}/receipt`, { agentName: 'claude-fable-5' });
  expect(signRes.status).toBe(201);
  const { receipt } = await signRes.json();
  expect(receipt.agent).toBe('claude-fable-5');
  expect(receipt.alg).toBe('ed25519');

  const verifyOkRes = await fetch(`${url}/api/board/tasks/${task.id}/receipt/verify`);
  expect(verifyOkRes.status).toBe(200);
  expect(await verifyOkRes.json()).toEqual({ valid: true });

  // Editing the doc changes the payload the receipt sealed, so verification
  // must now fail — the receipt is a snapshot claim, not a standing approval.
  await patchJson(`${url}/api/board/tasks/${task.id}`, { op: 'setDoc', doc: { outcome: 'Changed after signing, on purpose.' } });
  const verifyStaleRes = await fetch(`${url}/api/board/tasks/${task.id}/receipt/verify`);
  expect(verifyStaleRes.status).toBe(200);
  const staleBody = await verifyStaleRes.json();
  expect(staleBody.valid).toBe(false);
  expect(staleBody.reason).toBe('payload hash mismatch');
});

test('board receipt: POST without agentName defaults to "local"', async () => {
  const { url } = await boot({});
  const task = await (await postJson(`${url}/api/board/tasks`, { title: 'X' })).json();
  await patchJson(`${url}/api/board/tasks/${task.id}`, { op: 'setDoc', doc: fullDoc() });
  await postJson(`${url}/api/board/tasks/${task.id}/status`, { status: 'in_progress' });
  await postJson(`${url}/api/board/tasks/${task.id}/status`, { status: 'done' });

  const res = await postJson(`${url}/api/board/tasks/${task.id}/receipt`, {});
  expect(res.status).toBe(201);
  expect((await res.json()).receipt.agent).toBe('local');
});

test('board receipt: signing a task with no doc at all returns 409', async () => {
  const { url } = await boot({});
  const task = await (await postJson(`${url}/api/board/tasks`, { title: 'No doc yet' })).json();

  const res = await postJson(`${url}/api/board/tasks/${task.id}/receipt`, {});
  expect(res.status).toBe(409);
});

test('board receipt: signing a backlog task with a complete doc still returns 409 (status gate, not just doc gate)', async () => {
  const { url } = await boot({});
  const task = await (await postJson(`${url}/api/board/tasks`, { title: 'Not done yet' })).json();
  await patchJson(`${url}/api/board/tasks/${task.id}`, { op: 'setDoc', doc: fullDoc() });

  const res = await postJson(`${url}/api/board/tasks/${task.id}/receipt`, {});
  expect(res.status).toBe(409);
  const body = await res.json();
  expect(body.error).toContain('backlog');
});

test('board receipt: a done task whose doc was later shortened below the threshold returns 409 with the missing field', async () => {
  const { url } = await boot({});
  const task = await (await postJson(`${url}/api/board/tasks`, { title: 'Shortened after done' })).json();
  await patchJson(`${url}/api/board/tasks/${task.id}`, { op: 'setDoc', doc: fullDoc() });
  await postJson(`${url}/api/board/tasks/${task.id}/status`, { status: 'in_progress' });
  await postJson(`${url}/api/board/tasks/${task.id}/status`, { status: 'done' });

  // setDoc doesn't re-validate completeness — only the status transition
  // does — so this is a legitimate way to end up with an incomplete doc on
  // an already-'done' task.
  await patchJson(`${url}/api/board/tasks/${task.id}`, { op: 'setDoc', doc: { outcome: 'too short' } });

  const res = await postJson(`${url}/api/board/tasks/${task.id}/receipt`, {});
  expect(res.status).toBe(409);
  const body = await res.json();
  expect(body.missing).toContain('outcome');
});

test('board receipt: verifying a task with no receipt returns 404', async () => {
  const { url } = await boot({});
  const task = await (await postJson(`${url}/api/board/tasks`, { title: 'X' })).json();

  const res = await fetch(`${url}/api/board/tasks/${task.id}/receipt/verify`);
  expect(res.status).toBe(404);
});

test('board receipt: unknown task id returns 404 for both sign and verify', async () => {
  const { url } = await boot({});
  const unknownId = '00000000-0000-0000-0000-000000000000';

  const signRes = await postJson(`${url}/api/board/tasks/${unknownId}/receipt`, {});
  expect(signRes.status).toBe(404);

  const verifyRes = await fetch(`${url}/api/board/tasks/${unknownId}/receipt/verify`);
  expect(verifyRes.status).toBe(404);
});

test('CSRF hardening: POST /api/board/tasks/<id>/receipt without x-app-request header is rejected with 403', async () => {
  const { url } = await boot({});
  const task = await (await postJson(`${url}/api/board/tasks`, { title: 'X' })).json();
  await patchJson(`${url}/api/board/tasks/${task.id}`, { op: 'setDoc', doc: fullDoc() });

  const res = await fetch(`${url}/api/board/tasks/${task.id}/receipt`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{}',
  });
  expect(res.status).toBe(403);
});

test('board: a body over the 256 KB limit is rejected with 413', async () => {
  const { url } = await boot({});
  const bigTitle = 'x'.repeat(300 * 1024);
  const res = await postJson(`${url}/api/board/tasks`, { title: bigTitle });
  expect(res.status).toBe(413);
});
