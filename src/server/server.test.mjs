// Tests for the local HTTP API server. Run: npx vitest run src/server
//
// Exercises a real server on an ephemeral port (127.0.0.1) via the Node
// built-in fetch — no external network involved, no mocks for node:http.
import { test, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import nodeHttp from 'node:http';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { EventEmitter } from 'node:events';
import { startServer, createSseQueue, effectiveApprovalDeadline, DEFERRAL_MESSAGE, parseRelayAnswer } from './server.mjs';
import { TOKEN_HEADER } from './token.mjs';
import { createFakeHarness } from '../harness/fake.mjs';
import { appendRun } from '../orchestrator/runs.mjs';
import { MAX_TRIGGER_TURNS_PER_HOUR } from '../triggers/limits.mjs';
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
  expect(searchBody).toEqual({ available: false, reason: 'no sqlite here', future: false });

  const reindexRes = await fetch(`${url}/api/search/reindex`, { method: 'POST', headers: APP_HEADERS });
  expect(reindexRes.status).toBe(200);
  const reindexBody = await reindexRes.json();
  expect(reindexBody).toEqual({
    available: false,
    reason: 'no sqlite here',
    future: false,
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

test('triggers: a question trigger is no longer blocked by "nobody is streaming" — the server wires the durable inbox', async () => {
  const harness = gatedHarness();
  const { url } = await boot({ harness, harnessName: 'fake' });
  await postJson(`${url}/api/triggers`, everyMinutesTrigger({ id: 'ask-me', escalation: 'question' }));
  await postJson(`${url}/api/triggers`, everyMinutesTrigger({ id: 'quiet-one', escalation: 'notify' }));

  const statusOf = async (id) => {
    const body = await (await fetch(`${url}/api/triggers`)).json();
    return body.triggers.find((t) => t.id === id);
  };

  // Nothing is streaming here, and it no longer matters: a question raised now
  // is written to <dataDir>/approvals.json and can be looked up later (see
  // approval-store.mjs). The old refusal — 'needs an open UI to ask for
  // approval' — was correct only while a question could ONLY be pushed.
  expect(await statusOf('ask-me')).toMatchObject({ approvalPath: 'inbox', blocked: null });
  // A notify trigger decides in kaprek's own code and never needed either.
  expect(await statusOf('quiet-one')).toMatchObject({ approvalPath: 'policy', blocked: null });

  // Still true with a stream open — the inbox is the path either way; a live
  // stream only makes the question arrive faster.
  const turnRes = await postJson(`${url}/api/chat/turn`, { text: 'hold the stream open' });
  await harness.started;
  expect(await statusOf('ask-me')).toMatchObject({ approvalPath: 'inbox', blocked: null });

  harness.release();
  await readSse(turnRes);
  expect(await statusOf('ask-me')).toMatchObject({ approvalPath: 'inbox', blocked: null });
});

/** A harness whose turn raises one approval and then blocks on the answer — the unattended case, with no stream anywhere. */
function inboxApprovalHarness() {
  let markAsked;
  const asked = new Promise((resolve) => {
    markAsked = resolve;
  });
  return {
    asked,
    async startTurn({ onEvent, onApprovalRequest } = {}) {
      onEvent?.({ type: 'init', sessionId: 's1', tools: [], model: 'm', permissionMode: 'default' });
      const pending = onApprovalRequest({ id: 'night-1', toolName: 'Bash', displayName: 'Bash', input: { command: 'ls' } });
      markAsked();
      const decision = await pending;
      onEvent?.({ type: 'text', text: `decision was ${decision.behavior}` });
      onEvent?.({ type: 'result', sessionId: 's1', costUsd: 0, usage: {}, isError: false });
      return { sessionId: 's1', costUsd: 0, usage: {}, stopReason: 'result', error: null };
    },
  };
}

test('triggers: a question trigger driven by a background tick DOES start a turn with nothing streaming, and its question waits in GET /api/approvals', async () => {
  const harness = inboxApprovalHarness();
  // A minute, not the real eight hours: a failing assertion below must not
  // leave an eight-hour timer armed behind it.
  const { url, runner } = await boot({ harness, harnessName: 'fake', unattendedApprovalTimeoutMs: 60_000 });
  await postJson(`${url}/api/triggers`, everyMinutesTrigger({ id: 'ask-me', escalation: 'question' }));

  // Reaches fireTrigger the way a tick does — cause.origin is the trigger's
  // own type, never 'user'. No HTTP route can produce that, and waiting on the
  // real 60-second timer is not a test.
  const firing = runner.fireTrigger('ask-me', { cause: { origin: 'schedule' } });
  await harness.asked;

  // THE POINT OF THE WHOLE FEATURE: no SSE stream was ever open — not during
  // the request, not before it — and the question is still there to be found.
  const inbox = await (await fetch(`${url}/api/approvals`)).json();
  expect(inbox.approvals).toHaveLength(1);
  expect(inbox.approvals[0]).toMatchObject({
    id: 'night-1',
    toolName: 'Bash',
    input: { command: 'ls' },
    source: { kind: 'trigger', triggerId: 'ask-me' },
  });
  expect(typeof inbox.approvals[0].chatId).toBe('string');

  // And it is answerable through the route the live dialog already uses.
  const decided = await postJson(`${url}/api/approvals/night-1`, { chatId: inbox.approvals[0].chatId, behavior: 'allow' });
  expect(decided.status).toBe(200);

  const result = await firing;
  expect(result.fired).toBe(true);
  // Answered, so it is out of the inbox — not still sitting there to be
  // answered a second time.
  expect((await (await fetch(`${url}/api/approvals`)).json()).approvals).toEqual([]);
});

test('approvals: an entry left behind by a previous process is refused with 410 and names why, instead of a misleading 404', async () => {
  // What a killed server leaves on disk: an entry still marked pending, from
  // a process that is gone. Written BEFORE this server starts, because that
  // is when the store reads it — the same order a real restart produces.
  const chatId = '11111111-2222-3333-4444-555555555555';
  fs.writeFileSync(
    path.join(dataDir, 'approvals.json'),
    JSON.stringify({
      version: 1,
      approvals: [{ id: `${chatId}:old-1`, requestId: 'old-1', chatId, status: 'pending', toolName: 'Bash', requestedAt: Date.now() }],
    }),
    'utf8',
  );
  const { url } = await boot({});

  const res = await postJson(`${url}/api/approvals/old-1`, { chatId, behavior: 'allow' });
  expect(res.status).toBe(410);
  expect((await res.json()).error).toMatch(/process gone/);
  // It is not offered as answerable either.
  expect((await (await fetch(`${url}/api/approvals`)).json()).approvals).toEqual([]);
});

/**
 * A harness for the broadcast test: the FIRST turn parks until released (the
 * chat turn holding a stream open), the SECOND raises an approval (the
 * background trigger's turn). Ordered by construction — the test only fires
 * the trigger once the first turn is provably in flight.
 */
function chatThenApprovalHarness() {
  let markStarted;
  let release;
  const started = new Promise((resolve) => {
    markStarted = resolve;
  });
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  let turns = 0;
  return {
    started,
    release: () => release(),
    async startTurn({ onEvent, onApprovalRequest } = {}) {
      turns += 1;
      if (turns === 1) {
        markStarted();
        await gate;
        onEvent?.({ type: 'result', sessionId: 's1', costUsd: 0, usage: {}, isError: false });
        return { sessionId: 's1', costUsd: 0, usage: {}, stopReason: 'result', error: null };
      }
      const decision = await onApprovalRequest({ id: 'bg-approval-1', toolName: 'Bash', displayName: 'Bash', input: { command: 'ls' } });
      onEvent?.({ type: 'text', text: `decision was ${decision.behavior}` });
      onEvent?.({ type: 'result', sessionId: 's2', costUsd: 0, usage: {}, isError: false });
      return { sessionId: 's2', costUsd: 0, usage: {}, stopReason: 'result', error: null };
    },
  };
}

test('triggers: an approval for a chat nobody streams is delivered to whatever stream IS open', async () => {
  // A background trigger creates its own chat, so no client is watching THAT
  // chatId — the question used to go to a no-op writer and be auto-denied ten
  // minutes later (codex-tag3.md F6).
  const harness = chatThenApprovalHarness();
  const { url, runner } = await boot({ harness, harnessName: 'fake' });
  await postJson(`${url}/api/triggers`, everyMinutesTrigger({ id: 'ask-me', escalation: 'question' }));

  const turnRes = await postJson(`${url}/api/chat/turn`, { text: 'a completely unrelated chat' });
  await harness.started;

  const seen = [];
  const reading = readSse(turnRes, async (frame) => {
    seen.push(frame);
    if (frame.type !== 'approval') return;
    const decideRes = await postJson(`${url}/api/approvals/${frame.id}`, { chatId: frame.chatId, behavior: 'deny' });
    expect(decideRes.status).toBe(200);
    harness.release();
  });

  const result = await runner.fireTrigger('ask-me', { cause: { origin: 'schedule' }, onEvent: () => {} });
  await reading;
  expect(result.fired).toBe(true);

  const approval = seen.find((f) => f.type === 'approval');
  expect(approval).toMatchObject({ type: 'approval', id: 'bg-approval-1', toolName: 'Bash' });
  // Arriving unannounced in someone else's chat, it has to say what asked.
  expect(approval.source).toEqual({ kind: 'trigger', triggerId: 'ask-me', title: expect.any(String) });
  // The frame carries the TRIGGER's chat, not the chat this stream belongs to
  // — which is exactly why the answer has to send that chatId back, and why a
  // client can answer a question about a chat it is not watching.
  expect(approval.chatId).toBe(result.chatId);
  expect(approval.chatId).not.toBe(seen[0].chatId);
});

test('triggers: a "question" trigger fired over HTTP streams its question live AND files it, and the answer runs in a follow-up turn', async () => {
  // The live frame is still sent — a tab that happens to be open sees the
  // question immediately. What changed is what the turn does about it: it is
  // told the action is filed and finishes, so the frame is an FYI rather than
  // a prompt the turn is blocked on. Answering therefore comes AFTER the turn
  // ends, and starts a second one.
  const harness = askingHarness([
    [{ id: 'trigger-approve-1', toolName: 'Bash', displayName: 'Bash', input: { command: 'ls' } }],
    [{ id: 'follow-1', toolName: 'Bash', displayName: 'Bash', input: { command: 'ls' } }],
  ]);
  const { url } = await boot({ harness, harnessName: 'fake' });
  await postJson(`${url}/api/triggers`, everyMinutesTrigger({ id: 'ask-me', escalation: 'question' }));

  const listed = (await (await fetch(`${url}/api/triggers`)).json()).triggers.find((t) => t.id === 'ask-me');
  expect(listed).toMatchObject({ approvalPath: 'inbox', blocked: null });

  const res = await fetch(`${url}/api/triggers/ask-me/fire`, { method: 'POST', headers: APP_JSON_HEADERS });
  const frames = await readSse(res);

  const approvalFrame = frames.find((f) => f.type === 'approval');
  expect(approvalFrame).toMatchObject({ id: 'trigger-approve-1', toolName: 'Bash', mode: 'deferred' });
  expect(approvalFrame.chatId).toBe(frames[0].chatId);
  expect(frames.find((f) => f.type === 'trigger-complete')).toMatchObject({ fired: true });

  // Answering it now — the turn is over, so the follow-up can start.
  const decideRes = await postJson(`${url}/api/approvals/trigger-approve-1`, { chatId: approvalFrame.chatId, behavior: 'allow' });
  expect(decideRes.status).toBe(200);
  expect(await decideRes.json()).toMatchObject({ followUp: true });
  await vi.waitFor(() => expect(harness.turns).toBe(2), { timeout: 4_000 });
  // The approved call ran without asking again.
  expect(harness.decisions.find((d) => d.turn === 2).decision).toEqual({ behavior: 'allow' });
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

test('apps: GET /api/apps returns display metadata per app', async () => {
  const bundledDir = fs.mkdtempSync(path.join(os.tmpdir(), 'server-test-apps-'));
  writeApp(bundledDir, 'shipped');
  writeApp(bundledDir, 'sensitive', {
    policy: { fsWrite: true, dataEgress: true, externalAction: 'approval', sensitivity: 'high' },
  });

  const { url } = await boot({ bundledAppsDir: bundledDir });
  const res = await fetch(`${url}/api/apps`);
  expect(res.status).toBe(200);
  const body = await res.json();

  expect(body.errors).toEqual([]);
  expect(body.blocked).toEqual([]);
  const byId = Object.fromEntries(body.apps.map((app) => [app.id, app]));
  expect(Object.keys(byId).sort()).toEqual(['sensitive', 'shipped']);
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
  expect(byId.sensitive.policy).toEqual({ fsWrite: true, dataEgress: true, externalAction: 'approval', sensitivity: 'high' });

  fs.rmSync(bundledDir, { recursive: true, force: true });
});

test('apps: KAPREK_ALLOW_USER_APPS=1 loads a third-party app again, source "user"', async () => {
  const bundledDir = fs.mkdtempSync(path.join(os.tmpdir(), 'server-test-apps-'));
  writeApp(path.join(dataDir, 'apps'), 'weather');
  const previous = process.env.KAPREK_ALLOW_USER_APPS;
  process.env.KAPREK_ALLOW_USER_APPS = '1';
  try {
    const { url } = await boot({ bundledAppsDir: bundledDir });
    const body = await (await fetch(`${url}/api/apps`)).json();
    expect(body.apps.map((app) => [app.id, app.source])).toEqual([['weather', 'user']]);
    expect(body.blocked).toEqual([]);
  } finally {
    if (previous === undefined) delete process.env.KAPREK_ALLOW_USER_APPS;
    else process.env.KAPREK_ALLOW_USER_APPS = previous;
    fs.rmSync(bundledDir, { recursive: true, force: true });
  }
});

test('apps: a third-party app under <dataDir>/apps is listed as blocked, not loaded', async () => {
  const bundledDir = fs.mkdtempSync(path.join(os.tmpdir(), 'server-test-apps-'));
  writeApp(bundledDir, 'shipped');
  writeApp(path.join(dataDir, 'apps'), 'weather');

  const { url } = await boot({ bundledAppsDir: bundledDir });
  const body = await (await fetch(`${url}/api/apps`)).json();

  expect(body.apps.map((app) => app.id)).toEqual(['shipped']);
  // Not an error — the app is fine, it is switched off until worker isolation.
  expect(body.errors).toEqual([]);
  expect(body.blocked).toEqual([{ id: 'weather' }]);
  // Directory name only: no manifest fields, and above all no path.
  expect(Object.keys(body.blocked[0])).toEqual(['id']);

  fs.rmSync(bundledDir, { recursive: true, force: true });
});

test('apps: a blocked third-party app is invisible to the trigger authorization too', async () => {
  // The same loadApps() answer backs appScope validation (see startServer's
  // installedAppIds), so an app that is not loaded cannot be granted either.
  const bundledDir = fs.mkdtempSync(path.join(os.tmpdir(), 'server-test-apps-'));
  writeApp(path.join(dataDir, 'apps'), 'weather');
  const { url } = await boot({ bundledAppsDir: bundledDir });

  const res = await postJson(`${url}/api/triggers`, everyMinutesTrigger({ appScope: ['weather'] }));
  expect(res.status).toBe(400);
  expect((await res.json()).field).toBe('appScope');

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
  for (const target of ['/api/projects', '/api/triggers', '/api/chat/list', '/api/search?q=x', '/api/approvals']) {
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

// ------------------------------------------------------------- appScope is bound to installed apps

/** Writes a minimal, valid app.json into a bundled-apps dir, so an appScope can legitimately name it. */
function writeBundledApp(baseDir, id, tools = []) {
  const appDir = path.join(baseDir, id);
  fs.mkdirSync(appDir, { recursive: true });
  const manifest = {
    id,
    version: '1.0.0',
    name: id,
    description: `${id} app for tests`,
    tools: tools.map((toolId) => ({ id: toolId, description: `desc for ${toolId}`, inputSchema: { type: 'object' }, handler: 'handler.mjs' })),
    policy: { fsWrite: false, dataEgress: false, externalAction: 'never', sensitivity: 'low' },
  };
  fs.writeFileSync(path.join(appDir, 'app.json'), JSON.stringify(manifest), 'utf8');
  return appDir;
}

test('triggers: POST /api/triggers rejects an appScope naming a CLI tool instead of an installed app', async () => {
  const bundledAppsDir = path.join(tmpDir, 'apps');
  writeBundledApp(bundledAppsDir, 'notes', ['notes.write']);
  const { url } = await boot({ bundledAppsDir });

  const res = await postJson(`${url}/api/triggers`, everyMinutesTrigger({ appScope: ['Bash'] }));
  expect(res.status).toBe(400);
  const body = await res.json();
  expect(body.field).toBe('appScope');
  expect(body.error).toMatch(/unknown app id "Bash"/);

  // Nothing was stored behind that 400.
  expect((await (await fetch(`${url}/api/triggers`)).json()).triggers).toEqual([]);
});

test('triggers: POST /api/triggers accepts an appScope naming an app that IS installed', async () => {
  const bundledAppsDir = path.join(tmpDir, 'apps');
  writeBundledApp(bundledAppsDir, 'notes', ['notes.write']);
  const { url } = await boot({ bundledAppsDir });

  const res = await postJson(`${url}/api/triggers`, everyMinutesTrigger({ appScope: ['notes'] }));
  expect(res.status).toBe(200);
  expect((await res.json()).appScope).toEqual(['notes']);
});

test('triggers: a hand-edited triggers.json with appScope:["Bash"] loads with an EMPTY effective scope', async () => {
  const bundledAppsDir = path.join(tmpDir, 'apps');
  writeBundledApp(bundledAppsDir, 'notes', ['notes.write']);
  // Straight to disk, past the API's validation — the route a hand edit takes.
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(
    path.join(dataDir, 'triggers.json'),
    JSON.stringify({
      version: 1,
      triggers: [
        {
          ...everyMinutesTrigger({ appScope: ['Bash', 'notes'] }),
          escalation: 'notify',
          approvalRequired: false,
          limits: { maxRunsPerDay: 24, maxCostPerDay: 1 },
        },
      ],
    }),
    'utf8',
  );

  const { url } = await boot({ bundledAppsDir });
  const listed = (await (await fetch(`${url}/api/triggers`)).json()).triggers[0];
  expect(listed.appScope).toEqual(['notes']); // "Bash" is gone, the trigger is not
  expect(listed.enabled).toBe(true);
});

test('triggers: GET /api/triggers reports a capped trigger as blocked, with cost marked estimated', async () => {
  const { url } = await boot({});
  await postJson(`${url}/api/triggers`, everyMinutesTrigger({ limits: { maxRunsPerDay: 1, maxCostPerDay: 5 } }));

  const before = (await (await fetch(`${url}/api/triggers`)).json()).triggers[0];
  expect(before.blocked).toBeNull();

  // One run of unknown cost today: the run cap is now used up, and the cost
  // shown is an estimate rather than a measured $0.
  appendRun(dataDir, { ts: new Date().toISOString(), triggerId: 'nightly-sync', origin: 'trigger', costUsd: null });

  const after = (await (await fetch(`${url}/api/triggers`)).json()).triggers[0];
  expect(after.blocked).toMatch(/daily run limit/);
  expect(after.runsToday).toBe(1);
  expect(after.costEstimated).toBe(true);
  expect(after.costToday).toBeGreaterThan(0);
});

test('triggers: the global trigger cap shows up as blocked on every trigger', async () => {
  const { url } = await boot({});
  await postJson(`${url}/api/triggers`, everyMinutesTrigger({ limits: { maxRunsPerDay: 500, maxCostPerDay: 50 } }));
  for (let i = 0; i < MAX_TRIGGER_TURNS_PER_HOUR; i += 1) {
    appendRun(dataDir, { ts: new Date().toISOString(), triggerId: 'some-other-trigger', origin: 'trigger', costUsd: 0 });
  }

  const listed = (await (await fetch(`${url}/api/triggers`)).json()).triggers[0];
  expect(listed.blocked).toMatch(/global trigger cap/);
});

test('triggers: a fire refused by the global cap streams the reason instead of starting a turn', async () => {
  const { url } = await boot({ harness: createFakeHarness({ script: fakeScript() }), harnessName: 'fake' });
  await postJson(`${url}/api/triggers`, everyMinutesTrigger({ limits: { maxRunsPerDay: 500, maxCostPerDay: 50 } }));
  for (let i = 0; i < MAX_TRIGGER_TURNS_PER_HOUR; i += 1) {
    appendRun(dataDir, { ts: new Date().toISOString(), triggerId: 'some-other-trigger', origin: 'trigger', costUsd: 0 });
  }

  const frames = await readSse(await postJson(`${url}/api/triggers/nightly-sync/fire`, {}));
  const complete = frames.find((f) => f.type === 'trigger-complete');
  expect(complete.fired).toBe(false);
  expect(complete.reason).toMatch(/global trigger cap/);
});

// -------------------------------------------------- approval inbox, Fix-Runde 1
//
// Four mechanisms the first round shipped without a test, each of them found by
// a mutant that survived the whole suite (panel findings I2, I4, M6/M7, M10).

/**
 * Waits for the store to have finished writing, then reads the file. The
 * store persists on its own queue (see approval-store.mjs::serialized), so a
 * decision made a moment ago may not be on disk yet; every public store call
 * joins that queue, and GET /api/approvals is one, so a response to it means
 * everything queued before it has landed.
 */
async function settledApprovalsFile(url) {
  await (await fetch(`${url}/api/approvals`)).json();
  return readApprovalsFile();
}

/** Reads the durable inbox straight off disk, for a point where nothing is still queued. */
function readApprovalsFile() {
  const raw = fs.readFileSync(path.join(dataDir, 'approvals.json'), 'utf8');
  return JSON.parse(raw).approvals;
}

/** A harness that raises one approval and parks on it until the test lets go. */
function parkingApprovalHarness(request = { id: 'park-1', toolName: 'Bash', displayName: 'Bash', input: { command: 'ls' } }) {
  let markAsked;
  const asked = new Promise((resolve) => {
    markAsked = resolve;
  });
  return {
    asked,
    async startTurn({ onEvent, onApprovalRequest } = {}) {
      onEvent?.({ type: 'init', sessionId: 's1', tools: [], model: 'm', permissionMode: 'default' });
      const pending = onApprovalRequest(request);
      markAsked();
      const decision = await pending;
      onEvent?.({ type: 'text', text: `decision was ${decision.behavior}` });
      onEvent?.({ type: 'result', sessionId: 's1', costUsd: 0, usage: {}, isError: false });
      return { sessionId: 's1', costUsd: 0, usage: {}, stopReason: 'result', error: null };
    },
  };
}

test('a chat turn is refused 409 while a trigger turn is running in that same chat', async () => {
  // The gate that keeps two CLIs off one transcript. It used to matter for
  // hours at a time, because an unattended turn parked on its question; now it
  // lasts as long as the turn actually works, which is the point of the
  // deferred model. The rule itself is unchanged and still needed - a
  // follow-up turn is a trigger turn like any other.
  const harness = holdingHarness();
  const { url, runner } = await boot({ harness, harnessName: 'fake' });
  await postJson(`${url}/api/triggers`, everyMinutesTrigger({ id: 'busy-one', escalation: 'notify' }));

  const firing = runner.fireTrigger('busy-one', { cause: { origin: 'schedule' } });
  await harness.started;
  const chatId = (await (await fetch(`${url}/api/chat/list?includeSilent=1`)).json()).chats[0].id;

  const res = await postJson(`${url}/api/chat/turn`, { chatId, text: 'unrelated message' });
  expect(res.status).toBe(409);
  expect((await res.json()).error).toMatch(/trigger turn/);

  harness.release();
  await firing;

  // Once it is over, the chat takes turns again.
  const after = await postJson(`${url}/api/chat/turn`, { chatId, text: 'now it is free' });
  expect(after.status).toBe(200);
  await readSse(after);
});

/** A harness that holds its turn open until the test releases it, without involving an approval. */
function holdingHarness() {
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
      onEvent?.({ type: 'result', sessionId: 's1', costUsd: 0, usage: {}, isError: false });
      return { sessionId: 's1', costUsd: 0, usage: {}, stopReason: 'result', error: null };
    },
  };
}

test('a deferred question OUTLIVES its turn, while an interactive one is still released when the turn ends', async () => {
  // Two opposite rules, and the difference is the whole redesign. An
  // interactive question belongs to a live wait: when the turn ends there is
  // nobody to answer and nothing to answer into, so it is resolved and
  // recorded. A deferred question was never a wait - outliving the turn is
  // exactly what it is for, and releasing it would throw away the thing the
  // user is supposed to answer tomorrow.
  const abandoningHarness = {
    async startTurn({ onEvent, onApprovalRequest } = {}) {
      onEvent?.({ type: 'init', sessionId: 's1', tools: [], model: 'm', permissionMode: 'default' });
      // Raised and deliberately not awaited: the turn walks away from it.
      onApprovalRequest({ id: 'abandoned-1', toolName: 'Bash', displayName: 'Bash', input: { command: 'ls' } });
      await Promise.resolve();
      onEvent?.({ type: 'result', sessionId: 's1', costUsd: 0, usage: {}, isError: false });
      return { sessionId: 's1', costUsd: 0, usage: {}, stopReason: 'result', error: null };
    },
  };
  const { url, runner } = await boot({ harness: abandoningHarness, harnessName: 'fake' });
  await postJson(`${url}/api/triggers`, everyMinutesTrigger({ id: 'ask-me', escalation: 'question' }));

  // Unattended: filed, and still there after the turn is long over.
  const scheduled = await runner.fireTrigger('ask-me', { cause: { origin: 'schedule' } });
  expect(scheduled.fired).toBe(true);
  const inbox = (await (await fetch(`${url}/api/approvals`)).json()).approvals;
  expect(inbox.map((e) => e.id)).toEqual(['abandoned-1']);
  expect(inbox[0].mode).toBe('deferred');

  // A CHAT turn is the interactive case: somebody typed it and is looking at
  // the dialog, so its question IS a live wait. When that turn abandons it,
  // it is released rather than left dangling with an armed timer. (A manual
  // trigger fire is NOT this case: it still runs a trigger turn, which files
  // its questions - see the HTTP-route test further down.)
  const chatRes = await postJson(`${url}/api/chat/turn`, { text: 'ask me something' });
  const chatFrames = await readSse(chatRes);
  const chatId = chatFrames[0].chatId;
  const chatEntries = (await settledApprovalsFile(url)).filter((e) => e.chatId === chatId);
  expect(chatEntries).toHaveLength(1);
  expect(chatEntries[0]).toMatchObject({ mode: 'interactive', status: 'decided', decision: { behavior: 'deny', message: 'turn ended' } });
});

test('approvals: the SSE frame carries the server\'s own deadlineAt, so the client never has to guess which of the two deadlines applies', async () => {
  // M10: the web half of this was tested against synthetic frames, so dropping
  // deadlineAt from the server left both suites green. The client would then
  // fall back to its 10-minute constant and sweep an 8-hour trigger question
  // out of the live dialog after ten minutes, buttons and all.
  const { url } = await boot({
    harness: approvalHarness({ request: { id: 'deadline-1', toolName: 'Bash', displayName: 'Bash', input: { command: 'ls' } } }),
    harnessName: 'fake',
    approvalTimeoutMs: 60_000,
  });

  const before = Date.now();
  const res = await postJson(`${url}/api/chat/turn`, { text: 'when do you give up?' });
  let approvalFrame = null;
  await readSse(res, async (frame) => {
    if (frame.type === 'approval' && approvalFrame === null) {
      approvalFrame = frame;
      await postJson(`${url}/api/approvals/${frame.id}`, { chatId: frame.chatId, behavior: 'allow' });
    }
  });
  const after = Date.now();

  expect(approvalFrame.deadlineAt).toBeGreaterThanOrEqual(before + 60_000);
  expect(approvalFrame.deadlineAt).toBeLessThanOrEqual(after + 60_000);
});

// -------------------------------------------------- approval inbox, Fix-Runde 2
//
// One finding, found independently by both external reviewers: a published
// deadline the turn cannot keep. The turn's own wall clock (never paused, see
// timeout.mjs's ABSOLUTE_MS) can be the nearer of the two limits, and every
// question raised late in a turn used to be advertised with the full approval
// deadline anyway — API, SSE frame and inbox all showing hours that did not
// exist.

/** Raises two approvals in one turn: the first answered by the test, the second `gapMs` later. */
function twoQuestionHarness(gapMs = 120) {
  let markFirst;
  let markSecond;
  const first = new Promise((resolve) => {
    markFirst = resolve;
  });
  const second = new Promise((resolve) => {
    markSecond = resolve;
  });
  return {
    first,
    second,
    async startTurn({ onEvent, onApprovalRequest } = {}) {
      onEvent?.({ type: 'init', sessionId: 's1', tools: [], model: 'm', permissionMode: 'default' });
      const one = onApprovalRequest({ id: 'q-1', toolName: 'Bash', displayName: 'Bash', input: { command: 'ls' } });
      markFirst();
      await one;
      await new Promise((resolve) => setTimeout(resolve, gapMs));
      const two = onApprovalRequest({ id: 'q-2', toolName: 'Write', displayName: 'Write', input: { path: 'x' } });
      markSecond();
      const decision = await two;
      onEvent?.({ type: 'text', text: `second decision was ${decision.behavior}` });
      onEvent?.({ type: 'result', sessionId: 's1', costUsd: 0, usage: {}, isError: false });
      return { sessionId: 's1', costUsd: 0, usage: {}, stopReason: 'result', error: null };
    },
  };
}

test('approvals: the cap only ever shortens — a question whose own deadline is the nearer limit keeps it in full', async () => {
  // The cap must not quietly shorten a question that fits inside its turn.
  // A chat turn's clock is the harness default, which the server now passes
  // explicitly so that capping is measured against a fact rather than an
  // assumption; one minute into a 60-minute budget nothing is near it.
  const { url } = await boot({
    harness: approvalHarness({ request: { id: 'uncapped-1', toolName: 'Bash', displayName: 'Bash', input: { command: 'ls' } } }),
    harnessName: 'fake',
    approvalTimeoutMs: 60_000,
  });

  const before = Date.now();
  const res = await postJson(`${url}/api/chat/turn`, { text: 'no cap here' });
  let approvalFrame = null;
  await readSse(res, async (frame) => {
    if (frame.type === 'approval' && approvalFrame === null) {
      approvalFrame = frame;
      await postJson(`${url}/api/approvals/${frame.id}`, { chatId: frame.chatId, behavior: 'allow' });
    }
  });

  expect(approvalFrame.deadlineAt).toBeGreaterThanOrEqual(before + 60_000);
});

test('effectiveApprovalDeadline: the earlier of the two limits wins, and says which one it was', () => {
  // The arithmetic on its own, without a server: three cases and the two
  // degenerate ones a caller can actually produce.
  const asked = 1_000_000;

  // The question fits inside the turn — its own deadline stands, untouched.
  expect(effectiveApprovalDeadline(asked, 60_000, asked + 500_000)).toEqual({ deadlineAt: asked + 60_000, cappedByTurn: false });
  // The turn dies first — capped, and the caller is told so it can name the
  // real cause in the deny.
  expect(effectiveApprovalDeadline(asked, 60_000, asked + 5_000)).toEqual({ deadlineAt: asked + 5_000, cappedByTurn: true });
  // Exactly equal is not a cap: nothing is being shortened.
  expect(effectiveApprovalDeadline(asked, 60_000, asked + 60_000)).toEqual({ deadlineAt: asked + 60_000, cappedByTurn: false });
  // No wall clock known — inventing one would be the same lie in reverse.
  expect(effectiveApprovalDeadline(asked, 60_000, null)).toEqual({ deadlineAt: asked + 60_000, cappedByTurn: false });
  // A turn already past its clock caps to that instant; the caller turns the
  // resulting non-positive delay into an immediate deny rather than a wait
  // nobody can win.
  expect(effectiveApprovalDeadline(asked, 60_000, asked - 10)).toEqual({ deadlineAt: asked - 10, cappedByTurn: true });
});

// ------------------------------------------------ deferred approvals (Paket C)
//
// An unattended question is FILED and the turn carries on. Nothing waits, so
// none of the park model's costs (a held subprocess, an hours-long chat lock,
// a stretched wall clock) apply any more.

test('deferred: an unattended question is filed and the turn is told to carry on, in one step', async () => {
  const seen = [];
  const harness = {
    async startTurn({ onEvent, onApprovalRequest } = {}) {
      onEvent?.({ type: 'init', sessionId: 's1', tools: [], model: 'm', permissionMode: 'default' });
      const decision = await onApprovalRequest({ id: 'q-1', toolName: 'Bash', displayName: 'Bash', input: { command: 'ls' } });
      seen.push(decision);
      // The turn keeps working and ends normally, which is the entire point.
      onEvent?.({ type: 'text', text: 'carried on and finished' });
      onEvent?.({ type: 'result', sessionId: 's1', costUsd: 0, usage: {}, isError: false });
      return { sessionId: 's1', costUsd: 0, usage: {}, stopReason: 'result', error: null };
    },
  };
  const { url, runner } = await boot({ harness, harnessName: 'fake' });
  await postJson(`${url}/api/triggers`, everyMinutesTrigger({ id: 'ask-me', escalation: 'question' }));

  const startedAt = Date.now();
  const result = await runner.fireTrigger('ask-me', { cause: { origin: 'schedule' } });

  expect(result.fired).toBe(true);
  // No parking: the turn did not wait for anybody.
  expect(Date.now() - startedAt).toBeLessThan(3_000);
  expect(seen[0].behavior).toBe('deny');
  expect(seen[0].message).toBe(DEFERRAL_MESSAGE);
  // The wording has to keep the agent working rather than reading a refusal.
  expect(seen[0].message).toMatch(/do NOT retry it in this turn/);
  expect(seen[0].message).toMatch(/finish the turn normally/);

  // And the question is waiting, hours after its turn ended if need be.
  const inbox = (await (await fetch(`${url}/api/approvals`)).json()).approvals;
  expect(inbox).toHaveLength(1);
  expect(inbox[0]).toMatchObject({ id: 'q-1', toolName: 'Bash', mode: 'deferred', askedCount: 1 });
});

/** A harness whose turn asks for `requests` in order and reports what it was told. */
function askingHarness(requests) {
  const decisions = [];
  let turns = 0;
  return {
    decisions,
    get turns() {
      return turns;
    },
    async startTurn({ onEvent, onApprovalRequest } = {}) {
      turns += 1;
      onEvent?.({ type: 'init', sessionId: 's1', tools: [], model: 'm', permissionMode: 'default' });
      for (const request of requests[Math.min(turns, requests.length) - 1] ?? []) {
        decisions.push({ turn: turns, request, decision: await onApprovalRequest(request) });
      }
      onEvent?.({ type: 'result', sessionId: 's1', costUsd: 0, usage: {}, isError: false });
      return { sessionId: 's1', costUsd: 0, usage: {}, stopReason: 'result', error: null };
    },
  };
}

test('deferred: approving runs the action in a follow-up turn, with a one-shot pre-approval for exactly that call', async () => {
  const approved = { id: 'q-1', toolName: 'Bash', displayName: 'Bash', input: { command: 'git push' } };
  const harness = askingHarness([
    [approved],
    // The follow-up turn: the approved call, then the SAME call again (a
    // one-shot approval must not become a licence to repeat it), then a
    // different one.
    [
      { id: 'f-1', toolName: 'Bash', displayName: 'Bash', input: { command: 'git push' } },
      { id: 'f-2', toolName: 'Bash', displayName: 'Bash', input: { command: 'git push' } },
      { id: 'f-3', toolName: 'Bash', displayName: 'Bash', input: { command: 'rm -rf /' } },
    ],
  ]);
  const { url, runner } = await boot({ harness, harnessName: 'fake' });
  await postJson(`${url}/api/triggers`, everyMinutesTrigger({ id: 'ask-me', escalation: 'question' }));

  const first = await runner.fireTrigger('ask-me', { cause: { origin: 'schedule' } });
  const filed = (await (await fetch(`${url}/api/approvals`)).json()).approvals[0];

  const res = await postJson(`${url}/api/approvals/${filed.id}`, { chatId: filed.chatId, behavior: 'allow' });
  expect(res.status).toBe(200);
  expect(await res.json()).toMatchObject({ ok: true, followUp: true });

  await vi.waitFor(() => expect(harness.turns).toBe(2), { timeout: 4_000 });
  await vi.waitFor(() => expect(harness.decisions.filter((d) => d.turn === 2)).toHaveLength(3), { timeout: 4_000 });

  const followUp = harness.decisions.filter((d) => d.turn === 2);
  // Exactly the approved call runs without asking again.
  expect(followUp[0].decision).toEqual({ behavior: 'allow' });
  // The second identical call does NOT: one approval, one execution.
  expect(followUp[1].decision.behavior).toBe('deny');
  expect(followUp[1].decision.message).toBe(DEFERRAL_MESSAGE);
  // And a different call is nowhere near covered by it.
  expect(followUp[2].decision.behavior).toBe('deny');

  // Same chat, so the transcript reads as one story.
  const chats = await (await fetch(`${url}/api/chat/list?includeSilent=1`)).json();
  expect(chats.chats.map((c) => c.id)).toEqual([first.chatId]);
});

test('deferred: the pre-approval matches on content, not on tool name', async () => {
  const harness = askingHarness([
    [{ id: 'q-1', toolName: 'Bash', displayName: 'Bash', input: { command: 'echo one' } }],
    // Same tool, one byte different. This must NOT be waved through.
    [{ id: 'f-1', toolName: 'Bash', displayName: 'Bash', input: { command: 'echo one ' } }],
  ]);
  const { url, runner } = await boot({ harness, harnessName: 'fake' });
  await postJson(`${url}/api/triggers`, everyMinutesTrigger({ id: 'ask-me', escalation: 'question' }));

  await runner.fireTrigger('ask-me', { cause: { origin: 'schedule' } });
  const filed = (await (await fetch(`${url}/api/approvals`)).json()).approvals[0];
  await postJson(`${url}/api/approvals/${filed.id}`, { chatId: filed.chatId, behavior: 'allow' });

  await vi.waitFor(() => expect(harness.decisions.filter((d) => d.turn === 2)).toHaveLength(1), { timeout: 4_000 });
  expect(harness.decisions.find((d) => d.turn === 2).decision.behavior).toBe('deny');
});

test('deferred: denying records the decision and starts nothing', async () => {
  const harness = askingHarness([[{ id: 'q-1', toolName: 'Bash', displayName: 'Bash', input: { command: 'ls' } }]]);
  const { url, runner } = await boot({ harness, harnessName: 'fake' });
  await postJson(`${url}/api/triggers`, everyMinutesTrigger({ id: 'ask-me', escalation: 'question' }));

  await runner.fireTrigger('ask-me', { cause: { origin: 'schedule' } });
  const filed = (await (await fetch(`${url}/api/approvals`)).json()).approvals[0];

  const res = await postJson(`${url}/api/approvals/${filed.id}`, { chatId: filed.chatId, behavior: 'deny' });
  expect(res.status).toBe(200);
  expect(await res.json()).toMatchObject({ ok: true, followUp: false });
  expect(harness.turns).toBe(1);
  expect((await (await fetch(`${url}/api/approvals`)).json()).approvals).toEqual([]);
});

test('deferred: a question filed by a previous process is still answerable after a restart', async () => {
  // The park model could not do this at all: the answer had to reach a promise
  // in a process that no longer existed. A filed question has no such tether.
  const chatId = '11111111-2222-3333-4444-555555555555';
  const requestedAt = Date.now();
  fs.writeFileSync(
    path.join(dataDir, 'approvals.json'),
    JSON.stringify({
      version: 1,
      approvals: [
        {
          id: `${chatId}:old-1`,
          requestId: 'old-1',
          chatId,
          triggerId: 'ask-me',
          mode: 'deferred',
          status: 'pending',
          toolName: 'Bash',
          input: { command: 'ls' },
          requestedAt,
          deadlineAt: requestedAt + 60_000,
          askedCount: 1,
        },
      ],
    }),
    'utf8',
  );
  const { url } = await boot({});

  const inbox = (await (await fetch(`${url}/api/approvals`)).json()).approvals;
  expect(inbox.map((e) => e.id)).toEqual(['old-1']);
  // Denying needs no turn and must simply work.
  const res = await postJson(`${url}/api/approvals/old-1`, { chatId, behavior: 'deny' });
  expect(res.status).toBe(200);
});

test('deferred: a trigger fired over its own HTTP route defers too — the route a person actually presses', async () => {
  // THE GAP THE LIVE RUN FOUND. Every deferred test so far drove
  // runner.fireTrigger() directly with cause.origin 'schedule'. The real
  // route, POST /api/triggers/<id>/fire, passes cause.origin 'user' — and the
  // mode was decided from exactly that field, so the one path a person can
  // actually take was still the parking path. The turn blocked on its
  // question, the SSE stream never finished, and the entry landed as
  // 'interactive'.
  //
  // Driven through the HTTP route on purpose: the runner-level tests cannot
  // see this, because the wiring that was wrong lives between the route and
  // the handler.
  const asked = [];
  const harness = {
    async startTurn({ onEvent, onApprovalRequest } = {}) {
      onEvent?.({ type: 'init', sessionId: 's1', tools: [], model: 'm', permissionMode: 'default' });
      asked.push(await onApprovalRequest({ id: 'http-1', toolName: 'Bash', displayName: 'Bash', input: { command: 'ls' } }));
      onEvent?.({ type: 'text', text: 'carried on' });
      onEvent?.({ type: 'result', sessionId: 's1', costUsd: 0, usage: {}, isError: false });
      return { sessionId: 's1', costUsd: 0, usage: {}, stopReason: 'result', error: null };
    },
  };
  const { url } = await boot({ harness, harnessName: 'fake' });
  await postJson(`${url}/api/triggers`, everyMinutesTrigger({ id: 'ask-me', escalation: 'question' }));

  // The stream has to END. Under the bug it stayed open until the client gave
  // up, because the turn was parked on an answer nobody was going to give.
  const res = await fetch(`${url}/api/triggers/ask-me/fire`, { method: 'POST', headers: APP_JSON_HEADERS });
  const frames = await readSse(res);
  expect(frames.find((f) => f.type === 'trigger-complete')).toMatchObject({ fired: true });

  // The turn was told to carry on rather than left waiting.
  expect(asked[0]).toMatchObject({ behavior: 'deny', message: DEFERRAL_MESSAGE });

  // And the entry is a filed question, not a live wait.
  const entry = (await settledApprovalsFile(url)).find((e) => e.requestId === 'http-1');
  expect(entry).toMatchObject({ mode: 'deferred', status: 'pending', toolName: 'Bash' });
  expect((await (await fetch(`${url}/api/approvals`)).json()).approvals).toHaveLength(1);
});

// ------------------------------------------ the replay must actually replay
//
// A live run found the hole these cover: approving marked the entry decided
// and started a follow-up turn, that turn died on an ask-policy coverage gap
// BEFORE running anything, and the approval was gone. The command never ran,
// the entry read decided/allow, and nobody could approve it again.

/**
 * A harness whose follow-up turn fails with a coverage gap for its first
 * `failures` attempts, exactly as the real CLI does when it reports a tool the
 * ask list has never seen (the tools are learned on the way out, so the next
 * attempt normally succeeds).
 */
function coverageGapHarness({ failures }) {
  let turns = 0;
  const attempts = [];
  return {
    get turns() {
      return turns;
    },
    attempts,
    async startTurn({ onEvent, onApprovalRequest } = {}) {
      turns += 1;
      onEvent?.({ type: 'init', sessionId: 's1', tools: [], model: 'm', permissionMode: 'default' });
      if (turns === 1) {
        // Turn 1: the trigger's own turn, which files its question.
        attempts.push({ turn: turns, decision: await onApprovalRequest({ id: 'q-1', toolName: 'Bash', displayName: 'Bash', input: { command: 'ls' } }) });
        onEvent?.({ type: 'result', sessionId: 's1', costUsd: 0, usage: {}, isError: false });
        return { sessionId: 's1', costUsd: 0, usage: {}, stopReason: 'result', error: null };
      }

      const replayAttempt = turns - 1;
      if (replayAttempt <= failures) {
        // Killed before any tool call, which is the whole point: the approved
        // action cannot have run.
        return {
          sessionId: 's1',
          costUsd: null,
          usage: null,
          stopReason: 'error',
          error: { message: 'ask-policy coverage gap: CLI reports tool(s) not in the ask list: ListMcpResources (learned for future turns)' },
        };
      }
      attempts.push({ turn: turns, decision: await onApprovalRequest({ id: `f-${replayAttempt}`, toolName: 'Bash', displayName: 'Bash', input: { command: 'ls' } }) });
      onEvent?.({ type: 'result', sessionId: 's1', costUsd: 0, usage: {}, isError: false });
      return { sessionId: 's1', costUsd: 0, usage: {}, stopReason: 'result', error: null };
    },
  };
}

test('replay: a coverage gap on the first attempt is retried at once, and the approved action still runs', async () => {
  const harness = coverageGapHarness({ failures: 1 });
  const { url, runner } = await boot({ harness, harnessName: 'fake' });
  await postJson(`${url}/api/triggers`, everyMinutesTrigger({ id: 'ask-me', escalation: 'question' }));

  await runner.fireTrigger('ask-me', { cause: { origin: 'schedule' } });
  const filed = (await (await fetch(`${url}/api/approvals`)).json()).approvals[0];
  expect(await postJson(`${url}/api/approvals/${filed.id}`, { chatId: filed.chatId, behavior: 'allow' })).toMatchObject({ status: 200 });

  // Three turns in total: the trigger's own, the one that hit the gap, and the
  // retry that got through.
  await vi.waitFor(() => expect(harness.turns).toBe(3), { timeout: 4_000 });
  const replayDecision = harness.attempts.find((a) => a.turn === 3);
  expect(replayDecision.decision).toEqual({ behavior: 'allow' });

  // The approval was consumed by a run that happened, so it stays decided.
  const entry = (await settledApprovalsFile(url)).find((e) => e.requestId === 'q-1');
  expect(entry).toMatchObject({ status: 'decided', decision: { behavior: 'allow' } });
  expect((await (await fetch(`${url}/api/approvals`)).json()).approvals).toEqual([]);

  // And the replay is identifiable as one in the run log.
  const runs = fs
    .readFileSync(path.join(dataDir, 'runs.jsonl'), 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
  const replays = runs.filter((run) => run.replayOf);
  expect(replays.length).toBeGreaterThanOrEqual(1);
  expect(replays.every((run) => run.replayOf === `${filed.chatId}:q-1`)).toBe(true);
  // The trigger's own turn is not marked as a replay of anything.
  expect(runs[0].replayOf).toBeNull();
});

test('replay: when both attempts die before the action, the approval is handed back instead of burnt', async () => {
  // Without this the user has authorised something that never happened, with
  // no way to see it and no way to approve it again.
  const harness = coverageGapHarness({ failures: 2 });
  const { url, runner } = await boot({ harness, harnessName: 'fake' });
  await postJson(`${url}/api/triggers`, everyMinutesTrigger({ id: 'ask-me', escalation: 'question' }));

  await runner.fireTrigger('ask-me', { cause: { origin: 'schedule' } });
  const filed = (await (await fetch(`${url}/api/approvals`)).json()).approvals[0];
  expect(await postJson(`${url}/api/approvals/${filed.id}`, { chatId: filed.chatId, behavior: 'allow' })).toMatchObject({ status: 200 });

  await vi.waitFor(() => expect(harness.turns).toBe(3), { timeout: 4_000 });

  // Back on the queue, answerable again, and carrying the reason it came back.
  const reopened = await vi.waitFor(
    async () => {
      const list = (await (await fetch(`${url}/api/approvals`)).json()).approvals;
      expect(list).toHaveLength(1);
      return list[0];
    },
    { timeout: 4_000 },
  );
  expect(reopened.id).toBe('q-1');

  const entry = (await settledApprovalsFile(url)).find((e) => e.requestId === 'q-1');
  expect(entry).toMatchObject({ status: 'pending', decision: null });
  expect(entry.replayFailedReason).toMatch(/coverage gap/);
  expect(typeof entry.replayFailedAt).toBe('number');

  // And approving it again is accepted, rather than 409 'already decided'.
  const second = await postJson(`${url}/api/approvals/q-1`, { chatId: filed.chatId, behavior: 'allow' });
  expect(second.status).toBe(200);
});

/**
 * A harness whose turns answer in the relay's shape, plus a stub grok peer.
 * Neither ever reaches a real CLI: `boot` is handed the stub through
 * startServer's getPeerDriver option.
 */
function relayReviewHarness(statuses) {
  let call = 0;
  return {
    async startTurn({ onEvent } = {}) {
      const status = statuses[Math.min(call, statuses.length - 1)];
      call += 1;
      onEvent?.({ type: 'init', sessionId: 's1', tools: [], model: 'm', permissionMode: 'default' });
      onEvent?.({ type: 'text', text: JSON.stringify({ status, message: `review ${call}` }) });
      onEvent?.({ type: 'result', sessionId: 's1', costUsd: 0, usage: {}, isError: false });
      return { sessionId: 's1', costUsd: 0, usage: {}, stopReason: 'result', error: null };
    },
  };
}

/**
 * Boots a server with ONE stub peer for the whole run. Creating a stub per
 * lookup would restart its counter, every draft would come out identical, and
 * the run would stop on "same output twice" - which is the no-progress guard
 * doing its job on a bug in the test.
 */
async function bootRelay(opts) {
  const grok = stubGrokDriver();
  return boot({ ...opts, getPeerDriver: (id) => (id === 'grok' ? grok : null) });
}

/** The grok side of a relay test: answers in shape, spawns nothing. */
function stubGrokDriver() {
  let call = 0;
  return {
    id: 'grok',
    available: () => true,
    async runTurn() {
      call += 1;
      return { status: 'handoff', message: `draft ${call}`, usage: null, costUsd: null, durationMs: 1, rawLogPath: null };
    },
  };
}

// ------------------------------------------------------- the relay, end to end
//
// Driven through the routes a person actually uses, for the reason the last
// two live runs taught: the wiring between a route and the thing it starts is
// exactly where the tests below the route cannot see.

/** A relay gate answered through the ordinary approvals route, which is the only route there is for it. */
async function answerGate(url, entry, behavior) {
  return postJson(`${url}/api/approvals/${entry.id}`, { chatId: entry.chatId, behavior });
}

test('relay: a run started from a chat hands off along its route and files one gate', async () => {
  // The whole point in one test: start once, watch two handoffs happen on
  // their own, get exactly one decision to make.
  const { url } = await bootRelay({ harness: relayReviewHarness(['handoff', 'handoff']), harnessName: 'fake' });
  await readSse(await postJson(`${url}/api/chat/turn`, { text: 'set up the batch' }));
  const chatId = (await (await fetch(`${url}/api/chat/list?includeSilent=1`)).json()).chats[0].id;

  const started = await postJson(`${url}/api/chat/${chatId}/relay`, { goal: 'write the batch' });
  expect(started.status).toBe(200);
  const { runId } = await started.json();
  expect(typeof runId).toBe('string');

  const gate = await vi.waitFor(
    async () => {
      const list = (await (await fetch(`${url}/api/approvals`)).json()).approvals;
      const found = list.find((entry) => entry.kind === 'relay.gate');
      if (!found) {
        const { chat, events } = await (await fetch(`${url}/api/chat/${chatId}`)).json();
        throw new Error(`no gate yet; relay=${JSON.stringify(chat?.relay)} events=${JSON.stringify((events ?? []).filter((e) => e.kind === 'relay').map((e) => [e.eventType, e.reason]))}`);
      }
      return found;
    },
    { timeout: 8_000 },
  );

  // The gate reads as a decision about a run, not as a tool-use question.
  expect(gate.displayName).toContain('write the batch');
  expect(gate.description).toMatch(/rounds done/);

  const events = (await (await fetch(`${url}/api/chat/${chatId}`)).json()).events.filter((event) => event.kind === 'relay');
  expect(events.filter((event) => event.eventType === 'message').map((event) => event.from)).toEqual(['grok', 'claude', 'grok', 'claude']);
  expect(events.filter((event) => event.eventType === 'gate.requested')).toHaveLength(1);
}, 25_000);

test('relay: approving the gate buys one more round; denying stops the run', async () => {
  const { url } = await bootRelay({ harness: relayReviewHarness(['handoff', 'handoff', 'handoff']), harnessName: 'fake' });
  await readSse(await postJson(`${url}/api/chat/turn`, { text: 'seed' }));
  const chatId = (await (await fetch(`${url}/api/chat/list?includeSilent=1`)).json()).chats[0].id;
  await postJson(`${url}/api/chat/${chatId}/relay`, { goal: 'write the batch' });

  const gate = await vi.waitFor(
    async () => {
      const found = (await (await fetch(`${url}/api/approvals`)).json()).approvals.find((entry) => entry.kind === 'relay.gate');
      expect(found).toBeTruthy();
      return found;
    },
    { timeout: 5_000 },
  );

  const allowed = await answerGate(url, gate, 'allow');
  expect(allowed.status).toBe(200);
  expect(await allowed.json()).toMatchObject({ relay: 'resumed' });

  // One round later it is asking again rather than carrying on by itself.
  const second = await vi.waitFor(
    async () => {
      const found = (await (await fetch(`${url}/api/approvals`)).json()).approvals.find((entry) => entry.kind === 'relay.gate');
      expect(found).toBeTruthy();
      return found;
    },
    { timeout: 5_000 },
  );

  const denied = await answerGate(url, second, 'deny');
  expect(denied.status).toBe(200);
  expect(await denied.json()).toMatchObject({ relay: 'stopped' });
  const { chat } = await (await fetch(`${url}/api/chat/${chatId}`)).json();
  expect(chat.relay.status).toBe('stopped');
}, 25_000);

test('relay: a chat that is handing off refuses a typed turn, and an unknown run cannot be stopped', async () => {
  const { url } = await bootRelay({ harness: relayReviewHarness(['handoff', 'handoff']), harnessName: 'fake' });
  await readSse(await postJson(`${url}/api/chat/turn`, { text: 'seed' }));
  const chatId = (await (await fetch(`${url}/api/chat/list?includeSilent=1`)).json()).chats[0].id;
  await postJson(`${url}/api/chat/${chatId}/relay`, { goal: 'g' });

  // A second run on the same chat is refused: one conversation, one thing
  // writing into it.
  const second = await postJson(`${url}/api/chat/${chatId}/relay`, { goal: 'another' });
  expect(second.status).toBe(409);

  const stopUnknown = await postJson(`${url}/api/relay/does-not-exist/stop`, {});
  expect(stopUnknown.status).toBe(404);
}, 25_000);

test('relay: a run without a goal is refused, and the routes need the instance token like everything else', async () => {
  const { url } = await bootRelay({ harness: relayReviewHarness(['handoff']), harnessName: 'fake' });
  await readSse(await postJson(`${url}/api/chat/turn`, { text: 'seed' }));
  const chatId = (await (await fetch(`${url}/api/chat/list?includeSilent=1`)).json()).chats[0].id;

  expect((await postJson(`${url}/api/chat/${chatId}/relay`, {})).status).toBe(400);
  // rawFetch sends no token; every /api route answers 401 to that.
  expect((await rawFetch(`${url}/api/chat/${chatId}/relay`, { method: 'POST', headers: APP_JSON_HEADERS, body: '{}' })).status).toBe(401);
}, 25_000);

test('relay: a turn that a reviewer cannot answer in the agreed shape parks the run instead of guessing', async () => {
  // The local Claude harness is not schema-constrained, so its answer is
  // parsed. An unreadable one must not be turned into a "handoff" by a lenient
  // parser: the run stops and asks, with the text attached.
  expect(parseRelayAnswer('I think this is fine, ship it')).toMatchObject({ status: 'needs_human' });
  expect(parseRelayAnswer('```json\n{"status":"done","message":"ok"}\n```')).toMatchObject({ status: 'done', message: 'ok' });
  expect(parseRelayAnswer('{"status":"handoff","message":"revised"}')).toMatchObject({ status: 'handoff' });
  // A schema-shaped answer with a bogus status is not an answer either.
  expect(parseRelayAnswer('{"status":"whatever","message":"x"}')).toMatchObject({ status: 'needs_human' });
});

test('relay: the German-quote trap — broken JSON with an unambiguous status field still reads as that status', async () => {
  // Straight from the tag-5 live acceptance: the reviewer wrote „Zitat" with
  // an unescaped ASCII quote closing a German quotation INSIDE a JSON string,
  // which kills JSON.parse — but the status FIELD is sitting right there,
  // unambiguous. Parking that at a gate made a working relay look broken.
  const broken = '```json\n{\n  "status": "handoff",\n  "message": "Befund 1: „tickt ein stummes Licht" — Licht tickt nicht. Bitte revidieren."\n}\n```';
  const parsed = parseRelayAnswer(broken);
  expect(parsed.status).toBe('handoff');
  // The whole text becomes the message — the next peer reads it as prose.
  expect(parsed.message).toContain('Licht tickt nicht');

  // Two CONTRADICTING status fields are ambiguous — that stays a human call.
  const ambiguous = '{"status": "handoff", "inner": {"status": "done", "message": "x"';
  expect(parseRelayAnswer(ambiguous)).toMatchObject({ status: 'needs_human' });

  // Broken JSON without any status field keeps the old honest answer.
  expect(parseRelayAnswer('{"message": "no status here"')).toMatchObject({ status: 'needs_human' });
});

// --- missions: the mission routes and mission-bound chat turns (Zielbild M0) ---

test('missions: create, list, detail roundtrip over HTTP', async () => {
  const { url } = await boot();
  const created = await fetch(`${url}/api/missions`, {
    method: 'POST',
    headers: APP_JSON_HEADERS,
    body: JSON.stringify({ title: 'Ship it', goal: 'ship the widget' }),
  });
  expect(created.status).toBe(201);
  const { mission } = await created.json();
  expect(mission.status).toBe('active');

  const list = await fetch(`${url}/api/missions`);
  const listBody = await list.json();
  expect(listBody.missions).toHaveLength(1);
  expect(listBody.missions[0].pendingApprovals).toBe(0);

  const detail = await fetch(`${url}/api/missions/${mission.id}`);
  expect(detail.status).toBe(200);
  const detailBody = await detail.json();
  expect(detailBody.mission.title).toBe('Ship it');
  expect(detailBody.chats).toEqual([]);
  expect(detailBody.tasks).toEqual([]);
  expect(detailBody.pendingApprovals).toEqual([]);
});

test('missions: creating with a non-existent or relative cwd is a 400, never a silent fallback', async () => {
  const { url } = await boot();
  const missing = await fetch(`${url}/api/missions`, {
    method: 'POST',
    headers: APP_JSON_HEADERS,
    body: JSON.stringify({ title: 'x', cwd: path.join(os.tmpdir(), 'kaprek-definitely-missing-dir') }),
  });
  expect(missing.status).toBe(400);
  const relative = await fetch(`${url}/api/missions`, {
    method: 'POST',
    headers: APP_JSON_HEADERS,
    body: JSON.stringify({ title: 'x', cwd: 'relative/dir' }),
  });
  expect(relative.status).toBe(400);
});

test('missions: unknown mission id is a 404 on detail, status, and link', async () => {
  const { url } = await boot();
  expect((await fetch(`${url}/api/missions/nope`)).status).toBe(404);
  expect((await fetch(`${url}/api/missions/nope/status`, { method: 'POST', headers: APP_JSON_HEADERS, body: JSON.stringify({ status: 'done' }) })).status).toBe(404);
  expect((await fetch(`${url}/api/missions/nope/link`, { method: 'POST', headers: APP_JSON_HEADERS, body: JSON.stringify({ chatId: 'c1' }) })).status).toBe(404);
});

test('missions: status transitions are validated, link takes exactly one of chatId/taskId', async () => {
  const { url } = await boot();
  const { mission } = await (await fetch(`${url}/api/missions`, { method: 'POST', headers: APP_JSON_HEADERS, body: JSON.stringify({ title: 'x' }) })).json();

  const ok = await fetch(`${url}/api/missions/${mission.id}/status`, { method: 'POST', headers: APP_JSON_HEADERS, body: JSON.stringify({ status: 'waiting' }) });
  expect((await ok.json()).mission.status).toBe('waiting');
  const bad = await fetch(`${url}/api/missions/${mission.id}/status`, { method: 'POST', headers: APP_JSON_HEADERS, body: JSON.stringify({ status: 'paused' }) });
  expect(bad.status).toBe(400);

  const both = await fetch(`${url}/api/missions/${mission.id}/link`, { method: 'POST', headers: APP_JSON_HEADERS, body: JSON.stringify({ chatId: 'c1', taskId: 't1' }) });
  expect(both.status).toBe(400);
  const neither = await fetch(`${url}/api/missions/${mission.id}/link`, { method: 'POST', headers: APP_JSON_HEADERS, body: JSON.stringify({}) });
  expect(neither.status).toBe(400);
  const task = await fetch(`${url}/api/missions/${mission.id}/link`, { method: 'POST', headers: APP_JSON_HEADERS, body: JSON.stringify({ taskId: 't1' }) });
  expect((await task.json()).mission.tasks).toEqual(['t1']);
});

test('presets: GET /api/presets lists the builtin catalog', async () => {
  const { url } = await boot();
  const res = await fetch(`${url}/api/presets`);
  expect(res.status).toBe(200);
  const { presets } = await res.json();
  expect(presets.map((p) => p.id)).toContain('blank');
  expect(presets.map((p) => p.id)).toContain('guided-feature');
});

test('chat: a turn with missionId links the new chat and runs in the mission cwd — and a follow-up turn keeps it', async () => {
  const missionCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'kaprek-mission-cwd-'));
  const harness = createFakeHarness({ script: fakeScript() });
  const { url } = await boot({ harness, harnessName: 'fake' });

  const { mission } = await (await fetch(`${url}/api/missions`, { method: 'POST', headers: APP_JSON_HEADERS, body: JSON.stringify({ title: 'm', cwd: missionCwd }) })).json();

  const first = await fetch(`${url}/api/chat/turn`, { method: 'POST', headers: APP_JSON_HEADERS, body: JSON.stringify({ text: 'hi', missionId: mission.id }) });
  expect(first.status).toBe(200);
  const frames = await readSse(first);
  const chatId = frames[0].chatId;
  expect(harness.startedTurns[0].cwd).toBe(missionCwd);

  // The chat is linked on the mission and carries the missionId itself.
  const detail = await (await fetch(`${url}/api/missions/${mission.id}`)).json();
  expect(detail.chats.map((c) => c.id)).toEqual([chatId]);
  expect(detail.chats[0].missionId).toBe(mission.id);

  // A follow-up turn addressed by chatId alone still runs in the mission cwd.
  const second = await fetch(`${url}/api/chat/turn`, { method: 'POST', headers: APP_JSON_HEADERS, body: JSON.stringify({ text: 'again', chatId }) });
  expect(second.status).toBe(200);
  await readSse(second);
  expect(harness.startedTurns[1].cwd).toBe(missionCwd);

  fs.rmSync(missionCwd, { recursive: true, force: true });
});

test('chat: a turn with an unknown missionId is a 404 JSON response, no SSE', async () => {
  const { url } = await boot({ harness: createFakeHarness({ script: fakeScript() }), harnessName: 'fake' });
  const res = await fetch(`${url}/api/chat/turn`, { method: 'POST', headers: APP_JSON_HEADERS, body: JSON.stringify({ text: 'hi', missionId: 'nope' }) });
  expect(res.status).toBe(404);
  expect(res.headers.get('content-type')).toContain('application/json');
});

test('chat: a mission whose cwd vanished fails the turn with a 400, no silent workspace fallback', async () => {
  const missionCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'kaprek-mission-gone-'));
  const { url } = await boot({ harness: createFakeHarness({ script: fakeScript() }), harnessName: 'fake' });
  const { mission } = await (await fetch(`${url}/api/missions`, { method: 'POST', headers: APP_JSON_HEADERS, body: JSON.stringify({ title: 'm', cwd: missionCwd }) })).json();
  fs.rmSync(missionCwd, { recursive: true, force: true });
  const res = await fetch(`${url}/api/chat/turn`, { method: 'POST', headers: APP_JSON_HEADERS, body: JSON.stringify({ text: 'hi', missionId: mission.id }) });
  expect(res.status).toBe(400);
});

// --- engines: per-chat harness selection (M1) ---

/** A fake registry with two engines whose startTurn records that it ran. */
function fakeRegistry() {
  const ran = [];
  const engineOf = (id) => ({
    startTurn: async ({ onEvent }) => {
      ran.push(id);
      for (const event of fakeScript()) onEvent(event);
      return { sessionId: 'sess-1', costUsd: null, usage: null, stopReason: 'result', error: null };
    },
    capabilities: {
      id,
      displayName: id,
      supportsCostUsd: false,
      supportsUpdatedInput: false,
      supportsAllowedTools: false,
      supportsMcpConfig: false,
      supportsSettingsPath: false,
    },
  });
  const engines = new Map([
    ['claude-code', engineOf('claude-code')],
    ['fake-b', engineOf('fake-b')],
  ]);
  return {
    ran,
    getEngine: (id) => engines.get(id) ?? null,
    listEngines: () => [...engines.values()].map((engine) => engine.capabilities),
  };
}

test('engines: GET /api/engines lists the registry', async () => {
  const { url } = await boot({ engineRegistry: fakeRegistry() });
  const res = await fetch(`${url}/api/engines`);
  expect(res.status).toBe(200);
  const { engines } = await res.json();
  expect(engines.map((engine) => engine.id)).toEqual(['claude-code', 'fake-b']);
});

test('engines: a new chat created with an engine stores it and runs that engine, and follow-ups keep it', async () => {
  const registry = fakeRegistry();
  const { url } = await boot({ engineRegistry: registry });

  const res = await fetch(`${url}/api/chat/turn`, {
    method: 'POST',
    headers: APP_JSON_HEADERS,
    body: JSON.stringify({ text: 'hi', engine: 'fake-b' }),
  });
  expect(res.status).toBe(200);
  const frames = await readSse(res);
  const chatId = frames.find((frame) => frame.type === 'chat-id').chatId;
  expect(registry.ran).toEqual(['fake-b']);

  const { chat } = await (await fetch(`${url}/api/chat/${chatId}`)).json();
  expect(chat.engine).toBe('fake-b');

  // The follow-up names no engine and still runs the chat's own.
  const follow = await fetch(`${url}/api/chat/turn`, {
    method: 'POST',
    headers: APP_JSON_HEADERS,
    body: JSON.stringify({ text: 'again', chatId }),
  });
  expect(follow.status).toBe(200);
  await readSse(follow);
  expect(registry.ran).toEqual(['fake-b', 'fake-b']);
});

test('engines: a follow-up naming a DIFFERENT engine is refused before any SSE bytes', async () => {
  const registry = fakeRegistry();
  const { url } = await boot({ engineRegistry: registry });
  const res = await fetch(`${url}/api/chat/turn`, {
    method: 'POST',
    headers: APP_JSON_HEADERS,
    body: JSON.stringify({ text: 'hi', engine: 'fake-b' }),
  });
  const frames = await readSse(res);
  const chatId = frames.find((frame) => frame.type === 'chat-id').chatId;

  const conflict = await fetch(`${url}/api/chat/turn`, {
    method: 'POST',
    headers: APP_JSON_HEADERS,
    body: JSON.stringify({ text: 'switch', chatId, engine: 'claude-code' }),
  });
  expect(conflict.status).toBe(400);
  expect((await conflict.json()).error).toContain('fake-b');
});

test('engines: an unknown engine is a 400 before any chat is created', async () => {
  const registry = fakeRegistry();
  const { url } = await boot({ engineRegistry: registry });
  const res = await fetch(`${url}/api/chat/turn`, {
    method: 'POST',
    headers: APP_JSON_HEADERS,
    body: JSON.stringify({ text: 'hi', engine: 'nope' }),
  });
  expect(res.status).toBe(400);
  const chats = await (await fetch(`${url}/api/chat/list?includeSilent=1`)).json();
  expect(chats.chats).toHaveLength(0);
});

test('engines: an explicitly injected harness wins over the chat engine (the test-suite contract)', async () => {
  const registry = fakeRegistry();
  const seen = [];
  const harness = {
    startTurn: async ({ onEvent }) => {
      seen.push('injected');
      for (const event of fakeScript()) onEvent(event);
      return { sessionId: 'sess-1', costUsd: null, usage: null, stopReason: 'result', error: null };
    },
  };
  const { url } = await boot({ harness, harnessName: 'fake', engineRegistry: registry });
  const res = await fetch(`${url}/api/chat/turn`, {
    method: 'POST',
    headers: APP_JSON_HEADERS,
    body: JSON.stringify({ text: 'hi', engine: 'fake-b' }),
  });
  expect(res.status).toBe(200);
  await readSse(res);
  expect(seen).toEqual(['injected']);
  expect(registry.ran).toEqual([]);
});

test('approvalMode: auto reaches the harness as bypassPermissions, garbage is a 400 before SSE', async () => {
  const seen = [];
  const harness = {
    startTurn: async (options) => {
      seen.push(options.permissionMode);
      for (const event of fakeScript()) options.onEvent(event);
      return { sessionId: 'sess-1', costUsd: null, usage: null, stopReason: 'result', error: null };
    },
  };
  const { url } = await boot({ harness, harnessName: 'fake' });

  const res = await fetch(`${url}/api/chat/turn`, {
    method: 'POST',
    headers: APP_JSON_HEADERS,
    body: JSON.stringify({ text: 'go', approvalMode: 'auto' }),
  });
  expect(res.status).toBe(200);
  await readSse(res);
  expect(seen).toEqual(['bypassPermissions']);

  const bad = await fetch(`${url}/api/chat/turn`, {
    method: 'POST',
    headers: APP_JSON_HEADERS,
    body: JSON.stringify({ text: 'go', approvalMode: 'yolo-extreme' }),
  });
  expect(bad.status).toBe(400);
});

test('repeats: a request typed three times is offered as an automation, twice is not', async () => {
  const { url } = await boot({ harness: createFakeHarness({ script: fakeScript() }), harnessName: 'fake' });
  const say = async (text) => {
    const res = await fetch(`${url}/api/chat/turn`, { method: 'POST', headers: APP_JSON_HEADERS, body: JSON.stringify({ text }) });
    await readSse(res);
  };
  await say('Check the deployment logs for errors');
  await say('check the deployment logs for errors');
  expect((await (await fetch(`${url}/api/repeats`)).json()).repeats).toHaveLength(0);

  await say('Check the deployment logs for errors please');
  const { repeats } = await (await fetch(`${url}/api/repeats`)).json();
  expect(repeats).toHaveLength(1);
  expect(repeats[0].count).toBe(3);
  expect(repeats[0].sample).toContain('deployment logs');
}, 30_000);

// --- plans: guided planning's own routes (Klaus, 02.08.: "man findet den Plan
// unter einem eigenen Bereich des Projektes wieder") ---

test('plans: an empty workspace lists nothing rather than erroring', async () => {
  const { url } = await boot();
  const res = await fetch(`${url}/api/plans`);
  expect(res.status).toBe(200);
  expect((await res.json()).plans).toEqual([]);
});

test('plans: a plan written in the data dir is listed, read, and ticked over HTTP', async () => {
  const { url } = await boot();
  const planDir = path.join(dataDir, 'workspace', 'plans');
  fs.mkdirSync(planDir, { recursive: true });
  const planFile = path.join(planDir, '2026-08-02-idea.md');
  fs.writeFileSync(planFile, '# The idea\n\n- [ ] First step\n- [ ] Second step\n', 'utf8');

  // Registration happens through a turn; here we reach the same store the
  // route uses by registering through the route's own data dir.
  const { openPlans } = await import('../plans/store.mjs');
  const registered = openPlans(dataDir).register({ path: planFile });

  const list = await fetch(`${url}/api/plans`);
  expect((await list.json()).plans[0].title).toBe('The idea');

  const detail = await fetch(`${url}/api/plans/${registered.id}`);
  const { plan } = await detail.json();
  expect(plan.path).toBe(path.resolve(planFile));
  expect(plan.steps.map((s) => s.text)).toEqual(['First step', 'Second step']);

  const ticked = await fetch(`${url}/api/plans/${registered.id}/step`, {
    method: 'POST',
    headers: APP_JSON_HEADERS,
    body: JSON.stringify({ index: 1, done: true }),
  });
  expect(ticked.status).toBe(200);
  expect(fs.readFileSync(planFile, 'utf8')).toContain('- [x] Second step');
  expect(fs.readFileSync(planFile, 'utf8')).toContain('- [ ] First step');
});

test('plans: bad step arguments are refused, and a vanished step is a 409', async () => {
  const { url } = await boot();
  const planDir = path.join(dataDir, 'workspace', 'plans');
  fs.mkdirSync(planDir, { recursive: true });
  const planFile = path.join(planDir, 'p.md');
  fs.writeFileSync(planFile, '# P\n\n- [ ] Only step\n', 'utf8');
  const { openPlans } = await import('../plans/store.mjs');
  const registered = openPlans(dataDir).register({ path: planFile });

  for (const body of [{ index: -1, done: true }, { index: 'first', done: true }, { index: 0, done: 'yes' }]) {
    const res = await fetch(`${url}/api/plans/${registered.id}/step`, { method: 'POST', headers: APP_JSON_HEADERS, body: JSON.stringify(body) });
    expect(res.status).toBe(400);
  }

  const gone = await fetch(`${url}/api/plans/${registered.id}/step`, { method: 'POST', headers: APP_JSON_HEADERS, body: JSON.stringify({ index: 7, done: true }) });
  expect(gone.status).toBe(409);

  const missing = await fetch(`${url}/api/plans/does-not-exist`);
  expect(missing.status).toBe(404);
});

test('plans: a deleted plan file answers 410 instead of pretending', async () => {
  const { url } = await boot();
  const planFile = path.join(dataDir, 'workspace', 'plans', 'doomed.md');
  fs.mkdirSync(path.dirname(planFile), { recursive: true });
  fs.writeFileSync(planFile, '# Doomed\n\n- [ ] step\n', 'utf8');
  const { openPlans } = await import('../plans/store.mjs');
  const registered = openPlans(dataDir).register({ path: planFile });
  fs.rmSync(planFile);

  const res = await fetch(`${url}/api/plans/${registered.id}`);
  expect(res.status).toBe(410);
});

test('chat turn: an unknown guided mode is a 400 before any SSE byte is written', async () => {
  const { url } = await boot({ harness: { startTurn: async () => ({ sessionId: 's', costUsd: null, usage: null, stopReason: 'result', error: null }) } });
  const res = await fetch(`${url}/api/chat/turn`, {
    method: 'POST',
    headers: APP_JSON_HEADERS,
    body: JSON.stringify({ text: 'plan something', mode: 'freestyle' }),
  });
  expect(res.status).toBe(400);
  expect((await res.json()).error).toContain('invalid mode');
});

test('chat turn: a guided turn registers the plan the agent wrote and reports it', async () => {
  let seenPath = null;
  const harness = {
    startTurn: async (options) => {
      // The agent writes exactly where kaprek told it to.
      seenPath = /kaprek guided planning[\s\S]*?\n\n {2}(.+)\n/.exec(options.appendSystemPrompt ?? '')?.[1]?.trim() ?? null;
      if (seenPath) {
        fs.mkdirSync(path.dirname(seenPath), { recursive: true });
        fs.writeFileSync(seenPath, '# Newsletter generator\n\n- [ ] First step\n', 'utf8');
      }
      options.onEvent({ type: 'text', text: 'Plan written.' });
      return { sessionId: 's1', costUsd: null, usage: null, stopReason: 'result', error: null };
    },
  };
  const { url } = await boot({ harness });

  const res = await fetch(`${url}/api/chat/turn`, {
    method: 'POST',
    headers: APP_JSON_HEADERS,
    body: JSON.stringify({ text: 'write the plan for the newsletter generator', mode: 'plan' }),
  });
  const frames = await readSse(res);
  const complete = frames.find((f) => f.type === 'turn-complete');
  expect(complete.guided.mode).toBe('plan');
  expect(complete.guided.plan.title).toBe('Newsletter generator');
  expect(complete.guided.protocolBroken).toBe(false);

  const listed = await (await fetch(`${url}/api/plans`)).json();
  expect(listed.plans).toHaveLength(1);
  expect(path.isAbsolute(listed.plans[0].path)).toBe(true);
});

test('chat turn: a follow-up keeps writing to the same plan, named after the chat topic', async () => {
  const paths = [];
  const harness = {
    startTurn: async (options) => {
      const match = /\n\n {2}(.+\.md)\n/.exec(options.appendSystemPrompt ?? '');
      const target = match?.[1]?.trim();
      if (target) {
        paths.push(target);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, '# Line counter\n\n- [ ] First step\n', 'utf8');
      }
      options.onEvent({ type: 'text', text: 'Done.' });
      return { sessionId: 's1', costUsd: null, usage: null, stopReason: 'result', error: null };
    },
  };
  const { url } = await boot({ harness });

  const first = await fetch(`${url}/api/chat/turn`, {
    method: 'POST',
    headers: APP_JSON_HEADERS,
    body: JSON.stringify({ text: 'Lass uns einen Zeilenzaehler bauen', mode: 'plan' }),
  });
  const firstFrames = await readSse(first);
  const chatId = firstFrames.find((f) => f.type === 'chat-id').chatId;
  // The name comes from the topic, not from the whole sentence.
  expect(path.basename(paths[0])).toMatch(/^\d{4}-\d{2}-\d{2}-zeilenzaehler\.md$/);

  // A follow-up whose prompt is a quiz answer must not name a second file
  // after "My answers" — it deepens the plan that already exists.
  const second = await fetch(`${url}/api/chat/turn`, {
    method: 'POST',
    headers: APP_JSON_HEADERS,
    body: JSON.stringify({ chatId, text: 'My answers:\n\n- Which language?\n  Node', mode: 'plan' }),
  });
  await readSse(second);
  expect(paths[1]).toBe(paths[0]);

  const listed = await (await fetch(`${url}/api/plans`)).json();
  expect(listed.plans).toHaveLength(1);
});

// --- council: roles, levels, and asking a peer (Klaus, 02.08.: "Die
// Rückfragen mit den anderen KIs finden noch nicht statt") ---

test('council: a fresh install gets a suggestion, not an empty form', async () => {
  const { url } = await boot();
  const res = await fetch(`${url}/api/council`);
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.council.suggested).toBe(true);
  expect(body.council.level).toBe('plans');
  expect(body.council.assignment.lead).toBeTruthy();
  expect(body.available).toContain('claude-code');
  expect(body.levels).toEqual(['off', 'plans', 'decisions', 'always']);
});

test('council: a saved setup survives, and an impossible one is refused', async () => {
  const { url } = await boot();
  const saved = await fetch(`${url}/api/council`, {
    method: 'PUT',
    headers: APP_JSON_HEADERS,
    body: JSON.stringify({ level: 'decisions', assignment: { lead: 'claude-code', thinker: 'codex', worker: 'claude-code', peer: ['codex'] } }),
  });
  expect(saved.status).toBe(200);
  expect((await saved.json()).council.status.possible).toBe(true);

  const reread = await (await fetch(`${url}/api/council`)).json();
  expect(reread.council.suggested).toBe(false);
  expect(reread.council.level).toBe('decisions');

  // The lead as its own peer is the one rule the feature rests on.
  const bad = await fetch(`${url}/api/council`, {
    method: 'PUT',
    headers: APP_JSON_HEADERS,
    body: JSON.stringify({ level: 'plans', assignment: { lead: 'codex', thinker: 'codex', worker: 'codex', peer: ['codex'] } }),
  });
  expect(bad.status).toBe(400);
  expect((await bad.json()).error).toContain('second opinion');

  const stillThere = await (await fetch(`${url}/api/council`)).json();
  expect(stillThere.council.level).toBe('decisions');
});

test('council: an unknown level is refused rather than saved', async () => {
  const { url } = await boot();
  const res = await fetch(`${url}/api/council`, {
    method: 'PUT',
    headers: APP_JSON_HEADERS,
    body: JSON.stringify({ level: 'constantly', assignment: { lead: 'claude-code', thinker: 'codex', worker: 'codex', peer: ['codex'] } }),
  });
  expect(res.status).toBe(400);
});

test('council: consulting needs a question', async () => {
  const { url } = await boot();
  const res = await fetch(`${url}/api/council/consult`, { method: 'POST', headers: APP_JSON_HEADERS, body: JSON.stringify({ question: '  ' }) });
  expect(res.status).toBe(400);
});

/**
 * A guided plan turn plus a peer that answers instantly. Nothing here spawns
 * a process: makeCouncilAskPeer is injected, which is the whole reason
 * startServer accepts it.
 */
async function bootPlanCouncil({ answer = () => JSON.stringify({ verdict: 'agree', summary: 'sound', risks: [] }), planBody = '# Counter\n\n- [ ] First step\n' } = {}) {
  const asked = [];
  const harness = {
    startTurn: async (options) => {
      const target = /\n\n {2}(.+\.md)\n/.exec(options.appendSystemPrompt ?? '')?.[1]?.trim();
      if (target && planBody !== null) {
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, planBody, 'utf8');
      }
      options.onEvent({ type: 'text', text: 'Plan written.' });
      return { sessionId: 's1', costUsd: null, usage: null, stopReason: 'result', error: null };
    },
  };
  const started = await boot({
    harness,
    makeCouncilAskPeer: () => async (peerId, prompt) => {
      asked.push({ peerId, prompt });
      return answer(peerId, prompt);
    },
  });
  await fetch(`${started.url}/api/council`, {
    method: 'PUT',
    headers: APP_JSON_HEADERS,
    body: JSON.stringify({ level: 'plans', assignment: { lead: 'claude-code', thinker: 'codex', worker: 'codex', peer: ['codex'] } }),
  });
  return { ...started, asked };
}

async function planTurn(url, text = 'plan a line counter') {
  const res = await fetch(`${url}/api/chat/turn`, { method: 'POST', headers: APP_JSON_HEADERS, body: JSON.stringify({ text, mode: 'plan' }) });
  return readSse(res);
}

/** Polls until the consultation reaches a terminal state — it runs beside the turn, not inside it. */
async function settled(url, id) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const { consultation } = await (await fetch(`${url}/api/council/consultations/${id}`)).json();
    if (consultation.status !== 'running') return consultation;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('the consultation never finished');
}

test('council: a written plan starts a consultation on its own, without holding the turn open', async () => {
  const { url, asked } = await bootPlanCouncil();
  const frames = await planTurn(url);

  const started = frames.find((f) => f.type === 'council-started');
  expect(started.peers).toEqual(['codex']);
  // The turn ends with the turn. Only the id travels on the stream.
  expect(frames.findIndex((f) => f.type === 'council-started')).toBeLessThan(frames.findIndex((f) => f.type === 'turn-complete'));

  const consultation = await settled(url, started.consultationId);
  expect(consultation.status).toBe('completed');
  expect(consultation.result.agreed).toEqual(['codex']);
  expect(asked[0].prompt).toContain('.md');
});

test('council: the level decides — at off nothing fires by itself', async () => {
  const { url } = await bootPlanCouncil();
  await fetch(`${url}/api/council`, {
    method: 'PUT',
    headers: APP_JSON_HEADERS,
    body: JSON.stringify({ level: 'off', assignment: { lead: 'claude-code', thinker: 'codex', worker: 'codex', peer: ['codex'] } }),
  });
  const frames = await planTurn(url);
  expect(frames.find((f) => f.type === 'council-started')).toBeUndefined();
  const listed = await (await fetch(`${url}/api/council/consultations`)).json();
  expect(listed.consultations).toHaveLength(0);
});

test('council: a guided turn that wrote no plan has nothing to review', async () => {
  const { url } = await bootPlanCouncil({ planBody: null });
  const frames = await planTurn(url);
  expect(frames.find((f) => f.type === 'council-started')).toBeUndefined();
});

test('council: a dissenting peer is reported as dissent, not smoothed into agreement', async () => {
  const { url } = await bootPlanCouncil({
    answer: () => JSON.stringify({ verdict: 'disagree', summary: 'step 3 cannot work', risks: ['the file it edits does not exist yet'] }),
  });
  const frames = await planTurn(url);
  const consultation = await settled(url, frames.find((f) => f.type === 'council-started').consultationId);
  expect(consultation.result.consensus).toBe(false);
  expect(consultation.result.dissenting[0].summary).toBe('step 3 cannot work');
});

test('council: consultations are listed for the chat that asked', async () => {
  const { url } = await bootPlanCouncil();
  const frames = await planTurn(url);
  const chatId = frames.find((f) => f.type === 'chat-id').chatId;
  await settled(url, frames.find((f) => f.type === 'council-started').consultationId);

  const mine = await (await fetch(`${url}/api/council/consultations?chatId=${chatId}`)).json();
  expect(mine.consultations).toHaveLength(1);
  const other = await (await fetch(`${url}/api/council/consultations?chatId=chat-that-never-was`)).json();
  expect(other.consultations).toHaveLength(0);
});

test('council: an unknown consultation is a 404, not an empty object', async () => {
  const { url } = await boot();
  const res = await fetch(`${url}/api/council/consultations/nope`);
  expect(res.status).toBe(404);
});

// ---------------------------------------------------------------------------
// M2: recipes over http, and codex taking a real handoff
// ---------------------------------------------------------------------------

/**
 * A relay whose harness steps run on a fake registry, so a recipe naming
 * codex can be exercised without codex being installed.
 */
function recipeRegistry(onTurn) {
  const ran = [];
  const engineOf = (id) => ({
    id,
    startTurn: async (options) => {
      ran.push({ id, cwd: options.cwd, allowedTools: options.allowedTools, prompt: options.prompt });
      const answer = onTurn ? onTurn({ id, options, call: ran.length }) : null;
      options.onEvent({ type: 'text', text: answer ?? JSON.stringify({ status: 'handoff', message: `${id} did the work` }) });
      return { sessionId: `s-${ran.length}`, costUsd: null, usage: null, stopReason: 'result', error: null };
    },
    capabilities: { id, name: id, supportsResume: true, supportsMcpConfig: false, supportsSettingsPath: false },
  });
  const engines = new Map([
    ['claude-code', engineOf('claude-code')],
    ['codex', engineOf('codex')],
  ]);
  return { ran, getEngine: (id) => engines.get(id) ?? null, listEngines: () => [...engines.values()].map((engine) => engine.capabilities) };
}

/** Writes a user recipe into the data dir the server reads from. */
function writeRecipe(recipe) {
  const dir = path.join(dataDir, 'recipes');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${recipe.id}.json`), JSON.stringify(recipe), 'utf8');
}

test('recipes: GET /api/recipes lists the builtins and anything the user added', async () => {
  writeRecipe({
    id: 'mine',
    title: 'My own pairing',
    steps: [{ id: 'write', agent: 'grok' }],
    edges: [{ from: 'write', to: 'write' }],
  });
  const { url } = await boot();
  const { recipes } = await (await fetch(`${url}/api/recipes`)).json();
  expect(recipes.map((recipe) => recipe.id)).toContain('write-review');
  expect(recipes.find((recipe) => recipe.id === 'mine').builtin).toBe(false);
  // Every listed recipe is already normalized, so a UI never has to guess a default.
  expect(recipes.every((recipe) => Number.isInteger(recipe.budgets.maxRounds))).toBe(true);
});

test('recipes: starting a relay with an unknown recipe is refused before anything runs', async () => {
  const { url } = await bootRelay({ harness: relayReviewHarness(['handoff']), harnessName: 'fake' });
  await readSse(await postJson(`${url}/api/chat/turn`, { text: 'seed' }));
  const chatId = (await (await fetch(`${url}/api/chat/list?includeSilent=1`)).json()).chats[0].id;

  const res = await postJson(`${url}/api/chat/${chatId}/relay`, { goal: 'write the batch', recipeId: 'does-not-exist' });
  expect(res.status).toBe(400);
  expect((await res.json()).error).toMatch(/unknown recipe/);
  // Nothing was started.
  const { chat } = await (await fetch(`${url}/api/chat/${chatId}`)).json();
  expect(chat.relay).toBeNull();
});

test('recipes: a codex step takes a real handoff, in the mission directory, with tools only where the recipe says so', async () => {
  const registry = recipeRegistry();
  const grok = stubGrokDriver();
  const missionDir = fs.mkdtempSync(path.join(tmpRootDir, 'mission-'));
  const { url } = await boot({ harness: relayReviewHarness(['handoff', 'handoff']), harnessName: 'claude-code', engineRegistry: registry, getPeerDriver: (id) => (id === 'grok' ? grok : null) });

  const mission = await (
    await postJson(`${url}/api/missions`, { title: 'apply things', goal: 'apply things', cwd: missionDir })
  ).json();
  await readSse(await postJson(`${url}/api/chat/turn`, { text: 'seed', missionId: mission.mission.id }));
  const chatId = (await (await fetch(`${url}/api/chat/list?includeSilent=1`)).json()).chats[0].id;

  writeRecipe({
    id: 'apply-it',
    title: 'write then apply',
    steps: [
      { id: 'write', agent: 'grok' },
      { id: 'apply', agent: 'codex', tools: 'full' },
    ],
    edges: [
      { from: 'write', to: 'apply' },
      { from: 'apply', to: 'write' },
    ],
    budgets: { maxRounds: 1 },
  });

  const started = await postJson(`${url}/api/chat/${chatId}/relay`, { goal: 'apply the batch', recipeId: 'apply-it' });
  expect(started.status).toBe(200);
  expect((await started.json()).recipeId).toBe('apply-it');

  await vi.waitFor(
    async () => {
      const codexRun = registry.ran.find((entry) => entry.id === 'codex');
      if (!codexRun) {
        const { chat, events } = await (await fetch(`${url}/api/chat/${chatId}`)).json();
        throw new Error(`codex has not run yet; ran=${JSON.stringify(registry.ran.map((r) => r.id))} relay=${JSON.stringify(chat?.relay?.status)} events=${JSON.stringify((events ?? []).filter((e) => e.kind === 'relay').map((e) => [e.eventType, e.reason ?? e.from ?? '']))}`);
      }
      return codexRun;
    },
    { timeout: 10_000 },
  );

  const codexRun = registry.ran.find((entry) => entry.id === 'codex');
  // It ran where the project is, not in kaprek's scratch workspace.
  expect(fs.realpathSync(codexRun.cwd)).toBe(fs.realpathSync(missionDir));
  // 'full' means the CLI's own default tool set, expressed as "no allowlist".
  expect(codexRun.allowedTools).not.toEqual([]);
}, 30_000);

test('recipes: a step that did not ask for tools gets none', async () => {
  const registry = recipeRegistry();
  const grok = stubGrokDriver();
  const { url } = await boot({ harness: relayReviewHarness(['handoff', 'handoff']), harnessName: 'claude-code', engineRegistry: registry, getPeerDriver: (id) => (id === 'grok' ? grok : null) });
  await readSse(await postJson(`${url}/api/chat/turn`, { text: 'seed' }));
  const chatId = (await (await fetch(`${url}/api/chat/list?includeSilent=1`)).json()).chats[0].id;

  writeRecipe({
    id: 'read-only',
    title: 'write then review',
    steps: [
      { id: 'write', agent: 'grok' },
      { id: 'review', agent: 'codex' },
    ],
    edges: [
      { from: 'write', to: 'review' },
      { from: 'review', to: 'write' },
    ],
    budgets: { maxRounds: 1 },
  });
  await postJson(`${url}/api/chat/${chatId}/relay`, { goal: 'review the batch', recipeId: 'read-only' });

  await vi.waitFor(
    async () => {
      if (!registry.ran.some((entry) => entry.id === 'codex')) throw new Error('codex has not run yet');
      return true;
    },
    { timeout: 10_000 },
  );
  // v1's rule, now per step: no tools unless the recipe says so.
  expect(registry.ran.find((entry) => entry.id === 'codex').allowedTools).toEqual([]);
}, 30_000);

test('environment: reports what is on this machine, and never a value from it', async () => {
  const { url } = await boot();
  const res = await fetch(`${url}/api/environment`);
  expect(res.status).toBe(200);
  const body = await res.json();

  // Every known CLI gets an entry, present or not: an absence you can see is
  // worth more than a list that quietly omits it.
  expect(body.environment.clis.map((cli) => cli.id)).toContain('claude-code');
  expect(body.environment.clis.every((cli) => typeof cli.installed === 'boolean')).toBe(true);
  // Env files are reported as paths plus KEY NAMES.
  expect(body.environment.envFiles.every((file) => Array.isArray(file.keys))).toBe(true);
  // The council question, answered from what is actually installed.
  expect(body.suggestedCouncil).toHaveProperty('lead');
  expect(Array.isArray(body.nextSteps)).toBe(true);
});

test('environment: is read-only', async () => {
  const { url } = await boot();
  const res = await fetch(`${url}/api/environment`, { method: 'POST', headers: APP_JSON_HEADERS, body: '{}' });
  expect(res.status).toBe(405);
});

// ---------------------------------------------------------------------------
// M3: memory with scopes, over http and inside a turn
// ---------------------------------------------------------------------------

/** A harness that writes a kaprek-remember block, and records what it was told. */
function rememberingHarness(toRemember) {
  const prompts = [];
  return {
    prompts,
    startTurn: async (options) => {
      prompts.push(options.appendSystemPrompt ?? '');
      const block = toRemember ? ['```kaprek-remember', JSON.stringify(toRemember), '```'].join('\n') : '';
      options.onEvent({ type: 'text', text: `Done.\n\n${block}` });
      return { sessionId: 's1', costUsd: null, usage: null, stopReason: 'result', error: null };
    },
  };
}

async function missionChat(url, { title = 'a mission', cwd }) {
  const mission = await (await postJson(`${url}/api/missions`, { title, goal: title, cwd })).json();
  const res = await fetch(`${url}/api/chat/turn`, {
    method: 'POST',
    headers: APP_JSON_HEADERS,
    body: JSON.stringify({ text: 'go', missionId: mission.mission.id }),
  });
  const frames = await readSse(res);
  return { missionId: mission.mission.id, chatId: frames.find((f) => f.type === 'chat-id').chatId, frames };
}

test('memory: a turn in a mission writes what it learned, and the next one is told', async () => {
  const projectDir = fs.mkdtempSync(path.join(tmpRootDir, 'project-'));
  const harness = rememberingHarness({ text: 'the deploy token lives in the CI settings, not in .env', kind: 'fact' });
  const { url } = await boot({ harness });

  const first = await missionChat(url, { cwd: projectDir });
  const complete = first.frames.find((f) => f.type === 'turn-complete');
  expect(complete.remembered.map((entry) => entry.text)).toEqual(['the deploy token lives in the CI settings, not in .env']);
  // The first turn had nothing to be told.
  expect(harness.prompts[0]).not.toContain('deploy token');

  // A second turn in the same mission starts with it.
  await readSse(await fetch(`${url}/api/chat/turn`, { method: 'POST', headers: APP_JSON_HEADERS, body: JSON.stringify({ text: 'again', chatId: first.chatId }) }));
  expect(harness.prompts[1]).toContain('the deploy token lives in the CI settings');
  expect(harness.prompts[1]).toContain('trust what you find');
});

test('memory: a chat outside a mission neither reads nor writes', async () => {
  const harness = rememberingHarness({ text: 'something a scratch chat thought was worth keeping' });
  const { url } = await boot({ harness });

  const frames = await readSse(await fetch(`${url}/api/chat/turn`, { method: 'POST', headers: APP_JSON_HEADERS, body: JSON.stringify({ text: 'just asking' }) }));
  // No scope, so nothing is written — memory belongs to a body of work.
  expect(frames.find((f) => f.type === 'turn-complete').remembered).toEqual([]);
  expect(harness.prompts[0] ?? '').not.toContain('What kaprek remembers');
});

test('memory: one mission does not read another project mission', async () => {
  const projectA = fs.mkdtempSync(path.join(tmpRootDir, 'project-a-'));
  const projectB = fs.mkdtempSync(path.join(tmpRootDir, 'project-b-'));
  const harness = rememberingHarness({ text: 'a secret about project A' });
  const { url } = await boot({ harness });

  await missionChat(url, { title: 'mission in A', cwd: projectA });
  const second = await missionChat(url, { title: 'mission in B', cwd: projectB });

  // The prompt of the mission in B must not carry A's fact: different
  // project, different branch of the tree.
  const promptForB = harness.prompts[harness.prompts.length - 1];
  expect(promptForB).not.toContain('a secret about project A');
  expect(second.chatId).toBeTruthy();
});

test('memory: two missions in the SAME project share what was learned', async () => {
  const projectDir = fs.mkdtempSync(path.join(tmpRootDir, 'shared-'));
  const { url } = await boot({ harness: rememberingHarness({ text: 'the build needs Node 22' }) });
  const first = await missionChat(url, { title: 'first mission', cwd: projectDir });

  // Read it back the way a second agent would: through the project scope.
  const scopes = await (await fetch(`${url}/api/memory/scopes`)).json();
  const projectScope = scopes.scopes.find((scope) => scope.id.startsWith('project:'));
  const recalled = await (await fetch(`${url}/api/memory?scopeId=${encodeURIComponent(projectScope.id)}`)).json();
  // Written at the PROJECT level, so a second mission in the same codebase
  // reads it — a mission is a task, a project is where knowledge stays.
  expect(recalled.memories.map((entry) => entry.text)).toContain('the build needs Node 22');

  const missionScope = scopes.scopes.find((scope) => scope.id === `mission:${first.missionId}`);
  const fromMission = await (await fetch(`${url}/api/memory?scopeId=${encodeURIComponent(missionScope.id)}`)).json();
  // And the mission sees it too, because it sits under that project.
  expect(fromMission.memories.map((entry) => entry.text)).toContain('the build needs Node 22');
});

test('memory: reading requires a scope', async () => {
  const { url } = await boot();
  const res = await fetch(`${url}/api/memory`);
  expect(res.status).toBe(400);
  expect((await res.json()).error).toMatch(/scopeId is required/);
});

test('memory: a person can write, verify and withdraw a memory by hand', async () => {
  const { url } = await boot();
  await postJson(`${url}/api/memory/scopes`, { id: 'person:local' });
  const created = await (await postJson(`${url}/api/memory`, { scopeId: 'person:local', text: 'kaprek runs on 127.0.0.1 only', kind: 'profile', origin: 'person' })).json();
  expect(created.memory.kind).toBe('profile');

  const verified = await (await postJson(`${url}/api/memory/${created.memory.id}/verify`, {})).json();
  expect(verified.memory.stale).toBe(false);

  const forgotten = await fetch(`${url}/api/memory/${created.memory.id}`, { method: 'DELETE', headers: APP_JSON_HEADERS, body: JSON.stringify({ reason: 'no longer true' }) });
  expect(forgotten.status).toBe(200);
  const left = await (await fetch(`${url}/api/memory?scopeId=person:local`)).json();
  expect(left.memories).toEqual([]);
});

test('memory: an unknown scope is refused rather than created on the fly', async () => {
  const { url } = await boot();
  const res = await postJson(`${url}/api/memory`, { scopeId: 'project:never-made', text: 'x', origin: 'person' });
  expect(res.status).toBe(400);
});

// ---------------------------------------------------------------------------
// M4: --lan, and the Host check that still stands behind it
// ---------------------------------------------------------------------------

/**
 * A GET with a Host header of our choosing.
 *
 * fetch cannot do this: Host is a forbidden header name, so undici silently
 * drops it and every request arrives with the real one. A test written with
 * fetch here passes while checking nothing — which is exactly what the first
 * version of these tests did.
 */
function getWithHost(url, host, headers = {}, { withToken = true } = {}) {
  const target = new URL(url);
  return new Promise((resolve, reject) => {
    const req = nodeHttp.request(
      {
        hostname: target.hostname,
        port: target.port,
        path: target.pathname,
        method: 'GET',
        // The token is added the same way the fetch wrapper above does it,
        // unless the test is specifically about its absence.
        headers: { ...headers, ...(withToken ? { [TOKEN_HEADER]: currentToken ?? '' } : {}), Host: host },
      },
      (res) => {
        res.resume();
        res.on('end', () => resolve({ status: res.statusCode }));
      },
    );
    req.on('error', reject);
    req.end();
  });
}

test('lan: off by default — no lan url, and a foreign Host is refused', async () => {
  const { url, lanUrl } = await boot();
  expect(lanUrl).toBeNull();

  // 400 with no detail, on purpose: the rejection does not echo the Host it
  // refused (see the handler's own note).
  const res = await getWithHost(`${url}/api/projects`, '192.168.1.42:9999', APP_JSON_HEADERS);
  expect(res.status).toBe(400);
});

test('lan: with --lan the machine address is reported and accepted', async () => {
  const { url, lanUrl } = await boot({ lan: true, lanAddressOf: () => '192.168.1.42' });
  expect(lanUrl).toMatch(/^http:\/\/192\.168\.1\.42:\d+$/);

  const port = new URL(url).port;
  const res = await getWithHost(`${url}/api/projects`, `192.168.1.42:${port}`, APP_JSON_HEADERS);
  expect(res.status).toBe(200);
});

test('lan: only that one address — a hostname pointed at it is still refused', async () => {
  const { url } = await boot({ lan: true, lanAddressOf: () => '192.168.1.42' });
  const port = new URL(url).port;
  // DNS rebinding: an attacker's page can point a name at this IP, but it
  // cannot make the browser send a Host header naming the IP itself.
  const res = await getWithHost(`${url}/api/projects`, `evil.example.com:${port}`, APP_JSON_HEADERS);
  expect(res.status).toBe(400);
});

test('lan: the token is still required from the network', async () => {
  const { url } = await boot({ lan: true, lanAddressOf: () => '192.168.1.42' });
  const port = new URL(url).port;
  const res = await getWithHost(`${url}/api/projects`, `192.168.1.42:${port}`, { 'x-app-request': '1' }, { withToken: false });
  expect(res.status).toBe(401);
});

test('lan: a machine with no network address stays on localhost and says so', async () => {
  const { lanUrl } = await boot({ lan: true, lanAddressOf: () => null });
  // Binding wide with no address to name would be an open door nobody can
  // find; reporting one that does not exist would be worse.
  expect(lanUrl).toBeNull();
});

test('lan: the served page never carries the token, not even to loopback', async () => {
  // A reverse proxy or ssh -L tunnel connects as 127.0.0.1 while forwarding
  // for someone else; injecting the token for any loopback request would hand
  // it to them. In LAN mode the local browser gets it from the URL fragment
  // instead (see bin/cli.mjs). (Codex' review.)
  const webDist = fs.mkdtempSync(path.join(tmpRootDir, 'webdist-'));
  fs.writeFileSync(path.join(webDist, 'index.html'), '<html><head><title>kaprek</title></head><body></body></html>', 'utf8');
  const { url, token } = await boot({ webDist, lan: true, lanAddressOf: () => '127.0.0.1' });

  const local = await (await fetch(`${url}/`)).text();
  expect(local).not.toContain(token);
});

test('non-lan: loopback still gets the token in the page', async () => {
  // Without --lan the server binds to 127.0.0.1 only, so there is no proxy
  // path to worry about and the local browser is bootstrapped the usual way.
  const webDist = fs.mkdtempSync(path.join(tmpRootDir, 'webdist-'));
  fs.writeFileSync(path.join(webDist, 'index.html'), '<html><head><title>kaprek</title></head><body></body></html>', 'utf8');
  const { url, token } = await boot({ webDist });

  expect(await (await fetch(`${url}/`)).text()).toContain(token);
});

test('notify: nothing configured by default, and a shell string is refused', async () => {
  const { url } = await boot();
  expect((await (await fetch(`${url}/api/notify`)).json()).notify.configured).toBe(false);

  const bad = await fetch(`${url}/api/notify`, { method: 'PUT', headers: APP_JSON_HEADERS, body: JSON.stringify({ command: 'ntfy publish topic' }) });
  expect(bad.status).toBe(400);

  const good = await fetch(`${url}/api/notify`, { method: 'PUT', headers: APP_JSON_HEADERS, body: JSON.stringify({ command: ['ntfy', 'publish', 'topic'] }) });
  expect(good.status).toBe(200);
  expect((await (await fetch(`${url}/api/notify`)).json()).notify.command).toEqual(['ntfy', 'publish', 'topic']);
});

test('workflows: export bundles what is set up, import shows what it would change first', async () => {
  const { url } = await boot();
  const preset = { id: 'piece', title: 'Marketing piece', firstPrompt: 'Research, draft, check against the style rules, stop before publishing.' };

  const exported = await postJson(`${url}/api/workflows`, {
    id: 'marketing-piece',
    title: 'Marketing piece',
    preset,
    recipeId: 'write-review',
    councilLevel: 'plans',
    profile: ['This project publishes in German.'],
  });
  expect(exported.status).toBe(201);
  const { workflow } = await exported.json();
  expect(workflow.recipe.id).toBe('write-review');

  // A file from a colleague: what does taking it actually do?
  const preview = await postJson(`${url}/api/workflows/preview`, { workflow });
  expect(preview.status).toBe(200);
  const { changes } = await preview.json();
  expect(changes.join('\n')).toContain('grok → claude');
  expect(changes.join('\n')).toContain('plans');

  const listed = await (await fetch(`${url}/api/workflows`)).json();
  expect(listed.workflows.map((entry) => entry.id)).toEqual(['marketing-piece']);
});

test('workflows: an absolute path is refused at export, not stripped', async () => {
  const { url } = await boot();
  const res = await postJson(`${url}/api/workflows`, {
    id: 'leaky',
    title: 'Leaky',
    preset: { id: 'leaky', title: 'Leaky', firstPrompt: 'Read C:\\Users\\klaus\\notes.md first' },
  });
  expect(res.status).toBe(400);
  expect((await res.json()).error).toMatch(/absolute path/);
});

test('workflows: an unknown version is refused on import', async () => {
  const { url } = await boot();
  const res = await postJson(`${url}/api/workflows/preview`, { workflow: { version: 99, id: 'x', title: 'x', preset: { firstPrompt: 'x' } } });
  expect(res.status).toBe(400);
});

test('home: the four guided missions, each with at most three questions', async () => {
  const { url } = await boot();
  const { missions } = await (await fetch(`${url}/api/home`)).json();
  expect(missions.map((mission) => mission.id)).toEqual(['game', 'trip', 'tool', 'reel']);
  for (const mission of missions) expect(mission.questions.length).toBeLessThanOrEqual(3);
});

test('home: starting one produces an ordinary mission and its first prompt', async () => {
  const projectDir = fs.mkdtempSync(path.join(tmpRootDir, 'home-'));
  const { url } = await boot();

  const res = await postJson(`${url}/api/home/game/start`, {
    cwd: projectDir,
    answers: { about: 'Catching things that fall', who: 'A young child', look: 'Bright and simple shapes' },
  });
  expect(res.status).toBe(201);
  const body = await res.json();

  // The same missions store as everything else — no second product.
  const listed = await (await fetch(`${url}/api/missions`)).json();
  expect(listed.missions.map((mission) => mission.id)).toContain(body.mission.id);

  expect(body.firstPrompt).toContain('A young child');
  expect(body.firstPrompt).toMatch(/Do not ask more/);
  expect(body.done).toContain('double-click');
});

test('home: an unknown guided mission is a 404, and a missing folder a 400', async () => {
  const { url } = await boot();
  expect((await postJson(`${url}/api/home/nope/start`, { cwd: 'x' })).status).toBe(404);
  expect((await postJson(`${url}/api/home/game/start`, {})).status).toBe(400);
});

test('chat: an unanswered quiz survives a reload', async () => {
  // It used to arrive on a stream and be gone when the stream was: a
  // refresh mid-question lost the question.
  const quiz = ['```kaprek-quiz', JSON.stringify({ questions: [{ id: 'lang', header: 'Language', question: 'Which language?', options: [{ label: 'German' }, { label: 'English' }] }] }), '```'].join('\n');
  const harness = {
    startTurn: async (options) => {
      options.onEvent({ type: 'text', text: `Let me ask first.\n\n${quiz}` });
      return { sessionId: 's1', costUsd: null, usage: null, stopReason: 'result', error: null };
    },
  };
  const { url } = await boot({ harness });

  const frames = await readSse(await postJson(`${url}/api/chat/turn`, { text: 'plan a thing', mode: 'brainstorm' }));
  const chatId = frames.find((frame) => frame.type === 'chat-id').chatId;

  const reloaded = await (await fetch(`${url}/api/chat/${chatId}`)).json();
  expect(reloaded.openQuiz.questions[0].question).toBe('Which language?');
});

test('chat: a finished quiz is not offered again on reload', async () => {
  const harness = {
    startTurn: async (options) => {
      options.onEvent({ type: 'text', text: 'All done, nothing to ask.' });
      return { sessionId: 's1', costUsd: null, usage: null, stopReason: 'result', error: null };
    },
  };
  const { url } = await boot({ harness });
  const frames = await readSse(await postJson(`${url}/api/chat/turn`, { text: 'hello' }));
  const chatId = frames.find((frame) => frame.type === 'chat-id').chatId;

  expect((await (await fetch(`${url}/api/chat/${chatId}`)).json()).openQuiz).toBeUndefined();
});

test('lan: the phone token answers approvals and nothing else', async () => {
  const { url, approvalToken, token } = await boot({ lan: true, lanAddressOf: () => '127.0.0.1' });
  expect(approvalToken).toBeTruthy();
  expect(approvalToken).not.toBe(token);

  const withPhone = (path, method = 'GET') =>
    rawFetch(`${url}${path}`, { method, headers: { [TOKEN_HEADER]: approvalToken, 'x-app-request': '1', 'Content-Type': 'application/json' }, ...(method === 'POST' ? { body: '{}' } : {}) });

  // The inbox: yes.
  expect((await withPhone('/api/approvals')).status).toBe(200);

  // Everything else: no. PUT /api/notify is the one that matters — its whole
  // job is to run a command, and the QR used to carry a token that could set
  // it. (Codex' review.)
  for (const [path, method] of [
    ['/api/notify', 'PUT'],
    ['/api/chat/turn', 'POST'],
    ['/api/projects', 'GET'],
    ['/api/memory/scopes', 'POST'],
    ['/api/workflows', 'POST'],
    ['/api/council', 'GET'],
  ]) {
    const res = await withPhone(path, method);
    expect(`${method} ${path}: ${res.status}`).toBe(`${method} ${path}: 403`);
  }
});

test('lan: without the flag there is no phone token at all', async () => {
  expect((await boot()).approvalToken).toBeNull();
});

test('lan: a made-up token is still a plain 401', async () => {
  const { url } = await boot({ lan: true, lanAddressOf: () => '127.0.0.1' });
  const res = await rawFetch(`${url}/api/approvals`, { headers: { [TOKEN_HEADER]: 'not-a-real-token', 'x-app-request': '1' } });
  expect(res.status).toBe(401);
});

test('plans: done is gated on a clean convergence check; an override passes it on record', async () => {
  const { url } = await boot();
  const planFile = path.join(dataDir, 'workspace', 'plans', 'gated.md');
  fs.mkdirSync(path.dirname(planFile), { recursive: true });
  fs.writeFileSync(planFile, '# Gated\n\n- [x] step\n', 'utf8');
  const { openPlans } = await import('../plans/store.mjs');
  const store = openPlans(dataDir);
  const registered = store.register({ path: planFile });

  const refused = await postJson(`${url}/api/plans/${registered.id}/status`, { status: 'done' });
  expect(refused.status).toBe(409);
  const refusedBody = await refused.json();
  expect(refusedBody.notConverged).toBe(true);
  expect(refusedBody.error).toContain('no convergence check');

  const badOverride = await postJson(`${url}/api/plans/${registered.id}/status`, { status: 'done', override: { by: '' } });
  expect(badOverride.status).toBe(400);
  const badStatus = await postJson(`${url}/api/plans/${registered.id}/status`, { status: 'finished' });
  expect(badStatus.status).toBe(400);

  const overridden = await postJson(`${url}/api/plans/${registered.id}/status`, { status: 'done', override: { by: 'Klaus' } });
  expect(overridden.status).toBe(200);
  const { plan } = await overridden.json();
  expect(plan.status).toBe('done');
  expect(plan.override.by).toBe('Klaus');

  // After a clean check, done needs no override.
  store.setStatus(registered.id, 'active');
  store.recordConverge(registered.id, { findings: 0, converged: true });
  expect((await (await fetch(`${url}/api/plans/${registered.id}`)).json()).plan.status).toBe('done');
});

test('chat turn: a converge turn names its plan by id, appends the findings to that file and reports them', async () => {
  const planFile = path.join(dataDir, 'workspace', 'plans', 'to-check.md');
  fs.mkdirSync(path.dirname(planFile), { recursive: true });
  fs.writeFileSync(planFile, '# To check\n\n- [x] Build it\n', 'utf8');
  let seenPrompt = null;
  const harness = {
    startTurn: async (options) => {
      seenPrompt = options.appendSystemPrompt ?? '';
      options.onEvent({
        type: 'text',
        text: ['Checked.', '', '```kaprek-findings', JSON.stringify({ converged: false, findings: [{ id: 'F1', sourceRef: 'Build it', gapType: 'partial', severity: 'medium', evidence: 'no README', remainingWork: 'write the README' }] }), '```'].join('\n'),
      });
      return { sessionId: 's1', costUsd: null, usage: null, stopReason: 'result', error: null };
    },
  };
  const { url } = await boot({ harness });
  const { openPlans } = await import('../plans/store.mjs');
  const registered = openPlans(dataDir).register({ path: planFile });

  const unknown = await postJson(`${url}/api/chat/turn`, { text: 'check', mode: 'converge', planId: 'nope' });
  expect(unknown.status).toBe(404);

  const res = await postJson(`${url}/api/chat/turn`, { text: 'check the work against the plan', mode: 'converge', planId: registered.id });
  const frames = await readSse(res);
  const complete = frames.find((f) => f.type === 'turn-complete');
  expect(seenPrompt).toContain(path.resolve(planFile));
  expect(complete.guided.mode).toBe('converge');
  expect(complete.guided.findings.findings).toHaveLength(1);
  expect(complete.guided.plan.id).toBe(registered.id);
  expect(complete.guided.plan.status).toBe('active');
  expect(fs.readFileSync(planFile, 'utf8')).toContain('- [ ] **F1 (medium, partial, Build it):** write the README — no README');

  // Still one plan: the converge turn checked the named one, it did not register a rival.
  expect((await (await fetch(`${url}/api/plans`)).json()).plans).toHaveLength(1);
});

test('board receipt: the payload carries the convergence record of every plan whose chat is one of the task sessions', async () => {
  const harness = {
    startTurn: async (options) => {
      options.onEvent({ type: 'init', sessionId: 'cli-session-7', tools: [], model: 'm', permissionMode: 'default' });
      options.onEvent({ type: 'text', text: ['```kaprek-findings', '{"converged": true, "findings": []}', '```'].join('\n') });
      return { sessionId: 'cli-session-7', costUsd: null, usage: null, stopReason: 'result', error: null };
    },
  };
  const { url } = await boot({ harness });
  const planFile = path.join(dataDir, 'workspace', 'plans', 'receipted.md');
  fs.mkdirSync(path.dirname(planFile), { recursive: true });
  fs.writeFileSync(planFile, '# Receipted\n\n- [x] step\n', 'utf8');
  const { openPlans } = await import('../plans/store.mjs');
  const registered = openPlans(dataDir).register({ path: planFile });
  const frames = await readSse(await postJson(`${url}/api/chat/turn`, { text: 'check', mode: 'converge', planId: registered.id }));
  const chatId = frames.find((f) => f.type === 'turn-complete').chatId;

  const task = await (await postJson(`${url}/api/board/tasks`, { title: 'Receipt with proof' })).json();
  await patchJson(`${url}/api/board/tasks/${task.id}`, { op: 'setDoc', doc: fullDoc() });
  await patchJson(`${url}/api/board/tasks/${task.id}`, { op: 'linkSession', session: { machine: 'pc', projectSlug: 'p', sessionId: 'cli-session-7' } });
  await postJson(`${url}/api/board/tasks/${task.id}/status`, { status: 'in_progress' });
  await postJson(`${url}/api/board/tasks/${task.id}/status`, { status: 'done' });

  const { receipt } = await (await postJson(`${url}/api/board/tasks/${task.id}/receipt`, { agentName: 'fable' })).json();
  expect(receipt.alg).toBe('ed25519');
  expect(await (await fetch(`${url}/api/board/tasks/${task.id}/receipt/verify`)).json()).toEqual({ valid: true });

  // The receipt sealed the plan's state: a later override or check changes the payload, so verification fails.
  openPlans(dataDir).setStatus(registered.id, 'active');
  expect((await (await fetch(`${url}/api/board/tasks/${task.id}/receipt/verify`)).json()).valid).toBe(false);
  expect(chatId).toBeTruthy();
});

test('posture: a turn asked for past the ceiling is a 400 naming the ceiling and its source; the mission only ever tightens', async () => {
  const harness = { startTurn: async () => ({ sessionId: 's', costUsd: null, usage: null, stopReason: 'result', error: null }) };
  const { url } = await boot({ harness });
  fs.writeFileSync(path.join(dataDir, 'policy.json'), JSON.stringify({ posture: 'edits' }), 'utf8');

  const past = await postJson(`${url}/api/chat/turn`, { text: 'go', approvalMode: 'auto' });
  expect(past.status).toBe(400);
  const pastBody = await past.json();
  expect(pastBody.error).toContain('above the posture ceiling "edits" set by policy.json');
  expect(pastBody.posture).toBe('edits');

  const within = await postJson(`${url}/api/chat/turn`, { text: 'go', approvalMode: 'edits' });
  expect(within.status).toBe(200);
  await readSse(within);

  // A mission that tries to loosen (auto under a global edits) changes nothing; one that tightens does.
  const loose = await (await postJson(`${url}/api/missions`, { title: 'loose', posture: 'auto' })).json();
  const stillEdits = await postJson(`${url}/api/chat/turn`, { text: 'go', approvalMode: 'auto', missionId: loose.mission.id });
  expect(stillEdits.status).toBe(400);
  expect((await stillEdits.json()).error).toContain('set by policy.json');

  const tight = await (await postJson(`${url}/api/missions`, { title: 'tight' })).json();
  const set = await postJson(`${url}/api/missions/${tight.mission.id}/posture`, { posture: 'ask' });
  expect(set.status).toBe(200);
  expect((await set.json()).mission.posture).toBe('ask');
  const refused = await postJson(`${url}/api/chat/turn`, { text: 'go', approvalMode: 'edits', missionId: tight.mission.id });
  expect(refused.status).toBe(400);
  expect((await refused.json()).error).toContain('set by the mission "tight"');

  const bad = await postJson(`${url}/api/missions/${tight.mission.id}/posture`, { posture: 'yolo' });
  expect(bad.status).toBe(400);
  const cleared = await postJson(`${url}/api/missions/${tight.mission.id}/posture`, { posture: null });
  expect((await cleared.json()).mission.posture).toBeNull();
});

test('board receipt: policyVersion is null under the default policy and a fingerprint once policy.json owns a posture or a denial', async () => {
  const { url } = await boot({});
  const task = await (await postJson(`${url}/api/board/tasks`, { title: 'Policy me' })).json();
  await patchJson(`${url}/api/board/tasks/${task.id}`, { op: 'setDoc', doc: fullDoc() });
  await postJson(`${url}/api/board/tasks/${task.id}/status`, { status: 'in_progress' });
  await postJson(`${url}/api/board/tasks/${task.id}/status`, { status: 'done' });
  const first = await (await postJson(`${url}/api/board/tasks/${task.id}/receipt`, {})).json();
  expect(first.receipt.alg).toBe('ed25519');
  expect(await (await fetch(`${url}/api/board/tasks/${task.id}/receipt/verify`)).json()).toEqual({ valid: true });

  // A policy that says something of its own changes the payload the receipt sealed.
  fs.writeFileSync(path.join(dataDir, 'policy.json'), JSON.stringify({ posture: 'ask' }), 'utf8');
  expect((await (await fetch(`${url}/api/board/tasks/${task.id}/receipt/verify`)).json()).valid).toBe(false);
});

test('GET /api/usage reads the latest subscription-window signal per harness back from runs.jsonl', async () => {
  const harness = {
    startTurn: async (options) => {
      options.onEvent({ type: 'init', sessionId: 's', tools: [], model: 'm', permissionMode: 'default' });
      options.onEvent({ type: 'rate-limit', info: { status: 'allowed_warning', utilization: 0.8, rateLimitType: 'five_hour', resetsAt: 1756310400 } });
      return { sessionId: 's', costUsd: null, usage: null, stopReason: 'result', error: null };
    },
  };
  const { url } = await boot({ harness });
  expect((await (await fetch(`${url}/api/usage`)).json()).usage).toEqual([]);
  await readSse(await postJson(`${url}/api/chat/turn`, { text: 'hi' }));
  const { usage } = await (await fetch(`${url}/api/usage`)).json();
  expect(usage).toHaveLength(1);
  expect(usage[0].summary).toMatchObject({ usedPercent: 80, window: 'five_hour', status: 'allowed_warning' });
  expect(usage[0].info).toMatchObject({ utilization: 0.8 });
});
