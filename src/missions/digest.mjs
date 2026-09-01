// P8 — Morning digest, numbers core (DESIGN-SPEC "P8 — Morgen-Digest,
// Zahlen-Kern"). One Markdown document per mission and window, built from
// what is already on disk: runs.jsonl (src/orchestrator/runs.mjs) and the
// pending deferred questions (src/server/approval-store.mjs listPending).
//
// NUMBERS ONLY, and that is a decision, not a gap: no model call, no engine,
// no network, no new subprocess. The three-sentence prose summary needs an
// engine and stays an explicit Phase-3 opt-in; until someone turns that
// switch on, the digest is free — it must never cost more than what it
// reports.
//
// THE WINDOW IS DST-SAFE. It is the interval [local day start, local day
// start of the following day) as REAL time points, so a spring-forward day
// is a 23 h window and a fall-back day a 25 h window — never "00:00–24:00
// = 24 h". The local day decomposition is INJECTED (decompose/compose, see
// below) so tests can pin a fixed timezone instead of depending on the
// machine's clock. The header states the actual span.
//
// HONESTY RULE, binding: a missing value appears neither as 0 nor silently
// inside a sum. Every field can be "unknown", the header carries a coverage
// counter ("Kosten bekannt für 3 von 5 Läufen"), and sums are labelled
// "(bekannter Teil)".
//
// THE DIGEST IS A REPORT, NOT A STORE. Building it twice on the same day
// overwrites the same file (`digests/<datum>.md`, local date of the window
// end); there are no revision files. History lives in runs.jsonl, which is
// append-only and never touched here — this module only ever READS it.
import fs from 'node:fs';
import path from 'node:path';
import { readRuns } from '../orchestrator/runs.mjs';

/** A deferred question's lifetime (src/server/approval-store.mjs APPROVAL_INBOX_TTL_MS). Restated here, not imported, so this module stays a pure reader. */
export const QUESTION_TTL_MS = 24 * 60 * 60_000;

const HOUR_MS = 60 * 60_000;

// --- Injected local-day decomposition -------------------------------------
//
// decompose(ms) → {y, m, d} in LOCAL calendar terms (m is 0-based, like
// Date); compose({y, m, d}) → the epoch ms of that LOCAL midnight. The
// defaults use the runtime's own timezone — no TZ environment variable is
// read or changed. Tests inject a fixed-zone pair (e.g. Europe/Berlin built
// on Intl) so DST behaviour is pinned, not machine-dependent.

export function defaultDecompose(ms) {
  const d = new Date(ms);
  return { y: d.getFullYear(), m: d.getMonth(), d: d.getDate() };
}

export function defaultCompose({ y, m, d }) {
  return new Date(y, m, d, 0, 0, 0, 0).getTime();
}

const DAY_MS = 24 * 60 * 60_000;

/**
 * The [start, end) of the LOCAL day containing `ms`, as real time points.
 *
 * Stepping from one midnight to the next cannot be done by adding 24 h
 * (that is exactly the DST bug). Instead: land safely inside the neighbour
 * day by adding 26 h — on a 23 h day that is 3 h past its midnight, on a
 * 25 h day 1 h past — and decompose THAT instant. compose() of its parts is
 * the true next local midnight, whether the day held 23, 24, or 25 hours.
 */
export function localDayBounds(ms, { decompose = defaultDecompose, compose = defaultCompose } = {}) {
  const startMs = compose(decompose(ms));
  const nextParts = decompose(startMs + 26 * HOUR_MS);
  const endMs = compose(nextParts);
  return { startMs, endMs, spanMs: endMs - startMs };
}

function parseInstant(value) {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    if (/^-?\d+$/.test(value.trim())) return Number(value.trim());
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  throw new Error(`digest: cannot read "${value}" as a time point (epoch ms or ISO-8601 expected)`);
}

function ddmmyyyy(parts) {
  return `${String(parts.d).padStart(2, '0')}.${String(parts.m + 1).padStart(2, '0')}.${parts.y}`;
}

function iso(ms) {
  return new Date(ms).toISOString();
}

/**
 * Resolves the digest window.
 *
 * - No since/until: yesterday's local day, seen from `now` — the morning
 *   digest default. Yesterday's midnight is reached via `todayStart - 1 h`
 *   (safe even on the spring-forward day, where that instant is 23:00 of
 *   the short previous day, still decomposing to yesterday).
 * - `since` only: the local day containing that instant.
 * - `since` and `until`: an arbitrary window of real time points, used as
 *   given.
 *
 * `name` is the local calendar date of the window END — for the default
 * morning digest that is today, the day the report is read.
 */
export function resolveWindow({ since = null, until = null, now = Date.now(), decompose = defaultDecompose, compose = defaultCompose } = {}) {
  const ctx = { decompose, compose };
  let startMs;
  let endMs;
  if (since === null && until === null) {
    const bounds = localDayBounds(compose(decompose(now)) - HOUR_MS, ctx);
    ({ startMs, endMs } = bounds);
  } else if (until === null) {
    ({ startMs, endMs } = localDayBounds(parseInstant(since), ctx));
  } else {
    startMs = parseInstant(since);
    endMs = parseInstant(until);
    if (!(endMs > startMs)) throw new Error('digest: until must be after since');
  }
  const spanMs = endMs - startMs;
  return {
    startMs,
    endMs,
    spanMs,
    kind: since !== null && until !== null ? 'explicit' : 'day',
    /** Local calendar date of the window end — the file name's date. */
    name: ddmmyyyy(decompose(endMs)),
  };
}

// --- Rendering -------------------------------------------------------------

export function fmtDuration(ms) {
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms < 0) return 'unknown';
  if (ms < 1000) return `${ms} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1).replace('.', ',')} s`;
  if (ms < HOUR_MS) {
    const m = Math.floor(ms / 60_000);
    const s = Math.round((ms % 60_000) / 1000);
    return s > 0 ? `${m} min ${s} s` : `${m} min`;
  }
  const h = Math.floor(ms / HOUR_MS);
  const m = Math.round((ms % HOUR_MS) / 60_000);
  return m > 0 ? `${h} h ${m} min` : `${h} h`;
}

export function fmtCost(usd) {
  return `$${usd.toFixed(4)}`;
}

/** One run's outcome line, exactly the states runs.jsonl can name (P7 fields included). */
function runLine(run) {
  const duration = run.durationMs != null ? `, Dauer ${fmtDuration(run.durationMs)}` : ', Dauer unknown';
  if (run.skipped === 'condition') {
    const kind = run.conditionKind ?? 'unknown';
    return `- übersprungen (condition false) — Bedingung ${kind}${duration}`;
  }
  if (run.skipped === 'condition-error') {
    const kind = run.conditionKind ?? 'unknown';
    const cause = run.conditionError ? String(run.conditionError).split('\n')[0].slice(0, 120) : 'unknown';
    return `- übersprungen (condition-error) — Bedingung ${kind} konnte nicht geprüft werden: ${cause}${duration}`;
  }
  const failed = run.stopReason === 'error' || run.error != null;
  const state = failed ? 'fehlgeschlagen' : 'gelaufen';
  const stop = failed && run.stopReason ? ` (stopReason: ${run.stopReason})` : '';
  const cost = typeof run.costUsd === 'number' ? fmtCost(run.costUsd) : 'Kosten unknown';
  const tokens = typeof run.tokens === 'number' ? run.tokens : 'unknown';
  return `- ${state}${stop} — ${cost}, ${tokens} Tokens${duration}`;
}

/** Files a run record itself names, if any. No index is built here — only what the record already carries. */
function filesOf(run) {
  const out = [];
  for (const field of ['files', 'touchedFiles']) {
    if (Array.isArray(run[field])) out.push(...run[field].filter((f) => typeof f === 'string'));
  }
  return out;
}

/**
 * Renders the digest document. Pure: same inputs, same bytes — that is what
 * makes a second build on the same day byte-identical (overwrite, no
 * revisions). `nowMs` only enters the open questions' remaining time.
 */
export function renderDigest({ mission, window, runs, openQuestions, nowMs = Date.now() }) {
  const title = mission?.title ?? mission?.id ?? 'Mission';
  const lines = [];

  lines.push(`# Morning digest — ${title}`);
  lines.push('');
  if (window.kind === 'day') {
    lines.push(`Fenster: ${window.label}, lokaler Tag — ${window.spanHours} h Fenster, von ${iso(window.startMs)} bis ${iso(window.endMs)}`);
  } else {
    lines.push(`Fenster: ${iso(window.startMs)} bis ${iso(window.endMs)} — ${window.spanHours} h`);
  }
  lines.push('');

  // (a) Trigger runs of the window, per trigger.
  const triggerRuns = runs.filter((run) => run.origin === 'trigger');
  lines.push('## Trigger-Läufe');
  lines.push('');
  if (triggerRuns.length === 0) {
    lines.push(`0 Läufe im Fenster${runs.length === 0 ? ' (0 Runs überhaupt)' : ` (${runs.length} Runs außerhalb von Triggern)`}.`);
  } else {
    const byTrigger = new Map();
    for (const run of triggerRuns) {
      const key = run.triggerId ?? 'unbekannter Trigger';
      if (!byTrigger.has(key)) byTrigger.set(key, []);
      byTrigger.get(key).push(run);
    }
    for (const [triggerId, list] of byTrigger) {
      lines.push(`### ${triggerId}`);
      lines.push('');
      for (const run of list) lines.push(runLine(run));
      lines.push('');
    }
  }

  // (b) Open (pending deferred) questions, with remaining time against their 24 h deadline.
  lines.push('## Offene Fragen');
  lines.push('');
  if (openQuestions.length === 0) {
    lines.push('0 offene Fragen.');
  } else {
    for (const q of openQuestions) {
      const deadline = typeof q.deadlineAt === 'number' ? q.deadlineAt : null;
      const rest = deadline != null ? deadline - nowMs : null;
      const restText = rest != null ? `${fmtDuration(Math.max(rest, 0))} von 24 h` : 'unknown';
      const text = (q.title ?? q.question ?? q.id ?? 'Frage').toString().split('\n')[0].slice(0, 160);
      lines.push(`- ${text} — Restlaufzeit: ${restText}`);
    }
  }
  lines.push('');

  // (c) Costs and tokens — the honesty rule lives here.
  const costKnown = runs.filter((run) => typeof run.costUsd === 'number');
  const tokenKnown = runs.filter((run) => typeof run.tokens === 'number');
  lines.push('## Kosten und Tokens');
  lines.push('');
  lines.push(`Kosten bekannt für ${costKnown.length} von ${runs.length} Läufen.`);
  const costSum = costKnown.reduce((acc, run) => acc + run.costUsd, 0);
  const tokenSum = tokenKnown.reduce((acc, run) => acc + run.tokens, 0);
  const costNote = costKnown.length === runs.length ? '' : ` (bekannter Teil; ${runs.length - costKnown.length} Läufe unknown)`;
  const tokenNote = tokenKnown.length === runs.length ? '' : ` (bekannter Teil; ${runs.length - tokenKnown.length} Läufe unknown)`;
  lines.push(`- Kosten: ${runs.length === 0 ? '$0.0000' : `${fmtCost(costSum)}${costNote}`}`);
  lines.push(`- Tokens: ${tokenSum}${tokenNote}`);
  if (costKnown.length < runs.length) {
    lines.push('');
    lines.push(`Ein fehlender Wert ist weder 0 noch in einer Summe: die ${runs.length - costKnown.length} Läufe ohne bekannte Kosten bleiben unknown und zählen nicht mit.`);
  }
  lines.push('');

  // (d) Files the window's run records themselves name. Nothing is indexed
  // here; if the records carry no file list, the digest says so.
  const files = [...new Set(runs.flatMap(filesOf))].sort();
  lines.push('## Berührte Dateien');
  lines.push('');
  if (files.length === 0) {
    lines.push('Aus den Runs nicht ersichtlich (die Run-Records nennen keine Dateien).');
  } else {
    for (const file of files) lines.push(`- ${file}`);
  }
  lines.push('');

  return lines.join('\n');
}

/**
 * Runs of this mission inside the window: a run belongs to the mission when
 * its chat is one of the mission's chats (the union of linked chats and
 * chats claiming the mission — same rule as the detail route).
 */
export function selectRuns(runs, window, chatIds) {
  return runs.filter((run) => {
    const ts = Date.parse(run.ts);
    if (!Number.isFinite(ts) || ts < window.startMs || ts >= window.endMs) return false;
    return run.chatId != null && chatIds.has(run.chatId);
  });
}

// --- Storage ---------------------------------------------------------------

export function digestsDir(dataDir, missionId) {
  return path.join(dataDir, 'missions', missionId, 'digests');
}

/**
 * Builds the digest document for a mission and stores it, overwriting the
 * same `<datum>.md` on every build of the same day. Runs are read from
 * runs.jsonl (read-only); the pending questions come in from the caller —
 * the approval store lives in src/server and this module only looks at it.
 *
 * Returns `{ markdown, path, window }`; `wrote` says whether bytes changed.
 */
export function buildDigest({
  dataDir,
  mission,
  chatIds,
  pendingQuestions = [],
  since = null,
  until = null,
  now = Date.now(),
  decompose = defaultDecompose,
  compose = defaultCompose,
  runs: runsOverride = null,
}) {
  const windowBase = resolveWindow({ since, until, now, decompose, compose });
  const spanHours = Math.round((windowBase.spanMs / HOUR_MS) * 10) / 10;
  // The label uses the window boundaries' local dates, in the injected zone.
  const window = {
    ...windowBase,
    spanHours: Number.isInteger(spanHours) ? `${spanHours}` : String(spanHours).replace('.', ','),
    label: windowBase.kind === 'day'
      ? ddmmyyyy(decompose(windowBase.startMs))
      : `${ddmmyyyy(decompose(windowBase.startMs))} – ${ddmmyyyy(decompose(windowBase.endMs))}`,
  };

  const runs = runsOverride ?? selectRuns(readRuns(dataDir), window, chatIds);
  const markdown = renderDigest({ mission, window, runs, openQuestions: pendingQuestions, nowMs: now });

  const dir = digestsDir(dataDir, mission.id);
  fs.mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, `${window.name}.md`);
  const existing = fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf8') : null;
  const wrote = existing !== markdown;
  if (wrote) fs.writeFileSync(filePath, markdown, 'utf8');
  return { markdown, path: filePath, window, wrote };
}

/** The existing digest files of a mission, newest first. */
export function listDigests(dataDir, missionId) {
  const dir = digestsDir(dataDir, missionId);
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((name) => name.endsWith('.md'))
    .sort()
    .reverse()
    .map((name) => {
      const full = path.join(dir, name);
      return { name, path: full, bytes: fs.statSync(full).size };
    });
}
