// grants.mjs — standing grants: what a person allowed ONCE, for exactly this
// tool form, and how often kaprek has since made use of that permission.
//
// WHY IT EXISTS (ERW #1, P6a): some questions are the same question. A nightly
// form of `Bash(npm test …)` asked on Monday and answered on Monday does not
// get more dangerous by Tuesday — but without a memory it asks again every
// time, and a person who answers the same dialog twenty times starts answering
// it while reading neither question nor input. A grant is the honest middle:
// the person says "always for this form", and kaprek keeps BOTH halves of that
// sentence — always (it stops asking) and FOR THIS FORM (the grant carries a
// hash of the exact input, and anything else still asks).
//
// THE SHAPE (P6a, exact only):
//
//   A grant is an append-only JSONL log at <dataDir>/grants.jsonl with an
//   in-memory projection, built like src/memory/store.mjs. Every event —
//   minted, used, revoked, reconfirmed, superseded — is a line; nothing is
//   ever deleted or rewritten. Revocation is an EVENT on the record, not a
//   deletion: "this was allowed, and then withdrawn on <date>" is worth as
//   much as the allowance. There is deliberately NO expiresAt: a grant dies
//   when the person revokes it or when the authorities it was minted under
//   (posture ceiling, hard denials — checked at match time by the caller,
//   see server.mjs's makeGrantCheck) no longer match, never on a timer.
//   Visibility replaces lifetime: useCount and lastUsedAt are on the record,
//   and every use is its own event line, so the audit trail lives HERE and
//   does not depend on the approval log, which prunes after 7 days / 500
//   entries (H2).
//
// THE SCHEMA GATE (P0.5): every event carries schemaVersion. A HIGHER version
// than this binary writes means a newer kaprek appended here; the store opens
// READ-ONLY — reads and projections work, every append throws. The log is
// never pruned, rewritten or deleted by an older binary.
//
// CORRUPTION: one unparseable line (in practice a torn final line from a
// crash mid-append) moves the WHOLE file aside, grants.corrupt-<ts>.jsonl
// (M4, the same posture as approval-store's setCorruptFileAside), and the
// store starts empty — loudly. A grant log that silently dropped its tail
// would resurrect questions their person believes already answered.
//
// THE SALT (K1): matching is sha256(salt ‖ canonical(rawInput)) — see
// inputHashOf() below. The salt is drawn once per installation and kept in
// its own file, <dataDir>/grants.salt, NOT inside grants.jsonl and NOT inside
// approvals.json (where the per-question hashes land): the grant log and the
// approval log alone do not permit an offline dictionary walk over "plausible
// command lines". It must persist across restarts, because a per-process salt
// would orphan every grant at every restart — the opposite of "standing".
// Anyone who can read grants.salt can already read everything else in the
// data dir; the salt's job is keeping the hashes from being attackable in
// isolation.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { canonicalInput, MAX_STORED_INPUT_BYTES } from '../server/approval-store.mjs';

const FILE_NAME = 'grants.jsonl';
const SALT_FILE_NAME = 'grants.salt';

/** P0.5: this binary writes and understands version 1. Higher → read-only. */
const SCHEMA_VERSION = 1;

/** Grant kinds. 6a ships exactly one; the field is on the record because P6b adds 'shape' beside it, not instead of it. */
export const GRANT_MATCH_KINDS = ['exact'];

/** How a grant names its reach. 6a mints ONLY mission scopes; 'global' exists as a word so the reader can see what is NOT there yet. */
export const GRANT_SCOPES = ['mission'];

/**
 * sha256(salt ‖ canonical(rawInput)) — the exact-form identity of a tool
 * call. Returns null when the input cannot honestly be hashed: unserialisable
 * input, or input whose canonical JSON exceeds MAX_STORED_INPUT_BYTES (the
 * same cap that truncates the stored approval record — an over-cap input
 * never even gets a hash, so it can neither mint a grant nor match one; both
 * sides fail identically instead of a truncated form quietly matching a full
 * one). canonicalInput() is the SAME canonicalisation the approval store
 * uses, so "same input" means the same thing in both places.
 */
export function inputHashOf(salt, rawInput) {
  if (typeof salt !== 'string' || salt.length === 0) return null;
  const canonical = canonicalInput(rawInput ?? null);
  if (canonical === null) return null;
  if (Buffer.byteLength(canonical, 'utf8') > MAX_STORED_INPUT_BYTES) return null;
  return crypto.createHash('sha256').update(`${salt}\u0000${canonical}`, 'utf8').digest('hex');
}

/** Reads or creates the installation salt. Never throws on create; a read failure degrades to a fresh salt (grants then simply stop matching until the old salt is restored — loud in the log, safe in effect). */
function loadSalt(dataDir, { fsImpl = fs, log = (m) => console.warn(m) } = {}) {
  const saltPath = path.join(dataDir, SALT_FILE_NAME);
  try {
    const existing = fsImpl.readFileSync(saltPath, 'utf8').trim();
    if (existing.length >= 32) return existing;
  } catch (err) {
    if (err.code !== 'ENOENT') {
      log(`grants: could not read ${saltPath} (${err.message}); drawing a fresh salt — existing grants will not match until it is restored`);
    }
  }
  const salt = crypto.randomBytes(32).toString('hex');
  try {
    fsImpl.mkdirSync(dataDir, { recursive: true });
    fsImpl.writeFileSync(saltPath, `${salt}\n`, 'utf8');
  } catch (err) {
    log(`grants: could not persist ${saltPath} (${err.message}); using an in-memory salt for this process`);
  }
  return salt;
}

function applyEvent(state, event) {
  const { grants } = state;
  const data = event.data ?? {};
  if (event.type === 'grant.minted') {
    if (!grants.has(data.id)) {
      grants.set(data.id, {
        id: data.id,
        schemaVersion: event.schemaVersion ?? SCHEMA_VERSION,
        scope: data.scope,
        toolName: data.toolName,
        inputHash: data.inputHash,
        match: data.match ?? 'exact',
        postureAtGrant: data.postureAtGrant,
        // The posture the grant was LAST confirmed under; starts as the mint
        // posture. Loosening the ceiling past this is what triggers the
        // reactivation question (see makeGrantCheck in server.mjs).
        confirmedPosture: data.postureAtGrant,
        hardDenialsHash: data.hardDenialsHash,
        missionId: data.missionId ?? null,
        createdAt: data.createdAt ?? event.ts,
        createdFromApprovalId: data.createdFromApprovalId ?? null,
        useCount: 0,
        lastUsedAt: null,
        revokedAt: null,
        revokedReason: null,
        supersededBy: null,
        reconfirmPending: false,
        reconfirmedAt: null,
      });
    }
    return;
  }
  const grant = grants.get(data.id);
  if (!grant) return;
  if (event.type === 'grant.used') {
    grants.set(data.id, { ...grant, useCount: (grant.useCount ?? 0) + 1, lastUsedAt: event.ts });
  } else if (event.type === 'grant.revoked') {
    grants.set(data.id, { ...grant, revokedAt: event.ts, revokedReason: data.reason ?? null, reconfirmPending: false });
  } else if (event.type === 'grant.reconfirmed') {
    grants.set(data.id, { ...grant, reconfirmPending: false, reconfirmedAt: event.ts, confirmedPosture: data.posture ?? grant.confirmedPosture });
  } else if (event.type === 'grant.reactivation') {
    grants.set(data.id, { ...grant, reconfirmPending: true });
  } else if (event.type === 'grant.superseded') {
    grants.set(data.id, { ...grant, supersededBy: data.by ?? null, reconfirmPending: false });
  }
}

/**
 * Opens the grant store for one data dir.
 *
 * @param {object} [options]
 * @param {string} options.dataDir
 * @param {() => number} [options.now] - injectable clock (tests never sleep)
 * @param {(message: string) => void} [options.log]
 * @param {typeof import('node:fs')} [options.fsImpl]
 * @param {string} [options.salt] - injectable salt (tests); default: the
 *   installation salt file
 */
export function createGrantStore({ dataDir, now = Date.now, log = (message) => console.warn(message), fsImpl = fs, salt = null } = {}) {
  const filePath = path.join(dataDir, FILE_NAME);

  /** id -> projected grant record, newest event wins. */
  const grants = new Map();

  /**
   * Set when the log carries an event with a schemaVersion NEWER than this
   * binary (P0.5). Reads work; every append throws.
   */
  let readOnly = false;
  let readOnlyVersion = null;

  /**
   * Moves an unparseable log aside so the next append cannot silently build
   * on a file whose tail may say something else. Same three-level fallback
   * as approval-store's setCorruptFileAside; never throws.
   */
  function setCorruptFileAside(raw, parseError) {
    const asidePath = path.join(dataDir, `grants.corrupt-${now()}.jsonl`);
    try {
      fsImpl.renameSync(filePath, asidePath);
      log(`grants: ${filePath} has an unreadable line (${parseError.message}); moved to ${asidePath} and starting from an empty grant list`);
      return;
    } catch (renameErr) {
      try {
        fsImpl.writeFileSync(asidePath, raw, 'utf8');
        log(`grants: ${filePath} has an unreadable line and could not be moved (${renameErr.message}); copied to ${asidePath} instead`);
        return;
      } catch (copyErr) {
        log(`grants: ${filePath} has an unreadable line, and it could be neither moved (${renameErr.message}) nor copied aside (${copyErr.message}) — its contents will be LOST on the next append`);
      }
    }
  }

  function loadFromDisk() {
    let raw;
    try {
      raw = fsImpl.readFileSync(filePath, 'utf8');
    } catch (err) {
      if (err.code !== 'ENOENT') {
        // ENOENT is the ordinary first start. Anything else: empty store, loud line — a record that cannot be read must not stop kaprek starting.
        log(`grants: failed to read ${filePath} (${err.message}); starting from an empty grant list`);
      }
      return;
    }
    if (raw.trim() === '') return; // an empty (or whitespace-only) file is not corruption, it is nothing

    const lines = raw.split('\n');
    const parsedEvents = [];
    for (const line of lines) {
      if (line.trim() === '') continue;
      try {
        parsedEvents.push(JSON.parse(line));
      } catch (err) {
        // One torn line poisons the projection's trust in the whole file —
        // a crash mid-append can only damage the LAST line, but this binary
        // cannot prove which line a different writer damaged. Move the file
        // aside and start empty rather than project a grant list whose tail
        // is guesswork.
        setCorruptFileAside(raw, err);
        grants.clear();
        readOnly = false;
        readOnlyVersion = null;
        return;
      }
    }
    for (const event of parsedEvents) {
      const version = typeof event?.schemaVersion === 'number' ? event.schemaVersion : SCHEMA_VERSION;
      if (version > SCHEMA_VERSION) {
        // The gate applies to the whole store: one newer event means shapes
        // this binary does not know may follow it, so the projection still
        // replays (best effort, like the memory store's) but nothing is
        // appended any more.
        readOnly = true;
        readOnlyVersion = Math.max(readOnlyVersion ?? 0, version);
      }
      applyEvent({ grants }, event);
    }
    if (readOnly) {
      log(`grants: ${filePath} was written by a newer kaprek version (schema version ${readOnlyVersion} > ${SCHEMA_VERSION}); opening READ-ONLY — grants are listed but nothing can be minted, used or revoked`);
    }
  }

  loadFromDisk();

  function append(type, data) {
    if (readOnly) {
      throw new Error(
        `grants.jsonl was written by a newer kaprek version (schema version ${readOnlyVersion} > ${SCHEMA_VERSION}); ` +
          'this process opens the store READ-ONLY and refuses to append',
      );
    }
    const event = { schemaVersion: SCHEMA_VERSION, id: crypto.randomUUID(), ts: new Date(now()).toISOString(), type, data };
    fsImpl.mkdirSync(dataDir, { recursive: true });
    fsImpl.appendFileSync(filePath, `${JSON.stringify(event)}\n`, 'utf8');
    applyEvent({ grants }, event);
    return event;
  }

  const project = (id) => {
    const grant = grants.get(id);
    return grant ? { ...grant } : null;
  };

  const isActive = (grant) => grant && !grant.revokedAt && !grant.supersededBy;

  return {
    /** The salt this installation hashes inputs with. Not secret from anyone who can read the data dir; secret from everyone else. */
    get salt() {
      return salt ?? loadSalt(dataDir, { fsImpl, log });
    },

    /**
     * Mints a grant from a just-answered question. The CALLER (server.mjs's
     * grant-mint route) has already verified the approval, its nonce and the
     * scope; this only writes and projects. Minting an exact twin (same
     * scope, tool, input hash) supersedes the older active ones — one
     * question, one grant; the old record stays readable, pointed at its
     * successor via supersededBy.
     *
     * @returns {object} the new grant's projected record
     */
    mint({ scope, toolName, inputHash, postureAtGrant, hardDenialsHash, missionId = null, createdFromApprovalId = null }) {
      if (typeof scope !== 'string' || !scope.includes(':')) throw new Error(`grant scope must be "<kind>:<id>", got: ${scope}`);
      if (typeof toolName !== 'string' || toolName === '') throw new Error('grant needs a toolName');
      if (typeof inputHash !== 'string' || inputHash.length !== 64) throw new Error('grant needs a valid inputHash');
      const id = crypto.randomUUID();
      append('grant.minted', {
        id,
        scope,
        toolName,
        inputHash,
        match: 'exact',
        postureAtGrant,
        hardDenialsHash,
        missionId,
        createdAt: new Date(now()).toISOString(),
        createdFromApprovalId,
      });
      for (const twin of grants.values()) {
        if (twin.id !== id && isActive(twin) && twin.scope === scope && twin.toolName === toolName && twin.inputHash === inputHash) {
          append('grant.superseded', { id: twin.id, by: id });
        }
      }
      return project(id);
    },

    /** Records one redeemed grant (the exact form came in again and kaprek allowed it without asking). The event line IS the audit trail. */
    use(id) {
      const grant = grants.get(id);
      if (!grant) throw new Error(`unknown grant: ${id}`);
      if (grant.revokedAt) throw new Error(`grant ${id} was revoked; refusing to record a use`);
      if (grant.supersededBy) throw new Error(`grant ${id} was superseded by ${grant.supersededBy}; refusing to record a use`);
      append('grant.used', { id, at: new Date(now()).toISOString() });
      return project(id);
    },

    /**
     * Revocation is an event, never a deletion: the record stays in the file
     * and in list(), marked. Returns {ok, grant} or {ok:false, error} for
     * unknown ids; revoking an already-revoked grant is idempotent.
     */
    revoke(id, reason = null) {
      if (!grants.has(id)) return { ok: false, error: 'unknown' };
      const grant = grants.get(id);
      if (grant.revokedAt) return { ok: true, already: true, grant: project(id) };
      append('grant.revoked', { id, reason });
      return { ok: true, grant: project(id) };
    },

    /**
     * The reactivation half (K2): after the ceiling was LOOSER than the one
     * the grant was confirmed under, its first hit must ask once again. This
     * marks the question as owed — persisted, so a restart does not quietly
     * convert "asks once after a loosening" into "never asks".
     */
    markReactivation(id) {
      const grant = grants.get(id);
      if (!grant) throw new Error(`unknown grant: ${id}`);
      if (isActive(grant) && !grant.reconfirmPending) append('grant.reactivation', { id });
      return project(id);
    },

    /** The reactivation question was answered: confirmed (posture recorded as the new binding) or discarded (= revoke). */
    reconfirm(id, { posture = null } = {}) {
      if (!grants.has(id)) throw new Error(`unknown grant: ${id}`);
      append('grant.reconfirmed', { id, posture });
      return project(id);
    },

    /** Active exact match for one incoming call: same tool, same form, same scope, not revoked, not superseded. Newest first. */
    match({ toolName, inputHash, scope }) {
      if (typeof inputHash !== 'string') return [];
      return [...grants.values()]
        .filter(
          (grant) =>
            isActive(grant) &&
            grant.match === 'exact' &&
            grant.toolName === toolName &&
            grant.inputHash === inputHash &&
            grant.scope === scope,
        )
        .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
        .map((grant) => ({ ...grant }));
    },

    get(id) {
      return project(id);
    },

    /** Every grant, revoked and superseded included — a list that hid what was withdrawn would lie about the past. Newest first. */
    list() {
      return [...grants.values()].sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1)).map((grant) => ({ ...grant }));
    },

    active() {
      return this.list().filter(isActive);
    },

    /** For the setup view's one line. */
    countActive() {
      return [...grants.values()].filter(isActive).length;
    },

    /** Test/doctor seam: whether the store refuses appends (P0.5 gate). */
    isReadOnly() {
      return { readOnly, version: readOnlyVersion };
    },
  };
}
