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
import { createFakeHarness } from '../harness/fake.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SECRET_FIXTURE = path.join(__dirname, 'fixtures', 'session-with-secret.jsonl');

const APP_HEADERS = { 'x-app-request': '1' };
const APP_JSON_HEADERS = { ...APP_HEADERS, 'Content-Type': 'application/json' };

let tmpDir;
let dataDir;
let tmpRootDir;
let servers = [];

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'server-test-'));
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'server-test-data-'));
  // A dedicated, empty scratchpad root — startServer()'s tmpRoot default is
  // the REAL os.tmpdir()/claude, which must never be touched by a test.
  tmpRootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'server-test-tmproot-'));
  servers = [];
});

afterEach(async () => {
  for (const { server } of servers) {
    await new Promise((resolve) => server.close(resolve));
  }
  fs.rmSync(tmpDir, { recursive: true, force: true });
  fs.rmSync(dataDir, { recursive: true, force: true });
  fs.rmSync(tmpRootDir, { recursive: true, force: true });
});

/** Starts a server for this test and registers it for teardown. Always uses
 * a per-test temp dataDir/tmpRoot — never the real ~/.kaprek app dir or
 * os.tmpdir()/claude. */
async function boot(opts) {
  const started = await startServer({ port: 0, rootDir: tmpDir, dataDir, tmpRoot: tmpRootDir, ...opts });
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

test('digest cache serves a fresh digest immediately once the underlying file changes (mtime/size bust the cache key)', async () => {
  const dir = writeProject('proj-fresh', { s1: aiTitleLine('Original') });
  const { url } = await boot({});

  const first = await (await fetch(`${url}/api/session/proj-fresh/s1/digest`)).json();
  expect(first.meta.title).toBe('Original');

  // Same cache key, unchanged file: still cached, still 'Original' — trivially
  // true either way, but establishes the baseline before the file changes.
  const stillOriginal = await (await fetch(`${url}/api/session/proj-fresh/s1/digest`)).json();
  expect(stillOriginal.meta.title).toBe('Original');

  // Change the file's content AND its mtime — this must produce a different
  // cache key, so the server must NOT keep serving the stale cached title.
  await new Promise((resolve) => setTimeout(resolve, 10));
  fs.writeFileSync(path.join(dir, 's1.jsonl'), aiTitleLine('Changed'), 'utf8');
  const future = new Date(Date.now() + 5000);
  fs.utimesSync(path.join(dir, 's1.jsonl'), future, future);

  const afterChange = await (await fetch(`${url}/api/session/proj-fresh/s1/digest`)).json();
  expect(afterChange.meta.title).toBe('Changed');
});

test('digest LRU cache holds at most 20 entries without erroring across many distinct sessions', async () => {
  const dir = writeProject('proj-lru', { 'session-a': aiTitleLine('Original A') });
  const { url } = await boot({});

  const first = await (await fetch(`${url}/api/session/proj-lru/session-a/digest`)).json();
  expect(first.meta.title).toBe('Original A');

  // Fill the cache with 20 more distinct sessions, well past DIGEST_CACHE_SIZE
  // (20) — each fetch must still return the correct digest for its own
  // session, proving eviction of older entries never corrupts or drops a
  // still-relevant cache entry for a different key.
  for (let i = 0; i < 20; i += 1) {
    const sessionId = `session-b${i}`;
    fs.writeFileSync(path.join(dir, `${sessionId}.jsonl`), aiTitleLine(`B${i}`), 'utf8');
    const digest = await (await fetch(`${url}/api/session/proj-lru/${sessionId}/digest`)).json();
    expect(digest.meta.title).toBe(`B${i}`);
  }

  // session-a's entry may or may not have been evicted by now — either way,
  // re-fetching it must still return the correct (unchanged) digest.
  const afterMany = await (await fetch(`${url}/api/session/proj-lru/session-a/digest`)).json();
  expect(afterMany.meta.title).toBe('Original A');
});

test('SPA fallback serves a plain status page at / when no webDist is configured', async () => {
  const { url } = await boot({});
  const res = await fetch(`${url}/`);
  expect(res.status).toBe(200);
  expect(res.headers.get('content-type')).toContain('text/plain');
  const text = await res.text();
  expect(text).toContain('kaprek');
});

test('SPA fallback serves index.html for unknown non-API routes when webDist is configured', async () => {
  const webDist = fs.mkdtempSync(path.join(os.tmpdir(), 'server-test-webdist-'));
  fs.writeFileSync(path.join(webDist, 'index.html'), '<!doctype html><title>kaprek</title>', 'utf8');
  const { url } = await boot({ webDist });

  const res = await fetch(`${url}/some/deep/client/route`);
  expect(res.status).toBe(200);
  expect(res.headers.get('content-type')).toContain('text/html');
  const text = await res.text();
  expect(text).toContain('kaprek');

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
  expect(reindexBody).toEqual({
    available: false,
    reason: 'no sqlite here',
    artifacts: { copied: 0, skipped: 0 },
  });
});

test('POST /api/search/reindex response includes an artifacts sweep summary', async () => {
  const { url } = await boot({});
  fs.mkdirSync(path.join(tmpRootDir, 'proj-a', 's1', 'scratchpad'), { recursive: true });
  fs.writeFileSync(path.join(tmpRootDir, 'proj-a', 's1', 'scratchpad', 'note.txt'), 'hi', 'utf8');

  const res = await fetch(`${url}/api/search/reindex`, { method: 'POST', headers: APP_HEADERS });
  const body = await res.json();
  expect(body.artifacts).toEqual({ copied: 1, skipped: 0 });
});

test('GET /api/session/<slug>/<id>/artifacts returns the preserved-artifact manifest, defaulting to { files: [] }', async () => {
  writeProject('proj-a', { s1: aiTitleLine('x') });
  const { url } = await boot({});

  const emptyRes = await fetch(`${url}/api/session/proj-a/s1/artifacts`);
  expect(emptyRes.status).toBe(200);
  expect(await emptyRes.json()).toEqual({ files: [] });

  fs.mkdirSync(path.join(tmpRootDir, 'proj-a', 's1', 'scratchpad'), { recursive: true });
  fs.writeFileSync(path.join(tmpRootDir, 'proj-a', 's1', 'scratchpad', 'note.txt'), 'hi', 'utf8');
  await fetch(`${url}/api/search/reindex`, { method: 'POST', headers: APP_HEADERS });

  const res = await fetch(`${url}/api/session/proj-a/s1/artifacts`);
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.files.length).toBe(1);
  expect(body.files[0].relPath).toBe('note.txt');
});

test('GET /api/session/<slug>/<id>/artifacts rejects an unsafe id with 400', async () => {
  const { url } = await boot({});
  const res = await fetch(`${url}/api/session/sneaky..name/s1/artifacts`);
  expect(res.status).toBe(400);
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

  const createRes = await postJson(`${url}/api/board/tasks`, { title: 'Ship the board UI', project: 'kaprek', tags: ['p1'] });
  expect(createRes.status).toBe(201);
  const task = await createRes.json();
  expect(task.title).toBe('Ship the board UI');
  expect(task.project).toBe('kaprek');
  expect(task.tags).toEqual(['p1']);
  expect(task.status).toBe('backlog');

  const listRes = await fetch(`${url}/api/board/tasks`);
  expect(listRes.status).toBe(200);
  const listBody = await listRes.json();
  expect(listBody.tasks.map((t) => t.id)).toContain(task.id);

  const filteredRes = await fetch(`${url}/api/board/tasks?status=backlog&project=kaprek`);
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
    session: { projectSlug: 'kaprek', sessionId: 's1', machine: 'desktop' },
  });
  expect(linkRes.status).toBe(200);
  const linked = await linkRes.json();
  expect(linked.sessions).toEqual([{ projectSlug: 'kaprek', sessionId: 's1', machine: 'desktop' }]);

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

test('board: setDoc on a done task that would break completeness is rejected with 409, doc stays intact', async () => {
  const { url } = await boot({});
  const task = await (await postJson(`${url}/api/board/tasks`, { title: 'Shortened after done' })).json();
  await patchJson(`${url}/api/board/tasks/${task.id}`, { op: 'setDoc', doc: fullDoc() });
  await postJson(`${url}/api/board/tasks/${task.id}/status`, { status: 'in_progress' });
  await postJson(`${url}/api/board/tasks/${task.id}/status`, { status: 'done' });

  // The done invariant now holds going forward too: setDoc on a 'done' task
  // is rejected outright if the resulting doc would no longer satisfy the
  // 7-field rule — it never gets a chance to become incomplete in the first place.
  const res = await patchJson(`${url}/api/board/tasks/${task.id}`, { op: 'setDoc', doc: { outcome: 'too short' } });
  expect(res.status).toBe(409);
  const body = await res.json();
  expect(body.missing).toContain('outcome');

  const listRes = await fetch(`${url}/api/board/tasks?status=done`);
  const listBody = await listRes.json();
  const stillDone = listBody.tasks.find((t) => t.id === task.id);
  expect(stillDone.doc.outcome).toBe(fullDoc().outcome);
});

test('board receipt: moving a signed task back to backlog invalidates its receipt (status is part of the signed payload)', async () => {
  const { url } = await boot({});
  const task = await (await postJson(`${url}/api/board/tasks`, { title: 'Rolled back after signing' })).json();
  await patchJson(`${url}/api/board/tasks/${task.id}`, { op: 'setDoc', doc: fullDoc() });
  await postJson(`${url}/api/board/tasks/${task.id}/status`, { status: 'in_progress' });
  await postJson(`${url}/api/board/tasks/${task.id}/status`, { status: 'done' });

  const signRes = await postJson(`${url}/api/board/tasks/${task.id}/receipt`, {});
  expect(signRes.status).toBe(201);

  const verifyOkRes = await fetch(`${url}/api/board/tasks/${task.id}/receipt/verify`);
  expect(await verifyOkRes.json()).toEqual({ valid: true });

  // Same doc, same sessions — only the status moves back. The receipt still
  // must not verify: it sealed a 'done' snapshot, and this task is no longer 'done'.
  await postJson(`${url}/api/board/tasks/${task.id}/status`, { status: 'backlog' });
  const verifyAfterRollbackRes = await fetch(`${url}/api/board/tasks/${task.id}/receipt/verify`);
  const rollbackBody = await verifyAfterRollbackRes.json();
  expect(rollbackBody.valid).toBe(false);
  expect(rollbackBody.reason).toBe('payload hash mismatch');
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

// --- Clickjacking hardening --------------------------------------------

test('clickjacking hardening: X-Frame-Options and a frame-ancestors CSP are set on every response, API and static alike', async () => {
  writeProject('proj-a', { s1: aiTitleLine('S1') });
  const { url } = await boot({});

  const rootRes = await fetch(`${url}/`);
  expect(rootRes.headers.get('x-frame-options')).toBe('DENY');
  expect(rootRes.headers.get('content-security-policy')).toContain("frame-ancestors 'none'");

  const apiRes = await fetch(`${url}/api/projects`);
  expect(apiRes.headers.get('x-frame-options')).toBe('DENY');
  expect(apiRes.headers.get('content-security-policy')).toContain("frame-ancestors 'none'");

  const notFoundRes = await fetch(`${url}/api/sessions?project=does-not-exist`);
  expect(notFoundRes.status).toBe(404);
  expect(notFoundRes.headers.get('x-frame-options')).toBe('DENY');
});

test('board: a body over the 256 KB limit is rejected with 413', async () => {
  const { url } = await boot({});
  const bigTitle = 'x'.repeat(300 * 1024);
  const res = await postJson(`${url}/api/board/tasks`, { title: bigTitle });
  expect(res.status).toBe(413);
});

// --- Chat API (SSE) ---------------------------------------------------------

/**
 * A harness like createFakeHarness(), but each scripted event is preceded
 * by a real-time delay, checking `signal` before and after each wait — used
 * to give the cancel test a window in which a second, concurrent request
 * can actually reach the server before the turn finishes on its own.
 */
function slowFakeHarness({ script, delayMs = 20 }) {
  return {
    async startTurn({ sessionId: requestedSessionId, onEvent, signal } = {}) {
      let sessionId = requestedSessionId ?? null;
      let costUsd = null;
      let usage = null;
      let isError = false;
      let sawResult = false;
      for (const event of script) {
        if (signal?.aborted) return { sessionId, costUsd, usage, stopReason: 'aborted', error: null };
        await new Promise((resolve) => setTimeout(resolve, delayMs));
        if (signal?.aborted) return { sessionId, costUsd, usage, stopReason: 'aborted', error: null };
        onEvent?.(event);
        if (event.type === 'result') {
          sawResult = true;
          if (event.sessionId) sessionId = event.sessionId;
          costUsd = event.costUsd ?? null;
          usage = event.usage ?? null;
          isError = !!event.isError;
        }
      }
      if (!sawResult) return { sessionId, costUsd, usage, stopReason: 'error', error: { message: 'no result event' } };
      return { sessionId, costUsd, usage, stopReason: isError ? 'error' : 'result', error: null };
    },
  };
}

/**
 * Reads an SSE response body to completion, parsing each `data: ` frame as
 * JSON. `onEvent` (if given) is awaited after each parsed frame — the cancel
 * test uses this to fire a second request as soon as the `chat-id` bootstrap
 * frame arrives, while the turn is still in flight.
 */
async function readSse(res, onEvent) {
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const frames = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let idx;
    while ((idx = buffer.indexOf('\n\n')) !== -1) {
      const raw = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      if (!raw.startsWith('data: ')) continue;
      const frame = JSON.parse(raw.slice('data: '.length));
      frames.push(frame);
      if (onEvent) await onEvent(frame);
    }
  }
  return frames;
}

function fakeScript() {
  return [
    { type: 'init', sessionId: 'sess-1', tools: [], model: 'claude-opus-5', permissionMode: 'default' },
    { type: 'text', text: 'Hello from the fake harness' },
    { type: 'result', sessionId: 'sess-1', costUsd: 0.0123, usage: { input_tokens: 10, output_tokens: 5 }, isError: false },
  ];
}

test('chat: POST /api/chat/turn streams the fake harness events plus a turn-complete frame', async () => {
  const { url } = await boot({ harness: createFakeHarness({ script: fakeScript() }), harnessName: 'fake' });

  const res = await fetch(`${url}/api/chat/turn`, {
    method: 'POST',
    headers: APP_JSON_HEADERS,
    body: JSON.stringify({ text: 'hi there' }),
  });
  expect(res.status).toBe(200);
  expect(res.headers.get('content-type')).toContain('text/event-stream');

  const frames = await readSse(res);
  expect(frames[0].type).toBe('chat-id');
  expect(typeof frames[0].chatId).toBe('string');

  const types = frames.map((f) => f.type);
  expect(types).toEqual(['chat-id', 'init', 'text', 'result', 'turn-complete']);

  const complete = frames.at(-1);
  expect(complete).toMatchObject({
    type: 'turn-complete',
    chatId: frames[0].chatId,
    cliSessionId: 'sess-1',
    costUsd: 0.0123,
    stopReason: 'result',
    error: null,
  });

  // The turn is persisted — a reload of the same chat sees the same events.
  const chatRes = await fetch(`${url}/api/chat/${frames[0].chatId}`);
  const chatBody = await chatRes.json();
  expect(chatBody.chat.id).toBe(frames[0].chatId);
  expect(chatBody.events.map((e) => e.kind)).toEqual(['user', 'assistant']);
  expect(chatBody.events[0].text).toBe('hi there');
  expect(chatBody.events[1].text).toBe('Hello from the fake harness');
});

test('chat: POST /api/chat/turn with an existing chatId resumes that chat', async () => {
  const { url } = await boot({ harness: createFakeHarness({ script: fakeScript() }), harnessName: 'fake' });
  const first = await fetch(`${url}/api/chat/turn`, {
    method: 'POST',
    headers: APP_JSON_HEADERS,
    body: JSON.stringify({ text: 'first message' }),
  });
  const firstFrames = await readSse(first);
  const chatId = firstFrames[0].chatId;

  const second = await fetch(`${url}/api/chat/turn`, {
    method: 'POST',
    headers: APP_JSON_HEADERS,
    body: JSON.stringify({ chatId, text: 'second message' }),
  });
  const secondFrames = await readSse(second);
  expect(secondFrames[0]).toEqual({ type: 'chat-id', chatId });

  const chatRes = await fetch(`${url}/api/chat/${chatId}`);
  const chatBody = await chatRes.json();
  expect(chatBody.events.map((e) => e.text)).toEqual([
    'first message',
    'Hello from the fake harness',
    'second message',
    'Hello from the fake harness',
  ]);
});

test('chat: POST /api/chat/turn with empty/missing text returns 400 (plain JSON, not SSE)', async () => {
  const { url } = await boot({ harness: createFakeHarness({ script: fakeScript() }) });

  const missing = await postJson(`${url}/api/chat/turn`, {});
  expect(missing.status).toBe(400);
  expect(missing.headers.get('content-type')).toContain('application/json');

  const blank = await postJson(`${url}/api/chat/turn`, { text: '   ' });
  expect(blank.status).toBe(400);
});

test('chat: POST /api/chat/turn with an unknown chatId returns 404', async () => {
  const { url } = await boot({ harness: createFakeHarness({ script: fakeScript() }) });
  const res = await postJson(`${url}/api/chat/turn`, { chatId: '00000000-0000-0000-0000-000000000000', text: 'hi' });
  expect(res.status).toBe(404);
});

test('chat: GET /api/chat/turn (wrong method) returns 405', async () => {
  const { url } = await boot({});
  const res = await fetch(`${url}/api/chat/turn`);
  expect(res.status).toBe(405);
});

test('chat: CSRF hardening — POST /api/chat/turn without x-app-request header is rejected with 403', async () => {
  const { url } = await boot({});
  const res = await fetch(`${url}/api/chat/turn`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: 'hi' }),
  });
  expect(res.status).toBe(403);
});

test('chat: GET /api/chat/list and GET /api/chat/<id> reflect store contents, newest first', async () => {
  const { url } = await boot({ harness: createFakeHarness({ script: fakeScript() }) });
  const first = await readSse(
    await fetch(`${url}/api/chat/turn`, { method: 'POST', headers: APP_JSON_HEADERS, body: JSON.stringify({ text: 'alpha' }) }),
  );
  const second = await readSse(
    await fetch(`${url}/api/chat/turn`, { method: 'POST', headers: APP_JSON_HEADERS, body: JSON.stringify({ text: 'beta' }) }),
  );

  const listRes = await fetch(`${url}/api/chat/list`);
  expect(listRes.status).toBe(200);
  const listBody = await listRes.json();
  expect(listBody.chats.map((c) => c.id)).toEqual([second[0].chatId, first[0].chatId]);
  expect(listBody.chats[0].title).toBe('beta');

  const getRes = await fetch(`${url}/api/chat/${first[0].chatId}`);
  const getBody = await getRes.json();
  expect(getBody.chat.title).toBe('alpha');
  expect(getBody.events).toHaveLength(2);
});

test('chat: GET /api/chat/<unknown-id> returns 404', async () => {
  const { url } = await boot({});
  const res = await fetch(`${url}/api/chat/00000000-0000-0000-0000-000000000000`);
  expect(res.status).toBe(404);
});

test('chat: cancel aborts an in-flight turn, the SSE stream resolves with stopReason aborted', async () => {
  const slowScript = [
    { type: 'init', sessionId: 'sess-slow', tools: [], model: 'm', permissionMode: 'default' },
    { type: 'text', text: 'partial one' },
    { type: 'text', text: 'partial two' },
    { type: 'result', sessionId: 'sess-slow', costUsd: 0.01, usage: {}, isError: false },
  ];
  const { url } = await boot({ harness: slowFakeHarness({ script: slowScript, delayMs: 25 }), harnessName: 'fake' });

  const res = await fetch(`${url}/api/chat/turn`, {
    method: 'POST',
    headers: APP_JSON_HEADERS,
    body: JSON.stringify({ text: 'go slowly' }),
  });

  let cancelStatus = null;
  let cancelBody = null;
  const frames = await readSse(res, async (frame) => {
    if (frame.type === 'chat-id' && cancelStatus === null) {
      const cancelRes = await postJson(`${url}/api/chat/${frame.chatId}/cancel`);
      cancelStatus = cancelRes.status;
      cancelBody = await cancelRes.json();
    }
  });

  expect(cancelStatus).toBe(200);
  expect(cancelBody).toEqual({ cancelled: true });

  const complete = frames.at(-1);
  expect(complete.type).toBe('turn-complete');
  expect(complete.stopReason).toBe('aborted');
});

test('chat: cancelling a chat with no in-flight turn returns cancelled:false, and an unknown chat 404s', async () => {
  const { url } = await boot({ harness: createFakeHarness({ script: fakeScript() }) });
  const frames = await readSse(
    await fetch(`${url}/api/chat/turn`, { method: 'POST', headers: APP_JSON_HEADERS, body: JSON.stringify({ text: 'done already' }) }),
  );
  const chatId = frames[0].chatId;

  const idleCancel = await postJson(`${url}/api/chat/${chatId}/cancel`);
  expect(idleCancel.status).toBe(200);
  expect(await idleCancel.json()).toEqual({ cancelled: false });

  const unknownCancel = await postJson(`${url}/api/chat/00000000-0000-0000-0000-000000000000/cancel`);
  expect(unknownCancel.status).toBe(404);
});
