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
import { fileURLToPath } from 'node:url';
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
import {
  openMissions,
  MISSION_STATUSES,
  MissionNotFoundError,
  InvalidTitleError as MissionInvalidTitleError,
  InvalidStatusError as MissionInvalidStatusError,
  InvalidCwdError,
  InvalidGoalError,
  InvalidLinkError,
} from '../missions/store.mjs';
import { loadPresets } from '../missions/presets.mjs';
import { runTurn } from '../orchestrator/run.mjs';
import { startTurn as claudeCodeStartTurn } from '../harness/claude-code.mjs';
import { openTriggers, InvalidTriggerError } from '../triggers/registry.mjs';
import { loadApps, resolveToolOwnership } from '../apps/loader.mjs';
import { createTriggerRunner } from '../triggers/runner.mjs';
import { createRelayDispatcher, RELAY_DEFAULT_ROUTE, RELAY_GATE_KIND, RELAY_ROUNDS_PER_GATE } from '../relay/dispatcher.mjs';
import { getPeerDriver as getRegisteredPeerDriver } from '../harness/peers/driver.mjs';
import '../harness/peers/grok.mjs';
import { checkLimits } from '../triggers/limits.mjs';
import { ensureInstanceToken, timingSafeTokenEqual, TOKEN_HEADER } from './token.mjs';
import {
  createApprovalStore,
  APPROVAL_DEADLINE_INTERACTIVE_MS,
  APPROVAL_INBOX_TTL_MS,
} from './approval-store.mjs';
import { ABSOLUTE_MS } from '../harness/timeout.mjs';

// The apps/ directory shipped with kaprek, resolved the same way
// src/apps/mcp-server.mjs resolves it (this file lives in src/server/).
const DEFAULT_BUNDLED_APPS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'apps');

const DIGEST_CACHE_SIZE = 20;
const MAX_BOARD_BODY_BYTES = 256 * 1024;
const TASK_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// Chat ids are crypto.randomUUID() too (see src/chats/store.mjs), same shape as task ids.
const CHAT_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// Mirrors ID_RE in src/triggers/registry.mjs (not exported there) — used to
// reject a malformed ?triggerId= filter on GET /api/chat/list before it ever
// reaches the chat list.
const TRIGGER_ID_RE = /^[a-z0-9-]{1,64}$/;
const DEFAULT_HARNESS_NAME = 'claude-code';
const DEFAULT_HARNESS = { startTurn: claudeCodeStartTurn };

/**
 * The never-pausing wall clock a CHAT turn runs under. Identical to the
 * harness's own default (claude-code.mjs's DEFAULT_ABSOLUTE_TIMEOUT_MS, which
 * is timeout.mjs's ABSOLUTE_MS), and passed EXPLICITLY rather than left
 * implicit: an approval's published deadline is capped to the turn's clock
 * (see effectiveApprovalDeadline), and capping against a number this file
 * merely assumed the harness would use would be a guess dressed as a
 * guarantee. Unattended turns get their own, much larger clock from the
 * runner (see runner.mjs::unattendedAbsoluteTimeoutMs).
 */
const CHAT_ABSOLUTE_TIMEOUT_MS = ABSOLUTE_MS;

/**
 * What an unattended turn is told when it asks for something only a human can
 * grant. It is a deny, because the tool call does not happen now, but the
 * wording is doing real work and is not decoration.
 *
 * A bare "denied" reads to a capable agent as a verdict: it stops trying, or
 * it decides the whole task is impossible and abandons work it could have
 * finished. So this says three things instead. The action was FILED, not
 * refused. It may still run later, so there is no point retrying it now (a
 * retry loop would file the same question again and again). And everything
 * that does not depend on it should still be done before the turn ends.
 */
export const DEFERRAL_MESSAGE =
  'kaprek: this action needs human approval and none is available right now. ' +
  'The request has been filed to the approval inbox; if approved later, kaprek will run it in a follow-up turn ' +
  '- do NOT retry it in this turn. Continue with everything that does not need this approval and finish the turn normally.';

/** The follow-up turn's prompt. Deliberately narrow: this turn exists to run ONE approved action, not to resume the original work. */
export function followUpPrompt({ toolName, input }) {
  const rendered = (() => {
    try {
      return JSON.stringify(input ?? null, null, 2);
    } catch {
      return '(input could not be displayed)';
    }
  })();
  return [
    `Your earlier request to run ${toolName ?? 'a tool'} with the input below was just approved by the user.`,
    'Execute exactly that action now, report the result briefly, and do nothing else beyond what finishing this action requires.',
    '',
    rendered,
  ].join('\n');
}

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
 * When this question really lapses: the EARLIER of its own deadline and the
 * instant its turn dies regardless (`turnDeadlineAt` — the turn's absolute
 * wall clock, see timeout.mjs's ABSOLUTE_MS).
 *
 * WHY THE MINIMUM MATTERS (found independently by both external reviewers,
 * Fix-Runde 2). An unattended turn runs under a wall clock of roughly
 * deadline + 45 minutes. Its first question lapses at the deadline and is
 * auto-denied — which ends that ONE question, not the turn, so the agent may
 * immediately ask again. Question two used to be published with a fresh full
 * deadline: eight more hours, in the API, in the SSE frame and in the inbox.
 * The turn was in fact killed by its wall clock some 45 minutes later, and
 * cleanupApprovalsForChat() denied the question as 'turn ended' with more
 * than seven hours still showing on it. The inbox was promising time that did
 * not exist — the one thing this feature must never do, because a person
 * decides whether to answer now or later BASED on that number.
 *
 * Capping is honest in both directions: it never extends a question past its
 * own deadline, and never past its turn's life. `turnDeadlineAt` of null
 * means the caller has no wall clock to speak of, and nothing is capped —
 * inventing a limit would be the same lie in the other direction.
 *
 * @returns {{deadlineAt: number, cappedByTurn: boolean}} `cappedByTurn` tells
 *   the caller which limit won, so the eventual auto-deny can say what really
 *   ended the question instead of blaming the person who did not answer.
 */
export function effectiveApprovalDeadline(requestedAt, approvalTimeoutMs, turnDeadlineAt) {
  const ownDeadlineAt = requestedAt + approvalTimeoutMs;
  if (!Number.isFinite(turnDeadlineAt) || turnDeadlineAt >= ownDeadlineAt) {
    return { deadlineAt: ownDeadlineAt, cappedByTurn: false };
  }
  return { deadlineAt: turnDeadlineAt, cappedByTurn: true };
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
 *
 * `turnDeadlineAt` is the instant this TURN dies no matter what — its
 * never-pausing wall clock (timeout.mjs's `absolute`, which counts
 * approval-wait time in full). Every deadline this handler publishes is
 * capped to it; see effectiveApprovalDeadline() for why that is a
 * correctness issue and not a nicety.
 */
function makeApprovalHandler({
  chatId,
  enqueue,
  pendingApprovals,
  approvalTimeoutMs,
  approvalStore = null,
  turnDeadlineAt = null,
  mode = 'interactive',
  triggerId = null,
  describeSource = () => null,
}) {
  if (mode === 'deferred') {
    return makeDeferringApprovalHandler({ chatId, enqueue, approvalStore, approvalTimeoutMs, triggerId, describeSource });
  }
  return async (request) => {
    const key = approvalKey(chatId, request.id);
    const requestedAt = Date.now();
    const { deadlineAt, cappedByTurn } = effectiveApprovalDeadline(requestedAt, approvalTimeoutMs, turnDeadlineAt);
    const timeoutMessage = cappedByTurn
      ? 'approval timed out: the turn ran out of time before this question could be answered'
      : 'approval timed out';

    // ORDER MATTERS, and a test caught it the moment persist() became async
    // (Haertung r3): the pending entry is registered BEFORE the store write is
    // awaited. cleanupApprovalsForChat() resolves whatever it finds in this
    // map when a turn ends, so a question registered only AFTER the write
    // would escape that cleanup entirely if the turn happened to end during
    // the write - left pending in the file forever, with an armed timer and a
    // promise nobody would ever resolve. Registering first also puts the
    // store's put() into its queue ahead of any decide() the cleanup makes,
    // so the two land in the right order.
    let resolveDecision;
    const decided = new Promise((resolve) => {
      resolveDecision = resolve;
    });
    const timer = setTimeout(() => {
      const entry = pendingApprovals.get(key);
      if (!entry || entry.decided) return;
      entry.decided = true;
      pendingApprovals.delete(key);
      recordDecision(approvalStore, key, { behavior: 'deny', message: timeoutMessage });
      resolveDecision({ behavior: 'deny', message: timeoutMessage });
      // Fires at the EFFECTIVE deadline, not at approvalTimeoutMs: when the
      // wall clock is the nearer limit, the question must end at its own deny,
      // so the turn gets a decision it can react to rather than being cut off
      // mid-wait by a clock, with the CLI killed and the record left saying
      // the question was still open.
    }, Math.max(0, deadlineAt - requestedAt));
    pendingApprovals.set(key, { chatId, decided: false, resolve: resolveDecision, timer, createdAt: requestedAt });

    // Written down before the question is shown anywhere, and awaited: from
    // here on the CLI is blocked, and a GET /api/approvals arriving one
    // millisecond later must already find it. A store write that fails is
    // fail-closed, not "carry on and hope someone is streaming" - a question
    // that was never recorded is one nobody can look up.
    if (approvalStore) {
      try {
        await approvalStore.put({
          id: key,
          requestId: request.id,
          chatId,
          source: describeSource(chatId),
          toolName: request.toolName ?? null,
          displayName: request.displayName ?? null,
          input: request.input ?? null,
          description: request.description ?? null,
          reason: request.reason ?? null,
          agentId: request.agentId ?? null,
          requestedAt,
          deadlineAt,
        });
      } catch (err) {
        // Take the registration back, unless the turn already ended during
        // the write and resolved it for us.
        const entry = pendingApprovals.get(key);
        if (entry && !entry.decided) {
          entry.decided = true;
          clearTimeout(entry.timer);
          pendingApprovals.delete(key);
          return { behavior: 'deny', message: `approval could not be recorded: ${err.message}` };
        }
        return decided;
      }
    }

    // Fire-and-forget, like every other onEvent->enqueue call in this file
    // (see handleChatTurn's own comment on the same pattern), but explicitly
    // caught here (never actually rejects today; writeSseFrame itself swallows
    // write errors) so a future change to that guarantee can't turn this into
    // an unhandled rejection on the approval path. `source` says WHERE the
    // question comes from (which trigger, or which chat). It matters because
    // an approval is delivered to whatever stream is open, not only to the one
    // watching this chat - a user shown "allow Bash?" out of nowhere has to be
    // able to see what asked, or they are granting rights blind.

      enqueue({ type: 'approval', chatId, source: describeSource(chatId), ...request, deadlineAt }).catch(() => {});
    return decided;
  };
}

/**
 * The unattended half of makeApprovalHandler: file the question and let the
 * turn get on with its work.
 *
 * WHY THIS REPLACED PARKING. The first version of the inbox kept the CLI
 * blocked on `can_use_tool` until someone answered, for up to eight hours.
 * That one decision produced most of this feature's problems: a `claude`
 * subprocess held open all night, the trigger's chat locked and every manual
 * fire refused for as long, caps that could not see a turn that had not ended,
 * and a wall clock that had to be stretched around the wait and then lied
 * about how long a question really had. None of that is inherent to asking a
 * human; it came from making the agent WAIT for the answer.
 *
 * So the turn is told, immediately, that the action is filed and that it
 * should carry on (DEFERRAL_MESSAGE). The entry outlives the turn on purpose -
 * that is what makes it redeemable later, by a follow-up turn that runs the
 * one approved action (see handleApprovalDecision). Nothing is registered in
 * `pendingApprovals` and no timer is armed, because nothing is waiting.
 */
function makeDeferringApprovalHandler({ chatId, enqueue, approvalStore, approvalTimeoutMs, triggerId, describeSource }) {
  return async (request) => {
    const requestedAt = Date.now();
    let entry;
    try {
      entry = await approvalStore.put({
        id: approvalKey(chatId, request.id),
        requestId: request.id,
        chatId,
        triggerId,
        mode: 'deferred',
        source: describeSource(chatId),
        toolName: request.toolName ?? null,
        displayName: request.displayName ?? null,
        input: request.input ?? null,
        description: request.description ?? null,
        reason: request.reason ?? null,
        agentId: request.agentId ?? null,
        requestedAt,
        deadlineAt: requestedAt + approvalTimeoutMs,
      });
    } catch (err) {
      // Fail-closed, and say why: a question that could not be filed is one
      // nobody will ever see, so promising a follow-up would be a lie.
      return { behavior: 'deny', message: `kaprek: this action needs human approval, and the request could not be filed (${err.message}). Continue without it.` };
    }

    // The frame carries the ENTRY's identity, not the raw request's: a
    // repeated question is deduped onto the existing entry (see the store's
    // put()), and an answer has to name the id that actually exists.
    enqueue({
      type: 'approval',
      chatId: entry.chatId,
      source: entry.source ?? null,
      ...request,
      id: entry.requestId,
      mode: 'deferred',
      askedCount: entry.askedCount ?? 1,
      requestedAt: entry.requestedAt,
      deadlineAt: entry.deadlineAt,
    }).catch(() => {});

    return { behavior: 'deny', message: DEFERRAL_MESSAGE };
  };
}

/**
 * Records an already-made decision in the durable inbox. Best-effort BY
 * DESIGN, and the direction matters: the in-memory entry in `pendingApprovals`
 * is what actually unblocks the CLI, so a store that cannot write must not
 * turn a valid answer into a failed request or a hung turn. The store is the
 * record, not the gate.
 *
 * The one thing it must never do is stay silent about a decision that DID
 * happen — an entry left `pending` on disk would show up in the inbox as a
 * question to answer twice. store.decide() throwing here means exactly one of
 * three things (unknown id, already decided, expired), all of which mean the
 * durable record is already at least as final as this call would make it.
 */
function recordDecision(approvalStore, key, decision) {
  if (!approvalStore) return;
  approvalStore.decide(key, decision).catch(() => {});
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
function cleanupApprovalsForChat(pendingApprovals, chatId, approvalStore = null) {
  for (const [key, entry] of pendingApprovals) {
    if (entry.chatId !== chatId) continue;
    clearTimeout(entry.timer);
    if (!entry.decided) {
      entry.decided = true;
      recordDecision(approvalStore, key, { behavior: 'deny', message: 'turn ended' });
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
async function handleApprovalDecision(req, res, id, pendingApprovals, approvalStore = null, getRunner = null, getRelay = null) {
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

  const key = approvalKey(chatId, id);
  const entry = pendingApprovals.get(key);
  if (!entry) {
    // DEFERRED entries live only in the store: nothing in this process is
    // waiting on them, which is exactly why they can still be answered hours
    // later and across a restart. Answering one is not "resolving a promise",
    // it is a decision plus, for an allow, a fresh turn that runs the action.
    const filed = approvalStore ? await approvalStore.get(key) : null;
    if (filed?.kind === RELAY_GATE_KIND && filed.status === 'pending') {
      await decideRelayGate(res, { key, entry: filed, behavior, approvalStore, getRelay });
      return;
    }
    if (filed?.mode === 'deferred' && filed.status === 'pending') {
      await decideDeferredApproval(res, { key, entry: filed, behavior, message: body.data?.message, approvalStore, getRunner });
      return;
    }
    if (filed?.status === 'lapsed') {
      sendJson(res, 410, { error: 'approval lapsed: nobody answered it before its deadline' });
      return;
    }
    // Nothing is waiting in THIS process. The durable record can still say
    // why, and the two reasons are worth telling apart: a question that died
    // with a previous process (410 — answering it is impossible, no amount of
    // retrying helps) versus one that never existed here at all (404). A
    // browser tab left open across a server restart hits the first case, and
    // "unknown" would be a misleading thing to tell it.
    const known = approvalStore ? await approvalStore.get(key) : null;
    if (known?.status === 'expired') {
      sendJson(res, 410, { error: `approval expired: ${known.expired}`, expired: known.expired });
      return;
    }
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
  const decision = behavior === 'allow' ? { behavior: 'allow' } : { behavior: 'deny', message: message ?? 'denied by user' };
  recordDecision(approvalStore, key, decision);
  entry.resolve(decision);
  sendJson(res, 200, { ok: true });
}

/**
 * Answers a DEFERRED question: record the decision, and on an allow start the
 * follow-up turn that actually runs the action.
 *
 * Order matters. The follow-up is gated BEFORE the decision is recorded, so a
 * refusal (another turn is running in that chat) leaves the question exactly
 * as it was — still pending, still answerable in a minute — instead of burning
 * it on a turn that never started. There is deliberately no queueing: kaprek
 * would otherwise be promising to run something at an unknown later time,
 * which is the promise this whole redesign exists to stop making.
 *
 * The turn itself is NOT awaited. It can take minutes, and the browser is
 * waiting for an answer to "did my approval land", not for the work to finish.
 */
async function decideDeferredApproval(res, { key, entry, behavior, message, approvalStore, getRunner }) {
  if (behavior === 'deny') {
    try {
      await approvalStore.decide(key, { behavior: 'deny', message: typeof message === 'string' ? message : 'denied by user' });
    } catch (err) {
      sendJson(res, 409, { error: err.message });
      return;
    }
    sendJson(res, 200, { ok: true, followUp: false });
    return;
  }

  const runner = getRunner ? getRunner() : null;
  if (!runner) {
    sendJson(res, 503, { error: 'cannot run the approved action right now' });
    return;
  }
  const gate = runner.canStartFollowUp(entry.chatId);
  if (!gate.allowed) {
    // The question survives untouched, which is the point of checking first.
    sendJson(res, 409, { error: `${gate.reason} — approve again when the current turn is done` });
    return;
  }

  try {
    await approvalStore.decide(key, { behavior: 'allow' });
  } catch (err) {
    sendJson(res, 409, { error: err.message });
    return;
  }

  // Fire-and-forget: errors reach the log and the chat transcript, not this
  // response (which is long sent by the time the turn ends).
  runner.fireFollowUp({ entry }).catch(() => {});
  sendJson(res, 200, { ok: true, followUp: true });
}

/**
 * Answers a relay gate: one more round, or the run stops.
 *
 * The approval carries the hashes the run had when it asked (see
 * dispatcher.mjs::participantsHashOf). They are handed back rather than
 * recomputed here, so the dispatcher can check that the run it is about to
 * continue is still the run the operator saw. An approval is a statement
 * about a specific run at a specific moment, and this is what keeps it from
 * being spent on a different one.
 */
async function decideRelayGate(res, { key, entry, behavior, approvalStore, getRelay }) {
  const relay = getRelay ? getRelay() : null;
  if (!relay) {
    sendJson(res, 503, { error: 'the relay is not available in this server' });
    return;
  }

  if (behavior === 'deny') {
    try {
      await approvalStore.decide(key, { behavior: 'deny', message: 'the operator stopped the run' });
      await relay.denyGate({ chatId: entry.chatId, reason: 'the operator stopped the run at the gate' });
    } catch (err) {
      sendJson(res, 409, { error: err.message });
      return;
    }
    sendJson(res, 200, { ok: true, relay: 'stopped' });
    return;
  }

  try {
    await approvalStore.decide(key, { behavior: 'allow' });
  } catch (err) {
    sendJson(res, 409, { error: err.message });
    return;
  }

  try {
    await relay.resumeAfterGate({
      chatId: entry.chatId,
      voucher: { participantsHash: entry.participantsHash, budgetSnapshotHash: entry.budgetSnapshotHash, approvalKey: key },
    });
  } catch (err) {
    // The voucher was recorded as spent but could not be redeemed - almost
    // always because the run changed shape in between. Say so rather than
    // reporting a success the run did not have.
    sendJson(res, 409, { error: err.message });
    return;
  }
  sendJson(res, 200, { ok: true, relay: 'resumed' });
}

/**
 * Reads a relay answer out of what a Claude turn said.
 *
 * The peers are constrained by a JSON schema; the local Claude harness is not,
 * so its answer is parsed here — leniently about wrapping (a fenced block is
 * still an answer) and strictly about content. An answer that cannot be read
 * counts as `needs_human`: the run parks at a gate with the text attached
 * rather than guessing what the reviewer meant, because the alternative is a
 * loop steered by a misread word.
 */
export function parseRelayAnswer(text, result = {}) {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text ?? '');
  const candidate = (fenced ? fenced[1] : text ?? '').trim();
  try {
    const parsed = JSON.parse(candidate);
    if (['handoff', 'done', 'needs_human'].includes(parsed?.status) && typeof parsed?.message === 'string') {
      return { status: parsed.status, message: parsed.message, usage: result.usage ?? null, costUsd: result.costUsd ?? null, durationMs: 0, rawLogPath: null };
    }
  } catch {
    // falls through to the honest answer below
  }
  return {
    status: 'needs_human',
    message: text && text.trim().length > 0 ? text : '(the reviewer produced no readable answer)',
    usage: result.usage ?? null,
    costUsd: result.costUsd ?? null,
    durationMs: 0,
    rawLogPath: null,
  };
}

/**
 * POST /api/chat/<id>/relay — starts a relay run on that chat.
 *
 * A human starts a run, always. There is deliberately no way for a trigger to
 * start one: a scheduled job that can start an agent-to-agent loop is exactly
 * the shape of thing that runs all night without anyone deciding it should.
 */
async function handleRelayStart(req, res, chatId, { getRelay, getRunner }) {
  if (!CHAT_ID_RE.test(chatId)) {
    sendJson(res, 400, { error: 'invalid chat id' });
    return;
  }
  const relay = getRelay ? getRelay() : null;
  if (!relay) {
    sendJson(res, 503, { error: 'the relay is not available in this server' });
    return;
  }
  const body = await readJsonBody(req);
  if (!body.ok) {
    sendJson(res, body.status, { error: body.error });
    return;
  }
  const goal = body.data?.goal;
  if (typeof goal !== 'string' || goal.trim().length === 0) {
    sendJson(res, 400, { error: 'goal is required' });
    return;
  }
  const route = Array.isArray(body.data?.route) && body.data.route.length > 0 ? body.data.route : [...RELAY_DEFAULT_ROUTE];
  const maxRounds = Number.isInteger(body.data?.maxRounds) && body.data.maxRounds > 0 ? body.data.maxRounds : RELAY_ROUNDS_PER_GATE;

  // Same busy rule a chat turn gets: one conversation, one thing writing into
  // it at a time.
  if (getRunner && getRunner().isChatRunning(chatId)) {
    sendJson(res, 409, { error: 'chat busy: a turn is already running in this chat' });
    return;
  }

  try {
    const started = await relay.startRun({ chatId, goal, route, maxRounds });
    sendJson(res, 200, { runId: started.runId, status: started.status, route: started.route, maxRounds: started.maxRounds });
  } catch (err) {
    sendJson(res, 409, { error: err.message });
  }
}

/** POST /api/relay/<runId>/stop — ends a run where it stands. */
async function handleRelayStop(res, runId, { getRelay }) {
  if (!isSafeId(runId)) {
    sendJson(res, 400, { error: 'invalid run id' });
    return;
  }
  const relay = getRelay ? getRelay() : null;
  if (!relay) {
    sendJson(res, 503, { error: 'the relay is not available in this server' });
    return;
  }
  const result = await relay.stopRun(runId, 'stopped by the operator');
  if (!result.stopped) {
    sendJson(res, 404, { error: result.reason ?? 'unknown run' });
    return;
  }
  sendJson(res, 200, { ok: true });
}

/**
 * GET /api/approvals — the inbox: every question this process is still
 * waiting on, oldest first. This is the half an SSE frame cannot cover: a
 * frame only reaches whoever was connected at the moment it was pushed, so a
 * page opened afterwards had no way to learn a question existed at all. Here
 * it can simply ask.
 *
 * The response deliberately mirrors an SSE approval frame's fields (see
 * makeApprovalHandler above), plus `requestedAt`/`deadlineAt`, so the web app
 * renders an inbox entry with the same component and answers it through the
 * same POST /api/approvals/<id> — `id` is the CLI's own request id and
 * `chatId` is required alongside it (see approvalKey()).
 *
 * Entries left over from a previous process are NOT listed: they cannot be
 * answered (see approval-store.mjs's own doc comment), and offering buttons
 * that can only fail is worse than not showing the entry.
 */
async function handleApprovalsList(res, approvalStore) {
  const pending = approvalStore ? await approvalStore.listPending() : [];
  const approvals = pending.map((entry) => ({
    id: entry.requestId,
    chatId: entry.chatId,
    source: entry.source ?? null,
    toolName: entry.toolName,
    displayName: entry.displayName,
    input: entry.input,
    // The short form a list renders from (see approval-store.mjs's
    // inputPreview) - always present, so a client never has to pull a
    // megabyte of tool input to show one line.
    inputPreview: entry.inputPreview ?? null,
    description: entry.description,
    reason: entry.reason,
    agentId: entry.agentId,
    requestedAt: entry.requestedAt,
    deadlineAt: entry.deadlineAt,
    // 'deferred' questions are the ones the floating box shows: nothing is
    // waiting on them, they outlive their turn, and answering one starts a
    // follow-up turn. 'interactive' ones belong to a live dialog and are
    // already on screen wherever they matter.
    mode: entry.mode ?? 'interactive',
    // What sort of question this is: a tool-use approval, or a relay gate
    // (see relay/dispatcher.mjs). The UI needs it to label the card, and a
    // gate is answered through a different path on the way back in.
    kind: entry.kind ?? null,
    triggerId: entry.triggerId ?? null,
    // How often the trigger has asked this same question (see the store's
    // dedupe). Worth showing: a question asked five times is a different kind
    // of pending than one asked once.
    askedCount: entry.askedCount ?? 1,
  }));
  sendJson(res, 200, { approvals });
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
/** Maps a mission-store error to an HTTP status, or null for a non-mission error. */
function missionErrorStatus(err) {
  if (err instanceof MissionNotFoundError) return 404;
  if (
    err instanceof MissionInvalidTitleError ||
    err instanceof MissionInvalidStatusError ||
    err instanceof InvalidCwdError ||
    err instanceof InvalidGoalError ||
    err instanceof InvalidLinkError
  ) {
    return 400;
  }
  return null;
}

/**
 * Mission routes, mounted at /api/missions/*. A mission is the central
 * object of Zielbild M0: a goal plus an optional working directory and
 * links to the chats and board tasks carrying the work. `getMissions()` is
 * a lazy singleton like `getBoard()` — the mission store is only ever
 * written through these routes, so one cached projection stays truthful.
 */
async function handleMissionRoutes(req, res, segments, { getMissions, getChats, getBoard, getApprovalStore }) {
  const missions = getMissions();

  // /api/missions
  if (segments.length === 2) {
    if (req.method === 'GET') {
      const pending = await getApprovalStore().listPending();
      const list = missions.list().map((mission) => ({
        ...mission,
        pendingApprovals: pending.filter((entry) => entry.chatId && mission.chats.includes(entry.chatId)).length,
      }));
      sendJson(res, 200, { missions: list });
      return;
    }
    if (req.method === 'POST') {
      const body = await readJsonBody(req);
      if (!body.ok) {
        sendJson(res, body.status, { error: body.error });
        return;
      }
      const { title, goal = null, cwd = null, preset = null } = body.data ?? {};
      // Existence is a route concern, shape is a store concern: the store
      // validates "absolute path", but only this process can ask the disk.
      // Checked BEFORE create() so a mission with a dead cwd never enters
      // the log (fail-closed).
      if (cwd !== null) {
        if (typeof cwd !== 'string' || !path.isAbsolute(cwd)) {
          sendJson(res, 400, { error: 'cwd must be an absolute path' });
          return;
        }
        let stat = null;
        try {
          stat = fs.statSync(cwd);
        } catch {
          stat = null;
        }
        if (!stat || !stat.isDirectory()) {
          sendJson(res, 400, { error: 'cwd does not exist or is not a directory' });
          return;
        }
      }
      try {
        const mission = missions.create({ title, goal, cwd, preset });
        sendJson(res, 201, { mission });
      } catch (err) {
        const status = missionErrorStatus(err);
        if (status === null) throw err;
        sendJson(res, status, { error: err.message });
      }
      return;
    }
    sendJson(res, 405, { error: 'method not allowed' });
    return;
  }

  // /api/missions/<id>
  if (segments.length === 3) {
    if (req.method !== 'GET') {
      sendJson(res, 405, { error: 'method not allowed' });
      return;
    }
    let mission;
    try {
      mission = missions.get(segments[2]);
    } catch (err) {
      const status = missionErrorStatus(err);
      if (status === null) throw err;
      sendJson(res, status, { error: err.message });
      return;
    }
    // A chat belongs to the detail view if the chat itself claims the
    // mission (createChat missionId) OR the mission links it (link route) —
    // the union, so neither path leaves an orphan invisible.
    const chats = getChats()
      .list()
      .filter((chat) => chat.missionId === mission.id || mission.chats.includes(chat.id));
    const tasks = getBoard()
      .list()
      .filter((task) => mission.tasks.includes(task.id));
    const pendingApprovals = (await getApprovalStore().listPending())
      .filter((entry) => entry.chatId && chats.some((chat) => chat.id === entry.chatId));
    sendJson(res, 200, { mission, chats, tasks, pendingApprovals });
    return;
  }

  // /api/missions/<id>/status | /api/missions/<id>/link
  if (segments.length === 4 && (segments[3] === 'status' || segments[3] === 'link')) {
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
      if (segments[3] === 'status') {
        sendJson(res, 200, { mission: missions.setStatus(segments[2], body.data?.status) });
        return;
      }
      const { chatId, taskId } = body.data ?? {};
      const givenBoth = chatId !== undefined && taskId !== undefined;
      if (givenBoth || (chatId === undefined && taskId === undefined)) {
        sendJson(res, 400, { error: 'link takes exactly one of chatId or taskId' });
        return;
      }
      const mission = chatId !== undefined
        ? missions.linkChat(segments[2], chatId)
        : missions.linkTask(segments[2], taskId);
      sendJson(res, 200, { mission });
    } catch (err) {
      const status = missionErrorStatus(err);
      if (status === null) throw err;
      sendJson(res, status, { error: err.message });
    }
    return;
  }

  sendJson(res, 404, { error: 'not found' });
}

async function handleChatTurn(
  req,
  res,
  {
    getChats,
    getMissions,
    harness,
    harnessName,
    dataDir,
    chatAbortControllers,
    permissionMode,
    allowedTools,
    pendingApprovals,
    approvalTimeoutMs,
    chatAbsoluteTimeoutMs = CHAT_ABSOLUTE_TIMEOUT_MS,
    approvalStore,
    getRunner,
    isRelayChatRunning,
    chatSseQueues,
    approvalStreams,
    describeSource,
  },
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

  // Mission resolution — BEFORE any SSE bytes, so a bad mission is a plain
  // JSON error. A turn's mission comes either from the request (creating a
  // new chat inside a mission) or from the chat's own stored missionId (a
  // follow-up turn keeps running where the mission lives).
  const requestMissionId = body.data?.missionId;
  if (requestMissionId !== undefined && requestMissionId !== null && typeof requestMissionId !== 'string') {
    sendJson(res, 400, { error: 'invalid missionId' });
    return;
  }
  let mission = null;
  if (typeof requestMissionId === 'string') {
    try {
      mission = getMissions().get(requestMissionId);
    } catch (err) {
      if (err instanceof MissionNotFoundError) {
        sendJson(res, 404, { error: err.message });
        return;
      }
      throw err;
    }
  }

  let chatId = body.data?.chatId;
  if (chatId !== undefined) {
    if (typeof chatId !== 'string' || !CHAT_ID_RE.test(chatId)) {
      sendJson(res, 400, { error: 'invalid chatId' });
      return;
    }
    let existing;
    try {
      existing = chats.get(chatId);
    } catch (err) {
      if (err instanceof ChatNotFoundError) {
        sendJson(res, 404, { error: err.message });
        return;
      }
      throw err;
    }
    if (mission && existing.missionId && existing.missionId !== mission.id) {
      sendJson(res, 400, { error: 'chat already belongs to a different mission' });
      return;
    }
    if (!mission && existing.missionId) {
      try {
        mission = getMissions().get(existing.missionId);
      } catch {
        // Fail-closed: a chat that claims a mission this store cannot
        // resolve must not silently fall back to the workspace cwd.
        sendJson(res, 400, { error: 'mission not found for this chat' });
        return;
      }
    }
  } else {
    const title = text.slice(0, 80).trim();
    chatId = chats.createChat({
      ...(title.length > 0 ? { title } : {}),
      missionId: mission ? mission.id : null,
    }).id;
    if (mission) getMissions().linkChat(mission.id, chatId);
  }

  if (chatAbortControllers.has(chatId)) {
    sendJson(res, 409, { error: 'chat busy' });
    return;
  }

  // Same gate, other half: a TRIGGER turn writing into this chat holds no
  // entry in chatAbortControllers (it never came through this route). Without
  // this check, a chat turn posted into a trigger chat would run a second CLI
  // against one transcript, and its finally block's
  // cleanupApprovalsForChat(chatId) would deny the trigger's parked
  // question on the way out — an overnight approval destroyed by an unrelated
  // message (panel Fix-Runde 1, I2). Hours-long parks are exactly what the
  // inbox made possible, so this stopped being a theoretical race.
  if (getRunner && getRunner().isChatRunning(chatId)) {
    sendJson(res, 409, { error: 'chat busy: a trigger turn is running in this chat' });
    return;
  }
  if (isRelayChatRunning && isRelayChatRunning(chatId)) {
    sendJson(res, 409, { error: 'chat busy: a relay run is handing off in this chat' });
    return;
  }

  const workspaceDir = path.join(dataDir, 'workspace');
  fs.mkdirSync(workspaceDir, { recursive: true });

  // A mission with a cwd is the ONE deliberate door out of the workspace
  // jail: chosen by a human once at mission creation, re-checked here every
  // turn. If the directory is gone the turn fails — never a silent fallback
  // into the workspace, where the agent would edit the wrong tree.
  let turnCwd = workspaceDir;
  if (mission && mission.cwd) {
    let stat = null;
    try {
      stat = fs.statSync(mission.cwd);
    } catch {
      stat = null;
    }
    if (!stat || !stat.isDirectory()) {
      sendJson(res, 400, { error: `mission cwd does not exist: ${mission.cwd}` });
      return;
    }
    turnCwd = mission.cwd;
  }

  // Read before runTurn() rather than inside it, so the approval handler and
  // the harness are talking about the same turn start.
  const turnStartedAt = Date.now();

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
  controller.signal.addEventListener('abort', () => cleanupApprovalsForChat(pendingApprovals, chatId, approvalStore));

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
  const enqueue = createSseQueue(res);
  // A chat turn's stream can render an approval question too (it is the same
  // ApprovalDialog), so it counts as an approval client for as long as it runs
  // — and can be handed a background trigger's question via
  // deliverApprovalFrame(). See startServer's `approvalStreams`.
  approvalStreams.add(enqueue);
  chatSseQueues.set(chatId, enqueue);
  enqueue({ type: 'chat-id', chatId });

  try {
    const result = await runTurn({
      dataDir,
      chatId,
      text,
      harness,
      harnessName,
      cwd: turnCwd,
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
      absoluteTimeoutMs: chatAbsoluteTimeoutMs,
      onApprovalRequest: makeApprovalHandler({
        chatId,
        enqueue,
        pendingApprovals,
        approvalTimeoutMs,
        approvalStore,
        turnDeadlineAt: turnStartedAt + chatAbsoluteTimeoutMs,
        describeSource,
      }),
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
    approvalStreams.delete(enqueue);
    // Same "only our own entry" rule as the abort controller below.
    if (chatSseQueues.get(chatId) === enqueue) chatSseQueues.delete(chatId);
    // Only remove OUR OWN entry: blindly deleting by chatId would let a
    // slower-finishing turn's finally-block erase a different, still-running
    // turn's controller if the two were ever to overlap for the same key.
    if (chatAbortControllers.get(chatId) === controller) chatAbortControllers.delete(chatId);
    // Turn end, cancel, AND client disconnect all reach here (see this
    // function's own doc comment) — the single place that must never leave
    // a pending approval for this chat dangling (SECURITY: fail-closed).
    cleanupApprovalsForChat(pendingApprovals, chatId, approvalStore);
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
 *
 * `?triggerId=<id>` narrows the list to the chats that ONE trigger started
 * (chat.triggerId, set at creation time by src/orchestrator/run.mjs when the
 * runner passes origin 'trigger'), which is what the trigger page's "runs of
 * this trigger" link needs. It stays ORTHOGONAL to includeSilent: a
 * heartbeat's silent runs are still hidden unless the caller asks for them
 * too, so one query parameter never quietly re-enables what the other one
 * filters out.
 */
function handleChatList(res, getChats, includeSilent, triggerId) {
  if (triggerId !== null && !TRIGGER_ID_RE.test(triggerId)) {
    sendJson(res, 400, { error: 'invalid triggerId' });
    return;
  }
  const list = getChats()
    .list()
    .filter((chat) => includeSilent || !chat.silent)
    .filter((chat) => triggerId === null || chat.triggerId === triggerId)
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
    handleChatList(res, ctx.getChats, url.searchParams.get('includeSilent') === '1', url.searchParams.get('triggerId'));
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
function handleTriggersList(res, getTriggers, getRunner) {
  const runner = getRunner();
  const triggers = getTriggers()
    .list()
    .map((trigger) => {
      // `supported`/`unsupportedReason` (see runner.mjs::supportStatus) is the
      // same idea as `blocked` one field over: a clipboard trigger on a
      // non-Windows machine says so here in plain text, instead of offering a
      // switch that silently does nothing.
      // `unattended: true` — this list answers "will it fire on its own?", so
      // a question/review trigger with no stream open reads as blocked here
      // even though the caller could still fire it by hand (see
      // runner.mjs::approvalCapability's unattended gate).
      const capability = runner.approvalCapability(trigger, { unattended: true });
      const { blockedReason, runsToday, costToday, costEstimated } = runner.limitStatus(trigger);
      return {
        ...trigger,
        runsToday,
        costToday,
        // True when part of costToday is an estimate for a run the harness
        // reported no cost for (see limits.mjs) — so a UI can say "estimated"
        // instead of implying it measured the number.
        costEstimated,
        ...capability,
        // A trigger that is fine as configured but capped right now (its own
        // daily cap, or the global one shared by every trigger) reports that
        // here rather than looking armed and doing nothing. Approval wiring
        // still wins: a trigger that can NEVER fire is the more important of
        // the two answers.
        blocked: capability.blocked ?? blockedReason,
        ...runner.supportStatus(trigger),
      };
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
 * impossible: no fire that arrives OVER THIS ROUTE can start while any
 * trigger-origin turn (however it started) is still running. The guarantee
 * is route-scoped, not system-wide: the scheduler tick in runner.mjs calls
 * fireTrigger() directly and its own loop guard is per-trigger, so several
 * triggers coming due in the same tick still run concurrently (the README's
 * Known-gaps section says the same). A manual user fire briefly blocked by
 * an unrelated already-running heartbeat is an acceptable false positive
 * for the HTTP-chain guarantee.
 */
async function handleTriggerFire(res, getRunner, id, chatSseQueues, approvalStreams) {
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
  // This stream can show an approval question, so it counts towards
  // hasApprovalClient() for the whole time it is open (see startServer's
  // `approvalStreams`).
  approvalStreams.add(enqueue);

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
    approvalStreams.delete(enqueue);
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
async function handleTriggerRoutes(req, res, segments, { getTriggers, getRunner, dataDir, chatSseQueues, approvalStreams }) {
  // /api/triggers
  if (segments.length === 2) {
    if (req.method === 'GET') {
      handleTriggersList(res, getTriggers, getRunner);
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
      await handleTriggerFire(res, getRunner, segments[2], chatSseQueues, approvalStreams);
      return;
    }
  }
  sendJson(res, 404, { error: 'not found' });
}

/**
 * GET /api/apps — the installed apps, read-only, for the Apps page.
 *
 * Deliberately DISPLAY metadata only: id, name, description, icon, version,
 * how many tools the app brings, its `policy` (what it is allowed to do), its
 * source (bundled with kaprek vs. user-installed), and its uiSlot. Never the
 * tool `inputSchema`s, never `instructions`, and above all never a `handler`
 * path — a filesystem path is not display data, and this route offers no way to
 * install, enable, disable or run anything. Everything actually executable
 * still goes exclusively through the MCP server (src/apps/mcp-server.mjs).
 *
 * A broken app.json shows up in `errors` rather than taking the list down, the
 * same posture loadApps() itself takes. `dir` is stripped from those errors:
 * the reason is useful in the UI, the absolute path on this machine is not.
 */
function handleAppsList(res, dataDir, bundledAppsDir) {
  const { apps, errors, blocked } = loadApps({ bundledDir: bundledAppsDir, dataDir });
  sendJson(res, 200, {
    apps: apps.map(({ manifest, source }) => ({
      id: manifest.id,
      name: manifest.name,
      description: manifest.description,
      icon: manifest.icon,
      version: manifest.version,
      toolCount: manifest.tools.length,
      policy: manifest.policy,
      uiSlot: manifest.uiSlot,
      source,
    })),
    // Third-party apps that were found but not loaded (see
    // loader.mjs::userAppsAllowed). Listed so a user whose app is missing sees
    // that it is switched off rather than broken. Directory names only — a
    // blocked app's manifest is untrusted input with no reason to be parsed,
    // and `dir` stays off the wire for the same reason it does above.
    blocked: blocked.map(({ id }) => ({ id })),
    errors: errors.map((error) => ({ message: error.message })),
  });
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
    getMissions,
    tmpRoot,
    getChats,
    harness,
    harnessName,
    chatAbortControllers,
    permissionMode,
    allowedTools,
    pendingApprovals,
    approvalTimeoutMs,
    chatAbsoluteTimeoutMs,
    getApprovalStore,
    getRelay,
    isRelayChatRunning,
    getTriggers,
    getRunner,
    chatSseQueues,
    approvalStreams,
    describeSource,
    instanceToken,
    bundledAppsDir,
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
    if (segments[1] === 'missions') {
      await handleMissionRoutes(req, res, segments, { getMissions, getChats, getBoard, getApprovalStore });
      return;
    }
    if (segments.length === 2 && segments[1] === 'presets') {
      if (req.method !== 'GET') {
        sendJson(res, 405, { error: 'method not allowed' });
        return;
      }
      sendJson(res, 200, { presets: loadPresets(dataDir) });
      return;
    }
    if (segments.length === 4 && segments[1] === 'chat' && segments[3] === 'relay') {
      if (req.method !== 'POST') {
        sendJson(res, 405, { error: 'method not allowed' });
        return;
      }
      await handleRelayStart(req, res, segments[2], { getRelay, getRunner });
      return;
    }
    if (segments.length === 4 && segments[1] === 'relay' && segments[3] === 'stop') {
      if (req.method !== 'POST') {
        sendJson(res, 405, { error: 'method not allowed' });
        return;
      }
      await handleRelayStop(res, segments[2], { getRelay });
      return;
    }
    // Before the chat routes below: /api/chat/<id>/relay is a relay route
    // that happens to live under a chat's path, and handleChatRoutes would
    // otherwise answer 404 for it.
    if (segments[1] === 'chat') {
      await handleChatRoutes(req, res, segments, url, {
        getChats,
        getMissions,
        harness,
        harnessName,
        dataDir,
        chatAbortControllers,
        permissionMode,
        allowedTools,
        pendingApprovals,
        approvalTimeoutMs,
        chatAbsoluteTimeoutMs,
        approvalStore: getApprovalStore(),
        getRunner,
        isRelayChatRunning,
        chatSseQueues,
        approvalStreams,
        describeSource,
      });
      return;
    }
    if (segments[1] === 'triggers') {
      await handleTriggerRoutes(req, res, segments, { getTriggers, getRunner, dataDir, chatSseQueues, approvalStreams });
      return;
    }
    if (segments.length === 3 && segments[1] === 'approvals') {
      if (req.method !== 'POST') {
        sendJson(res, 405, { error: 'method not allowed' });
        return;
      }
      await handleApprovalDecision(req, res, segments[2], pendingApprovals, getApprovalStore(), getRunner, getRelay);
      return;
    }
    if (segments.length === 2 && segments[1] === 'approvals') {
      if (req.method !== 'GET') {
        sendJson(res, 405, { error: 'method not allowed' });
        return;
      }
      await handleApprovalsList(res, getApprovalStore());
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
    if (segments.length === 2 && segments[1] === 'apps') {
      handleAppsList(res, dataDir, bundledAppsDir);
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
  approvalTimeoutMs = APPROVAL_DEADLINE_INTERACTIVE_MS,
  unattendedApprovalTimeoutMs = APPROVAL_INBOX_TTL_MS,
  // The wall clock a CHAT turn runs under, and therefore the ceiling every
  // interactive deadline is capped to (see effectiveApprovalDeadline).
  // Overridable because that cap is only checkable end to end if a test can
  // make the clock the nearer of the two limits; the default is exactly what
  // the harness would have used anyway.
  chatAbsoluteTimeoutMs = CHAT_ABSOLUTE_TIMEOUT_MS,
  // How the relay finds its peer CLIs. Overridable so a test can hand it
  // stubs: a relay test that resolved the real drivers would spawn real,
  // billed CLIs, which is not something a test suite gets to do.
  getPeerDriver = getRegisteredPeerDriver,
  bundledAppsDir = DEFAULT_BUNDLED_APPS_DIR,
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

  // Missions, same lazy pattern as the board: only ever written through this
  // server's own routes, so one cached projection stays truthful.
  let missionStore = null;
  function getMissions() {
    if (!missionStore) missionStore = openMissions(dataDir);
    return missionStore;
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

  // The apps installed right now, re-read per call rather than cached: an app
  // can be added or removed while the server runs, and both answers below are
  // authorization inputs — a stale one would either grant a trigger an app
  // that is gone or refuse one that was just installed. Each call reads a
  // handful of small JSON files (see loadApps()).
  function installedAppIds() {
    const { apps } = loadApps({ bundledDir: bundledAppsDir, dataDir });
    return new Set(apps.map((app) => app.manifest.id));
  }

  /** Which app truly provides a tool id, per the manifests on disk (see loader.mjs::resolveToolOwnership) — the trigger policy's authorization input, never the tool's name. */
  function appIdForTool(toolId) {
    const { apps } = loadApps({ bundledDir: bundledAppsDir, dataDir });
    return resolveToolOwnership(apps).owners.get(toolId) ?? null;
  }

  // Trigger registry, opened lazily like the board above (most invocations
  // never touch it either). `knownAppIds` is what makes an appScope entry
  // checkable: it may only name an app that is actually installed.
  let triggers = null;
  function getTriggers() {
    if (!triggers) triggers = openTriggers(dataDir, { knownAppIds: installedAppIds });
    return triggers;
  }

  // The durable approval inbox (see approval-store.mjs), opened lazily like
  // the board and the registry above — creating it reads, and possibly
  // rewrites, <dataDir>/approvals.json, which most invocations never need.
  // Once opened it is shared by BOTH approval paths: a chat turn's questions
  // and a trigger's. One store, one file, one place GET /api/approvals reads.
  let approvalStore = null;
  function getApprovalStore() {
    if (!approvalStore) approvalStore = createApprovalStore({ dataDir });
    return approvalStore;
  }

  // Same dedicated workspace a chat turn's cwd already is (see
  // handleChatTurn) — a heartbeat trigger's checklistPath is read from here
  // (src/workspace/fs.mjs), and it's the harness's cwd for every trigger-
  // started turn too.
  const workspaceDir = path.join(dataDir, 'workspace');
  fs.mkdirSync(workspaceDir, { recursive: true });

  /**
   * Delivers one approval frame for `chatId`: to the stream watching that
   * exact chat if there is one, otherwise to every open stream (see
   * `approvalStreams` below for why that is both safe and necessary). Resolves
   * even when nothing is listening — the approval still exists server-side and
   * still auto-denies on the timeout.
   */
  function deliverApprovalFrame(chatId, frame) {
    const dedicated = chatSseQueues.get(chatId);
    if (dedicated) return dedicated(frame);
    return Promise.all([...approvalStreams].map((enqueue) => enqueue(frame)));
  }

  /**
   * Where an approval question comes from, for the dialog's own "From trigger:
   * nightly-check" line (see web/src/lib/approvals.ts::approvalSourceLabel).
   * Best-effort: a chat that cannot be read yields null, and the dialog then
   * simply shows no origin rather than the request failing over a label.
   */
  function describeApprovalSource(chatId) {
    try {
      const chat = getChats().get(chatId);
      return {
        kind: chat.origin === 'trigger' ? 'trigger' : 'chat',
        triggerId: chat.triggerId ?? null,
        title: chat.title ?? null,
      };
    } catch {
      return null;
    }
  }

  // The trigger runner, opened lazily and started once listen() resolves
  // (see below), stopped when the server closes. `makeUiApprovalHandler`
  // reuses the SAME makeApprovalHandler() a normal chat turn uses — see the
  // module doc comment further down — so a question/review trigger's approval
  // reaches whichever client is currently streaming (see
  // deliverApprovalFrame). `hasApprovalClient` is the matching gate: with no
  // stream open at all, such a trigger does not fire in the first place
  // instead of raising a question into the void. A 'notify' trigger never
  // calls any of this — its own self-contained policy decider (see
  // runner.mjs::notifyPolicyHandler()) needs nothing from here.
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
        // The notify policy's authorization input: which app REALLY provides a
        // tool, read from the manifests rather than from the tool's name (see
        // runner.mjs::notifyPolicyHandler).
        resolveToolApp: appIdForTool,
        hasApprovalClient: () => approvalStreams.size > 0,
        // The inbox is what lets an unattended question/review trigger fire
        // at all (see runner.mjs::approvalCapability). `hasApprovalClient`
        // above stays wired: it is still the honest answer for a runner
        // asked what it would do WITHOUT one, and the SSE broadcast below is
        // still the fastest path to a browser that happens to be open.
        approvalStore: getApprovalStore(),
        // The deadline the handler below actually enforces, so the runner can
        // size the turn's never-pausing wall clock around THIS number rather
        // than around the default constant. Passing a longer
        // unattendedApprovalTimeoutMs used to move only the auto-deny and
        // leave the wall clock at 8h45m, which would kill the turn before its
        // own approval could ever lapse (panel Fix-Runde 1, M5).
        approvalDeadlineMs: unattendedApprovalTimeoutMs,
        releaseApprovals: (chatId) => cleanupApprovalsForChat(pendingApprovals, chatId, getApprovalStore()),
        makeUiApprovalHandler: (chatId, { turnDeadlineAt = null, mode = 'interactive', triggerId = null } = {}) =>
          makeApprovalHandler({
            chatId,
            mode,
            triggerId,
            // The instant this turn's wall clock kills it, handed down by the
            // runner because only it knows when the turn started. Caps every
            // deadline an INTERACTIVE handler publishes (see
            // effectiveApprovalDeadline); a deferred question outlives the
            // turn by design and is not capped to it.
            turnDeadlineAt,
            enqueue: (frame) => deliverApprovalFrame(chatId, frame),
            pendingApprovals,
            // Two different meanings behind one parameter. Deferred: how long
            // the filed question stays answerable in the inbox, nothing is
            // waiting (APPROVAL_INBOX_TTL_MS). Interactive, which for a
            // trigger means someone pressed "run now" and is watching the
            // dialog: the ordinary ten minutes a person gets.
            approvalTimeoutMs: mode === 'deferred' ? unattendedApprovalTimeoutMs : approvalTimeoutMs,
            approvalStore: getApprovalStore(),
            describeSource: describeApprovalSource,
          }),
      });
    }
    return runner;
  }

  // The relay dispatcher, opened lazily like everything else here. It is
  // wired to the SAME limits the triggers answer to: its turns count against
  // the shared unattended ceiling, and its chats count as busy, because a
  // relay turn spends the same money on the same account and writes into the
  // same transcripts. A second budget for a second kind of unattended turn
  // would be a ceiling with a door in it.
  let relay = null;
  function getRelay() {
    if (!relay) {
      relay = createRelayDispatcher({
        dataDir,
        getChats,
        approvalStore: getApprovalStore(),
        getPeerDriver,
        canStartTurn: () => {
          const runner = getRunner();
          return runner.canStartFollowUp('relay');
        },
        onTurnStart: (chatId) => relayChatIds.add(chatId),
        onTurnEnd: (chatId) => relayChatIds.delete(chatId),
        // The relay's Claude turns run through the ordinary harness, with no
        // tools at all: in v1 Claude is here to READ the other agent's text
        // and say what is wrong with it. Anything that acts on the world goes
        // through the approval path, and an unattended review turn is not the
        // place to open that door.
        runClaudeTurn: async ({ chatId, prompt, signal }) => {
          const result = await runTurn({
            dataDir,
            chatId,
            text: prompt,
            harness,
            harnessName,
            cwd: workspaceDir,
            permissionMode,
            allowedTools: [],
            absoluteTimeoutMs: chatAbsoluteTimeoutMs,
            signal,
            origin: 'relay',
            silent: false,
          });
          if (result.error) throw new Error(result.error.message);
          const text = lastAssistantText(chatId);
          return parseRelayAnswer(text, result);
        },
        log: (message) => console.log(message),
      });
    }
    return relay;
  }

  // Chats a relay turn is writing into right now. Same job as the runner's
  // own set: a chat is one conversation, so a typed turn must not land in the
  // middle of a handoff.
  const relayChatIds = new Set();

  /** The last thing the assistant said in this chat — a relay turn's actual output. */
  function lastAssistantText(chatId) {
    try {
      const events = getChats().events(chatId);
      const last = [...events].reverse().find((event) => event.kind === 'assistant');
      return last?.text ?? '';
    } catch {
      return '';
    }
  }

  // One AbortController per chat with an in-flight turn, keyed by chatId —
  // lets POST /api/chat/<id>/cancel reach across requests to interrupt the
  // SSE request currently streaming that chat's turn.
  const chatAbortControllers = new Map();

  // One entry per in-flight tool-use approval, keyed by
  // approvalKey(chatId, request_id) — server-WIDE (not per-chat), and the
  // key is composite because the CLI numbers requests from 1 per turn, so
  // bare request_ids collide across chats. POST /api/approvals/<id>
  // requires chatId in its body for the same reason; see
  // makeApprovalHandler()/handleApprovalDecision()/
  // cleanupApprovalsForChat() above.
  const pendingApprovals = new Map();

  // One live SSE enqueue() function per chatId currently being streamed by
  // the trigger fire route below (POST /api/triggers/<id>/fire) — lets
  // getRunner()'s makeUiApprovalHandler find "is anyone actually watching
  // this trigger-started chat right now" without the runner needing to know
  // anything about HTTP/SSE itself.
  const chatSseQueues = new Map();

  // EVERY open SSE stream, whatever opened it (a chat turn or a manual trigger
  // fire). Two jobs, both for the unattended-approval problem (see
  // runner.mjs::approvalCapability):
  //
  //  1. `approvalStreams.size > 0` is the runner's hasApprovalClient() — the
  //     gate that keeps a tick-driven question/review trigger from starting a
  //     turn whose approval nobody could ever answer.
  //  2. It is where an approval for a chat NOBODY is streaming gets delivered.
  //     A background trigger creates its own fresh chat, so `chatSseQueues`
  //     never has an entry for it and the question used to go to a no-op. It
  //     is now broadcast to whatever streams are open instead.
  //
  // Broadcasting is safe because an approval frame carries its own `chatId`
  // and the answer must send that same chatId back (see approvalKey() and
  // web/src/lib/approvals.ts::buildApprovalAnswer) — a client can therefore
  // answer a question about a chat it is not itself watching, and cannot
  // accidentally answer for the wrong one. It is deliberately NOT a new
  // protocol: same `{type:'approval', chatId, …}` frame, more recipients.
  const approvalStreams = new Set();

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
      getMissions,
      tmpRoot,
      getChats,
      harness,
      harnessName,
      chatAbortControllers,
      permissionMode,
      allowedTools,
      pendingApprovals,
      approvalTimeoutMs,
      chatAbsoluteTimeoutMs,
      getApprovalStore,
      getRelay,
      isRelayChatRunning: (chatId) => relayChatIds.has(chatId),
      getTriggers,
      getRunner,
      chatSseQueues,
      approvalStreams,
      describeSource: describeApprovalSource,
      instanceToken,
      bundledAppsDir,
    }).catch((err) => {
      // The message stays out of the response body: an internal error can
      // carry filesystem paths or whatever a dependency put in its throw,
      // and this is the one route where ANY unhandled error surfaces. Log
      // locally, answer generically (launch review, low finding).
      console.error('[kaprek] internal error:', err);
      sendJson(res, 500, { error: 'internal error' });
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
      // token.mjs on why it never goes into a log line. `runner` comes back
      // for the same caller: a test needs to reach fireTrigger() the way a
      // background tick does (no HTTP route does that — POST .../fire is
      // always cause.origin 'user'), and waiting on a real 60-second timer is
      // not a test.
      resolve({ server, url: `http://127.0.0.1:${addr.port}`, token: instanceToken, runner: getRunner() });
    });
  });
}
