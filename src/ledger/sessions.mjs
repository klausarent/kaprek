// The session ledger: one line per hook event of a terminal session
// (start, stop), so kaprek knows which sessions ran where even when nobody
// opened its own chat. Append-only, like every kaprek store.
import fs from 'node:fs';
import path from 'node:path';

export const SESSION_EVENT_TYPES = ['start', 'stop'];

function ledgerPath(dataDir) {
  return path.join(dataDir, 'ledger', 'sessions.jsonl');
}

export function appendSessionEvent(dataDir, { type, sessionId, cwd = null, transcriptPath = null, ts = new Date().toISOString() } = {}) {
  if (!SESSION_EVENT_TYPES.includes(type)) throw new Error(`type must be one of ${SESSION_EVENT_TYPES.join(', ')}`);
  if (typeof sessionId !== 'string' || sessionId === '') throw new Error('sessionId must be a non-empty string');
  const file = ledgerPath(dataDir);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, `${JSON.stringify({ ts, type, sessionId, cwd, transcriptPath })}\n`, 'utf8');
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
