// Local, dependency-free HTTP API server for the loryme transcript viewer.
//
// Binds to 127.0.0.1 only, never 0.0.0.0 — this is a single-user local tool
// and must not become reachable from the network. Access to session files is
// read-only. sessionId/projectSlug from the URL are treated as untrusted:
// they are validated against a strict allowlist and resolved ONLY through
// scanProjects() results, never by concatenating raw user input into a path.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { scanProjects, readSessionMeta } from '../scan/scan.mjs';
import { digestSession } from '../parser/parse.mjs';
import { buildSearchIndex, searchSessions } from '../search/index.mjs';
import { getAppDir } from '../lib/appdir.mjs';
import {
  openBoard,
  STATUSES as BOARD_STATUSES,
  TaskNotFoundError,
  InvalidTitleError,
  InvalidStatusError,
  UnknownDocFieldError,
  DocIncompleteError,
} from '../board/store.mjs';

const DIGEST_CACHE_SIZE = 20;
const MAX_BOARD_BODY_BYTES = 256 * 1024;
const TASK_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

/**
 * Rejects requests whose Host header does not name this exact loopback
 * address+port. Binding to 127.0.0.1 alone is NOT sufficient: a page on a
 * remote origin can point a DNS name at 127.0.0.1 (DNS rebinding) and, once
 * the browser's same-origin check believes it is still talking to that
 * remote origin, issue requests that land on our loopback server anyway —
 * the well-known Vite/webpack-dev-server rebinding pattern. Checking the
 * Host header defeats this because an attacker-controlled page cannot make
 * the browser send a Host header naming our loopback address.
 */
function isAllowedHost(hostHeader, port) {
  if (typeof hostHeader !== 'string' || hostHeader.length === 0) return false;
  const host = hostHeader.toLowerCase();
  const allowed = new Set([
    `127.0.0.1:${port}`,
    `localhost:${port}`,
    `[::1]:${port}`,
    '127.0.0.1',
    'localhost',
    '[::1]',
  ]);
  return allowed.has(host);
}

/** Rejects path-traversal-capable ids: empty, '.', '..', or containing a separator. */
function isSafeId(id) {
  if (typeof id !== 'string' || id.length === 0) return false;
  if (id === '.' || id === '..') return false;
  if (id.includes('/') || id.includes('\\')) return false;
  if (id.includes('..')) return false;
  return true;
}

/** Rejects task ids that aren't a well-formed UUID (board task ids are crypto.randomUUID()). */
function isValidTaskId(id) {
  return typeof id === 'string' && TASK_ID_RE.test(id);
}

/**
 * Reads and JSON-parses a request body, enforcing `application/json` and a
 * hard byte cap (checked against Content-Length up front, and again while
 * streaming in case Content-Length is absent, wrong, or the body is
 * chunked). Never throws — callers get { ok: false, status, error } instead,
 * so route handlers can turn it straight into a JSON error response.
 */
function readJsonBody(req, maxBytes = MAX_BOARD_BODY_BYTES) {
  return new Promise((resolve) => {
    const contentType = req.headers['content-type'] || '';
    if (!contentType.toLowerCase().startsWith('application/json')) {
      req.resume();
      resolve({ ok: false, status: 400, error: 'expected Content-Type: application/json' });
      return;
    }
    const declaredLength = Number(req.headers['content-length']);
    if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
      req.resume();
      resolve({ ok: false, status: 413, error: 'request body too large' });
      return;
    }

    const chunks = [];
    let total = 0;
    let settled = false;
    req.on('data', (chunk) => {
      if (settled) return;
      total += chunk.length;
      if (total > maxBytes) {
        settled = true;
        resolve({ ok: false, status: 413, error: 'request body too large' });
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (settled) return;
      settled = true;
      const raw = Buffer.concat(chunks).toString('utf8');
      if (raw.trim().length === 0) {
        resolve({ ok: true, data: {} });
        return;
      }
      try {
        resolve({ ok: true, data: JSON.parse(raw) });
      } catch {
        resolve({ ok: false, status: 400, error: 'invalid JSON body' });
      }
    });
    req.on('error', () => {
      if (settled) return;
      settled = true;
      resolve({ ok: false, status: 400, error: 'error reading request body' });
    });
  });
}

/** Minimal LRU cache backed by Map insertion order (oldest = first key). */
function createLruCache(maxSize) {
  const map = new Map();
  return {
    get(key) {
      if (!map.has(key)) return undefined;
      const value = map.get(key);
      map.delete(key);
      map.set(key, value); // refresh recency
      return value;
    },
    set(key, value) {
      if (map.has(key)) map.delete(key);
      else if (map.size >= maxSize) map.delete(map.keys().next().value);
      map.set(key, value);
    },
    get size() {
      return map.size;
    },
  };
}

function sendJson(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(body);
}

function sendText(res, status, text) {
  res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end(text);
}

/** Newest session mtime in a project, or '' if the project has no sessions. */
function latestSessionMtime(project) {
  let latest = '';
  for (const s of project.sessions) {
    if (s.mtime > latest) latest = s.mtime;
  }
  return latest;
}

/** GET /api/projects — lightweight project list, no filesystem paths exposed. */
function handleProjects(res, rootDir) {
  const projects = scanProjects(rootDir)
    .slice()
    .sort((a, b) => (latestSessionMtime(b) > latestSessionMtime(a) ? 1 : latestSessionMtime(b) < latestSessionMtime(a) ? -1 : 0))
    .map((p) => ({
      projectSlug: p.projectSlug,
      sessionCount: p.sessions.length,
    }));
  sendJson(res, 200, projects);
}

/** GET /api/sessions?project=<slug> — session list merged with fast meta-scan. */
function handleSessions(res, rootDir, slug) {
  if (!isSafeId(slug)) {
    sendJson(res, 400, { error: 'invalid project' });
    return;
  }
  const project = scanProjects(rootDir).find((p) => p.projectSlug === slug);
  if (!project) {
    sendJson(res, 404, { error: 'project not found' });
    return;
  }
  const sessions = project.sessions.map((s) => {
    let meta = { title: null, startedAt: null, endedAt: null, turns: 0, machineHint: null };
    try {
      meta = readSessionMeta(s.file);
    } catch {
      // Meta scan is best-effort; a broken session file must not break the list.
    }
    return { sessionId: s.sessionId, sizeBytes: s.sizeBytes, mtime: s.mtime, ...meta };
  });
  sessions.sort((a, b) => (b.mtime > a.mtime ? 1 : b.mtime < a.mtime ? -1 : 0));
  sendJson(res, 200, sessions);
}

/** GET /api/session/<slug>/<sessionId>/digest — full digest, LRU-cached. */
async function handleDigest(res, rootDir, redact, cache, slug, sessionId) {
  if (!isSafeId(slug) || !isSafeId(sessionId)) {
    sendJson(res, 400, { error: 'invalid id' });
    return;
  }

  // Resolution goes through scanProjects()'s own file paths only — never
  // string-concatenate rootDir with the raw slug/sessionId from the URL.
  const project = scanProjects(rootDir).find((p) => p.projectSlug === slug);
  if (!project) {
    sendJson(res, 404, { error: 'project not found' });
    return;
  }
  const session = project.sessions.find((s) => s.sessionId === sessionId);
  if (!session) {
    sendJson(res, 404, { error: 'session not found' });
    return;
  }

  const cacheKey = `${slug}/${sessionId}`;
  let digest = cache.get(cacheKey);
  if (!digest) {
    digest = await digestSession(session.file, { redact });
    cache.set(cacheKey, digest);
  }
  sendJson(res, 200, digest);
}

/** GET /api/search?q=<query> — full-text search across indexed sessions. */
async function handleSearch(res, dataDir, query, importSqlite) {
  if (!query || !query.trim()) {
    sendJson(res, 400, { error: 'missing query' });
    return;
  }
  const results = await searchSessions({ dataDir, query, importSqlite });
  if (results && results.unavailable) {
    sendJson(res, 200, { available: false, reason: results.reason });
    return;
  }
  sendJson(res, 200, { available: true, results });
}

/** POST /api/search/reindex — (re)builds the search index synchronously. */
async function handleReindex(res, rootDir, dataDir, importSqlite) {
  const result = await buildSearchIndex({ rootDir, dataDir, importSqlite });
  if (result && result.unavailable) {
    sendJson(res, 200, { available: false, reason: result.reason });
    return;
  }
  sendJson(res, 200, { available: true, indexed: result.indexed, skipped: result.skipped });
}

/**
 * Board routes, mounted at /api/board/*. `getBoard()` opens (or returns the
 * already-open) board for the server's configured dataDir — see
 * startServer()'s lazy board getter below.
 */
async function handleBoardRoutes(req, res, getBoard, segments, url) {
  if (segments[2] !== 'tasks') {
    sendJson(res, 404, { error: 'not found' });
    return;
  }
  const board = getBoard();

  // /api/board/tasks
  if (segments.length === 3) {
    if (req.method === 'GET') {
      const status = url.searchParams.get('status') ?? undefined;
      const project = url.searchParams.get('project') ?? undefined;
      if (status !== undefined && !BOARD_STATUSES.includes(status)) {
        sendJson(res, 400, { error: `invalid status: ${status}` });
        return;
      }
      sendJson(res, 200, { tasks: board.list({ status, project }) });
      return;
    }
    if (req.method === 'POST') {
      const body = await readJsonBody(req);
      if (!body.ok) {
        sendJson(res, body.status, { error: body.error });
        return;
      }
      try {
        const task = board.create({ title: body.data.title, project: body.data.project, tags: body.data.tags });
        sendJson(res, 201, task);
      } catch (err) {
        if (err instanceof InvalidTitleError) {
          sendJson(res, 400, { error: err.message });
          return;
        }
        throw err;
      }
      return;
    }
    sendJson(res, 405, { error: 'method not allowed' });
    return;
  }

  // /api/board/tasks/<id>
  if (segments.length === 4) {
    const taskId = segments[3];
    if (!isValidTaskId(taskId)) {
      sendJson(res, 400, { error: 'invalid task id' });
      return;
    }
    if (req.method !== 'PATCH') {
      sendJson(res, 405, { error: 'method not allowed' });
      return;
    }
    const body = await readJsonBody(req);
    if (!body.ok) {
      sendJson(res, body.status, { error: body.error });
      return;
    }
    const op = body.data?.op;
    try {
      let task;
      if (op === 'update') {
        task = board.update(taskId, body.data.patch ?? {});
      } else if (op === 'setDoc') {
        task = board.setDoc(taskId, body.data.doc ?? {});
      } else if (op === 'linkSession') {
        task = board.linkSession(taskId, body.data.session ?? {});
      } else {
        sendJson(res, 400, { error: `unknown op: ${op}` });
        return;
      }
      sendJson(res, 200, task);
    } catch (err) {
      if (err instanceof TaskNotFoundError) {
        sendJson(res, 404, { error: err.message });
        return;
      }
      if (err instanceof UnknownDocFieldError) {
        sendJson(res, 400, { error: err.message, field: err.field });
        return;
      }
      throw err;
    }
    return;
  }

  // /api/board/tasks/<id>/status
  if (segments.length === 5 && segments[4] === 'status') {
    const taskId = segments[3];
    if (!isValidTaskId(taskId)) {
      sendJson(res, 400, { error: 'invalid task id' });
      return;
    }
    if (req.method !== 'POST') {
      sendJson(res, 405, { error: 'method not allowed' });
      return;
    }
    const body = await readJsonBody(req);
    if (!body.ok) {
      sendJson(res, body.status, { error: body.error });
      return;
    }
    try {
      const task = board.setStatus(taskId, body.data.status);
      sendJson(res, 200, task);
    } catch (err) {
      if (err instanceof TaskNotFoundError) {
        sendJson(res, 404, { error: err.message });
        return;
      }
      if (err instanceof InvalidStatusError) {
        sendJson(res, 400, { error: err.message });
        return;
      }
      if (err instanceof DocIncompleteError) {
        sendJson(res, 409, { error: err.message, missing: err.missing });
        return;
      }
      throw err;
    }
    return;
  }

  sendJson(res, 404, { error: 'not found' });
}

/** Serves static files from webDist with SPA fallback to index.html. */
function serveStatic(res, webDist, pathname) {
  if (!webDist || !fs.existsSync(webDist)) {
    if (pathname === '/') {
      sendText(res, 200, 'loryme local server is running.\nNo web build found — API only.\n');
    } else {
      sendJson(res, 404, { error: 'not found' });
    }
    return;
  }

  const webDistResolved = path.resolve(webDist);
  const requestedRel = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  const resolved = path.resolve(webDistResolved, requestedRel);
  const withinDist = resolved === webDistResolved || resolved.startsWith(webDistResolved + path.sep);

  let filePath = null;
  if (withinDist && fs.existsSync(resolved) && fs.statSync(resolved).isFile()) {
    filePath = resolved;
  } else {
    // SPA fallback: unknown non-API path serves index.html if present.
    const indexPath = path.join(webDistResolved, 'index.html');
    if (fs.existsSync(indexPath)) filePath = indexPath;
  }

  if (!filePath) {
    sendJson(res, 404, { error: 'not found' });
    return;
  }
  const contentType = MIME_TYPES[path.extname(filePath).toLowerCase()] || 'application/octet-stream';
  res.writeHead(200, { 'Content-Type': contentType });
  fs.createReadStream(filePath).pipe(res);
}

async function handleRequest(req, res, { rootDir, redact, webDist, cache, port, dataDir, importSqlite, getBoard }) {
  // No body details on rejection — don't echo the offending Host header back.
  if (!isAllowedHost(req.headers.host, port)) {
    sendJson(res, 400, { error: 'bad request' });
    return;
  }

  // CSRF hardening: every non-GET route requires this custom header. A
  // cross-origin page cannot set custom headers on a simple request, so this
  // forces the browser into a CORS preflight — and since this server sends
  // no CORS headers at all, the preflight fails and the browser never sends
  // the real request. This is the only line of defense against a malicious
  // page issuing state-changing requests against this loopback server, so it
  // applies uniformly to every write route, not just /api/board/*.
  if (req.method !== 'GET' && req.headers['x-app-request'] !== '1') {
    sendJson(res, 403, { error: 'missing app header' });
    return;
  }

  const url = new URL(req.url, 'http://127.0.0.1');
  const segments = url.pathname.split('/').filter(Boolean).map((s) => decodeURIComponent(s));

  if (segments[0] === 'api') {
    // Search and board routes have their own methods (GET for lookup, POST
    // to trigger a rebuild; board mixes GET/POST/PATCH) and are checked
    // before the blanket GET-only rule below.
    if (segments.length === 2 && segments[1] === 'search') {
      if (req.method !== 'GET') {
        sendJson(res, 405, { error: 'method not allowed' });
        return;
      }
      await handleSearch(res, dataDir, url.searchParams.get('q'), importSqlite);
      return;
    }
    if (segments.length === 3 && segments[1] === 'search' && segments[2] === 'reindex') {
      if (req.method !== 'POST') {
        sendJson(res, 405, { error: 'method not allowed' });
        return;
      }
      await handleReindex(res, rootDir, dataDir, importSqlite);
      return;
    }
    if (segments[1] === 'board') {
      await handleBoardRoutes(req, res, getBoard, segments, url);
      return;
    }

    if (req.method !== 'GET') {
      sendJson(res, 405, { error: 'method not allowed' });
      return;
    }
    if (segments.length === 2 && segments[1] === 'projects') {
      handleProjects(res, rootDir);
      return;
    }
    if (segments.length === 2 && segments[1] === 'sessions') {
      handleSessions(res, rootDir, url.searchParams.get('project'));
      return;
    }
    if (segments.length === 5 && segments[1] === 'session' && segments[4] === 'digest') {
      await handleDigest(res, rootDir, redact, cache, segments[2], segments[3]);
      return;
    }
    sendJson(res, 404, { error: 'not found' });
    return;
  }

  if (req.method !== 'GET') {
    sendJson(res, 405, { error: 'method not allowed' });
    return;
  }
  serveStatic(res, webDist, url.pathname);
}

/**
 * Starts the local API/static server. Binds to 127.0.0.1 only.
 * Resolves once listening, with the running http.Server and its base URL.
 */
export function startServer({ port = 0, rootDir, redact = true, webDist, dataDir = getAppDir(), importSqlite } = {}) {
  const cache = createLruCache(DIGEST_CACHE_SIZE);
  // Set for real once listen() resolves below (port:0 means an OS-assigned
  // ephemeral port); the Host-header check needs the actual bound port, not
  // the requested one.
  let boundPort = port;

  // Board is opened lazily on first access to a board route, not eagerly at
  // startup — most invocations of this server never touch the board, and
  // openBoard() replays the whole events.jsonl log.
  let board = null;
  function getBoard() {
    if (!board) board = openBoard(dataDir);
    return board;
  }

  const server = http.createServer((req, res) => {
    handleRequest(req, res, { rootDir, redact, webDist, cache, port: boundPort, dataDir, importSqlite, getBoard }).catch(
      (err) => {
        sendJson(res, 500, { error: 'internal error', message: err.message });
      },
    );
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      const addr = server.address();
      boundPort = addr.port;
      resolve({ server, url: `http://127.0.0.1:${addr.port}` });
    });
  });
}
