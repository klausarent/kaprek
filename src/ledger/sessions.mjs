// The session ledger: one line per hook event of a terminal session
// (start, stop, end), so kaprek knows which sessions ran where even when
// nobody opened its own chat. Append-only, like every kaprek store.
import fs from 'node:fs';
import path from 'node:path';

export const SESSION_EVENT_TYPES = ['start', 'stop', 'end'];

function ledgerPath(dataDir) {
  return path.join(dataDir, 'ledger', 'sessions.jsonl');
}

export function appendSessionEvent(dataDir, { type, sessionId, cwd = null, transcriptPath = null, reason = null, ts = new Date().toISOString() } = {}) {
  if (!SESSION_EVENT_TYPES.includes(type)) throw new Error(`type must be one of ${SESSION_EVENT_TYPES.join(', ')}`);
  if (typeof sessionId !== 'string' || sessionId === '') throw new Error('sessionId must be a non-empty string');
  const file = ledgerPath(dataDir);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, `${JSON.stringify({ ts, type, sessionId, cwd, transcriptPath, reason })}\n`, 'utf8');
}

export function readSessionEvents(dataDir, { limit = 500 } = {}) {
  const file = ledgerPath(dataDir);
  if (!fs.existsSync(file)) return [];
  const lines = fs.readFileSync(file, 'utf8').split('\n').filter((l) => l.trim() !== '');
  const events = [];
  for (const line of lines.slice(-limit)) {
    try {
      events.push(JSON.parse(line));
    } catch {
      // a torn line from a crash mid-write is not the ledger's problem
    }
  }
  return events;
}

/**
 * Folds the whole ledger into one entry per session id — the shape
 * `kaprek resume` needs to tell a session that really ran in a terminal
 * (however briefly) from a headless/cron run that never touched a hook:
 * `Map<sessionId, { firstStartTs, lastTs, lastType, cwd, transcriptPath, endReason }>`.
 * Reads the whole file (it is one line per hook event of an interactive
 * session, not per turn — small even for a busy machine) and folds it in one
 * pass, in file order, so `lastType`/`lastTs`/`endReason` always reflect the
 * most recent event seen for that id. A torn line from a crash mid-write is
 * skipped, same as readSessionEvents().
 */
export function readLedgerIndex(dataDir) {
  const file = ledgerPath(dataDir);
  const index = new Map();
  if (!fs.existsSync(file)) return index;
  const lines = fs.readFileSync(file, 'utf8').split('\n').filter((l) => l.trim() !== '');
  for (const line of lines) {
    let e;
    try {
      e = JSON.parse(line);
    } catch {
      continue;
    }
    if (typeof e?.sessionId !== 'string' || e.sessionId === '') continue;
    const existing = index.get(e.sessionId);
    index.set(e.sessionId, {
      firstStartTs: existing?.firstStartTs ?? (e.type === 'start' ? (e.ts ?? null) : null),
      lastTs: e.ts ?? existing?.lastTs ?? null,
      lastType: e.type,
      cwd: e.cwd ?? existing?.cwd ?? null,
      transcriptPath: e.transcriptPath ?? existing?.transcriptPath ?? null,
      endReason: e.type === 'end' ? (e.reason ?? null) : (existing?.endReason ?? null),
    });
  }
  return index;
}
