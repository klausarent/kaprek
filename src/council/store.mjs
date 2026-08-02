// Where consultations live: an append-only JSONL log with an in-memory
// projection, the same shape as the board and plan stores.
//
// WHY A STORE AT ALL. A consultation takes minutes — two CLIs read a repo
// and form an opinion. The chat turn that triggers one takes seconds. Both
// Codex and Grok, asked independently how to wire this, said the same thing:
// the turn's SSE stream ends with the turn, and the consultation is a
// separate, longer-lived job in the same process. Which means its result has
// to survive a closed tab, a page reload, and a restart — so it needs a home
// that is not a live stream.
//
// WHAT IT DOES NOT DO. It never re-runs anything. A consultation that was in
// flight when kaprek stopped is marked `interrupted` and left there: nobody
// knows whether those peers answered, and quietly asking them again is how
// somebody's tokens get spent twice for one question. That is the same rule
// relay dispatches follow, for the same reason.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

/** running is the only non-terminal one; everything else is final. */
export const CONSULTATION_STATUSES = ['running', 'completed', 'failed', 'interrupted'];

export class ConsultationNotFoundError extends Error {
  constructor(id) {
    super(`consultation not found: ${id}`);
    this.name = 'ConsultationNotFoundError';
    this.consultationId = id;
  }
}

export function sha256Of(text) {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
}

function loadEvents(file) {
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    return [];
  }
  const events = [];
  for (const line of raw.split('\n')) {
    if (line.trim() === '') continue;
    try {
      events.push(JSON.parse(line));
    } catch {
      // One corrupted line must not hide every consultation behind it.
    }
  }
  return events;
}

function applyEvent(entries, event) {
  const existing = entries.get(event.consultationId);
  if (event.type === 'consultation.queued') {
    // First writer wins: replaying a log that somehow holds the same id twice
    // must not resurrect a finished entry as running.
    if (!existing) entries.set(event.consultationId, { id: event.consultationId, status: 'running', result: null, error: null, ...event.data });
    return;
  }
  if (!existing) return;
  if (event.type === 'consultation.completed') entries.set(event.consultationId, { ...existing, status: 'completed', result: event.data.result, finishedAt: event.ts });
  else if (event.type === 'consultation.failed') entries.set(event.consultationId, { ...existing, status: 'failed', error: event.data.error, finishedAt: event.ts });
  else if (event.type === 'consultation.interrupted') entries.set(event.consultationId, { ...existing, status: 'interrupted', error: event.data.reason, finishedAt: event.ts });
}

/**
 * Whether the document this verdict was about still says what it said.
 *
 * Codex' point, and a sharp one: a plan can be edited while two peers are
 * reading it. An approving verdict displayed next to a plan it never saw is
 * worse than no verdict, because it looks like review.
 */
function isStale(entry) {
  if (!entry.planPath || !entry.planSha256) return false;
  try {
    return sha256Of(fs.readFileSync(entry.planPath, 'utf8')) !== entry.planSha256;
  } catch {
    // Gone or unreadable: whatever was reviewed, this is not it.
    return true;
  }
}

function decorate(entry) {
  return { ...JSON.parse(JSON.stringify(entry)), stale: isStale(entry) };
}

/** Opens the consultation store for `dataDir`, replaying its event log. */
export function openConsultations(dataDir) {
  const dir = path.join(dataDir, 'council');
  const eventsFile = path.join(dir, 'consultations.jsonl');

  const entries = new Map();
  for (const event of loadEvents(eventsFile)) applyEvent(entries, event);

  function commit(type, consultationId, data) {
    const event = { id: crypto.randomUUID(), ts: new Date().toISOString(), type, consultationId, data };
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(eventsFile, `${JSON.stringify(event)}\n`, 'utf8');
    applyEvent(entries, event);
    return event;
  }

  function require(id) {
    const entry = entries.get(id);
    if (!entry) throw new ConsultationNotFoundError(id);
    return entry;
  }

  return {
    /**
     * Records a consultation as started, BEFORE the peers are asked.
     *
     * Written first on purpose: a crash between "decided to ask" and "asked"
     * then leaves a running entry that the next start turns into
     * `interrupted`, rather than leaving no trace of a question that may
     * well have cost real turns.
     */
    queue({ chatId, moment, question, peers = [], planPath = null, planSha256 = null, missionId = null }) {
      const id = crypto.randomUUID();
      commit('consultation.queued', id, {
        chatId,
        moment,
        question,
        peers: [...peers],
        planPath,
        planSha256,
        missionId,
        startedAt: new Date().toISOString(),
      });
      return decorate(entries.get(id));
    },

    complete(id, result) {
      require(id);
      commit('consultation.completed', id, { result });
      return decorate(entries.get(id));
    },

    fail(id, error) {
      require(id);
      commit('consultation.failed', id, { error: typeof error === 'string' ? error : (error?.message ?? String(error)) });
      return decorate(entries.get(id));
    },

    get(id) {
      return decorate(require(id));
    },

    /** Newest first, optionally for one chat. */
    list({ chatId = null, limit = 50 } = {}) {
      return [...entries.values()]
        .filter((entry) => chatId === null || entry.chatId === chatId)
        .sort((a, b) => String(b.startedAt).localeCompare(String(a.startedAt)))
        .slice(0, limit)
        .map(decorate);
    },

    /**
     * The consultation this chat currently has in flight, if any.
     *
     * Single flight per chat is what keeps the `always` level from
     * multiplying CLI processes — both peers raised it independently. The
     * limit is per chat rather than global so one long-running review does
     * not silence a different conversation.
     */
    runningFor(chatId) {
      const running = [...entries.values()].filter((entry) => entry.chatId === chatId && entry.status === 'running');
      return running.length > 0 ? decorate(running[running.length - 1]) : null;
    },

    /**
     * Marks every still-running consultation as interrupted. Called once at
     * startup — see this file's header for why they are never replayed.
     */
    interruptRunning(reason = 'kaprek stopped while this consultation was running') {
      const ids = [...entries.values()].filter((entry) => entry.status === 'running').map((entry) => entry.id);
      for (const id of ids) commit('consultation.interrupted', id, { reason });
      return ids;
    },
  };
}
