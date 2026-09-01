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
// P6b adds the second half's generalisation, under its own guard: a 'shape'
// grant matches a DERIVED pattern (the versioned rule below) instead of one
// hashed input, is bound to the fingerprint {posture, hardDenialsHash,
// missionId, derivationVersion}, and cannot be minted without the mint
// preview (pattern sentence + concrete examples) having been confirmed.
//
// THE SHAPE (P6a exact, P6b shape beside it):
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
import { stricterPosture } from './guards.mjs';

const FILE_NAME = 'grants.jsonl';
const SALT_FILE_NAME = 'grants.salt';

/** P0.5: this binary writes and understands version 1. Higher → read-only. */
const SCHEMA_VERSION = 1;

/** Grant kinds. 'shape' (P6b) matches a DERIVED pattern, not one hashed input — see DERIVATION_RULE below. */
export const GRANT_MATCH_KINDS = ['exact', 'shape'];

// ---------------------------------------------------------------------------
// P6b — THE SHAPE-DERIVATION RULE (versioned spec, H1)
//
// DERIVATION_VERSION = 1. This block IS the specification: what a concrete
// tool input may be generalised into, and nothing else. A change to ANY of
// these paragraphs must bump DERIVATION_VERSION — an old grant's pattern was
// derived under the old rule, and only the version number lets a future
// binary know that matching it against inputs derived under a new rule would
// be comparing two different languages. A bump stales every existing shape
// grant (fingerprint check in server.mjs's makeGrantCheck); exact grants are
// unaffected, they never derived anything.
//
// THE RULE (v1): given a toolName, a raw (pre-redaction, K1) input object and
// the mission cwd, derivePattern() returns a pattern ONLY when the input is
// safely generalisable, and null otherwise — never a guess:
//
//   1. The input must be a plain object with EXACTLY ONE own enumerable key.
//      A form with several arguments has semantics between them (flags,
//      order, which arg is the target) that v1 does not pretend to
//      understand, so it derives nothing.
//   2. COMMAND FORM: that one key is `command`, its value a string of at most
//      512 characters. The pattern is the COMMAND HEAD: the first
//      whitespace-delimited token. The head must be a bare word — no path
//      separators, no quotes, no shell metacharacters (`; & | < > $ \` " '`),
//      no globs — because generalising "runs ./scripts/x" or "runs a`b" is
//      generalising something v1 cannot see. Every command whose head equals
//      this head matches (`npm test`, `npm run build`, `npm install …`).
//   3. PATH FORM: that one key is one of PATH_INPUT_KEYS ('file_path',
//      'path', 'notebook_path'), its value an ABSOLUTE path whose
//      normalised form lies inside the mission cwd (lexical containment —
//      no symlink resolution; see README for that honest limit). The pattern
//      is the containing directory: every file inside that directory (at any
//      depth) matches.
//
//   Anything else — relative paths, paths outside the mission, several keys,
//   non-string values, oversized commands — returns null, and the caller
//   refuses to mint with 409 'not-derivable'. The derivation NARROWS: it may
//   decline everything it cannot be sure about, because the fallback is the
//   question that would have been asked anyway.
//
// Derivation is deterministic: the same (toolName, input, cwd) always yields
// the same pattern, so an incoming call is judged by deriving ITS pattern
// under the same rule and comparing it structurally to the stored one.
// ---------------------------------------------------------------------------
export const DERIVATION_VERSION = 1;

/** Input keys whose string value v1 treats as a file path (rule 3). */
export const PATH_INPUT_KEYS = ['file_path', 'path', 'notebook_path'];

const MAX_COMMAND_LENGTH = 512;

/** Characters that make a command head something v1 refuses to generalise (paths, quoting, shell syntax, globs). */
const UNSAFE_HEAD_CHARS = /[\\/:;"'`$<>|&;\s*?]/;

/**
 * Normalises a path for comparison. Purely lexical; on Windows the comparison
 * is case-insensitive (NTFS is), elsewhere case-sensitive.
 */
function normalizeForCompare(p) {
  const normalized = path.normalize(p);
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

function isInside(child, ancestor) {
  const c = normalizeForCompare(child);
  const a = normalizeForCompare(ancestor);
  const withSep = a.endsWith(path.sep) ? a : a + path.sep;
  return c === a || c.startsWith(withSep);
}

function isStrictlyInside(child, ancestor) {
  const c = normalizeForCompare(child);
  const a = normalizeForCompare(ancestor);
  const withSep = a.endsWith(path.sep) ? a : a + path.sep;
  return c.startsWith(withSep);
}

/**
 * The v1 derivation rule (see the block above). Returns
 * `{ v, toolName, type, keys, head? , prefix? }` or null.
 *
 * @param {{ toolName: string, input: unknown, cwd: string }} args
 */
export function derivePattern({ toolName, input, cwd }) {
  if (typeof toolName !== 'string' || toolName === '') return null;
  if (typeof cwd !== 'string' || cwd === '') return null;
  if (input === null || typeof input !== 'object' || Array.isArray(input)) return null;
  const keys = Object.keys(input).sort();
  if (keys.length !== 1) return null; // rule 1: one key, or nothing
  const value = input[keys[0]];
  if (typeof value !== 'string' || value === '') return null;

  if (keys[0] === 'command') {
    // rule 2: the command head.
    if (value.length > MAX_COMMAND_LENGTH) return null;
    const trimmed = value.trim();
    if (trimmed === '') return null;
    const head = trimmed.split(/\s+/)[0];
    if (head === '' || UNSAFE_HEAD_CHARS.test(head)) return null;
    return { v: DERIVATION_VERSION, toolName, type: 'command-head', keys, head };
  }

  if (PATH_INPUT_KEYS.includes(keys[0])) {
    // rule 3: the containing directory of an absolute path inside the mission cwd.
    if (!path.isAbsolute(value)) return null;
    const normalized = path.normalize(value);
    if (!isInside(normalized, cwd)) return null;
    return { v: DERIVATION_VERSION, toolName, type: 'path-prefix', keys, prefix: path.dirname(normalized) };
  }

  return null; // unknown single key: not derivable, never guessed
}

/** Structural equality of two patterns — same rule version, tool, type, key set and head/prefix. */
export function patternEquals(a, b) {
  if (a === b) return true;
  if (!a || !b || a.type !== b.type || a.v !== b.v || a.toolName !== b.toolName) return false;
  if (JSON.stringify(a.keys ?? []) !== JSON.stringify(b.keys ?? [])) return false;
  if (a.type === 'command-head') return a.head === b.head;
  if (a.type === 'path-prefix') return normalizeForCompare(a.prefix ?? '') === normalizeForCompare(b.prefix ?? '');
  return false;
}

/**
 * Whether one incoming call is covered by a stored pattern: same tool, same
 * key set, and — command form — the same head, or — path form — the incoming
 * prefix INSIDE the stored one (a pattern for `<cwd>/src` covers a call
 * derived for `<cwd>/src/deep`: the same rule derived a narrower
 * generalisation of a call the broader one already allows). The comparison
 * is STRUCTURAL even across rule versions (a v0 command head and a v1
 * command head are the same shape) — but a cross-version match is only ever
 * allowed to STALE the grant, never to act: the fingerprint verdict
 * (shapeFingerprintVerdict below) checks `derivationVersion` and refuses.
 * That is why the version is deliberately NOT part of this comparison: a
 * version mismatch must surface as a stale-hit with its reason, not as
 * silence. The incoming pattern is passed pre-derived (the caller derives at
 * question time, from the raw input — K1); this only compares.
 */
export function patternCovers(grant, { toolName, inputPattern }) {
  if (!grant || grant.match !== 'shape') return false;
  if (grant.toolName !== toolName) return false;
  const stored = grant.pattern ?? null;
  const incoming = inputPattern ?? null;
  if (!stored || !incoming || stored.type !== incoming.type || stored.toolName !== incoming.toolName) return false;
  if (JSON.stringify(stored.keys ?? []) !== JSON.stringify(incoming.keys ?? [])) return false;
  if (stored.type === 'command-head') return stored.head === incoming.head;
  if (stored.type === 'path-prefix') {
    const a = normalizeForCompare(stored.prefix ?? '');
    const c = normalizeForCompare(incoming.prefix ?? '');
    const withSep = a.endsWith(path.sep) ? a : a + path.sep;
    return c === a || c.startsWith(withSep);
  }
  return false;
}

/**
 * The rendered reach of a pattern, for the dialog's mandatory sentence
 * ("would also allow: …") and the grants list.
 */
export function describePattern(pattern, cwd) {
  if (!pattern) return 'an unknown pattern';
  if (pattern.type === 'command-head') {
    return `every ${pattern.toolName} call whose command starts with "${pattern.head}"`;
  }
  if (pattern.type === 'path-prefix') {
    const rel = (() => {
      try {
        const r = path.relative(cwd, pattern.prefix);
        return r === '' ? '<mission cwd>' : `<mission cwd>/${r.split(path.sep).join('/')}`;
      } catch {
        return pattern.prefix;
      }
    })();
    return `every ${pattern.toolName} call touching a file under ${rel}/**`;
  }
  return 'an unknown pattern';
}

/**
 * The mint-preview's mandatory examples (P6b dialog duty): two to three
 * CONCRETE inputs, each labelled with whether the pattern would cover it.
 * The server generates these — the client renders them, it never invents
 * them — and a shape grant cannot be saved until they were shown.
 */
export function shapeExamples(pattern, cwd) {
  if (!pattern) return [];
  if (pattern.type === 'command-head') {
    const key = pattern.keys[0];
    const hitA = { [key]: `${pattern.head} --help` };
    const hitB = { [key]: `${pattern.head} test` };
    const other = pattern.head === 'git' ? 'npm' : 'git';
    const miss = { [key]: `${other} status` };
    return [
      { input: hitA, matches: true },
      { input: hitB, matches: true },
      { input: miss, matches: false },
    ];
  }
  if (pattern.type === 'path-prefix') {
    const key = pattern.keys[0];
    const hitA = { [key]: path.join(pattern.prefix, 'example-one.ts') };
    const hitB = { [key]: path.join(pattern.prefix, 'sub', 'example-two.md') };
    // A miss just outside the pattern's directory — but still a plausible
    // absolute path (inside the cwd when the prefix is not the cwd itself).
    const missPath = isStrictlyInside(path.join(path.dirname(pattern.prefix), 'outside-example.ts'), cwd)
      ? path.join(path.dirname(pattern.prefix), 'outside-example.ts')
      : path.join(path.dirname(cwd), 'outside-example.ts');
    const miss = { [key]: missPath };
    return [
      { input: hitA, matches: true },
      { input: hitB, matches: true },
      { input: miss, matches: false },
    ];
  }
  return [];
}

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
        // P6b, shape only (null on exact): the derived pattern (see
        // DERIVATION_VERSION above) and the rule version it was derived
        // under. The fingerprint's other parts are postureAtGrant,
        // hardDenialsHash and missionId — already on every record.
        pattern: data.pattern ?? null,
        derivationVersion: data.derivationVersion ?? null,
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
 * The FINGERPRINT verdict (P6b) for a SHAPE grant at hit time. The
 * fingerprint is deliberately narrow — {posture, hardDenialsHash, missionId,
 * derivationVersion} — and NOT the whole policy hash: policyVersion also
 * covers mode and rules like requireTaskDoc, so a totally unrelated rule
 * edit would stale every shape grant at once and re-educate people into
 * clicking through the re-asks (see DESIGN-SPEC, Änderung 2).
 *
 * @param {object} grant - the matched shape grant (projected record)
 * @param {{ ceiling: string, denialsHash: string, missionId: string|null, derivationVersion: number }} current
 *   - the values NOW, at the moment the grant would act
 * @returns {{ ok: true } | { ok: false, kind: 'stale', why: string } | { ok: false, kind: 'reactivation', why: string }}
 *   stale/reactivation use the same mechanics as P6a: neither lifts the
 *   question; 'reactivation' asks the one owed re-confirmation question.
 */
export function shapeFingerprintVerdict(grant, { ceiling, denialsHash, missionId = null, derivationVersion = DERIVATION_VERSION }) {
  if (grant.hardDenialsHash !== denialsHash) {
    return { ok: false, kind: 'stale', why: 'the hard-denials list changed since this grant was made' };
  }
  if ((grant.missionId ?? null) !== (missionId ?? null)) {
    return { ok: false, kind: 'stale', why: 'this grant belongs to another mission' };
  }
  if ((grant.derivationVersion ?? null) !== derivationVersion) {
    return {
      ok: false,
      kind: 'stale',
      why: `the pattern-derivation rule changed (version ${grant.derivationVersion ?? 'unknown'} → ${derivationVersion}); this grant's pattern was derived under the old rule`,
    };
  }
  const binding = grant.confirmedPosture ?? grant.postureAtGrant;
  if (binding && ceiling !== binding) {
    const stricter = stricterPosture(ceiling, binding);
    if (stricter === ceiling) {
      return { ok: false, kind: 'stale', why: `the posture ceiling tightened to "${ceiling}" since this grant was made` };
    }
    return { ok: false, kind: 'reactivation', why: 'the posture loosened; this question reactivates the standing grant' };
  }
  return { ok: true };
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
     * scope; this only writes and projects. Minting a twin (same scope, tool,
     * match kind, and — exact — input hash / — shape — pattern) supersedes
     * the older active ones — one question, one grant; the old record stays
     * readable, pointed at its successor via supersededBy.
     *
     * P6b: `match: 'shape'` stores a DERIVED pattern (derivePattern above)
     * plus `derivationVersion` beside the usual fingerprint fields. The
     * inputHash stays on the record even for shape grants: it is the
     * provenance (the concrete call the person was answering), only the
     * MATCHING ignores it.
     *
     * @returns {object} the new grant's projected record
     */
    mint({ scope, toolName, inputHash, match = 'exact', pattern = null, derivationVersion = null, postureAtGrant, hardDenialsHash, missionId = null, createdFromApprovalId = null }) {
      if (typeof scope !== 'string' || !scope.includes(':')) throw new Error(`grant scope must be "<kind>:<id>", got: ${scope}`);
      if (typeof toolName !== 'string' || toolName === '') throw new Error('grant needs a toolName');
      if (typeof inputHash !== 'string' || inputHash.length !== 64) throw new Error('grant needs a valid inputHash');
      if (!GRANT_MATCH_KINDS.includes(match)) throw new Error(`grant match must be one of ${GRANT_MATCH_KINDS.join(', ')}`);
      if (match === 'shape') {
        if (!pattern || typeof pattern !== 'object' || patternEquals(pattern, null)) throw new Error('a shape grant needs a derived pattern');
        if (!Number.isInteger(derivationVersion) || derivationVersion < 1) throw new Error('a shape grant needs its derivationVersion');
      }
      const id = crypto.randomUUID();
      append('grant.minted', {
        id,
        scope,
        toolName,
        inputHash,
        match,
        pattern,
        derivationVersion,
        postureAtGrant,
        hardDenialsHash,
        missionId,
        createdAt: new Date(now()).toISOString(),
        createdFromApprovalId,
      });
      for (const twin of grants.values()) {
        if (twin.id === id || !isActive(twin) || twin.scope !== scope || twin.toolName !== toolName || twin.match !== match) continue;
        const sameTwin = match === 'exact' ? twin.inputHash === inputHash : patternEquals(twin.pattern ?? null, pattern);
        if (sameTwin) append('grant.superseded', { id: twin.id, by: id });
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

    /**
     * Active SHAPE matches (P6b) for one incoming call: same scope and tool,
     * and a stored pattern that covers the freshly derived input pattern.
     * OLDEST FIRST, and the caller takes the first — when several shape
     * grants cover the same form, the oldest one wins. Rationale: the oldest
     * is the one the person has been living with longest (its useCount tells
     * the story); newest-first would make a freshly minted twin silently
     * take over the counting of an established grant, and a visible audit
     * trail beats a tidy-looking list. A shape twin minted over an older
     * grant supersedes it anyway, so true multiplicity is rare — this rule
     * is the deterministic tiebreak for the rest.
     */
    matchShape({ toolName, inputPattern, scope }) {
      if (!inputPattern || typeof inputPattern !== 'object') return [];
      return [...grants.values()]
        .filter((grant) => isActive(grant) && patternCovers(grant, { toolName, inputPattern }) && grant.scope === scope)
        .sort((a, b) => (a.createdAt > b.createdAt ? 1 : -1))
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
