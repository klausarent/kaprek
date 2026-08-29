// Shared between hook-session-start.mjs and hook-user-prompt.mjs: the last
// working directory a SessionStart/UserPromptSubmit context was built for,
// per session. One file per session id under `<dataDir>/context/`, not one
// shared file — Klaus runs many sessions in parallel, and a shared
// read-modify-write would race between them.
//
// Deliberately tiny (fs + path only): hook-user-prompt.mjs's fast path
// (unchanged cwd) must not pay for anything heavier than this module plus
// one small file read, so the actual context stores (missions, memory,
// chats — see session-start.mjs) are never imported from here.
import fs from 'node:fs';
import path from 'node:path';

/** Context state files untouched for longer than this are swept on the next write — a session that has not prompted in over a week is not "still switching directories". */
export const STATE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

/** Sanitizes a Claude Code session id into a safe filename component — same rule as council-gate.mjs's markerPath. */
function sanitizeSessionId(sessionId) {
  return String(sessionId).replace(/[^a-zA-Z0-9_-]/g, '_');
}

export function contextDir(dataDir) {
  return path.join(dataDir, 'context');
}

export function contextStatePath(dataDir, sessionId) {
  return path.join(contextDir(dataDir), `${sanitizeSessionId(sessionId)}.json`);
}

/** The `{ cwd, ts }` last recorded for this session, or null (missing file, unreadable, malformed, or a shape that lacks a string cwd). Never throws. */
export function readContextState(dataDir, sessionId) {
  try {
    const parsed = JSON.parse(fs.readFileSync(contextStatePath(dataDir, sessionId), 'utf8'));
    return typeof parsed?.cwd === 'string' ? parsed : null;
  } catch {
    return null;
  }
}

/** Records that this session's context was last built for `cwd`. Throws on a genuine write failure — callers wrap this in their own fail-open try/catch, same as every other kaprek hook write. */
export function writeContextState(dataDir, sessionId, cwd, now = Date.now()) {
  const file = contextStatePath(dataDir, sessionId);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ cwd, ts: new Date(now).toISOString() }), 'utf8');
}

/**
 * Deletes context state files older than STATE_MAX_AGE_MS. Best-effort and
 * silent — called only from the slow path of hook-user-prompt.mjs (a
 * directory switch), never on every prompt, so the readdir it does is rare
 * rather than routine.
 */
export function sweepOldContextState(dataDir, now = Date.now()) {
  const dir = contextDir(dataDir);
  let entries;
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return; // no context directory yet, or unreadable — nothing to sweep
  }
  for (const name of entries) {
    if (!name.endsWith('.json')) continue;
    const file = path.join(dir, name);
    try {
      if (now - fs.statSync(file).mtimeMs > STATE_MAX_AGE_MS) fs.unlinkSync(file);
    } catch {
      // a file that vanished mid-sweep or cannot be stat'd is not this sweep's problem
    }
  }
}
