// What kaprek remembers, and what it refuses to.
//
// An append-only JSONL log with an in-memory projection, like the board, the
// plans, and the consultations. Three decisions make this one different from
// a notes file:
//
//   1. EVERY STATEMENT HAS AN OWNER. A fact belongs to a scope, and a reader
//      sees it only if that scope is on its own path upwards (see
//      scopes.mjs). This is the mechanism behind both halves of M3 — "agent B
//      uses what agent A learned" and "a child's scope never sees the
//      company's" are the same rule read in two directions.
//
//   2. EVERY STATEMENT HAS AN AGE. created_at, last_verified_at, confidence,
//      origin — required, not optional. Past MAX_AGE_MS a fact still comes
//      back, marked stale. Silently dropping it would be worse: an agent that
//      forgets on a schedule is one nobody can reason about, and the fact that
//      something was believed six months ago and never rechecked is itself
//      information.
//
//   3. EVIDENCE IS A POINTER, NEVER A COPY. An 'evidence' entry holds a
//      session id and an event index. A memory store that embeds transcript
//      excerpts is a second transcript with worse search — and it copies
//      whatever the redaction pass had already decided to keep out of sight.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { validateScope, visibleScopes } from './scopes.mjs';

/**
 * The three layers, read in this order (the L0–L3 shape TencentDB describes:
 * profile first, facts on demand, raw log never).
 *
 *   profile   who/what this scope IS — short, stable, always loaded
 *   fact      something learned that may be recalled when relevant
 *   evidence  where a fact came from, as a reference
 */
export const MEMORY_KINDS = ['profile', 'fact', 'evidence'];

/** After this long without a verify, a fact comes back marked stale. */
export const MAX_AGE_MS = 90 * 24 * 60 * 60 * 1000;
/** How many distinct sources a confirmed fact lists. Past this the count still climbs; the list does not. */
const MAX_ORIGINS = 20;

/**
 * P0.5 schema gate, JSONL edition: every event this binary writes carries
 * `schemaVersion` (readers written before the field existed are version 1 —
 * backwards-readable). On load, any event with a HIGHER version means a
 * newer kaprek appended here; this binary then opens the store READ-ONLY:
 * reads and projections still work, but appendFileSync would be the one
 * write this binary cannot honestly make onto a log whose newer event
 * shapes it does not know.
 */
const SCHEMA_VERSION = 1;

/** Two texts that say the same thing, for the purpose of confirming rather than duplicating. */
function sameText(a, b) {
  const norm = (t) => String(t).toLowerCase().replace(/\s+/g, ' ').replace(/[.!]+$/, '').trim();
  return norm(a) === norm(b);
}

export class MemoryNotFoundError extends Error {
  constructor(id) {
    super(`no such memory: ${id}`);
    this.name = 'MemoryNotFoundError';
    this.memoryId = id;
  }
}

export class InvalidMemoryError extends Error {
  constructor(field, message) {
    super(message);
    this.name = 'InvalidMemoryError';
    this.field = field;
  }
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
      // One unreadable line must not hide every memory written after it.
    }
  }
  return events;
}

function applyEvent(state, event) {
  const { scopes, facts } = state;
  // Written order, not clock order. Two facts learned in the same
  // millisecond are ordinary, and "newest first" has to mean something even
  // then — a timestamp comparison would leave it to the sort's stability,
  // which is the opposite of the intended order.
  state.seq = (state.seq ?? 0) + 1;
  if (event.type === 'scope.created') {
    if (!scopes.has(event.data.id)) scopes.set(event.data.id, event.data);
    return;
  }
  if (event.type === 'memory.remembered') {
    if (!facts.has(event.memoryId)) facts.set(event.memoryId, { id: event.memoryId, seq: state.seq, forgotten: false, confirmations: 1, origins: [event.data.origin], ...event.data });
    return;
  }
  const existing = facts.get(event.memoryId);
  if (!existing) return;
  if (event.type === 'memory.verified') facts.set(event.memoryId, { ...existing, lastVerifiedAt: event.ts, confidence: event.data.confidence ?? existing.confidence });
  // A second agent (or a later turn) learning the same thing: not a second
  // entry, a confirmation — the count, the sources and the clock move. That
  // is what makes a fact carry its own weight: "3 sessions, last week"
  // rather than one line that could be anyone's guess.
  else if (event.type === 'memory.confirmed') {
    const origins = existing.origins ?? [existing.origin];
    const origin = typeof event.data?.origin === 'string' ? event.data.origin : null;
    facts.set(event.memoryId, {
      ...existing,
      confirmations: (existing.confirmations ?? 1) + 1,
      lastVerifiedAt: event.ts,
      confidence: Math.max(existing.confidence ?? 0, typeof event.data?.confidence === 'number' ? event.data.confidence : 0),
      origins: origin && !origins.includes(origin) ? [...origins, origin].slice(-MAX_ORIGINS) : origins,
    });
  }
  // A forget is an event, not a deleted line: the log stays replayable, and
  // "this was believed and then withdrawn" is worth as much as the belief.
  else if (event.type === 'memory.forgotten') facts.set(event.memoryId, { ...existing, forgotten: true, forgottenReason: event.data.reason ?? null, forgottenAt: event.ts });
}

/**
 * Opens the memory store for `dataDir`.
 *
 * @param {object} [options]
 * @param {() => number} [options.now] - injected so a test can age a fact by
 *   91 days without waiting 91 days
 */
export function openMemory(dataDir, { now = Date.now } = {}) {
  const dir = path.join(dataDir, 'memory');
  const eventsFile = path.join(dir, 'events.jsonl');

  const state = { scopes: new Map(), facts: new Map(), seq: 0 };
  const events = loadEvents(eventsFile);
  for (const event of events) applyEvent(state, event);

  // P0.5: a newer kaprek's events.jsonl is opened read-only. Missing
  // schemaVersion (every line written before the gate) counts as version 1.
  const newestSchemaVersion = events.reduce((max, e) => Math.max(max, typeof e?.schemaVersion === 'number' ? e.schemaVersion : 1), 1);
  const readOnly = newestSchemaVersion > SCHEMA_VERSION;

  function commit(type, memoryId, data) {
    if (readOnly) {
      throw new Error(
        `memory events were written by a newer kaprek version (schema version ${newestSchemaVersion} > ${SCHEMA_VERSION}); ` +
          'this process opens the store READ-ONLY and refuses to append',
      );
    }
    const event = { schemaVersion: SCHEMA_VERSION, id: crypto.randomUUID(), ts: new Date(now()).toISOString(), type, memoryId, data };
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(eventsFile, `${JSON.stringify(event)}\n`, 'utf8');
    applyEvent(state, event);
    return event;
  }

  /** A fact plus the two things a reader has to know about it before using it. */
  function decorate(fact) {
    const age = now() - Date.parse(fact.lastVerifiedAt ?? fact.createdAt);
    return { confirmations: 1, origins: [fact.origin], ...JSON.parse(JSON.stringify(fact)), stale: age > MAX_AGE_MS, ageMs: age };
  }

  return {
    /** Adds a scope to the tree. Idempotent by id — a second call is not an error, it is a restart. */
    addScope(scope) {
      const validated = validateScope(scope, state.scopes);
      if (!state.scopes.has(validated.id)) commit('scope.created', validated.id, validated);
      return state.scopes.get(validated.id);
    },

    scopes() {
      return [...state.scopes.values()].map((scope) => ({ ...scope }));
    },

    /**
     * Writes something down.
     *
     * @param {string} options.scopeId - who this belongs to; must already exist
     * @param {string} options.text
     * @param {'profile'|'fact'|'evidence'} [options.kind]
     * @param {string} options.origin - how it was learned (a chat id, a run, a person)
     * @param {number} [options.confidence] - 0..1
     * @param {{sessionId: string, eventIndex: number}} [options.evidenceRef] - a pointer, never an excerpt
     */
    remember({ scopeId, text, kind = 'fact', origin, confidence = 0.8, evidenceRef = null }) {
      if (!state.scopes.has(scopeId)) throw new InvalidMemoryError('scopeId', `unknown scope: ${scopeId} — a memory with no owner would be visible to nobody`);
      if (typeof text !== 'string' || text.trim() === '') throw new InvalidMemoryError('text', 'a memory needs text');
      if (!MEMORY_KINDS.includes(kind)) throw new InvalidMemoryError('kind', `kind must be one of ${MEMORY_KINDS.join(', ')}`);
      if (typeof origin !== 'string' || origin.trim() === '') throw new InvalidMemoryError('origin', 'a memory needs an origin — a fact nobody can trace is a rumour');
      if (typeof confidence !== 'number' || confidence < 0 || confidence > 1) throw new InvalidMemoryError('confidence', 'confidence must be between 0 and 1');

      // The same thing, already known in this scope and not withdrawn: a
      // confirmation, not a twin. The stale clock resets on its own when
      // work re-learns a fact — which is the honest way to keep it fresh.
      const twin = [...state.facts.values()].find((fact) => fact.scopeId === scopeId && fact.kind === kind && !fact.forgotten && sameText(fact.text, text));
      if (twin) {
        commit('memory.confirmed', twin.id, { origin, confidence });
        return { ...decorate(state.facts.get(twin.id)), confirmed: true };
      }

      const id = crypto.randomUUID();
      const ts = new Date(now()).toISOString();
      commit('memory.remembered', id, { scopeId, text: text.trim(), kind, origin, confidence, evidenceRef, createdAt: ts, lastVerifiedAt: ts });
      return decorate(state.facts.get(id));
    },

    /**
     * What this scope may read, layered.
     *
     * Profiles first and always; facts after, newest first; evidence only
     * when asked for. The order IS the point — a caller that takes the first
     * N entries gets the profile before it gets anything else.
     */
    recall({ scopeId, query = '', limit = 20, includeEvidence = false, includeForgotten = false }) {
      const visible = new Set(visibleScopes(scopeId, state.scopes));
      const needle = query.trim().toLowerCase();

      const matching = [...state.facts.values()]
        .filter((fact) => visible.has(fact.scopeId))
        .filter((fact) => includeForgotten || !fact.forgotten)
        .filter((fact) => includeEvidence || fact.kind !== 'evidence')
        .filter((fact) => needle === '' || fact.text.toLowerCase().includes(needle));

      const rank = { profile: 0, fact: 1, evidence: 2 };
      matching.sort((a, b) => rank[a.kind] - rank[b.kind] || b.seq - a.seq);
      return matching.slice(0, limit).map(decorate);
    },

    /** Says "still true", which resets the clock. The only thing that clears a stale badge. */
    verify(memoryId, { confidence = null } = {}) {
      if (!state.facts.has(memoryId)) throw new MemoryNotFoundError(memoryId);
      commit('memory.verified', memoryId, confidence === null ? {} : { confidence });
      return decorate(state.facts.get(memoryId));
    },

    /** Withdraws a memory with a reason. It stays in the log and out of recall. */
    forget(memoryId, reason = null) {
      if (!state.facts.has(memoryId)) throw new MemoryNotFoundError(memoryId);
      commit('memory.forgotten', memoryId, { reason });
      return decorate(state.facts.get(memoryId));
    },

    get(memoryId) {
      const fact = state.facts.get(memoryId);
      if (!fact) throw new MemoryNotFoundError(memoryId);
      return decorate(fact);
    },

    /** Everything owned by exactly this scope — for a settings page, not for an agent. */
    list({ scopeId = null } = {}) {
      return [...state.facts.values()]
        .filter((fact) => scopeId === null || fact.scopeId === scopeId)
        .sort((a, b) => b.seq - a.seq)
        .map(decorate);
    },
  };
}
