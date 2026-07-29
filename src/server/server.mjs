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

const DIGEST_CACHE_SIZE = 20;

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

async function handleRequest(req, res, { rootDir, redact, webDist, cache, port, dataDir, importSqlite }) {
  // No body details on rejection — don't echo the offending Host header back.
  if (!isAllowedHost(req.headers.host, port)) {
    sendJson(res, 400, { error: 'bad request' });
    return;
  }

  const url = new URL(req.url, 'http://127.0.0.1');
  const segments = url.pathname.split('/').filter(Boolean).map((s) => decodeURIComponent(s));

  if (segments[0] === 'api') {
    // Search routes have their own methods (GET for lookup, POST to trigger
    // a rebuild) and are checked before the blanket GET-only rule below.
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

  const server = http.createServer((req, res) => {
    handleRequest(req, res, { rootDir, redact, webDist, cache, port: boundPort, dataDir, importSqlite }).catch(
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
