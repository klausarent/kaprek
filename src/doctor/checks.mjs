// kaprek doctor — the individual checks. READ-ONLY: every check in here
// only reads files (or opens the search DB for a bare `PRAGMA user_version`
// read, which writes nothing); the only two places allowed to change
// anything live in doctor.mjs behind --fix (sweepOldContextState, index
// rebuild). Each check returns one result object:
//   { id, status: 'ok' | 'warn' | 'fail', message, detail? }
// — message is a single sentence a person reads, detail carries the per-item
// lines (file names, ids) the message names.
//
// Nothing in here throws: every check wraps its own body, because a doctor
// that crashes on the one broken thing it was asked to look at has failed
// at its only job.
import fs from 'node:fs';
import path from 'node:path';
import { SCHEMA_VERSION, FUTURE_SCHEMA_REASON } from '../search/index.mjs';
import { getSqlite } from '../lib/sqlite.mjs';
import { loadPolicy, PolicyValidationError } from '../policy/policy.mjs';
import { readSessionEvents } from '../ledger/sessions.mjs';
import { contextDir, STATE_MAX_AGE_MS, readContextState } from '../policy/prompt-context-state.mjs';
import { status as hookStatus } from '../cli/hooks.mjs';
import { loadPresets } from '../missions/presets.mjs';
import { createGrantStore } from '../policy/grants.mjs';

/** Number of most-recently-written transcripts the drift check samples. */
export const DRIFT_SAMPLE_SIZE = 10;
/** broken/unknown share at which the drift check warns / fails. */
export const DRIFT_WARN_SHARE = 0.01;
export const DRIFT_FAIL_SHARE = 0.10;
/** A grant unused for longer than this is a cleanup candidate — a candidate only, never an expiry. */
export const GRANT_IDLE_WARN_MS = 30 * 24 * 60 * 60 * 1000;

// The `type` values the parser knows. A well-formed line whose type is NOT
// in this set is silently dropped by the parser today (README, "Session
// format drift") — that silent drop is exactly what this check exists to
// surface. Kept in step with src/parser/parse.mjs by hand.
const KNOWN_TYPES = new Set([
  'user', 'assistant', 'system', 'attachment',
  'ai-title', 'last-prompt',
  // marker lines the parser skips without an event, but knows:
  'summary', 'mode', 'permission-mode', 'queue-operation',
  'file-history-snapshot', 'file-history-delta',
]);

function check(id, status, message, detail) {
  return detail === undefined ? { id, status, message } : { id, status, message, detail };
}

/** Recursively collects *.jsonl file paths under rootDir (best-effort). */
function collectJsonlFiles(rootDir) {
  const files = [];
  const walk = (dir, depth) => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (depth < 8) walk(full, depth + 1);
      } else if (entry.isFile() && entry.name.endsWith('.jsonl')) {
        files.push(full);
      }
    }
  };
  walk(rootDir, 0);
  return files;
}

/**
 * The DRIFT_SAMPLE_SIZE most recently written session transcripts under
 * rootDir, newest first: [{ file, mtimeMs }].
 */
export function newestTranscripts(rootDir, limit = DRIFT_SAMPLE_SIZE) {
  const withMtime = [];
  for (const file of collectJsonlFiles(rootDir)) {
    try {
      withMtime.push({ file, mtimeMs: fs.statSync(file).mtimeMs });
    } catch {
      // a file that vanished between readdir and stat is not sampled
    }
  }
  withMtime.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return withMtime.slice(0, limit);
}

/**
 * transcript-drift — samples the newest session transcripts and measures the
 * share of unusable lines: broken (non-JSON, the parser's `brokenLines`
 * rule) plus well-formed lines whose `type` the parser has no name for (the
 * parser drops those silently, so they surface nowhere else). Shares are
 * taken over all sampled lines together: warn from 1%, fail from 10%.
 */
export async function checkTranscriptDrift({ rootDir } = {}) {
  try {
    const samples = newestTranscripts(rootDir);
    if (samples.length === 0) {
      return check('transcript-drift', 'ok', 'No session transcripts found under the scan root — nothing to sample.');
    }
    let total = 0;
    let broken = 0;
    let unknownType = 0;
    const perFile = [];
    for (const sample of samples) {
      let fileBroken = 0;
      let fileUnknown = 0;
      let fileTotal = 0;
      // digestSession is kaprek's real parser: its brokenLines count is the
      // number of lines that are not valid JSON. The unknown-type count
      // needs the type field of lines the parser drops, so the raw lines are
      // classified here — line classification only, no event parsing.
      try {
        // The parser does not export its brokenLines counter, so the same
        // classification is applied to the raw lines: a line that is not
        // valid JSON is "broken" (exactly the parser's brokenLines rule),
        // a well-formed line with a `type` outside KNOWN_TYPES is
        // "unknown-type" (the parser drops it silently). Line
        // classification only — no event parsing duplicated here.
        const raw = fs.readFileSync(sample.file, 'utf8');
        for (const line of raw.split('\n')) {
          const trimmed = line.trim();
          if (trimmed === '') continue;
          fileTotal += 1;
          let obj;
          try {
            obj = JSON.parse(trimmed);
          } catch {
            fileBroken += 1;
            continue; // same rule as the parser's brokenLines counter
          }
          if (typeof obj?.type === 'string' && !KNOWN_TYPES.has(obj.type)) fileUnknown += 1;
        }
      } catch (err) {
        perFile.push(`${path.basename(sample.file)}: unreadable (${err.message})`);
        continue;
      }
      total += fileTotal;
      broken += fileBroken;
      unknownType += fileUnknown;
      if (fileBroken + fileUnknown > 0) {
        perFile.push(`${path.basename(sample.file)}: ${fileBroken} broken, ${fileUnknown} unknown-type of ${fileTotal} lines`);
      }
    }
    const bad = broken + unknownType;
    const share = total > 0 ? bad / total : 0;
    const pct = `${(share * 100).toFixed(1)}%`;
    const summary = `${bad} of ${total} sampled lines unusable (${pct}): ${broken} broken JSON, ${unknownType} unknown type, across ${samples.length} transcript(s).`;
    if (share >= DRIFT_FAIL_SHARE) {
      return check('transcript-drift', 'fail', `Heavy transcript drift: ${summary}`, perFile);
    }
    if (share >= DRIFT_WARN_SHARE) {
      return check('transcript-drift', 'warn', `Transcript drift detected: ${summary}`, perFile);
    }
    return check('transcript-drift', 'ok', `Transcripts parse cleanly: ${summary}`);
  } catch (err) {
    return check('transcript-drift', 'warn', `The transcript-drift check could not run: ${err.message}`);
  }
}

/**
 * hooks — verifies the four managed entries against the files they call:
 * script path exists, --managed-by marker intact (the entry is FOUND by the
 * marker — that is what "marker intact" means here — see cli/hooks.mjs),
 * and the recorded command is well-formed enough to extract a path from.
 */
export function checkHooks({ dataDir, settingsPath } = {}) {
  try {
    const report = hookStatus({ dataDir, settingsPath });
    if (report.settings === null) {
      return check('hooks', 'warn', `The Claude Code settings file at ${report.settingsPath} exists but is not valid JSON — the hook entries cannot be verified.`);
    }
    if (!report.installed) {
      return check('hooks', 'ok', 'No kaprek hooks installed in the Claude Code settings — nothing to verify (kaprek hooks install adds them).');
    }
    const problems = [];
    const lines = [];
    for (const [event, entry] of Object.entries(report.events)) {
      if (!entry.installed) {
        lines.push(`${event}: not installed`);
        problems.push(`${event} is not installed`);
        continue;
      }
      if (!entry.recordedPath) {
        lines.push(`${event}: installed, but the command is not well-formed (no script path could be read from it)`);
        problems.push(`${event}'s command is not well-formed`);
        continue;
      }
      if (entry.recordedPathMissing) {
        lines.push(`${event}: installed, but no file exists at the recorded path ${entry.recordedPath}`);
        problems.push(`${event} points at a missing script file (${entry.recordedPath})`);
        continue;
      }
      lines.push(`${event}: installed, script present (${entry.recordedPath})`);
    }
    if (problems.length > 0) {
      return check('hooks', 'warn', `Hook entries have problems: ${problems.join('; ')}. Re-running kaprek hooks install refreshes them.`, lines);
    }
    return check('hooks', 'ok', 'All four hook entries are installed, carry the --managed-by marker, and point at existing script files.', lines);
  } catch (err) {
    return check('hooks', 'warn', `The hooks check could not run: ${err.message}`);
  }
}

/**
 * search-index — reads the schema version BOTH ways (higher than this
 * binary's, lower than): higher → warn, a newer kaprek wrote this index and
 * the read-only gate refuses it anyway; lower → ok with a note that kaprek
 * drops and rebuilds the old schema on open; equal → ok. The version is
 * read with a bare `PRAGMA user_version` on a directly opened connection —
 * deliberately NOT through openSearchDb(), whose open path drops an older
 * schema (a write) and must stay out of a read-only doctor.
 */
export async function checkSearchIndex({ dataDir } = {}) {
  const dbPath = path.join(dataDir, 'search.db');
  try {
    if (!fs.existsSync(dbPath)) {
      return check('search-index', 'ok', 'No search index exists yet — it is built on first use.');
    }
    const { available, DatabaseSync, reason } = await getSqlite();
    if (!available) {
      return check('search-index', 'ok', `The search index file exists, but this runtime has no node:sqlite to read its schema version (${reason}).`);
    }
    let version;
    let db;
    try {
      db = new DatabaseSync(dbPath);
      version = db.prepare('PRAGMA user_version').get()?.user_version ?? 0;
    } catch (err) {
      return check('search-index', 'fail', `The search index file could not be opened: ${err.message}`);
    } finally {
      try { db?.close(); } catch { /* already closed */ }
    }
    if (version > SCHEMA_VERSION) {
      return check('search-index', 'warn', `The search index was written by a newer kaprek (schema ${version} > ${SCHEMA_VERSION}); this kaprek only reads it read-only. ${FUTURE_SCHEMA_REASON}`);
    }
    if (version < SCHEMA_VERSION) {
      return check('search-index', 'ok', `The search index uses an older schema (${version} < ${SCHEMA_VERSION}); kaprek drops and rebuilds it on next open, or kaprek doctor --fix triggers the rebuild now.`);
    }
    return check('search-index', 'ok', `The search index schema is current (version ${version}).`);
  } catch (err) {
    return check('search-index', 'warn', `The search-index check could not run: ${err.message}`);
  }
}

/** The on-disk schema version of <dataDir>/search.db, or null if it cannot be read. Used by the --fix gate. */
export async function readSearchSchemaVersion(dataDir) {
  const dbPath = path.join(dataDir, 'search.db');
  if (!fs.existsSync(dbPath)) return null;
  const { available, DatabaseSync } = await getSqlite();
  if (!available) return null;
  let db;
  try {
    db = new DatabaseSync(dbPath);
    return db.prepare('PRAGMA user_version').get()?.user_version ?? 0;
  } catch {
    return null;
  } finally {
    try { db?.close(); } catch { /* already closed */ }
  }
}

/**
 * policy — the load result. normal load → ok; fail-closed fallback (P0.5:
 * a readable policy.json this binary does not fully understand) → warn with
 * the reason; a load that fell back for a duller reason (unreadable file,
 * invalid JSON) → warn; a readable policy whose ceiling is 'ask' → ok, said
 * out loud. loadPolicyFailOpen() is deliberately NOT used here: it writes
 * the fail-closed line to policy.log, and doctor reports without writing.
 */
export function checkPolicy({ dataDir } = {}) {
  try {
    const policy = loadPolicy(dataDir);
    if (policy.reason) {
      return check('policy', 'warn', `The policy fell back: ${policy.reason}`);
    }
    if (policy.posture === 'ask') {
      return check('policy', 'ok', `The policy loads normally with the posture ceiling at 'ask' (mode: ${policy.mode}, ${policy.hardDenials.length} hard denial(s)).`);
    }
    return check('policy', 'ok', `The policy loads normally (mode: ${policy.mode}, posture: ${policy.posture}).`);
  } catch (err) {
    if (err instanceof PolicyValidationError) {
      return check('policy', 'warn', `policy.json fails schema validation, kaprek loads it FAIL-CLOSED to posture 'ask': ${err.message}`);
    }
    return check('policy', 'warn', `The policy check could not run: ${err.message}`);
  }
}

/**
 * presets — parses every <dataDir>/presets/*.json; broken files are named,
 * valid ones counted. The preset loader itself skips broken files silently
 * (a console.warn summarises the count) — a doctor can afford the names.
 */
export function checkPresets({ dataDir } = {}) {
  try {
    const presetsDir = path.join(dataDir, 'presets');
    let names = [];
    try {
      names = fs.readdirSync(presetsDir).filter((n) => n.endsWith('.json'));
    } catch {
      return check('presets', 'ok', 'No preset files exist (only the built-ins are in use).');
    }
    const broken = [];
    let valid = 0;
    for (const name of names.sort()) {
      try {
        JSON.parse(fs.readFileSync(path.join(presetsDir, name), 'utf8'));
        valid += 1;
      } catch {
        broken.push(name);
      }
    }
    if (broken.length > 0) {
      return check('presets', 'warn', `${broken.length} of ${names.length} preset file(s) do not parse and are skipped by the catalog: ${broken.join(', ')}.`, broken.map((n) => `broken: ${path.join('presets', n)}`));
    }
    return check('presets', 'ok', `All ${valid} preset file(s) parse.`);
  } catch (err) {
    return check('presets', 'warn', `The presets check could not run: ${err.message}`);
  }
}

/**
 * ledger — the last event of each of the most recently used sessions:
 * an `end` for a session that never `start`ed is orphaned, more than one
 * `end` for the same session is circular (ended, then ended again). Both
 * mean the ledger's answer to "is this session still open?" is unreliable.
 */
export function checkLedger({ dataDir, maxSessions = 100 } = {}) {
  try {
    const events = readSessionEvents(dataDir, { limit: 1000 });
    if (events.length === 0) {
      return check('ledger', 'ok', 'The session ledger is empty or does not exist — nothing to check.');
    }
    // Fold in file order, per session: starts, ends, last event.
    const sessions = new Map(); // id -> { starts, ends, lastType, lastTs }
    for (const e of events) {
      if (typeof e?.sessionId !== 'string' || e.sessionId === '') continue;
      const s = sessions.get(e.sessionId) ?? { starts: 0, ends: 0, lastType: null, lastTs: null };
      if (e.type === 'start') s.starts += 1;
      if (e.type === 'end') s.ends += 1;
      s.lastType = e.type;
      s.lastTs = e.ts ?? s.lastTs;
      sessions.set(e.sessionId, s);
    }
    const recent = [...sessions.entries()]
      .sort((a, b) => String(b[1].lastTs ?? '').localeCompare(String(a[1].lastTs ?? '')))
      .slice(0, maxSessions);
    const problems = [];
    let openCount = 0;
    for (const [id, s] of recent) {
      if (s.lastType !== 'end') openCount += 1;
      if (s.ends > 0 && s.starts === 0) problems.push(`${id}: ${s.ends} end event(s) but no start (orphaned end)`);
      else if (s.ends > 1) problems.push(`${id}: ${s.ends} end events (circular end)`);
    }
    if (problems.length > 0) {
      return check('ledger', 'warn', `${problems.length} of ${recent.length} recent session ledger entries look inconsistent (orphaned or circular end events).`, problems);
    }
    return check('ledger', 'ok', `${recent.length} recent session ledger entries are consistent (${openCount} still open by their last event).`);
  } catch (err) {
    return check('ledger', 'warn', `The ledger check could not run: ${err.message}`);
  }
}

/**
 * context-state — per-session cwd state files under <dataDir>/context/:
 * counts the ones the existing sweep would delete (mtime older than
 * STATE_MAX_AGE_MS — 7 days — the exact sweep condition, announced) and the
 * ones that do not parse. doctor only counts; deleting happens via --fix,
 * which calls the same sweep the hook slow path calls.
 */
export function checkContextState({ dataDir } = {}) {
  try {
    const dir = contextDir(dataDir);
    let names = [];
    try {
      names = fs.readdirSync(dir).filter((n) => n.endsWith('.json'));
    } catch {
      return check('context-state', 'ok', 'No context state directory yet — nothing to check.');
    }
    const stale = [];
    const malformed = [];
    const cutoff = Date.now() - STATE_MAX_AGE_MS;
    for (const name of names) {
      const file = path.join(dir, name);
      try {
        const stat = fs.statSync(file);
        if (stat.mtimeMs > cutoff) continue;
        stale.push(name);
      } catch {
        continue; // vanished mid-check
      }
    }
    // Malformed = readable file whose content has no cwd string. Only files
    // that are NOT already swept candidates are interesting here.
    for (const name of names) {
      if (stale.includes(name)) continue;
      const sessionId = name.replace(/\.json$/, '');
      if (readContextState(dataDir, sessionId) === null) malformed.push(name);
    }
    const days = Math.round(STATE_MAX_AGE_MS / (24 * 60 * 60 * 1000));
    const parts = [];
    if (stale.length > 0) parts.push(`${stale.length} older than ${days} days (kaprek doctor --fix deletes them, same condition as the automatic sweep)`);
    if (malformed.length > 0) parts.push(`${malformed.length} unreadable/malformed`);
    if (parts.length > 0) {
      return check('context-state', 'warn', `Context state files need attention: ${parts.join('; ')}.`, [...stale.map((n) => `stale: ${n}`), ...malformed.map((n) => `malformed: ${n}`)]);
    }
    return check('context-state', 'ok', `${names.length} context state file(s), none older than the ${days}-day sweep age, all readable.`);
  } catch (err) {
    return check('context-state', 'warn', `The context-state check could not run: ${err.message}`);
  }
}

/**
 * Context state files the --fix sweep would delete (the exact sweep
 * condition: mtime older than STATE_MAX_AGE_MS), listed BEFORE the fix runs.
 */
export function staleContextStateFiles(dataDir) {
  const dir = contextDir(dataDir);
  const cutoff = Date.now() - STATE_MAX_AGE_MS;
  const stale = [];
  let names = [];
  try {
    names = fs.readdirSync(dir).filter((n) => n.endsWith('.json'));
  } catch {
    return stale;
  }
  for (const name of names) {
    try {
      if (fs.statSync(path.join(dir, name)).mtimeMs <= cutoff) stale.push(path.join(dir, name));
    } catch {
      // vanished mid-listing
    }
  }
  return stale;
}

/**
 * grants — how many active grants exist, and which have not been used for
 * over 30 days: cleanup CANDIDATES, named with their idle age. Grants have
 * NO expiry (a design decision — visibility replaces lifetime, see
 * ERWEITERUNGSPLAN R6): doctor advises, the operator decides, the clock
 * never revokes anything.
 */
export function checkGrants({ dataDir, now = Date.now() } = {}) {
  try {
    const store = createGrantStore({ dataDir, log: () => {} });
    const active = store.active();
    if (active.length === 0) {
      return check('grants', 'ok', 'No active grants exist.');
    }
    const candidates = [];
    for (const grant of active) {
      const lastUsed = grant.lastUsedAt ?? grant.createdAt ?? null;
      if (typeof lastUsed !== 'string') continue;
      const ageMs = now - Date.parse(lastUsed);
      if (!Number.isFinite(ageMs) || ageMs < GRANT_IDLE_WARN_MS) continue;
      candidates.push(`${grant.id}: unused for ${Math.floor(ageMs / (24 * 60 * 60 * 1000))} days (last used ${lastUsed})`);
    }
    if (candidates.length > 0) {
      return check('grants', 'warn', `${active.length} active grant(s); ${candidates.length} unused for over 30 days — cleanup candidate(s), but grants never expire on their own and doctor does not revoke.`, candidates);
    }
    return check('grants', 'ok', `${active.length} active grant(s), none idle beyond 30 days.`);
  } catch {
    // The grants store module or its file shape is not present in this
    // installation — a missing feature is not a fault.
    return check('grants', 'ok', 'skipped (feature not present)');
  }
}

/**
 * triggers-degraded — lists every trigger whose condition-error streak in
 * runs.jsonl is > 0 (P7), flagging the ones past the degraded threshold.
 * When the condition infrastructure is not present in this build, the check
 * is skipped with an ok — an absent feature is not a fault.
 */
export async function checkTriggersDegraded({ dataDir } = {}) {
  try {
    // Imported lazily and inside try/catch: this is the "feature not
    // present" seam — if any of these modules or functions do not exist in
    // some future tree, the check skips instead of crashing.
    const [{ conditionErrorStreak, DEGRADED_STREAK_THRESHOLD }, { readRuns }, { openTriggers }] = await Promise.all([
      import('../triggers/condition.mjs'),
      import('../orchestrator/runs.mjs'),
      import('../triggers/registry.mjs'),
    ]);
    if (typeof conditionErrorStreak !== 'function' || typeof readRuns !== 'function' || typeof openTriggers !== 'function') {
      return check('triggers-degraded', 'ok', 'skipped (feature not present)');
    }
    let triggers;
    try {
      triggers = openTriggers(dataDir, { log: () => {} }).list();
    } catch {
      return check('triggers-degraded', 'ok', 'skipped (feature not present)');
    }
    const withCondition = triggers.filter((t) => t?.condition !== undefined);
    if (withCondition.length === 0) {
      return check('triggers-degraded', 'ok', `${triggers.length} trigger(s), none with a condition — no degraded streaks possible.`);
    }
    const runs = readRuns(dataDir);
    const streaks = [];
    let degradedCount = 0;
    for (const trigger of withCondition) {
      const streak = conditionErrorStreak(runs, trigger.id);
      if (streak <= 0) continue;
      const degraded = streak >= DEGRADED_STREAK_THRESHOLD;
      if (degraded) degradedCount += 1;
      streaks.push(`${trigger.id}: condition-error streak ${streak}${degraded ? ' — DEGRADED (past the threshold of ' + DEGRADED_STREAK_THRESHOLD + ')' : ''}`);
    }
    if (degradedCount > 0) {
      return check('triggers-degraded', 'warn', `${degradedCount} trigger(s) are DEGRADED from consecutive condition errors.`, streaks);
    }
    if (streaks.length > 0) {
      return check('triggers-degraded', 'warn', `${streaks.length} trigger(s) have condition errors in a row, none past the degraded threshold yet.`, streaks);
    }
    return check('triggers-degraded', 'ok', `${withCondition.length} conditional trigger(s), no condition-error streaks.`);
  } catch {
    return check('triggers-degraded', 'ok', 'skipped (feature not present)');
  }
}
