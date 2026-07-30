// Tests for the local HTTP API server. Run: npx vitest run src/server
//
// Exercises a real server on an ephemeral port (127.0.0.1) via the Node
// built-in fetch — no external network involved, no mocks for node:http.
import { test, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { EventEmitter } from 'node:events';
import { startServer, createSseQueue } from './server.mjs';
import { TOKEN_HEADER } from './token.mjs';
import { createFakeHarness } from '../harness/fake.mjs';
import { openChats } from '../chats/store.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SECRET_FIXTURE = path.join(__dirname, 'fixtures', 'session-with-secret.jsonl');

const APP_HEADERS = { 'x-app-request': '1' };
const APP_JSON_HEADERS = { ...APP_HEADERS, 'Content-Type': 'application/json' };

let tmpDir;
let dataDir;
let tmpRootDir;
let servers = [];
// The token of the server boot() started most recently — see the fetch
// wrapper below.
let currentToken = null;

/**
 * Every /api/* route requires the per-installation instance token (see
 * token.mjs). Rather than thread it through ~100 call sites, this
 * module-scoped wrapper SHADOWS the global fetch for this file only and adds
 * the header of the server boot() started last. The guard itself is never
 * weakened: the tests that must present a missing/wrong token call `rawFetch`
 * (the real global) directly.
 */
const rawFetch = (...args) => globalThis.fetch(...args);
function fetch(input, init = {}) {
  return rawFetch(input, { ...init, headers: { ...(init.headers ?? {}), [TOKEN_HEADER]: currentToken ?? '' } });
}

beforeEach(() => {
  currentToken = null;
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
  currentToken = started.token;
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
      {
        hostname: target.hostname,
        port: target.port,
        path: pathName,
        method: 'GET',
        // Carries the token like every other request in this file, so a
        // Host-header test observes the Host check's result, not a 401.
        headers: { [TOKEN_HEADER]: currentToken ?? '', ...headers },
      },
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
 * Like slowFakeHarness(), but exposes an `aborted` promise that resolves the
 * moment startTurn() observes `signal.aborted` — lets a test prove the
 * SERVER actually triggered the AbortController (e.g. on a client
 * disconnect) without relying on a side channel like the cancel endpoint,
 * which would itself abort the turn and confound the assertion.
 */
function observableAbortHarness({ script, delayMs = 20 }) {
  let resolveAborted;
  const aborted = new Promise((resolve) => {
    resolveAborted = resolve;
  });
  return {
    aborted,
    async startTurn({ sessionId: requestedSessionId, onEvent, signal } = {}) {
      let sessionId = requestedSessionId ?? null;
      for (const event of script) {
        if (signal?.aborted) {
          resolveAborted();
          return { sessionId, costUsd: null, usage: null, stopReason: 'aborted', error: null };
        }
        await new Promise((resolve) => setTimeout(resolve, delayMs));
        if (signal?.aborted) {
          resolveAborted();
          return { sessionId, costUsd: null, usage: null, stopReason: 'aborted', error: null };
        }
        onEvent?.(event);
        if (event.sessionId) sessionId = event.sessionId;
      }
      return { sessionId, costUsd: null, usage: null, stopReason: 'error', error: { message: 'no result event' } };
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

test('chat: closing the SSE response (client disconnect) aborts the turn on the server side', async () => {
  const slowScript = [
    { type: 'init', sessionId: 'sess-disconnect', tools: [], model: 'm', permissionMode: 'default' },
    { type: 'text', text: 'partial one' },
    { type: 'text', text: 'partial two' },
    { type: 'text', text: 'partial three' },
    { type: 'result', sessionId: 'sess-disconnect', costUsd: 0.01, usage: {}, isError: false },
  ];
  const harness = observableAbortHarness({ script: slowScript, delayMs: 100 });
  const { url } = await boot({ harness, harnessName: 'fake' });

  const clientController = new AbortController();
  const res = await fetch(`${url}/api/chat/turn`, {
    method: 'POST',
    headers: APP_JSON_HEADERS,
    body: JSON.stringify({ text: 'disconnect me' }),
    signal: clientController.signal,
  });

  // Read only up to the chat-id bootstrap frame, proving the SSE stream is
  // actually open and mid-turn, then simulate the client going away (closed
  // tab / killed fetch) instead of reading the stream to completion.
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let chatId = null;
  while (chatId === null) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const idx = buffer.indexOf('\n\n');
    if (idx !== -1) {
      chatId = JSON.parse(buffer.slice('data: '.length, idx)).chatId;
    }
  }
  expect(typeof chatId).toBe('string');

  clientController.abort();
  await reader.cancel().catch(() => {});

  // The harness observing signal.aborted proves the SERVER's own
  // AbortController fired because of the closed response, not because of
  // some other side channel (e.g. the cancel endpoint, which is never
  // called in this test).
  const timedOut = Symbol('timeout');
  const outcome = await Promise.race([harness.aborted.then(() => 'aborted'), new Promise((resolve) => setTimeout(() => resolve(timedOut), 3000))]);
  expect(outcome).toBe('aborted');
});

test('chat: a second concurrent turn on the same chat is rejected with 409 (no SSE stream opened), a new turn works once the first ends', async () => {
  const slowScript = [
    { type: 'init', sessionId: 'sess-busy', tools: [], model: 'm', permissionMode: 'default' },
    { type: 'text', text: 'partial' },
    { type: 'result', sessionId: 'sess-busy', costUsd: 0.01, usage: {}, isError: false },
  ];
  const { url } = await boot({ harness: slowFakeHarness({ script: slowScript, delayMs: 25 }), harnessName: 'fake' });

  const first = await fetch(`${url}/api/chat/turn`, {
    method: 'POST',
    headers: APP_JSON_HEADERS,
    body: JSON.stringify({ text: 'go slowly' }),
  });

  let busyStatus = null;
  let busyBody = null;
  let chatId = null;
  const frames = await readSse(first, async (frame) => {
    if (frame.type === 'chat-id' && busyStatus === null) {
      chatId = frame.chatId;
      const busyRes = await postJson(`${url}/api/chat/turn`, { chatId, text: 'second, while first is running' });
      busyStatus = busyRes.status;
      busyBody = await busyRes.json();
    }
  });

  expect(busyStatus).toBe(409);
  expect(busyBody).toEqual({ error: 'chat busy' });
  // The rejected request never got an SSE stream — no chat-id/turn-complete
  // frames from it interleaved into the first turn's own frame sequence.
  expect(frames.map((f) => f.type)).toEqual(['chat-id', 'init', 'text', 'result', 'turn-complete']);
  expect(frames.at(-1).stopReason).toBe('result');

  // The chat is idle again once the first turn has resolved.
  const third = await readSse(
    await fetch(`${url}/api/chat/turn`, { method: 'POST', headers: APP_JSON_HEADERS, body: JSON.stringify({ chatId, text: 'third, now idle' }) }),
  );
  expect(third.at(-1).stopReason).toBe('result');
});

test('chat: no leftover AbortController after a turn ends — cancelling that chat afterwards returns cancelled:false', async () => {
  const { url } = await boot({ harness: createFakeHarness({ script: fakeScript() }) });
  const frames = await readSse(
    await fetch(`${url}/api/chat/turn`, { method: 'POST', headers: APP_JSON_HEADERS, body: JSON.stringify({ text: 'finish normally' }) }),
  );
  const chatId = frames[0].chatId;

  const cancelRes = await postJson(`${url}/api/chat/${chatId}/cancel`);
  expect(cancelRes.status).toBe(200);
  expect(await cancelRes.json()).toEqual({ cancelled: false });
});

// SECURITY (P0-3): startServer() must default to the CLI's own restrictive
// permission mode and forward whatever it's given straight through to the
// harness, never widening what the agent can do beyond the server's own
// configured default.
test('chat: startServer() defaults pass permissionMode "default" and allowedTools null to the harness', async () => {
  const fakeHarness = createFakeHarness({ script: fakeScript() });
  const startTurnSpy = vi.spyOn(fakeHarness, 'startTurn');
  const { url } = await boot({ harness: fakeHarness, harnessName: 'fake' });

  await readSse(
    await fetch(`${url}/api/chat/turn`, { method: 'POST', headers: APP_JSON_HEADERS, body: JSON.stringify({ text: 'defaults check' }) }),
  );

  expect(startTurnSpy).toHaveBeenCalledTimes(1);
  expect(startTurnSpy.mock.calls[0][0]).toMatchObject({ permissionMode: 'default', allowedTools: null });
});

test('chat: startServer({ permissionMode, allowedTools }) options reach the harness unchanged', async () => {
  const fakeHarness = createFakeHarness({ script: fakeScript() });
  const startTurnSpy = vi.spyOn(fakeHarness, 'startTurn');
  const { url } = await boot({
    harness: fakeHarness,
    harnessName: 'fake',
    permissionMode: 'acceptEdits',
    allowedTools: ['Read', 'Grep'],
  });

  await readSse(
    await fetch(`${url}/api/chat/turn`, { method: 'POST', headers: APP_JSON_HEADERS, body: JSON.stringify({ text: 'custom options check' }) }),
  );

  expect(startTurnSpy.mock.calls[0][0]).toMatchObject({ permissionMode: 'acceptEdits', allowedTools: ['Read', 'Grep'] });
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

// P1-C1: a slow consumer (res.write() returning false) must not make
// createSseQueue() drop or reorder frames — each write waits its turn AND
// waits for 'drain' before the next one is even attempted.
test('createSseQueue: writes are serialized and wait for drain before the next frame is attempted', async () => {
  const written = [];
  const res = new EventEmitter();
  res.writableEnded = false;
  let acceptWrites = false;
  res.write = (chunk) => {
    written.push(chunk);
    return acceptWrites;
  };

  const enqueue = createSseQueue(res);
  const p1 = enqueue({ type: 'a' });
  const p2 = enqueue({ type: 'b' });
  const p3 = enqueue({ type: 'c' });

  // Let queued microtasks run: only the FIRST frame's write() should have
  // been attempted — it returned false, so the queue is waiting on 'drain'
  // before even calling write() for frame 'b'. (Several ticks: the chain's
  // own .then() hops each need a turn — a fixed, generous count rather than
  // relying on exact microtask-depth counting.)
  for (let i = 0; i < 10; i += 1) await Promise.resolve();
  expect(written).toEqual([`data: ${JSON.stringify({ type: 'a' })}\n\n`]);

  acceptWrites = true;
  res.emit('drain'); // unblocks frame 'a', which then attempts (and succeeds) frame 'b', then 'c'
  await p3; // p3 only settles once p2 (and, transitively, p1) have settled — waits out the whole chain
  expect(written).toEqual([
    `data: ${JSON.stringify({ type: 'a' })}\n\n`,
    `data: ${JSON.stringify({ type: 'b' })}\n\n`,
    `data: ${JSON.stringify({ type: 'c' })}\n\n`,
  ]);
  await p1;
  await p2;
});

test('createSseQueue: a client that is already gone (writableEnded) drops writes instead of throwing', async () => {
  const res = new EventEmitter();
  res.writableEnded = true;
  res.write = () => {
    throw new Error('must never be called once writableEnded');
  };

  const enqueue = createSseQueue(res);
  await expect(enqueue({ type: 'a' })).resolves.toBeUndefined();
});

// P1-C2's server-side half (the client-side half — IncompleteStreamError —
// is covered directly against web/src/lib/api.ts in
// src/server/sse-client.test.mjs): proves a response really can end without
// a 'turn-complete' frame having been sent yet (e.g. a server crash/proxy
// drop mid-stream), i.e. that the client-side check has something real to
// detect — a slow harness keeps the turn from finishing before the first
// chunk is read, so the read is guaranteed to observe only the 'chat-id'
// bootstrap frame.
test('chat: the first bytes of a still-running turn do not yet contain turn-complete', async () => {
  const { url } = await boot({ harness: slowFakeHarness({ script: fakeScript(), delayMs: 200 }), harnessName: 'fake' });
  const res = await fetch(`${url}/api/chat/turn`, {
    method: 'POST',
    headers: APP_JSON_HEADERS,
    body: JSON.stringify({ text: 'hi there' }),
  });
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  const { value } = await reader.read();
  const text = decoder.decode(value);
  expect(text).toContain('"chat-id"');
  expect(text).not.toContain('"turn-complete"');
  await reader.cancel();
});

// --- Approval chain (Task 6a) -------------------------------------------------

/**
 * A harness that asks for exactly one approval, then reports back what it
 * decided. `postDecisionDelayMs` gives a test a real window to fire a SECOND
 * POST /api/approvals/<id> before the turn (and its finally-block cleanup,
 * see cleanupApprovalsForChat()) removes the now-decided entry — without it,
 * a harness that finishes essentially synchronously after the decision would
 * make the "second POST -> 409" case unobservably racy against turn-end
 * cleanup.
 */
function approvalHarness({ request, postDecisionDelayMs = 30 }) {
  return {
    async startTurn({ onEvent, onApprovalRequest, signal } = {}) {
      const decision = await onApprovalRequest(request);
      if (postDecisionDelayMs > 0) await new Promise((resolve) => setTimeout(resolve, postDecisionDelayMs));
      if (signal?.aborted) {
        return { sessionId: null, costUsd: null, usage: null, stopReason: 'aborted', error: null };
      }
      onEvent?.({ type: 'text', text: `decision was ${decision.behavior}${decision.message ? `: ${decision.message}` : ''}` });
      onEvent?.({ type: 'result', sessionId: 's1', costUsd: 0.001, usage: {}, isError: false });
      return { sessionId: 's1', costUsd: 0.001, usage: {}, stopReason: 'result', error: null };
    },
  };
}

test('chat: approval — SSE delivers an "approval" frame, POST /api/approvals/<id> resolves it, the turn continues with that decision', async () => {
  const { url } = await boot({
    harness: approvalHarness({ request: { id: 'approve-me-1', toolName: 'Bash', displayName: 'Bash', input: { command: 'ls' } } }),
    harnessName: 'fake',
  });

  const res = await fetch(`${url}/api/chat/turn`, {
    method: 'POST',
    headers: APP_JSON_HEADERS,
    body: JSON.stringify({ text: 'approve please' }),
  });

  let approvalFrame = null;
  const frames = await readSse(res, async (frame) => {
    if (frame.type === 'approval' && approvalFrame === null) {
      approvalFrame = frame;
      const decideRes = await postJson(`${url}/api/approvals/${frame.id}`, { chatId: frame.chatId, behavior: 'allow' });
      expect(decideRes.status).toBe(200);
      expect(await decideRes.json()).toEqual({ ok: true });
    }
  });

  expect(approvalFrame).toMatchObject({ type: 'approval', id: 'approve-me-1', toolName: 'Bash', input: { command: 'ls' } });
  const textFrame = frames.find((f) => f.type === 'text');
  expect(textFrame.text).toBe('decision was allow');
  expect(frames.at(-1)).toMatchObject({ type: 'turn-complete', stopReason: 'result' });
});

test('chat: approval — a second POST to the same id is rejected 409, an unrelated/unknown id is rejected 404', async () => {
  const { url } = await boot({
    harness: approvalHarness({ request: { id: 'dup-id-1', toolName: 'Bash', input: {} } }),
    harnessName: 'fake',
  });

  const res = await fetch(`${url}/api/chat/turn`, {
    method: 'POST',
    headers: APP_JSON_HEADERS,
    body: JSON.stringify({ text: 'dup test' }),
  });

  let firstStatus = null;
  let secondStatus = null;
  let chatId = null;
  await readSse(res, async (frame) => {
    if (frame.type === 'approval' && firstStatus === null) {
      chatId = frame.chatId;
      firstStatus = (await postJson(`${url}/api/approvals/${frame.id}`, { chatId, behavior: 'deny' })).status;
      secondStatus = (await postJson(`${url}/api/approvals/${frame.id}`, { chatId, behavior: 'allow' })).status;
    }
  });

  expect(firstStatus).toBe(200);
  expect(secondStatus).toBe(409);

  const unknownRes = await postJson(`${url}/api/approvals/00000000-0000-0000-0000-000000000000`, { chatId, behavior: 'allow' });
  expect(unknownRes.status).toBe(404);
});

test('chat: approval — POST /api/approvals/<id> rejects a missing/invalid behavior with 400', async () => {
  const { url } = await boot({
    harness: approvalHarness({ request: { id: 'bad-body-1', toolName: 'Bash', input: {} } }),
    harnessName: 'fake',
  });

  const res = await fetch(`${url}/api/chat/turn`, {
    method: 'POST',
    headers: APP_JSON_HEADERS,
    body: JSON.stringify({ text: 'bad body test' }),
  });

  let badStatus = null;
  let missingChatIdStatus = null;
  await readSse(res, async (frame) => {
    if (frame.type === 'approval' && badStatus === null) {
      badStatus = (await postJson(`${url}/api/approvals/${frame.id}`, { chatId: frame.chatId, behavior: 'maybe' })).status;
      missingChatIdStatus = (await postJson(`${url}/api/approvals/${frame.id}`, { behavior: 'deny' })).status;
      await postJson(`${url}/api/approvals/${frame.id}`, { chatId: frame.chatId, behavior: 'deny' }); // let the turn actually finish
    }
  });

  expect(badStatus).toBe(400);
  expect(missingChatIdStatus).toBe(400);
});

test('chat: approval — cancelling the chat resolves an open approval as deny("turn ended"), the harness observes exactly that decision (no deadlock)', async () => {
  // A custom harness (not approvalHarness — that one skips emitting its
  // decision-echoing text event once aborted, so it can't prove WHAT the
  // harness actually received) that captures the resolved decision
  // unconditionally, mirroring the disconnect test right below.
  let capturedDecision = null;
  const harness = {
    async startTurn({ onApprovalRequest, signal } = {}) {
      capturedDecision = await onApprovalRequest({ id: 'cancel-me-1', toolName: 'Bash', input: {} });
      return { sessionId: null, costUsd: null, usage: null, stopReason: signal?.aborted ? 'aborted' : 'result', error: null };
    },
  };
  const { url } = await boot({ harness, harnessName: 'fake' });

  const res = await fetch(`${url}/api/chat/turn`, {
    method: 'POST',
    headers: APP_JSON_HEADERS,
    body: JSON.stringify({ text: 'cancel while pending' }),
  });

  let chatId = null;
  const frames = await readSse(res, async (frame) => {
    if (frame.type === 'chat-id') chatId = frame.chatId;
    if (frame.type === 'approval') {
      const cancelRes = await postJson(`${url}/api/chat/${chatId}/cancel`);
      expect(cancelRes.status).toBe(200);
    }
  });

  expect(frames.at(-1)).toMatchObject({ type: 'turn-complete', stopReason: 'aborted' });
  expect(capturedDecision).toEqual({ behavior: 'deny', message: 'turn ended' });

  // The approval id is gone from the pending map once the turn is cleaned
  // up — deciding it now is an unknown/expired id, not a "double decision".
  const lateRes = await postJson(`${url}/api/approvals/cancel-me-1`, { chatId, behavior: 'allow' });
  expect(lateRes.status).toBe(404);
});

test('chat: approval — deciding with a chatId that does not own this id is rejected 404, never resolves it', async () => {
  const { url } = await boot({
    harness: approvalHarness({ request: { id: 'belongs-to-chat-a', toolName: 'Bash', input: {} } }),
    harnessName: 'fake',
  });

  const res = await fetch(`${url}/api/chat/turn`, { method: 'POST', headers: APP_JSON_HEADERS, body: JSON.stringify({ text: 'chat a' }) });
  let approval = null;
  const framesPromise = readSse(res, async (frame) => {
    if (frame.type === 'approval' && approval === null) approval = frame;
  });
  while (approval === null) await new Promise((resolve) => setTimeout(resolve, 5));

  // A well-formed but otherwise unrelated chatId — no pending entry was
  // ever registered under approvalKey(someOtherChatId, approval.id).
  const someOtherChatId = crypto.randomUUID();
  expect(someOtherChatId).not.toBe(approval.chatId);
  const wrongChatRes = await postJson(`${url}/api/approvals/${approval.id}`, { chatId: someOtherChatId, behavior: 'allow' });
  expect(wrongChatRes.status).toBe(404);

  // Untouched by that failed attempt — still decidable under its own,
  // correct chatId.
  const rightChatRes = await postJson(`${url}/api/approvals/${approval.id}`, { chatId: approval.chatId, behavior: 'deny' });
  expect(rightChatRes.status).toBe(200);
  await framesPromise;
});

test('chat: approval — two chats whose harness hands out the SAME request_id each keep their own independent resolve/timer', async () => {
  const { url } = await boot({
    harness: approvalHarness({ request: { id: 'shared-request-id', toolName: 'Bash', input: {} } }),
    harnessName: 'fake',
  });

  // Two independent chats whose harness happens to hand out the exact same
  // request_id — collisions are exactly what approvalKey()'s composite
  // chatId+requestId key exists to make structurally impossible (task-6a
  // review Important #4/#5): each chat's entry lives under its OWN key even
  // though the raw request_id is identical.
  const first = await fetch(`${url}/api/chat/turn`, { method: 'POST', headers: APP_JSON_HEADERS, body: JSON.stringify({ text: 'chat one' }) });
  let firstApproval = null;
  const firstFramesPromise = readSse(first, async (frame) => {
    if (frame.type === 'approval' && firstApproval === null) firstApproval = frame;
  });
  while (firstApproval === null) await new Promise((resolve) => setTimeout(resolve, 5));

  const second = await fetch(`${url}/api/chat/turn`, { method: 'POST', headers: APP_JSON_HEADERS, body: JSON.stringify({ text: 'chat two' }) });
  let secondApproval = null;
  const secondFramesPromise = readSse(second, async (frame) => {
    if (frame.type === 'approval' && secondApproval === null) secondApproval = frame;
  });
  while (secondApproval === null) await new Promise((resolve) => setTimeout(resolve, 5));

  expect(firstApproval.id).toBe(secondApproval.id); // the actual collision
  expect(firstApproval.chatId).not.toBe(secondApproval.chatId);

  // Resolving chat two's entry first must not touch chat one's — if both
  // shared one bare request_id-keyed slot, this delete/resolve would have
  // wiped chat one's `resolve`/`timer` out of the map entirely.
  const secondDecisionRes = await postJson(`${url}/api/approvals/${secondApproval.id}`, { chatId: secondApproval.chatId, behavior: 'allow' });
  expect(secondDecisionRes.status).toBe(200);
  await secondFramesPromise;

  // Chat one's own, colliding-id entry is still there, independently decidable.
  const firstDecisionRes = await postJson(`${url}/api/approvals/${firstApproval.id}`, { chatId: firstApproval.chatId, behavior: 'deny' });
  expect(firstDecisionRes.status).toBe(200);
  await firstFramesPromise;
});

test('chat: approval — closing the SSE response (client disconnect) also resolves an open approval as deny, without deadlocking the harness', async () => {
  let capturedDecision = null;
  const harness = {
    async startTurn({ onApprovalRequest, signal } = {}) {
      capturedDecision = await onApprovalRequest({ id: 'disconnect-me-1', toolName: 'Bash', input: {} });
      return { sessionId: null, costUsd: null, usage: null, stopReason: signal?.aborted ? 'aborted' : 'result', error: null };
    },
  };
  const { url } = await boot({ harness, harnessName: 'fake' });

  const clientController = new AbortController();
  const res = await fetch(`${url}/api/chat/turn`, {
    method: 'POST',
    headers: APP_JSON_HEADERS,
    body: JSON.stringify({ text: 'disconnect while pending' }),
    signal: clientController.signal,
  });

  // Read only up to the approval frame, then simulate the client going away
  // instead of ever answering it — mirrors this file's existing client-
  // disconnect test pattern.
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let sawApproval = false;
  while (!sawApproval) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let idx;
    while ((idx = buffer.indexOf('\n\n')) !== -1) {
      const raw = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      if (!raw.startsWith('data: ')) continue;
      if (JSON.parse(raw.slice('data: '.length)).type === 'approval') sawApproval = true;
    }
  }
  expect(sawApproval).toBe(true);

  clientController.abort();
  await reader.cancel().catch(() => {});

  const timedOut = Symbol('timeout');
  const outcome = await Promise.race([
    (async () => {
      while (capturedDecision === null) await new Promise((resolve) => setTimeout(resolve, 10));
      return capturedDecision;
    })(),
    new Promise((resolve) => setTimeout(() => resolve(timedOut), 3000)),
  ]);
  expect(outcome).toEqual({ behavior: 'deny', message: 'turn ended' });
});

test('chat: approval — an unanswered approval is auto-denied once approvalTimeoutMs elapses', async () => {
  const { url } = await boot({
    harness: approvalHarness({ request: { id: 'timeout-me-1', toolName: 'Bash', input: {} } }),
    harnessName: 'fake',
    approvalTimeoutMs: 20,
  });

  const res = await fetch(`${url}/api/chat/turn`, {
    method: 'POST',
    headers: APP_JSON_HEADERS,
    body: JSON.stringify({ text: 'never answer this' }),
  });

  const frames = await readSse(res);
  expect(frames.some((f) => f.type === 'approval')).toBe(true);
  const textFrame = frames.find((f) => f.type === 'text');
  expect(textFrame.text).toBe('decision was deny: approval timed out');
});

// ------------------------------------------------------------- triggers

function deleteRequest(url, headers = APP_HEADERS) {
  return fetch(url, { method: 'DELETE', headers });
}

function everyMinutesTrigger(overrides = {}) {
  return {
    id: 'nightly-sync',
    type: 'schedule',
    config: { everyMinutes: 5 },
    promptTemplate: 'Run the nightly sync.',
    appScope: [],
    enabled: true,
    ...overrides,
  };
}

function heartbeatTriggerBody(overrides = {}) {
  return {
    id: 'heartbeat-check',
    type: 'heartbeat',
    config: { intervalMinutes: 30 },
    promptTemplate: 'Check the checklist.',
    appScope: [],
    enabled: true,
    ...overrides,
  };
}

test('triggers: GET /api/triggers on an empty registry returns an empty list', async () => {
  const { url } = await boot({});
  const res = await fetch(`${url}/api/triggers`);
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.triggers).toEqual([]);
});

test('triggers: POST /api/triggers creates a trigger, and GET reflects it with runsToday/costToday', async () => {
  const { url } = await boot({});
  const createRes = await postJson(`${url}/api/triggers`, everyMinutesTrigger());
  expect(createRes.status).toBe(200);
  const created = await createRes.json();
  expect(created.id).toBe('nightly-sync');
  expect(created.escalation).toBe('notify');

  const listRes = await fetch(`${url}/api/triggers`);
  const listBody = await listRes.json();
  expect(listBody.triggers).toHaveLength(1);
  expect(listBody.triggers[0]).toMatchObject({ id: 'nightly-sync', runsToday: 0, costToday: 0 });
});

test('triggers: POST /api/triggers with an invalid body returns 400 with the offending field', async () => {
  const { url } = await boot({});
  const res = await postJson(`${url}/api/triggers`, { id: 'bad', type: 'schedule', bogusField: true });
  expect(res.status).toBe(400);
  const body = await res.json();
  expect(typeof body.error).toBe('string');
  expect(body.field).toBe('bogusField');
});

test('triggers: POST /api/triggers with a malformed JSON body returns 400', async () => {
  const { url } = await boot({});
  const res = await fetch(`${url}/api/triggers`, { method: 'POST', headers: APP_JSON_HEADERS, body: '{ not json' });
  expect(res.status).toBe(400);
});

test('triggers: POST /api/triggers/<id>/toggle flips enabled; unknown id is 404; non-boolean body is 400', async () => {
  const { url } = await boot({});
  await postJson(`${url}/api/triggers`, everyMinutesTrigger({ enabled: false }));

  const toggled = await postJson(`${url}/api/triggers/nightly-sync/toggle`, { enabled: true });
  expect(toggled.status).toBe(200);
  expect((await toggled.json()).enabled).toBe(true);

  const unknown = await postJson(`${url}/api/triggers/does-not-exist/toggle`, { enabled: true });
  expect(unknown.status).toBe(404);

  const badBody = await postJson(`${url}/api/triggers/nightly-sync/toggle`, { enabled: 'yes' });
  expect(badBody.status).toBe(400);
});

test('triggers: POST /api/triggers/<id>/fire manually fires an enabled trigger and streams the turn as SSE (bootstrap chat-id + trigger-complete)', async () => {
  const { url } = await boot({ harness: createFakeHarness({ script: fakeScript() }), harnessName: 'fake' });
  await postJson(`${url}/api/triggers`, everyMinutesTrigger());

  const res = await postJson(`${url}/api/triggers/nightly-sync/fire`, {});
  expect(res.status).toBe(200);
  expect(res.headers.get('content-type')).toContain('text/event-stream');
  const frames = await readSse(res);
  expect(frames[0]).toMatchObject({ type: 'chat-id' });
  const complete = frames.find((f) => f.type === 'trigger-complete');
  expect(complete.fired).toBe(true);
  expect(typeof complete.chatId).toBe('string');
  expect(complete.chatId).toBe(frames[0].chatId);
});

test('triggers: POST /api/triggers/<id>/fire on a disabled trigger streams a single rejection frame, never opens a turn (not an HTTP error)', async () => {
  const { url } = await boot({});
  await postJson(`${url}/api/triggers`, everyMinutesTrigger({ enabled: false }));

  const res = await postJson(`${url}/api/triggers/nightly-sync/fire`, {});
  expect(res.status).toBe(200);
  const frames = await readSse(res);
  expect(frames).toEqual([{ type: 'trigger-complete', fired: false, reason: 'trigger disabled' }]);
});

/**
 * A harness whose turn STAYS in flight until release() is called, and whose
 * `started` promise resolves the moment startTurn() is entered. Both halves
 * are what make the loop-guard test below deterministic: no sleep, no margin
 * against a wall-clock delay — the second request is issued exactly when the
 * first turn is provably running, and the first turn ends exactly when the
 * test says so.
 */
function gatedHarness() {
  let markStarted;
  let release;
  const started = new Promise((resolve) => {
    markStarted = resolve;
  });
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  return {
    started,
    release: () => release(),
    async startTurn({ onEvent } = {}) {
      markStarted();
      await gate;
      onEvent?.({ type: 'text', text: 'done' });
      onEvent?.({ type: 'result', sessionId: 's1', costUsd: 0, usage: {}, isError: false });
      return { sessionId: 's1', costUsd: 0, usage: {}, stopReason: 'result', error: null };
    },
  };
}

test('triggers: POST /api/triggers/<id>/fire while a trigger turn is already in flight is rejected with 429 (loop-guard layer 2), before opening any stream', async () => {
  const harness = gatedHarness();
  const { url } = await boot({ harness, harnessName: 'fake' });
  await postJson(`${url}/api/triggers`, everyMinutesTrigger());

  const firstFire = fetch(`${url}/api/triggers/nightly-sync/fire`, { method: 'POST', headers: APP_JSON_HEADERS });
  await harness.started; // the first turn is in flight — no timing assumption

  const secondRes = await postJson(`${url}/api/triggers/nightly-sync/fire`, {});
  expect(secondRes.status).toBe(429);
  const secondBody = await secondRes.json();
  expect(secondBody).toEqual({ reason: 'trigger turn in progress' });

  harness.release();
  const firstFrames = await readSse(await firstFire);
  expect(firstFrames.find((f) => f.type === 'trigger-complete').fired).toBe(true);
});

test('triggers: a "question" escalation trigger fires (the server always wires a UI approval handler), and its approval question appears live in the SSE stream and is answerable via POST /api/approvals/<id>', async () => {
  const { url } = await boot({
    harness: approvalHarness({ request: { id: 'trigger-approve-1', toolName: 'Bash', displayName: 'Bash', input: { command: 'ls' } } }),
    harnessName: 'fake',
  });
  await postJson(`${url}/api/triggers`, everyMinutesTrigger({ id: 'ask-me', escalation: 'question' }));

  const listRes = await fetch(`${url}/api/triggers`);
  const listed = (await listRes.json()).triggers.find((t) => t.id === 'ask-me');
  expect(listed.approvalPath).toBe('ui');
  expect(listed.blocked).toBeNull();

  const res = await fetch(`${url}/api/triggers/ask-me/fire`, { method: 'POST', headers: APP_JSON_HEADERS });

  let approvalFrame = null;
  const frames = await readSse(res, async (frame) => {
    if (frame.type === 'approval' && approvalFrame === null) {
      approvalFrame = frame;
      const decideRes = await postJson(`${url}/api/approvals/${frame.id}`, { chatId: frame.chatId, behavior: 'allow' });
      expect(decideRes.status).toBe(200);
    }
  });

  expect(approvalFrame).toMatchObject({ type: 'approval', id: 'trigger-approve-1', toolName: 'Bash' });
  expect(approvalFrame.chatId).toBe(frames[0].chatId);
  const textFrame = frames.find((f) => f.type === 'text');
  expect(textFrame.text).toBe('decision was allow');
  const complete = frames.find((f) => f.type === 'trigger-complete');
  expect(complete.fired).toBe(true);
});

test('triggers: GET /api/triggers reports approvalPath:"policy" for a "notify" trigger, with blocked:null', async () => {
  const { url } = await boot({});
  await postJson(`${url}/api/triggers`, everyMinutesTrigger());

  const listRes = await fetch(`${url}/api/triggers`);
  const listed = (await listRes.json()).triggers.find((t) => t.id === 'nightly-sync');
  expect(listed.approvalPath).toBe('policy');
  expect(listed.blocked).toBeNull();
});

test('triggers: DELETE /api/triggers/<id> removes it; a second DELETE returns 404', async () => {
  const { url } = await boot({});
  await postJson(`${url}/api/triggers`, everyMinutesTrigger());

  const first = await deleteRequest(`${url}/api/triggers/nightly-sync`);
  expect(first.status).toBe(200);
  expect(await first.json()).toEqual({ removed: true });

  const second = await deleteRequest(`${url}/api/triggers/nightly-sync`);
  expect(second.status).toBe(404);

  const listRes = await fetch(`${url}/api/triggers`);
  expect((await listRes.json()).triggers).toEqual([]);
});

test('triggers: CSRF hardening — POST/DELETE without x-app-request are rejected with 403', async () => {
  const { url } = await boot({});
  const create = await fetch(`${url}/api/triggers`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(everyMinutesTrigger()),
  });
  expect(create.status).toBe(403);

  const del = await fetch(`${url}/api/triggers/nightly-sync`, { method: 'DELETE' });
  expect(del.status).toBe(403);
});

test('triggers: DNS-rebinding hardening applies to /api/triggers too', async () => {
  const { url, server } = await boot({});
  const port = server.address().port;
  const status = await rawGet(url, '/api/triggers', { Host: 'evil.example.com' });
  expect(status).toBe(400);
  const ok = await rawGet(url, '/api/triggers', { Host: `127.0.0.1:${port}` });
  expect(ok).toBe(200);
});

test('triggers: an unknown /api/triggers/<id>/<verb> route returns 404', async () => {
  const { url } = await boot({});
  const res = await postJson(`${url}/api/triggers/nightly-sync/bogus`, {});
  expect(res.status).toBe(404);
});

test('chat: GET /api/chat/list hides a silent heartbeat chat by default, includes it with ?includeSilent=1', async () => {
  const heartbeatOkScript = [
    { type: 'init', sessionId: 'sess-hb', tools: [], model: 'm', permissionMode: 'default' },
    { type: 'text', text: 'HEARTBEAT_OK' },
    { type: 'result', sessionId: 'sess-hb', costUsd: 0, usage: {}, isError: false },
  ];
  const { url } = await boot({ harness: createFakeHarness({ script: heartbeatOkScript }), harnessName: 'fake' });
  fs.mkdirSync(path.join(dataDir, 'workspace'), { recursive: true });
  fs.writeFileSync(path.join(dataDir, 'workspace', 'CHECKLIST.md'), '- nothing due', 'utf8');
  await postJson(`${url}/api/triggers`, heartbeatTriggerBody());

  const fireRes = await postJson(`${url}/api/triggers/heartbeat-check/fire`, {});
  const fireFrames = await readSse(fireRes);
  const fireComplete = fireFrames.find((f) => f.type === 'trigger-complete');
  expect(fireComplete.fired).toBe(true);
  expect(fireComplete.silent).toBe(true);
  const chatId = fireComplete.chatId;

  const defaultList = await (await fetch(`${url}/api/chat/list`)).json();
  expect(defaultList.chats.map((c) => c.id)).not.toContain(chatId);

  const withSilent = await (await fetch(`${url}/api/chat/list?includeSilent=1`)).json();
  expect(withSilent.chats.map((c) => c.id)).toContain(chatId);
  const silentChat = withSilent.chats.find((c) => c.id === chatId);
  expect(silentChat.origin).toBe('trigger');
  expect(silentChat.triggerId).toBe('heartbeat-check');
});

/** Writes a valid app manifest into `<dir>/<id>/app.json`. */
function writeApp(dir, id, overrides = {}) {
  const appDir = path.join(dir, id);
  fs.mkdirSync(appDir, { recursive: true });
  const manifest = {
    id,
    version: '1.0.0',
    name: `App ${id}`,
    description: `Does something for ${id}.`,
    icon: '🧩',
    instructions: 'Internal instructions that must never reach the apps list.',
    tools: [
      {
        id: `${id}.do`,
        description: 'Does the thing.',
        inputSchema: { type: 'object', properties: {}, required: [] },
        handler: 'handler.mjs',
      },
    ],
    policy: { fsWrite: false, dataEgress: false, externalAction: 'never', sensitivity: 'low' },
    uiSlot: 'text',
    ...overrides,
  };
  fs.writeFileSync(path.join(appDir, 'app.json'), JSON.stringify(manifest), 'utf8');
  return appDir;
}

test('apps: GET /api/apps returns display metadata for bundled and user apps', async () => {
  const bundledDir = fs.mkdtempSync(path.join(os.tmpdir(), 'server-test-apps-'));
  writeApp(bundledDir, 'shipped');
  writeApp(path.join(dataDir, 'apps'), 'installed', {
    policy: { fsWrite: true, dataEgress: true, externalAction: 'approval', sensitivity: 'high' },
  });

  const { url } = await boot({ bundledAppsDir: bundledDir });
  const res = await fetch(`${url}/api/apps`);
  expect(res.status).toBe(200);
  const body = await res.json();

  expect(body.errors).toEqual([]);
  const byId = Object.fromEntries(body.apps.map((app) => [app.id, app]));
  expect(Object.keys(byId).sort()).toEqual(['installed', 'shipped']);
  expect(byId.shipped).toEqual({
    id: 'shipped',
    name: 'App shipped',
    description: 'Does something for shipped.',
    icon: '🧩',
    version: '1.0.0',
    toolCount: 1,
    policy: { fsWrite: false, dataEgress: false, externalAction: 'never', sensitivity: 'low' },
    uiSlot: 'text',
    source: 'bundled',
  });
  expect(byId.installed.source).toBe('user');
  expect(byId.installed.policy).toEqual({ fsWrite: true, dataEgress: true, externalAction: 'approval', sensitivity: 'high' });

  fs.rmSync(bundledDir, { recursive: true, force: true });
});

test('apps: GET /api/apps exposes nothing executable — no handler paths, tool schemas or instructions', async () => {
  const bundledDir = fs.mkdtempSync(path.join(os.tmpdir(), 'server-test-apps-'));
  writeApp(bundledDir, 'shipped');
  const { url } = await boot({ bundledAppsDir: bundledDir });

  const raw = await (await fetch(`${url}/api/apps`)).text();
  expect(raw).not.toContain('handler.mjs');
  expect(raw).not.toContain('inputSchema');
  expect(raw).not.toContain('Internal instructions');
  // A filesystem path is not display data, and loadApps() reports one per app.
  expect(raw).not.toContain(bundledDir.split(path.sep).join('/'));
  expect(JSON.parse(raw).apps[0].tools).toBeUndefined();

  fs.rmSync(bundledDir, { recursive: true, force: true });
});

test('apps: a broken manifest is reported without its path and without hiding the healthy apps', async () => {
  const bundledDir = fs.mkdtempSync(path.join(os.tmpdir(), 'server-test-apps-'));
  writeApp(bundledDir, 'healthy');
  const brokenDir = path.join(bundledDir, 'broken');
  fs.mkdirSync(brokenDir, { recursive: true });
  fs.writeFileSync(path.join(brokenDir, 'app.json'), '{ not json', 'utf8');

  const { url } = await boot({ bundledAppsDir: bundledDir });
  const body = await (await fetch(`${url}/api/apps`)).json();

  expect(body.apps.map((app) => app.id)).toEqual(['healthy']);
  expect(body.errors).toHaveLength(1);
  expect(Object.keys(body.errors[0])).toEqual(['message']);
  expect(body.errors[0].message).toMatch(/invalid manifest/);

  fs.rmSync(bundledDir, { recursive: true, force: true });
});

test('apps: GET /api/apps needs the instance token like every other API route', async () => {
  const { url } = await boot({});
  const res = await rawFetch(`${url}/api/apps`);
  expect(res.status).toBe(401);
  expect(await res.text()).toBe('');
});

test('apps: GET /api/apps rejects a non-GET method', async () => {
  const { url } = await boot({});
  expect((await postJson(`${url}/api/apps`, {})).status).toBe(405);
});

test('chat: GET /api/chat/list?triggerId= narrows the list to that one trigger, orthogonally to includeSilent', async () => {
  const { url } = await boot({});
  const chats = openChats(dataDir);
  const userChat = chats.createChat({ title: 'a hand-written chat', origin: 'user' });
  const nightly = chats.createChat({ title: 'nightly run', origin: 'trigger', triggerId: 'nightly-sync' });
  const other = chats.createChat({ title: 'watcher run', origin: 'trigger', triggerId: 'watch-notes' });
  const nightlySilent = chats.createChat({ title: 'nightly quiet run', origin: 'trigger', triggerId: 'nightly-sync', silent: true });

  const filtered = await (await fetch(`${url}/api/chat/list?triggerId=nightly-sync`)).json();
  expect(filtered.chats.map((c) => c.id)).toEqual([nightly.id]);
  expect(filtered.chats.map((c) => c.id)).not.toContain(userChat.id);
  expect(filtered.chats.map((c) => c.id)).not.toContain(other.id);

  // includeSilent stays a separate opt-in: the trigger filter must not
  // quietly re-admit that trigger's silent runs.
  const filteredWithSilent = await (await fetch(`${url}/api/chat/list?triggerId=nightly-sync&includeSilent=1`)).json();
  expect(filteredWithSilent.chats.map((c) => c.id).sort()).toEqual([nightly.id, nightlySilent.id].sort());

  const unknown = await (await fetch(`${url}/api/chat/list?triggerId=no-such-trigger`)).json();
  expect(unknown.chats).toEqual([]);
});

test('chat: GET /api/chat/list rejects a malformed triggerId with 400', async () => {
  const { url } = await boot({});
  const res = await fetch(`${url}/api/chat/list?triggerId=Not%20An%20Id`);
  expect(res.status).toBe(400);
  expect((await res.json()).error).toBe('invalid triggerId');
});

test('triggers: a saved-prompt trigger fires only through the route, and still passes the daily cap', async () => {
  const { url } = await boot({ harness: createFakeHarness({ script: fakeScript() }), harnessName: 'fake' });
  const savedPrompt = {
    id: 'weekly-report',
    type: 'saved-prompt',
    config: {},
    promptTemplate: 'Write the weekly report.',
    appScope: [],
    enabled: true,
    limits: { maxRunsPerDay: 1, maxCostPerDay: 5 },
  };
  await postJson(`${url}/api/triggers`, savedPrompt);

  const first = await readSse(await postJson(`${url}/api/triggers/weekly-report/fire`, {}));
  expect(first.find((f) => f.type === 'trigger-complete').fired).toBe(true);

  // maxRunsPerDay is 1 and that run is now in runs.jsonl — the second fire is
  // refused by the cap, not by anything specific to this trigger type.
  const second = await readSse(await postJson(`${url}/api/triggers/weekly-report/fire`, {}));
  const complete = second.find((f) => f.type === 'trigger-complete');
  expect(complete.fired).toBe(false);
  expect(complete.reason).toMatch(/daily run limit/);
});

test('triggers: GET /api/triggers reports supported/unsupportedReason per trigger', async () => {
  const { url } = await boot({});
  await postJson(`${url}/api/triggers`, {
    id: 'watch-clip',
    type: 'clipboard',
    config: { matchPattern: 'https?://' },
    promptTemplate: 'Look at what was copied.',
    appScope: [],
  });

  const listed = (await (await fetch(`${url}/api/triggers`)).json()).triggers[0];
  // Platform-dependent by design (clipboard is Windows-only), so the contract
  // asserted here is the shape, plus the rule that a false MUST come with a
  // reason and a true never does.
  expect(typeof listed.supported).toBe('boolean');
  if (listed.supported) expect(listed.unsupportedReason).toBeNull();
  else expect(typeof listed.unsupportedReason).toBe('string');
  // A clipboard trigger is opt-in: created disabled, never armed by default.
  expect(listed.enabled).toBe(false);
});

// ------------------------------------------------------------- instance token

/** Writes a minimal web build into tmpDir and returns its path, for the static/index.html routes. */
function writeWebDist({ indexHtml = '<!doctype html>\n<html>\n  <head>\n    <title>kaprek</title>\n  </head>\n  <body></body>\n</html>\n' } = {}) {
  const dist = path.join(tmpDir, 'dist');
  fs.mkdirSync(dist, { recursive: true });
  fs.writeFileSync(path.join(dist, 'index.html'), indexHtml, 'utf8');
  fs.writeFileSync(path.join(dist, 'app.js'), 'export const x = 1;\n', 'utf8');
  return dist;
}

test('token: startServer resolves with a 64-hex instance token and persists it in dataDir', async () => {
  const { token } = await boot({});
  expect(token).toMatch(/^[0-9a-f]{64}$/);
  expect(fs.readFileSync(path.join(dataDir, 'instance-token'), 'utf8')).toBe(token);
});

test('token: a missing token is 401 on every API route, GET included', async () => {
  const { url } = await boot({});
  for (const target of ['/api/projects', '/api/triggers', '/api/chat/list', '/api/search?q=x']) {
    const res = await rawFetch(`${url}${target}`);
    expect(res.status).toBe(401);
    expect(await res.text()).toBe(''); // no hint about what was wrong
  }
});

test('token: a missing token is 401 on a write route too — before the CSRF check ever runs', async () => {
  const { url } = await boot({});
  const res = await rawFetch(`${url}/api/board/tasks`, {
    method: 'POST',
    headers: APP_JSON_HEADERS, // CSRF header present and correct
    body: JSON.stringify({ title: 'should never be created' }),
  });
  expect(res.status).toBe(401);

  // And nothing was created behind that 401.
  const list = await (await fetch(`${url}/api/board/tasks`)).json();
  expect(list.tasks).toEqual([]);
});

test('token: a wrong token is 401, the right one is 200', async () => {
  const { url, token } = await boot({});
  const wrong = await rawFetch(`${url}/api/projects`, { headers: { [TOKEN_HEADER]: 'f'.repeat(64) } });
  expect(wrong.status).toBe(401);

  // Same length, one character off — the comparison is exact, not a prefix.
  const nearMiss = await rawFetch(`${url}/api/projects`, { headers: { [TOKEN_HEADER]: `${token.slice(0, -1)}${token.endsWith('0') ? '1' : '0'}` } });
  expect(nearMiss.status).toBe(401);

  const right = await rawFetch(`${url}/api/projects`, { headers: { [TOKEN_HEADER]: token } });
  expect(right.status).toBe(200);
});

test('token: another installation\'s token (a different dataDir) is rejected', async () => {
  const otherDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'server-test-other-'));
  try {
    const other = await startServer({ port: 0, rootDir: tmpDir, dataDir: otherDataDir, tmpRoot: tmpRootDir });
    servers.push(other);
    const { url, token } = await boot({});
    expect(other.token).not.toBe(token);

    const res = await rawFetch(`${url}/api/projects`, { headers: { [TOKEN_HEADER]: other.token } });
    expect(res.status).toBe(401);
  } finally {
    fs.rmSync(otherDataDir, { recursive: true, force: true });
  }
});

test('token: index.html is served WITHOUT a token and carries it in a <meta> tag the client can read', async () => {
  const webDist = writeWebDist();
  const { url, token } = await boot({ webDist });

  const res = await rawFetch(`${url}/`); // no token header at all
  expect(res.status).toBe(200);
  const html = await res.text();
  expect(html).toContain(`<meta name="kaprek-token" content="${token}">`);
  // Injected inside <head>, not appended after </html>.
  expect(html.indexOf('kaprek-token')).toBeLessThan(html.indexOf('</head>'));

  // The token read out of that document is the one the API accepts.
  const fromMeta = html.match(/<meta name="kaprek-token" content="([0-9a-f]{64})">/)[1];
  const api = await rawFetch(`${url}/api/projects`, { headers: { [TOKEN_HEADER]: fromMeta } });
  expect(api.status).toBe(200);
});

test('token: the token-carrying index.html is sent with Cache-Control: no-store', async () => {
  const webDist = writeWebDist();
  const { url } = await boot({ webDist });
  const res = await rawFetch(`${url}/`);
  // A cached copy of this document is the token sitting in the browser's
  // on-disk cache after the session that minted it is long gone.
  expect(res.headers.get('cache-control')).toBe('no-store');
  await res.text();
});

test('token: static assets (JS) are served without a token — the browser needs them before it can read the meta tag', async () => {
  const webDist = writeWebDist();
  const { url } = await boot({ webDist });
  const res = await rawFetch(`${url}/app.js`);
  expect(res.status).toBe(200);
  expect(res.headers.get('content-type')).toContain('javascript');
});

test('token: the SPA fallback route also injects the token (it serves index.html too)', async () => {
  const webDist = writeWebDist();
  const { url, token } = await boot({ webDist });
  const html = await (await rawFetch(`${url}/some/deep/client-route`)).text();
  expect(html).toContain(`content="${token}"`);
});

test('token: a document without a <head> still gets the meta tag, at the very top', async () => {
  const webDist = writeWebDist({ indexHtml: '<body>no head here</body>\n' });
  const { url, token } = await boot({ webDist });
  const html = await (await rawFetch(`${url}/`)).text();
  expect(html.startsWith(`<meta name="kaprek-token" content="${token}">`)).toBe(true);
});

test('token: it never reaches the chat store verbatim — a turn mentioning it is persisted redacted', async () => {
  const { url, token } = await boot({ harness: createFakeHarness({ script: fakeScript() }), harnessName: 'fake' });

  const res = await postJson(`${url}/api/chat/turn`, { text: `remember my token ${token} please` });
  const frames = await readSse(res);
  const chatId = frames[0].chatId;

  const stored = await (await fetch(`${url}/api/chat/${chatId}`)).json();
  const userEvent = stored.events.find((e) => e.kind === 'user');
  expect(userEvent.text).toContain('[REDACTED]');
  expect(userEvent.text).not.toContain(token);

  // Not just the API projection — the bytes on disk must not carry it either.
  const eventsRaw = fs.readFileSync(path.join(dataDir, 'chats', chatId, 'events.jsonl'), 'utf8');
  expect(eventsRaw).not.toContain(token);
});
