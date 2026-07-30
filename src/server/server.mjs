// Local, dependency-free HTTP API server for the kaprek transcript viewer.
//
// Binds to 127.0.0.1 only, never 0.0.0.0 — this is a single-user local tool
// and must not become reachable from the network. Access to session files is
// read-only. sessionId/projectSlug from the URL are treated as untrusted:
// they are validated against a strict allowlist and resolved ONLY through
// scanProjects() results, never by concatenating raw user input into a path.
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { scanProjects, readSessionMeta } from '../scan/scan.mjs';
import { digestSession, registerSecret } from '../parser/parse.mjs';
import { buildSearchIndex, searchSessions } from '../search/index.mjs';
import { getAppDir } from '../lib/appdir.mjs';
import { sweepArtifacts, readArtifactManifest } from '../artifacts/preserve.mjs';
import {
  openBoard,
  STATUSES as BOARD_STATUSES,
  TaskNotFoundError,
  InvalidTitleError,
  InvalidProjectError,
  InvalidTagsError,
  InvalidStatusError,
  UnknownDocFieldError,
  DocIncompleteError,
  missingDocFields,
} from '../board/store.mjs';
import { signReceipt, verifyReceipt, InvalidAgentNameError } from '../receipt/receipt.mjs';
import { openChats, ChatNotFoundError } from '../chats/store.mjs';
import { runTurn } from '../orchestrator/run.mjs';
import { startTurn as claudeCodeStartTurn } from '../harness/claude-code.mjs';
import { openTriggers, InvalidTriggerError } from '../triggers/registry.mjs';
import { createTriggerRunner } from '../triggers/runner.mjs';
import { checkLimits } from '../triggers/limits.mjs';
import { ensureInstanceToken, timingSafeTokenEqual, TOKEN_HEADER } from './token.mjs';

const DIGEST_CACHE_SIZE = 20;
const MAX_BOARD_BODY_BYTES = 256 * 1024;
const TASK_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// Chat ids are crypto.randomUUID() too (see src/chats/store.mjs), same shape as task ids.
const CHAT_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DEFAULT_HARNESS_NAME = 'claude-code';
const DEFAULT_HARNESS = { startTurn: claudeCodeStartTurn };
// Fail-closed: an approval nobody answers must not keep the CLI (and the
// chat's turn) blocked forever — the server layer denies it on its own
// after this long. Overridable per startServer() call so tests don't wait
// 10 real minutes.
const DEFAULT_APPROVAL_TIMEOUT_MS = 10 * 60 * 1000;

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

  // mtime+size are part of the cache key (not just slug/sessionId) so an
  // actively-changing session never serves a stale cached digest — scanProjects()
  // above already stat'd the file fresh for this request, so this costs nothing extra.
  const cacheKey = `${slug}/${sessionId}/${session.mtime}/${session.sizeBytes}`;
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

/**
 * POST /api/search/reindex — (re)builds the search index synchronously, and
 * (best-effort, alongside it) sweeps scratchpad artifacts into dataDir. The
 * two are unrelated features bundled onto the same button/route purely
 * because both are "catch the server up on disk state since last run" —
 * a sweep failure must never fail the reindex response itself.
 */
async function handleReindex(res, rootDir, dataDir, importSqlite, tmpRoot) {
  const result = await buildSearchIndex({ rootDir, dataDir, importSqlite });

  let artifacts = { copied: 0, skipped: 0 };
  try {
    const sweep = sweepArtifacts({ tmpRoot, dataDir });
    artifacts = { copied: sweep.copied, skipped: sweep.skipped };
  } catch {
    // best-effort — a sweep failure must not break the reindex response
  }

  if (result && result.unavailable) {
    sendJson(res, 200, { available: false, reason: result.reason, artifacts });
    return;
  }
  sendJson(res, 200, {
    available: true,
    indexed: result.indexed,
    skipped: result.skipped,
    removed: result.removed,
    artifacts,
  });
}

/** GET /api/session/<slug>/<sessionId>/artifacts — that session's preserved-artifact manifest, or { files: [] }. */
function handleArtifactsManifest(res, dataDir, slug, sessionId) {
  if (!isSafeId(slug) || !isSafeId(sessionId)) {
    sendJson(res, 400, { error: 'invalid id' });
    return;
  }
  const manifest = readArtifactManifest(dataDir, slug, sessionId);
  sendJson(res, 200, manifest);
}

/**
 * Builds the receipt payload for a task's CURRENT state: the exact object
 * signReceipt()/verifyReceipt() hash and sign. Called both when creating a
 * receipt and when verifying one, always from a freshly re-read task — a
 * receipt seals a snapshot, so any later edit to title/project/status/doc/
 * sessions changes this payload and makes an existing receipt verify as
 * invalid. `status` is included so a task that was signed as 'done' and
 * later moved back to e.g. 'backlog' also invalidates its receipt — a
 * receipt otherwise unchanged (same doc, same sessions) must not still
 * verify as a completed-task receipt once the task itself is no longer
 * done. gitCommit/policyVersion aren't tracked yet; carried as null
 * placeholders so the payload shape is stable for future receipts that do
 * set them.
 */
function receiptPayloadFor(task) {
  return {
    taskId: task.id,
    title: task.title,
    project: task.project,
    status: task.status,
    doc: task.doc,
    sessionIds: task.sessions.map((s) => s.sessionId),
    gitCommit: null,
    policyVersion: null,
  };
}

/**
 * Board routes, mounted at /api/board/*. `getBoard()` opens (or returns the
 * already-open) board for the server's configured dataDir — see
 * startServer()'s lazy board getter below.
 */
async function handleBoardRoutes(req, res, getBoard, segments, url, dataDir) {
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
      if (err instanceof InvalidTitleError || err instanceof InvalidProjectError || err instanceof InvalidTagsError) {
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

  // /api/board/tasks/<id>/receipt
  if (segments.length === 5 && segments[4] === 'receipt') {
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
    let task;
    try {
      task = board.get(taskId);
    } catch (err) {
      if (err instanceof TaskNotFoundError) {
        sendJson(res, 404, { error: err.message });
        return;
      }
      throw err;
    }
    // A receipt claims the task is actually done and fully documented, so
    // both must hold at sign time — not just "some doc exists". Reuses the
    // same completeness rule setStatus('done') enforces (missingDocFields),
    // so a task can never get a receipt in a state the board itself would
    // refuse to call 'done'.
    if (task.status !== 'done') {
      sendJson(res, 409, { error: `task is not done (status: ${task.status})` });
      return;
    }
    const missing = missingDocFields(task.doc);
    if (missing.length > 0) {
      sendJson(res, 409, { error: 'doc incomplete, cannot sign a receipt', missing });
      return;
    }
    const agentName =
      typeof body.data?.agentName === 'string' && body.data.agentName.trim().length > 0
        ? body.data.agentName.trim()
        : 'local';
    let receipt;
    try {
      receipt = signReceipt({ dataDir, agentName, payload: receiptPayloadFor(task) });
    } catch (err) {
      if (err instanceof InvalidAgentNameError) {
        sendJson(res, 400, { error: err.message });
        return;
      }
      throw err;
    }
    board.setReceipt(taskId, receipt);
    sendJson(res, 201, { receipt });
    return;
  }

  // /api/board/tasks/<id>/receipt/verify
  if (segments.length === 6 && segments[4] === 'receipt' && segments[5] === 'verify') {
    const taskId = segments[3];
    if (!isValidTaskId(taskId)) {
      sendJson(res, 400, { error: 'invalid task id' });
      return;
    }
    if (req.method !== 'GET') {
      sendJson(res, 405, { error: 'method not allowed' });
      return;
    }
    let task;
    try {
      task = board.get(taskId);
    } catch (err) {
      if (err instanceof TaskNotFoundError) {
        sendJson(res, 404, { error: err.message });
        return;
      }
      throw err;
    }
    if (!task.receipt) {
      sendJson(res, 404, { error: 'no receipt for this task' });
      return;
    }
    // Reconstructed from the task's CURRENT state, not a stored snapshot —
    // see receiptPayloadFor()'s comment.
    const result = verifyReceipt({ payload: receiptPayloadFor(task), receipt: task.receipt });
    sendJson(res, 200, result);
    return;
  }

  sendJson(res, 404, { error: 'not found' });
}

/**
 * Writes one SSE `data:` frame, resolving once it has actually been
 * accepted by the underlying socket. `res.write()` returns `false` when the
 * socket's internal buffer is full (a slow client / small highWaterMark) —
 * writing more on top of that would just grow Node's own write buffer
 * without bound, so this waits for 'drain' before resolving instead of
 * firing writes as fast as events arrive. Silently resolves (does not
 * write) if the client is already gone.
 */
export function writeSseFrame(res, obj) {
  return new Promise((resolve) => {
    if (res.writableEnded) {
      resolve();
      return;
    }
    let ok;
    try {
      ok = res.write(`data: ${JSON.stringify(obj)}\n\n`);
    } catch {
      // client disconnected mid-write — best effort, nothing to recover
      resolve();
      return;
    }
    if (ok) {
      resolve();
    } else {
      res.once('drain', resolve);
    }
  });
}

/**
 * Creates a per-response FIFO write queue for SSE frames. Events arrive
 * synchronously (see runTurn()'s onEvent callback chain, all the way down
 * to claude-code.mjs's readline 'line' handler) and must be written to the
 * client in that exact order — chaining each writeSseFrame() call onto the
 * previous one's promise (rather than firing them all at once) is what
 * keeps both the ordering AND the backpressure-awaiting from writeSseFrame()
 * meaningful: without the chain, a later frame could win the race and reach
 * the socket before an earlier one still waiting on 'drain'.
 */
export function createSseQueue(res) {
  let chain = Promise.resolve();
  return function enqueue(obj) {
    chain = chain.then(() => writeSseFrame(res, obj));
    return chain;
  };
}

/**
 * `pendingApprovals` is server-WIDE (see startServer()), not per-chat, so it
 * needs a key that stays unique across every chat at once — the CLI's own
 * `request_id` alone is NOT guaranteed to be that (task-6a review Important
 * #4/#5): two different CLI subprocesses (two different chats) can in
 * principle hand out colliding ids. A bare `request_id` key would let one
 * chat's entry silently overwrite another's — the earlier chat's `resolve`
 * and `timer` are then gone from the map entirely (leaked promise, orphaned
 * timer that can later mis-fire and deny the WRONG chat's approval). Keying
 * by `chatId:requestId` makes a collision structurally impossible (two
 * different chats can never produce the same composite key even if their
 * raw request_ids happen to match).
 */
function approvalKey(chatId, requestId) {
  return `${chatId}:${requestId}`;
}

/**
 * Builds this turn's onApprovalRequest handler (passed to runTurn(), see
 * src/orchestrator/run.mjs), closing over the SSE `enqueue()` already open
 * for this turn's response. Per approval request:
 *   1. registers a pending entry (keyed by approvalKey(chatId, request.id) —
 *      see that function's doc comment — in `pendingApprovals`, a
 *      server-wide map like `chatAbortControllers`) carrying the promise's
 *      own `resolve`,
 *   2. streams the (already-redacted, see run.mjs's wrapping) request, WITH
 *      the chatId it belongs to, to the browser as one more SSE frame — the
 *      client needs chatId back in POST /api/approvals/<id>'s body (see
 *      handleApprovalDecision() below),
 *   3. returns the promise — resolved by POST /api/approvals/<id> below, by
 *      the timeout further down, or by handleChatTurn's cleanup on turn end/
 *      cancel/disconnect (see cleanupApprovalsForChat()).
 * Never rejects: every path resolves with an ApprovalDecision, deny being
 * the fail-closed default.
 */
function makeApprovalHandler({ chatId, enqueue, pendingApprovals, approvalTimeoutMs }) {
  return (request) =>
    new Promise((resolve) => {
      const key = approvalKey(chatId, request.id);
      const timer = setTimeout(() => {
        const entry = pendingApprovals.get(key);
        if (!entry || entry.decided) return;
        pendingApprovals.delete(key);
        resolve({ behavior: 'deny', message: 'approval timed out' });
      }, approvalTimeoutMs);

      pendingApprovals.set(key, { chatId, decided: false, resolve, timer, createdAt: Date.now() });
      // Fire-and-forget, like every other onEvent->enqueue call in this
      // file (see handleChatTurn's own comment on the same pattern) — but
      // explicitly caught here (never actually rejects today; writeSseFrame
      // itself swallows write errors) so a future change to that guarantee
      // can't turn this into an unhandled rejection on the approval path.
      enqueue({ type: 'approval', chatId, ...request }).catch(() => {});
    });
}

/**
 * Resolves (or garbage-collects) every pending approval belonging to
 * `chatId` — called once per turn, from handleChatTurn's finally block, so
 * turn end, cancel (POST /api/chat/<id>/cancel), and client disconnect all
 * go through this ONE cleanup path (all three simply end the same in-flight
 * runTurn() call, which always reaches this finally). An approval nobody
 * ever answers must not dangle forever once its turn is gone — a HUNG
 * onApprovalRequest promise inside the harness would otherwise never
 * resolve, leaking an async call and (if a caller ever awaited on it) a
 * hung request. `entry.chatId !== chatId` entries (a DIFFERENT chat's still
 * in-flight approval) are left completely untouched — see the module's
 * approval-route doc comment.
 */
function cleanupApprovalsForChat(pendingApprovals, chatId) {
  for (const [key, entry] of pendingApprovals) {
    if (entry.chatId !== chatId) continue;
    clearTimeout(entry.timer);
    if (!entry.decided) {
      entry.decided = true;
      entry.resolve({ behavior: 'deny', message: 'turn ended' });
    }
    pendingApprovals.delete(key);
  }
}

/**
 * POST /api/approvals/<id> — answers a pending tool-use approval (see
 * makeApprovalHandler() above). Body: `{chatId, behavior:'allow'|'deny',
 * message?}`. `chatId` is REQUIRED (not just an optional hint): the id alone
 * is not enough to look an entry up (see approvalKey()'s doc comment above),
 * and a caller that only knows `id` (e.g. from a different chat's own SSE
 * stream) must get exactly the same 404 an unknown id would — never a 409
 * or a decision for a chat it has no business deciding for (task-6a review
 * Important #4). `message` is only meaningful for a deny; an allow always
 * resolves with a plain `{behavior:'allow'}` (see adapter.mjs's
 * ApprovalDecision — this route never accepts an `updatedInput` override
 * from the browser, only the CLI's own proposed input is ever allowed
 * through).
 */
async function handleApprovalDecision(req, res, id, pendingApprovals) {
  if (!isSafeId(id)) {
    sendJson(res, 400, { error: 'invalid approval id' });
    return;
  }
  const body = await readJsonBody(req);
  if (!body.ok) {
    sendJson(res, body.status, { error: body.error });
    return;
  }
  const chatId = body.data?.chatId;
  if (typeof chatId !== 'string' || !CHAT_ID_RE.test(chatId)) {
    sendJson(res, 400, { error: 'chatId is required' });
    return;
  }
  const behavior = body.data?.behavior;
  if (behavior !== 'allow' && behavior !== 'deny') {
    sendJson(res, 400, { error: 'behavior must be "allow" or "deny"' });
    return;
  }

  const entry = pendingApprovals.get(approvalKey(chatId, id));
  if (!entry) {
    sendJson(res, 404, { error: 'unknown or expired approval' });
    return;
  }
  if (entry.decided) {
    sendJson(res, 409, { error: 'approval already decided' });
    return;
  }

  entry.decided = true;
  clearTimeout(entry.timer);
  const message = typeof body.data?.message === 'string' ? body.data.message : undefined;
  entry.resolve(behavior === 'allow' ? { behavior: 'allow' } : { behavior: 'deny', message: message ?? 'denied by user' });
  sendJson(res, 200, { ok: true });
}

/**
 * POST /api/chat/turn — runs one chat turn and streams it back as SSE.
 *
 * The chat is resolved (created if `chatId` is omitted, looked up if given)
 * BEFORE any SSE bytes are written, so a 400/404 can still be a normal JSON
 * response. Once resolved, its id is sent as a `{type:'chat-id'}` bootstrap
 * frame ahead of the harness events — this is NOT one of adapter.mjs's
 * NormalizedEvent types, it's a protocol addition of this route: a brand new
 * chat's id is otherwise only known once the whole turn finishes (runTurn()
 * only returns it at the very end), which would be too late for the client
 * to ever call POST /api/chat/<id>/cancel on it mid-turn.
 *
 * cwd is <dataDir>/workspace, not the server process's own cwd: the agent
 * must not read/write wherever `kaprek` happened to be launched from, and a
 * dedicated directory under dataDir keeps every chat's file edits inside the
 * same place the chat's own transcript already lives.
 *
 * One turn per chat at a time: a chat with an entry in chatAbortControllers
 * already has a turn in flight, so a second POST for the SAME chatId is
 * rejected with a plain 409 JSON response (no SSE stream opened at all) —
 * two turns racing on one chat would otherwise both resume the CLI from the
 * same cliSessionId and interleave their events in the chat store. The busy
 * check and the controller registration below run with no `await` between
 * them (chats.get()/createChat()/mkdirSync() are all synchronous), so two
 * concurrent requests for the same chatId can never both pass the check.
 */
async function handleChatTurn(
  req,
  res,
  { getChats, harness, harnessName, dataDir, chatAbortControllers, permissionMode, allowedTools, pendingApprovals, approvalTimeoutMs },
) {
  const body = await readJsonBody(req);
  if (!body.ok) {
    sendJson(res, body.status, { error: body.error });
    return;
  }
  const text = body.data?.text;
  if (typeof text !== 'string' || text.trim().length === 0) {
    sendJson(res, 400, { error: 'text is required' });
    return;
  }

  const chats = getChats();
  let chatId = body.data?.chatId;
  if (chatId !== undefined) {
    if (typeof chatId !== 'string' || !CHAT_ID_RE.test(chatId)) {
      sendJson(res, 400, { error: 'invalid chatId' });
      return;
    }
    try {
      chats.get(chatId);
    } catch (err) {
      if (err instanceof ChatNotFoundError) {
        sendJson(res, 404, { error: err.message });
        return;
      }
      throw err;
    }
  } else {
    const title = text.slice(0, 80).trim();
    chatId = chats.createChat(title.length > 0 ? { title } : undefined).id;
  }

  if (chatAbortControllers.has(chatId)) {
    sendJson(res, 409, { error: 'chat busy' });
    return;
  }

  const workspaceDir = path.join(dataDir, 'workspace');
  fs.mkdirSync(workspaceDir, { recursive: true });

  const controller = new AbortController();
  chatAbortControllers.set(chatId, controller);
  // Listens on `res`, not `req`: by the time this handler runs, the request
  // body has already been fully read by readJsonBody() above, so `req`'s own
  // 'close' event has typically already fired (or never fires again) and a
  // closed browser tab / killed fetch would NOT reliably reach this turn —
  // `res` is the SSE response actually still streaming to the client, so its
  // 'close' event is what actually reflects the client going away mid-turn.
  const onClientClose = () => controller.abort();
  res.on('close', onClientClose);

  // DEADLOCK GUARD: a pending approval must be resolved the MOMENT abort is
  // requested (cancel route or client disconnect, both call
  // controller.abort()), not only once `await runTurn(...)` below returns —
  // the harness is itself AWAITING that approval's decision, so it would
  // never return in the first place if cleanup waited for it. The `finally`
  // block's own cleanupApprovalsForChat() call further down stays as a
  // second, idempotent pass for any approval that outlives the turn without
  // ever going through abort (e.g. it resolves on its own right as the turn
  // is wrapping up for some other reason).
  controller.signal.addEventListener('abort', () => cleanupApprovalsForChat(pendingApprovals, chatId));

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
  const enqueue = createSseQueue(res);
  enqueue({ type: 'chat-id', chatId });

  try {
    const result = await runTurn({
      dataDir,
      chatId,
      text,
      harness,
      harnessName,
      cwd: workspaceDir,
      permissionMode,
      allowedTools,
      // Not awaited here: onEvent is called synchronously from deep inside
      // the harness (see claude-code.mjs's readline 'line' handler), so
      // there is nothing to await into — enqueue() itself preserves both
      // order and backpressure (see createSseQueue()'s doc comment) without
      // the caller needing to. The 'turn-complete' write below IS awaited,
      // so the response is only ended once every enqueued frame, including
      // this one, has actually reached the socket.
      onEvent: (event) => enqueue(event),
      onApprovalRequest: makeApprovalHandler({ chatId, enqueue, pendingApprovals, approvalTimeoutMs }),
      signal: controller.signal,
    });
    await enqueue({ type: 'turn-complete', ...result });
  } catch (err) {
    // A harness/orchestrator throw here is a genuine programming error (see
    // adapter.mjs's contract note), not a normal turn failure — those are
    // already reported via result.error above. Headers are long sent by this
    // point, so this cannot become a 500 JSON response; report it as one
    // more SSE frame instead of letting it surface as an unhandled rejection.
    await enqueue({ type: 'turn-complete', chatId, cliSessionId: null, costUsd: null, stopReason: 'error', error: { message: err.message } });
  } finally {
    res.off('close', onClientClose);
    // Only remove OUR OWN entry: blindly deleting by chatId would let a
    // slower-finishing turn's finally-block erase a different, still-running
    // turn's controller if the two were ever to overlap for the same key.
    if (chatAbortControllers.get(chatId) === controller) chatAbortControllers.delete(chatId);
    // Turn end, cancel, AND client disconnect all reach here (see this
    // function's own doc comment) — the single place that must never leave
    // a pending approval for this chat dangling (SECURITY: fail-closed).
    cleanupApprovalsForChat(pendingApprovals, chatId);
    if (!res.writableEnded) res.end();
  }
}

/** POST /api/chat/<id>/cancel — aborts that chat's in-flight turn, if any. */
function handleChatCancel(res, getChats, chatId, chatAbortControllers) {
  if (!CHAT_ID_RE.test(chatId)) {
    sendJson(res, 400, { error: 'invalid chat id' });
    return;
  }
  const chats = getChats();
  try {
    chats.get(chatId);
  } catch (err) {
    if (err instanceof ChatNotFoundError) {
      sendJson(res, 404, { error: err.message });
      return;
    }
    throw err;
  }
  const controller = chatAbortControllers.get(chatId);
  if (controller) {
    controller.abort();
    sendJson(res, 200, { cancelled: true });
  } else {
    sendJson(res, 200, { cancelled: false });
  }
}

/**
 * GET /api/chat/list — chat summaries, newest first. A chat whose
 * `chat.created` carries `silent: true` (see src/chats/store.mjs and
 * src/triggers/runner.mjs's heartbeat-silence handling) is excluded unless
 * the caller passes `?includeSilent=1` — the whole point of a silent
 * heartbeat run is to NOT clutter this list with 48 empty-check chats a
 * day, while still keeping every one of them on disk for audit.
 */
function handleChatList(res, getChats, includeSilent) {
  const list = getChats()
    .list()
    .filter((chat) => includeSilent || !chat.silent)
    .slice()
    .sort((a, b) => (b.updatedAt > a.updatedAt ? 1 : b.updatedAt < a.updatedAt ? -1 : 0));
  sendJson(res, 200, { chats: list });
}

/** GET /api/chat/<id> — chat metadata plus its full event log. */
function handleChatGet(res, getChats, chatId) {
  if (!CHAT_ID_RE.test(chatId)) {
    sendJson(res, 400, { error: 'invalid chat id' });
    return;
  }
  const chats = getChats();
  try {
    const chat = chats.get(chatId);
    const events = chats.events(chatId);
    sendJson(res, 200, { chat, events });
  } catch (err) {
    if (err instanceof ChatNotFoundError) {
      sendJson(res, 404, { error: err.message });
      return;
    }
    throw err;
  }
}

/** Chat routes, mounted at /api/chat/*. Checked before the blanket GET-only rule (turn/cancel are POST). */
async function handleChatRoutes(req, res, segments, url, ctx) {
  if (segments.length === 3 && segments[2] === 'turn') {
    if (req.method !== 'POST') {
      sendJson(res, 405, { error: 'method not allowed' });
      return;
    }
    await handleChatTurn(req, res, ctx);
    return;
  }
  if (segments.length === 3 && segments[2] === 'list') {
    if (req.method !== 'GET') {
      sendJson(res, 405, { error: 'method not allowed' });
      return;
    }
    handleChatList(res, ctx.getChats, url.searchParams.get('includeSilent') === '1');
    return;
  }
  if (segments.length === 4 && segments[3] === 'cancel') {
    if (req.method !== 'POST') {
      sendJson(res, 405, { error: 'method not allowed' });
      return;
    }
    handleChatCancel(res, ctx.getChats, segments[2], ctx.chatAbortControllers);
    return;
  }
  if (segments.length === 3) {
    if (req.method !== 'GET') {
      sendJson(res, 405, { error: 'method not allowed' });
      return;
    }
    handleChatGet(res, ctx.getChats, segments[2]);
    return;
  }
  sendJson(res, 404, { error: 'not found' });
}

/**
 * GET /api/triggers — every trigger plus its runsToday/costToday (see
 * src/triggers/limits.mjs::checkLimits) and its approval-wiring status
 * (`approvalPath`: 'policy' for 'notify' — kaprek's own code decides, no
 * human, no wiring needed; 'ui' for 'question'/'review' — needs a live
 * approval surface; see runner.mjs::approvalCapability()). `blocked` is a
 * human-readable reason (or null) — a 'question'/'review' trigger that can
 * structurally never fire (no UI approval handler wired) is visible here,
 * not just a console.log line (task-7a-review.md Important #2).
 */
function handleTriggersList(res, getTriggers, getRunner, dataDir) {
  const runner = getRunner();
  const triggers = getTriggers()
    .list()
    .map((trigger) => {
      const { runsToday, costToday } = checkLimits({ dataDir, trigger, now: Date.now() });
      // `supported`/`unsupportedReason` (see runner.mjs::supportStatus) is the
      // same idea as `blocked` one field over: a clipboard trigger on a
      // non-Windows machine says so here in plain text, instead of offering a
      // switch that silently does nothing.
      return { ...trigger, runsToday, costToday, ...runner.approvalCapability(trigger), ...runner.supportStatus(trigger) };
    });
  sendJson(res, 200, { triggers });
}

/** POST /api/triggers — upsert (create or replace by id). Body is the full trigger shape (see src/triggers/registry.mjs::validateTrigger); 400 with a field name on a validation error. */
async function handleTriggerUpsert(req, res, getTriggers) {
  const body = await readJsonBody(req);
  if (!body.ok) {
    sendJson(res, body.status, { error: body.error });
    return;
  }
  try {
    const trigger = getTriggers().upsert(body.data);
    sendJson(res, 200, trigger);
  } catch (err) {
    if (err instanceof InvalidTriggerError) {
      sendJson(res, 400, { error: err.message, field: err.field });
      return;
    }
    throw err;
  }
}

/** POST /api/triggers/<id>/toggle — body `{enabled}`. */
async function handleTriggerToggle(req, res, getTriggers, id) {
  if (!isSafeId(id)) {
    sendJson(res, 400, { error: 'invalid trigger id' });
    return;
  }
  const body = await readJsonBody(req);
  if (!body.ok) {
    sendJson(res, body.status, { error: body.error });
    return;
  }
  const enabled = body.data?.enabled;
  if (typeof enabled !== 'boolean') {
    sendJson(res, 400, { error: 'enabled must be a boolean' });
    return;
  }
  const trigger = getTriggers().setEnabled(id, enabled);
  if (!trigger) {
    sendJson(res, 404, { error: `unknown trigger: ${id}` });
    return;
  }
  sendJson(res, 200, trigger);
}

/**
 * POST /api/triggers/<id>/fire — manual fire, for test/UI use. Runs through
 * the exact same src/triggers/runner.mjs::fireTrigger() path a background
 * tick uses, with `cause: {origin: 'user'}` — every fail-closed check
 * (limits, loop guard, schedule slot, approval handler) still applies; this
 * is not a bypass.
 *
 * Streams the SAME kind of SSE response POST /api/chat/turn does (a
 * bootstrap `chat-id` frame once the turn's chat is known, live turn
 * events, one final frame) — this is what actually lets a 'question'/
 * 'review' trigger's approval question reach a live client (see
 * getRunner()'s makeUiApprovalHandler wiring, bound to `chatSseQueues`
 * below). A REJECTED fire (disabled, over its daily cap, no due slot, ...)
 * never starts a turn at all — it streams exactly one rejection frame and
 * ends, same shape as a completed one minus `chatId`/`result`.
 *
 * Loop-guard layer 2 of 3 (layer 1: a 'notify' trigger's own policy handler
 * can never reach Bash/WebFetch to call this route in the first place —
 * see runner.mjs::notifyPolicyHandler(); layer 3: an instance-token check
 * across whatever multiple kaprek processes end up talking to the same
 * dataDir, task 7b): while ANY trigger-origin turn is in flight
 * (runner.isAnyTriggerRunning()), this route refuses OUTRIGHT with 429,
 * before opening any stream at all. Deliberately coarse (see that method's
 * own doc comment) — the simplest thing that makes an unnoticed
 * trigger-A-fires-trigger-B-fires-trigger-A chain over HTTP structurally
 * impossible: at most one trigger-origin turn can ever be in flight,
 * system-wide, so a second trigger can never even reach fireTrigger() while
 * a first one (however it started) is still running. A manual user fire
 * briefly blocked by an unrelated already-running heartbeat is an
 * acceptable false positive for that guarantee.
 */
async function handleTriggerFire(res, getRunner, id, chatSseQueues) {
  if (!isSafeId(id)) {
    sendJson(res, 400, { error: 'invalid trigger id' });
    return;
  }
  const runner = getRunner();
  if (runner.isAnyTriggerRunning()) {
    sendJson(res, 429, { reason: 'trigger turn in progress' });
    return;
  }

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
  const enqueue = createSseQueue(res);

  let chatIdForCleanup = null;
  try {
    const result = await runner.fireTrigger(id, {
      cause: { origin: 'user' },
      // Not awaited (same reasoning as handleChatTurn's own onEvent above):
      // events arrive synchronously from deep inside the harness, and
      // enqueue() itself preserves order/backpressure.
      onEvent: (event) => enqueue(event),
      onChatId: (chatId) => {
        chatIdForCleanup = chatId;
        chatSseQueues.set(chatId, enqueue);
        enqueue({ type: 'chat-id', chatId }).catch(() => {});
      },
    });
    await enqueue({ type: 'trigger-complete', ...result });
  } catch (err) {
    // A runner/orchestrator throw here is a genuine programming error, not
    // a normal rejection (those already come back as {fired:false, reason}
    // — see runner.mjs). Headers are long sent by this point, so this
    // cannot become a 429/500 JSON response; report it as one more frame.
    await enqueue({ type: 'trigger-complete', fired: false, reason: `internal error: ${err.message}` });
  } finally {
    if (chatIdForCleanup) chatSseQueues.delete(chatIdForCleanup);
    if (!res.writableEnded) res.end();
  }
}

/** DELETE /api/triggers/<id>. */
function handleTriggerDelete(res, getTriggers, id) {
  if (!isSafeId(id)) {
    sendJson(res, 400, { error: 'invalid trigger id' });
    return;
  }
  const removed = getTriggers().remove(id);
  if (!removed) {
    sendJson(res, 404, { error: `unknown trigger: ${id}` });
    return;
  }
  sendJson(res, 200, { removed: true });
}

/** Trigger routes, mounted at /api/triggers/*. */
async function handleTriggerRoutes(req, res, segments, { getTriggers, getRunner, dataDir, chatSseQueues }) {
  // /api/triggers
  if (segments.length === 2) {
    if (req.method === 'GET') {
      handleTriggersList(res, getTriggers, getRunner, dataDir);
      return;
    }
    if (req.method === 'POST') {
      await handleTriggerUpsert(req, res, getTriggers);
      return;
    }
    sendJson(res, 405, { error: 'method not allowed' });
    return;
  }
  // /api/triggers/<id>
  if (segments.length === 3) {
    if (req.method !== 'DELETE') {
      sendJson(res, 405, { error: 'method not allowed' });
      return;
    }
    handleTriggerDelete(res, getTriggers, segments[2]);
    return;
  }
  // /api/triggers/<id>/toggle | /api/triggers/<id>/fire
  if (segments.length === 4 && req.method === 'POST') {
    if (segments[3] === 'toggle') {
      await handleTriggerToggle(req, res, getTriggers, segments[2]);
      return;
    }
    if (segments[3] === 'fire') {
      await handleTriggerFire(res, getRunner, segments[2], chatSseQueues);
      return;
    }
  }
  sendJson(res, 404, { error: 'not found' });
}

/**
 * Injects the instance token into a served HTML document as
 * `<meta name="kaprek-token" content="…">`, right after the opening <head>
 * tag (or at the very top for a document without one). This is the ONE way
 * the token reaches the browser: never a query parameter (those land in
 * referrers, proxy logs and history), never a cookie (nothing here needs
 * ambient credentials), never a log line. The value is 64 hex characters (see
 * token.mjs), so it cannot break out of the attribute it sits in.
 */
function injectTokenMeta(html, token) {
  const meta = `<meta name="kaprek-token" content="${token}">`;
  const headMatch = html.match(/<head[^>]*>/i);
  if (!headMatch) return `${meta}\n${html}`;
  const insertAt = headMatch.index + headMatch[0].length;
  return `${html.slice(0, insertAt)}\n    ${meta}${html.slice(insertAt)}`;
}

/** Serves static files from webDist with SPA fallback to index.html. HTML documents get the instance token injected (see injectTokenMeta); everything else is streamed as-is. */
function serveStatic(res, webDist, pathname, instanceToken) {
  if (!webDist || !fs.existsSync(webDist)) {
    if (pathname === '/') {
      sendText(res, 200, 'kaprek local server is running.\nNo web build found — API only.\n');
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
  const extension = path.extname(filePath).toLowerCase();
  const contentType = MIME_TYPES[extension] || 'application/octet-stream';
  if (extension === '.html') {
    const html = injectTokenMeta(fs.readFileSync(filePath, 'utf8'), instanceToken);
    // no-store because this document carries the instance token: a cached copy
    // is the token sitting in the browser's on-disk cache, outliving the
    // session it was minted for.
    res.writeHead(200, { 'Content-Type': contentType, 'Cache-Control': 'no-store' });
    res.end(html);
    return;
  }
  res.writeHead(200, { 'Content-Type': contentType });
  fs.createReadStream(filePath).pipe(res);
}

async function handleRequest(
  req,
  res,
  {
    rootDir,
    redact,
    webDist,
    cache,
    port,
    dataDir,
    importSqlite,
    getBoard,
    tmpRoot,
    getChats,
    harness,
    harnessName,
    chatAbortControllers,
    permissionMode,
    allowedTools,
    pendingApprovals,
    approvalTimeoutMs,
    getTriggers,
    getRunner,
    chatSseQueues,
    instanceToken,
  },
) {
  // Clickjacking hardening, applied to EVERY response (API and static alike):
  // a hostile page could otherwise frame this loopback server in an <iframe>
  // and trick a user into clicking board/reindex/signing actions. Set via
  // setHeader (not writeHead) so it survives regardless of which handler
  // eventually calls writeHead/end further down.
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Content-Security-Policy', "frame-ancestors 'none'");

  // No body details on rejection — don't echo the offending Host header back.
  if (!isAllowedHost(req.headers.host, port)) {
    sendJson(res, 400, { error: 'bad request' });
    return;
  }

  const url = new URL(req.url, 'http://127.0.0.1');
  const segments = url.pathname.split('/').filter(Boolean).map((s) => decodeURIComponent(s));

  // Per-installation instance token (see src/server/token.mjs): required on
  // every /api/* route, GET included — loopback plus x-app-request keeps a
  // foreign web page out, but any LOCAL process can set that header itself,
  // and this server starts agent turns on request. A missing or wrong token
  // gets a bare 401: no body, no hint about which of the two it was.
  //
  // THE EXCEPTION is static delivery (everything that is not /api/*).
  // index.html is what HANDS the browser the token (see injectTokenMeta), so
  // it cannot require it, and the JS/CSS it references are requested before
  // any script has had the chance to read that meta tag — requiring the header
  // for those would make the app unloadable. This is deliberately WIDER than
  // the task brief's "only index.html": a stylesheet cannot set a header, so an
  // index.html-only exception would ship an app that never loads. Static
  // delivery is read-only and exposes nothing beyond the shipped web build.
  if (segments[0] === 'api' && !timingSafeTokenEqual(req.headers[TOKEN_HEADER], instanceToken)) {
    res.writeHead(401);
    res.end();
    return;
  }

  // CSRF hardening: every non-GET route requires this custom header. A
  // cross-origin page cannot set custom headers on a simple request, so this
  // forces the browser into a CORS preflight — and since this server sends
  // no CORS headers at all, the preflight fails and the browser never sends
  // the real request. Kept IN ADDITION to the token check above, not replaced
  // by it: the two defend against different attackers (a hostile page vs. a
  // local process), and the token could in principle leak into a page that
  // still cannot set custom headers.
  if (req.method !== 'GET' && req.headers['x-app-request'] !== '1') {
    sendJson(res, 403, { error: 'missing app header' });
    return;
  }

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
      await handleReindex(res, rootDir, dataDir, importSqlite, tmpRoot);
      return;
    }
    if (segments[1] === 'board') {
      await handleBoardRoutes(req, res, getBoard, segments, url, dataDir);
      return;
    }
    if (segments[1] === 'chat') {
      await handleChatRoutes(req, res, segments, url, {
        getChats,
        harness,
        harnessName,
        dataDir,
        chatAbortControllers,
        permissionMode,
        allowedTools,
        pendingApprovals,
        approvalTimeoutMs,
      });
      return;
    }
    if (segments[1] === 'triggers') {
      await handleTriggerRoutes(req, res, segments, { getTriggers, getRunner, dataDir, chatSseQueues });
      return;
    }
    if (segments.length === 3 && segments[1] === 'approvals') {
      if (req.method !== 'POST') {
        sendJson(res, 405, { error: 'method not allowed' });
        return;
      }
      await handleApprovalDecision(req, res, segments[2], pendingApprovals);
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
    if (segments.length === 5 && segments[1] === 'session' && segments[4] === 'artifacts') {
      handleArtifactsManifest(res, dataDir, segments[2], segments[3]);
      return;
    }
    sendJson(res, 404, { error: 'not found' });
    return;
  }

  if (req.method !== 'GET') {
    sendJson(res, 405, { error: 'method not allowed' });
    return;
  }
  serveStatic(res, webDist, url.pathname, instanceToken);
}

/**
 * Starts the local API/static server. Binds to 127.0.0.1 only.
 * Resolves once listening, with the running http.Server, its base URL, and
 * this installation's instance token (see src/server/token.mjs — every /api/*
 * request must carry it in the `x-kaprek-token` header).
 *
 * ============================================================================
 * SECURITY (permissionMode / allowedTools defaults — read before changing):
 *
 * Every chat turn (POST /api/chat/turn) runs the user's own local `claude`
 * CLI as a subprocess (src/harness/claude-code.mjs) with the SAME rights
 * that CLI already has on this machine: Bash, Edit, Write, network access —
 * whatever the CLI's own permission system allows. There is NO sandbox
 * around it here; `cwd` is a dedicated <dataDir>/workspace directory, but
 * that only sets a starting directory, it does not fence off the rest of
 * the filesystem, and `claude -p` (non-interactive/headless mode) skips the
 * CLI's own workspace-trust dialog entirely.
 *
 * permissionMode defaults to 'default' (NOT 'bypassPermissions' or
 * 'acceptEdits') and allowedTools defaults to null (the CLI's own default
 * tool set, but set explicitly here rather than left implicit) so that, at
 * minimum, this server does not itself widen what the agent can already do.
 * That is a floor, not a fence: a real sandbox/policy layer (OS-level
 * confinement, an allowlist enforced independent of the CLI, approval UI)
 * is a prerequisite before this server is exposed to anyone other than the
 * single local user who already trusts their own CLI — see the "Zwingende
 * Sicherheitsgrenze" section of ccview-docs/codex-review-tag1.md and the
 * P0/P1 security recommendations in ccview-docs/grok-review-tag1.md.
 * ============================================================================
 */
export function startServer({
  port = 0,
  rootDir,
  redact = true,
  webDist,
  dataDir = getAppDir(),
  importSqlite,
  tmpRoot = path.join(os.tmpdir(), 'claude'),
  harness = DEFAULT_HARNESS,
  harnessName = DEFAULT_HARNESS_NAME,
  permissionMode = 'default',
  allowedTools = null,
  approvalTimeoutMs = DEFAULT_APPROVAL_TIMEOUT_MS,
} = {}) {
  const cache = createLruCache(DIGEST_CACHE_SIZE);
  // Set for real once listen() resolves below (port:0 means an OS-assigned
  // ephemeral port); the Host-header check needs the actual bound port, not
  // the requested one.
  let boundPort = port;

  // Read (or created on first ever start) before anything can serve a request.
  // registerSecret() makes it redactable everywhere redactSecrets() runs — the
  // chat store's write path included (see run.mjs::sanitizeText) — so a token
  // that ever ends up in a prompt, a tool input or a CLI reply is stored as
  // [REDACTED] instead of verbatim in a transcript on disk.
  const instanceToken = ensureInstanceToken(dataDir);
  registerSecret(instanceToken);

  // Board is opened lazily on first access to a board route, not eagerly at
  // startup — most invocations of this server never touch the board, and
  // openBoard() replays the whole events.jsonl log.
  let board = null;
  function getBoard() {
    if (!board) board = openBoard(dataDir);
    return board;
  }

  // Unlike getBoard() above, this deliberately does NOT cache one openChats()
  // instance: src/orchestrator/run.mjs::runTurn() opens its OWN openChats()
  // instance internally to append a turn's events, entirely separate from
  // whatever instance this route handler holds. A cached instance here would
  // hold a stale in-memory projection the moment a turn (running through
  // runTurn's own instance) writes past it — the two would silently
  // disagree about what a chat contains. Re-opening (a full replay of
  // <dataDir>/chats/*/events.jsonl) on every call keeps this handler reading
  // the same source of truth runTurn just wrote to; the local, single-user,
  // JSONL-backed I/O involved makes that cost negligible.
  function getChats() {
    return openChats(dataDir);
  }

  // Trigger registry, opened lazily like the board above (most invocations
  // never touch it either).
  let triggers = null;
  function getTriggers() {
    if (!triggers) triggers = openTriggers(dataDir);
    return triggers;
  }

  // Same dedicated workspace a chat turn's cwd already is (see
  // handleChatTurn) — a heartbeat trigger's checklistPath is read from here
  // (src/workspace/fs.mjs), and it's the harness's cwd for every trigger-
  // started turn too.
  const workspaceDir = path.join(dataDir, 'workspace');
  fs.mkdirSync(workspaceDir, { recursive: true });

  // The trigger runner, opened lazily and started once listen() resolves
  // (see below), stopped when the server closes. `makeUiApprovalHandler`
  // reuses the SAME makeApprovalHandler() a normal chat turn uses — see the
  // module doc comment further down — bound to `chatSseQueues` so a
  // question/review trigger's approval streams live if (and only if) a
  // client currently has THAT chatId open via the SSE fire route below;
  // otherwise it still exists and still auto-denies after
  // `approvalTimeoutMs`, it just never gets a live listener. A 'notify'
  // trigger never calls this at all — its own self-contained policy
  // decider (see runner.mjs::notifyPolicyHandler()) needs nothing from here.
  let runner = null;
  function getRunner() {
    if (!runner) {
      runner = createTriggerRunner({
        dataDir,
        triggers: getTriggers(),
        runTurn,
        harness,
        harnessName,
        cwd: workspaceDir,
        permissionMode,
        makeUiApprovalHandler: (chatId) =>
          makeApprovalHandler({
            chatId,
            enqueue: (frame) => (chatSseQueues.get(chatId) ?? (() => Promise.resolve()))(frame),
            pendingApprovals,
            approvalTimeoutMs,
          }),
      });
    }
    return runner;
  }

  // One AbortController per chat with an in-flight turn, keyed by chatId —
  // lets POST /api/chat/<id>/cancel reach across requests to interrupt the
  // SSE request currently streaming that chat's turn.
  const chatAbortControllers = new Map();

  // One entry per in-flight tool-use approval, keyed by the CLI's own
  // request_id — server-WIDE (not per-chat), since POST /api/approvals/<id>
  // carries no chatId of its own; see makeApprovalHandler()/
  // handleApprovalDecision()/cleanupApprovalsForChat() above.
  const pendingApprovals = new Map();

  // One live SSE enqueue() function per chatId currently being streamed by
  // the trigger fire route below (POST /api/triggers/<id>/fire) — lets
  // getRunner()'s makeUiApprovalHandler find "is anyone actually watching
  // this trigger-started chat right now" without the runner needing to know
  // anything about HTTP/SSE itself. A background tick-driven fire never has
  // an entry here, so its approval requests still get created (and still
  // time out via approvalTimeoutMs) but never try to write to a dead queue.
  const chatSseQueues = new Map();

  const server = http.createServer((req, res) => {
    handleRequest(req, res, {
      rootDir,
      redact,
      webDist,
      cache,
      port: boundPort,
      dataDir,
      importSqlite,
      getBoard,
      tmpRoot,
      getChats,
      harness,
      harnessName,
      chatAbortControllers,
      permissionMode,
      allowedTools,
      pendingApprovals,
      approvalTimeoutMs,
      getTriggers,
      getRunner,
      chatSseQueues,
      instanceToken,
    }).catch((err) => {
      sendJson(res, 500, { error: 'internal error', message: err.message });
    });
  });

  // The runner's own tick timer is unref()'d (see runner.mjs::start()), so
  // it never keeps this process alive on its own — but it must still be
  // stopped when the server closes, so a test's afterEach (which always
  // closes the server) leaves no dangling interval behind either.
  server.on('close', () => {
    if (runner) runner.stop();
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      const addr = server.address();
      boundPort = addr.port;
      getRunner().start();
      // `token` is returned for the process that STARTED the server (the CLI,
      // a test) — it is deliberately not printed anywhere by default; see
      // token.mjs on why it never goes into a log line.
      resolve({ server, url: `http://127.0.0.1:${addr.port}`, token: instanceToken });
    });
  });
}
