// Bulk import: Klaus' existing knowledge (Claude-memory files, Mission
// Control, interview facts, chronicle) into kaprek's own memory and mission
// stores — so a freshly installed kaprek starts knowing what Fable already
// knows, instead of empty.
//
// Two extraction stages produce the input this module consumes (see
// C:\Users\karent\Documents\Software\tools\ccview-docs\plans\2026-08-28-kaprek-befuellen.md):
// an LLM stage turns prose sources into flat JSONL manifest lines, and this
// module — deterministic, no LLM, no network — turns those lines into scopes,
// facts and missions via the ordinary store APIs (store.mjs, missions/store.mjs).
// Using the ordinary APIs rather than writing events directly means a
// re-import gets the same idempotence and validation as any other write:
// a repeated fact becomes `memory.confirmed`, a repeated mission (matched by
// its `[mc:<id>]` goal prefix) becomes an update, never a duplicate.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openMemory, MEMORY_KINDS } from './store.mjs';
import { openMissions, MISSION_STATUSES } from '../missions/store.mjs';
import { redactSecrets } from '../parser/parse.mjs';

const DEFAULT_ROOT_SCOPE = 'person:local';

// Additional patterns beyond redactSecrets(): these do not get their matched
// SUBSTRING blanked out, they cause the WHOLE line to be discarded. A fact
// that only survives with "[REDACTED]" where the interesting part used to be
// is worse than no fact at all, and a manifest line built entirely around a
// credential (rather than merely mentioning one in passing) is exactly that
// case. Checked against the RAW text, before redactSecrets() runs — several
// of these formats (Bearer, sk-, ghp_, AKIA, xox[baprs]-) are also handled by
// redactSecrets(), and running this check afterward would find nothing but
// the literal string "[REDACTED]".
const SECRET_LINE_PATTERNS = [
  /Bearer\s+\S{8,}/i,
  /\bsk-[A-Za-z0-9_-]{10,}/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\bghp_[A-Za-z0-9]{20,}/,
  /\bxox[baprs]-[A-Za-z0-9-]{10,}/,
  /\b[A-Z]{2}\d{2}[A-Z0-9]{10,30}\b/, // IBAN shape: country + check digits + BBAN
  /-----BEGIN [A-Z ]*(?:PRIVATE KEY|CERTIFICATE)-----/,
  // A credential named as such, whatever its shape: "token: abc…", "Passwort=…".
  /\b(?:token|secret|passw(?:or[dt]|d)|api[_ -]?key|client[_ -]?secret)\s*[:=]\s*(?!\[)\S{8,}/i,
  // A raw hex token of SHA-256 length or longer. 32- and 40-char hex are
  // deliberately NOT matched: memory notes are full of commit hashes and
  // Convex/UUID-style ids, and losing a fact over a git hash is the wrong trade.
  /(?<![A-Za-z0-9])[A-Fa-f0-9]{64,}(?![A-Za-z0-9])/,
  // A raw base64/JWT-looking token: long, mixed case, digits, and at least
  // one base64 symbol or a dot-separated JWT shape. Plain lowercase ids
  // (Convex, ULID-like) and words never have all of these.
  /(?<![A-Za-z0-9+/=_-])(?=[^\s]*[a-z])(?=[^\s]*[A-Z])(?=[^\s]*\d)(?=[^\s]*[+/=]|[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.)[A-Za-z0-9+/=_.-]{40,}(?![A-Za-z0-9+/=_-])/,
];

/** Whether `text` looks enough like a bare credential that the whole line should be dropped rather than redacted in place. */
export function looksLikeSecret(text) {
  if (typeof text !== 'string' || text.trim() === '') return false;
  return SECRET_LINE_PATTERNS.some((pattern) => pattern.test(text));
}

/**
 * Parses one JSONL blob. A line that is not valid JSON is counted, not
 * thrown: one broken line in a 600-line manifest a worker produced must not
 * lose the other 599.
 */
export function parseJsonl(text) {
  const rows = [];
  let invalid = 0;
  for (const line of String(text ?? '').split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '') continue;
    try {
      rows.push(JSON.parse(trimmed));
    } catch {
      invalid += 1;
    }
  }
  return { rows, invalid };
}

function pad2(n) {
  return String(n).padStart(2, '0');
}

/** `YYYYMMDD-HHMMSS`, UTC — only used as a backup-file suffix, so a fixed offset beats a locally ambiguous one. */
function backupStamp(ms) {
  const d = new Date(ms);
  return `${d.getUTCFullYear()}${pad2(d.getUTCMonth() + 1)}${pad2(d.getUTCDate())}-${pad2(d.getUTCHours())}${pad2(d.getUTCMinutes())}${pad2(d.getUTCSeconds())}`;
}

/** Copies whichever of the two event logs already exist to `<file>.bak-<stamp>`. Returns the paths actually written. */
function backupEventFiles(dataDir, nowMs) {
  const stamp = backupStamp(nowMs);
  const targets = [path.join(dataDir, 'memory', 'events.jsonl'), path.join(dataDir, 'missions', 'events.jsonl')];
  const written = [];
  for (const file of targets) {
    if (!fs.existsSync(file)) continue;
    const dest = `${file}.bak-${stamp}`;
    fs.copyFileSync(file, dest);
    written.push(dest);
  }
  return written;
}

/**
 * Orders `scopeMap.scopes` parent-before-child so every `addScope` call sees
 * its parent already in the tree. A parent that is not itself a key in the
 * map (the common case — most scopes hang directly off the root) counts as
 * "already there" immediately; a genuine cycle inside the map falls out the
 * bottom unresolved and is left for `addScope`'s own cycle check to reject.
 */
function topoScopeEntries(scopeMap) {
  const scopes = scopeMap && typeof scopeMap === 'object' ? (scopeMap.scopes ?? {}) : {};
  const ids = Object.keys(scopes);
  const resolvedIds = new Set();
  const ordered = [];
  let pending = ids.slice();

  let progressed = true;
  while (pending.length > 0 && progressed) {
    progressed = false;
    const stillPending = [];
    for (const id of pending) {
      const parent = scopes[id]?.parent ?? null;
      const ready = parent === null || resolvedIds.has(parent) || !ids.includes(parent);
      if (ready) {
        ordered.push({ id, parent });
        resolvedIds.add(id);
        progressed = true;
      } else {
        stillPending.push(id);
      }
    }
    pending = stillPending;
  }
  // Whatever is left forms a cycle within the map itself — pass it through
  // as-is so addScope's own cycle detection is what rejects it.
  for (const id of pending) ordered.push({ id, parent: scopes[id]?.parent ?? null });

  return ordered;
}

/** Copies `<dataDir>/memory` and `<dataDir>/missions` (whichever exist) into a fresh temp directory, for a dry run to operate on. */
function copyDataDirToTemp(dataDir) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kaprek-import-dry-'));
  for (const sub of ['memory', 'missions']) {
    const src = path.join(dataDir, sub);
    if (fs.existsSync(src)) fs.cpSync(src, path.join(tmp, sub), { recursive: true });
  }
  return tmp;
}

/** The real work, run either against the real dataDir or a throwaway copy of it (see importManifest's dryRun branch). */
function runImport({ dataDir, scopeMap, facts, missions, now, allowBackup }) {
  const memory = openMemory(dataDir, { now });
  const missionsStore = openMissions(dataDir);

  const result = {
    scopesCreated: 0,
    factsNew: 0,
    factsConfirmed: 0,
    missionsNew: 0,
    missionsUpdated: 0,
    redacted: 0,
    skipped: 0,
    backup: [],
  };

  const rootId = typeof scopeMap?.root === 'string' && scopeMap.root.trim() !== '' ? scopeMap.root : DEFAULT_ROOT_SCOPE;
  const knownScopeIds = new Set(memory.scopes().map((scope) => scope.id));

  let backedUp = false;
  function backupOnce() {
    if (!allowBackup || backedUp) return;
    backedUp = true;
    result.backup = backupEventFiles(dataDir, now());
  }

  /** Adds a scope if it is not already there. Idempotent by design (addScope itself is), so a second import run creates nothing new here. */
  function ensureScope(id, parent) {
    if (knownScopeIds.has(id)) return true;
    backupOnce();
    try {
      memory.addScope({ id, parent });
      knownScopeIds.add(id);
      result.scopesCreated += 1;
      return true;
    } catch {
      // Malformed id, or a parent that does not resolve: nothing sane to
      // create. Whatever row depended on this scope gets skipped instead.
      return false;
    }
  }

  ensureScope(rootId, null);
  for (const entry of topoScopeEntries(scopeMap)) {
    ensureScope(entry.id, entry.parent ?? rootId);
  }

  /** Remembers one fact, honouring the secret checks and the two counters. Returns nothing — mutates `result` directly, like the loops around it. */
  function rememberFact({ scopeId, kind, text, origin, confidence }) {
    if (typeof text !== 'string' || text.trim() === '') {
      result.skipped += 1;
      return;
    }
    if (!MEMORY_KINDS.includes(kind)) {
      result.skipped += 1;
      return;
    }
    if (looksLikeSecret(text)) {
      result.redacted += 1;
      return;
    }
    if (typeof scopeId !== 'string' || scopeId.trim() === '') {
      result.skipped += 1;
      return;
    }
    if (!ensureScope(scopeId, rootId)) {
      result.skipped += 1;
      return;
    }
    const cleanText = redactSecrets(text).trim();
    if (cleanText === '') {
      result.skipped += 1;
      return;
    }
    const cleanOrigin = typeof origin === 'string' && origin.trim() !== '' ? origin : 'import:unknown';
    const cleanConfidence = typeof confidence === 'number' && confidence >= 0 && confidence <= 1 ? confidence : 0.8;
    backupOnce();
    let outcome;
    try {
      outcome = memory.remember({ scopeId, kind, text: cleanText, origin: cleanOrigin, confidence: cleanConfidence });
    } catch {
      result.skipped += 1;
      return;
    }
    if (outcome.confirmed) result.factsConfirmed += 1;
    else result.factsNew += 1;
  }

  for (const row of facts) {
    if (!row || typeof row !== 'object') {
      result.skipped += 1;
      continue;
    }
    rememberFact({
      scopeId: row.scopeId,
      kind: row.kind ?? 'fact',
      text: row.text,
      origin: row.origin,
      confidence: row.confidence,
    });
  }

  for (const row of missions) {
    if (!row || typeof row !== 'object') {
      result.skipped += 1;
      continue;
    }
    const { mcId, scopeId, title, goal, status, cwd, facts: missionFacts } = row;
    if (typeof mcId !== 'string' || mcId.trim() === '' || typeof title !== 'string' || title.trim() === '' || typeof goal !== 'string' || goal.trim() === '') {
      result.skipped += 1;
      continue;
    }
    if (typeof scopeId !== 'string' || scopeId.trim() === '' || !ensureScope(scopeId, rootId)) {
      result.skipped += 1;
      continue;
    }

    const goalPrefix = `[mc:${mcId}]`;
    const existing = missionsStore.list().find((m) => typeof m.goal === 'string' && m.goal.startsWith(goalPrefix));
    const targetStatus = MISSION_STATUSES.includes(status) ? status : null;

    let mission;
    backupOnce();
    if (existing) {
      mission = missionsStore.update(existing.id, { title, goal });
      if (targetStatus && targetStatus !== mission.status) mission = missionsStore.setStatus(mission.id, targetStatus);
      result.missionsUpdated += 1;
    } else {
      const cwdOk = typeof cwd === 'string' && path.isAbsolute(cwd) && fs.existsSync(cwd) && fs.statSync(cwd).isDirectory();
      mission = missionsStore.create({ title, goal, cwd: cwdOk ? cwd : null });
      if (targetStatus && targetStatus !== mission.status) mission = missionsStore.setStatus(mission.id, targetStatus);
      result.missionsNew += 1;
    }

    const missionScopeId = `mission:${mission.id}`;
    ensureScope(missionScopeId, scopeId);
    for (const factText of Array.isArray(missionFacts) ? missionFacts : []) {
      rememberFact({ scopeId: missionScopeId, kind: 'fact', text: factText, origin: `import:mc:${mcId}`, confidence: 0.8 });
    }
  }

  return result;
}

/**
 * Imports a manifest (facts + missions, already extracted from prose sources
 * by the LLM stage) into `dataDir`'s memory and mission stores.
 *
 * Idempotent: run it twice with the same input and the second run creates
 * nothing new — every fact is a `memory.confirmed`, every mission an
 * `update`, every scope a no-op. That is what makes a re-import (after new
 * memory files or MC tasks appear) safe to just run again.
 *
 * `dryRun` computes the exact same counters without writing anything to
 * `dataDir`: the whole run happens against a throwaway copy of the current
 * store state instead, so twin detection (new vs. confirmed, new vs.
 * updated) reflects reality rather than an empty store pretending nothing
 * exists yet.
 */
export function importManifest({ dataDir, scopeMap, facts = [], missions = [], dryRun = false, now = Date.now }) {
  if (!dryRun) return runImport({ dataDir, scopeMap, facts, missions, now, allowBackup: true });

  const tmpDir = copyDataDirToTemp(dataDir);
  try {
    return runImport({ dataDir: tmpDir, scopeMap, facts, missions, now, allowBackup: false });
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}
