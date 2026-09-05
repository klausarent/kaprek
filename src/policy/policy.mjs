// Policy engine backing the Claude Code Stop hook (see hook-stop.mjs).
//
// Fail-open is the overriding design constraint: a bug or a malformed
// policy.json here must never stop a user from ending a Claude Code turn.
// loadPolicy() itself already falls back to the 'observe' default on a
// missing or unreadable/corrupt policy.json; evaluateStop() wraps its own
// body in try/catch on top of that, so even a bug in the evaluation logic
// (or a schema error loadPolicy() legitimately throws) resolves to 'allow'.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import readline from 'node:readline';
import { openBoard } from '../board/store.mjs';
import { POSTURES, validateHardDenials, HardDenialValidationError } from './guards.mjs';

const VALID_MODES = ['observe', 'warn', 'block'];
const KNOWN_TOP_FIELDS = ['version', 'mode', 'rules', 'posture', 'hardDenials', 'budget'];
const KNOWN_RULE_FIELDS = ['requireTaskDoc', 'requireCommitTask'];
const KNOWN_BUDGET_FIELDS = ['defaultDailyUsd'];

export const DEFAULT_POLICY = Object.freeze({
  version: 1,
  mode: 'observe',
  rules: Object.freeze({ requireTaskDoc: true, requireCommitTask: true }),
  // The global posture ceiling (see guards.mjs): 'auto' means no ceiling,
  // which is what every install before this field had.
  posture: 'auto',
  // Rules a person added on top of guards.mjs's built-ins. The built-ins
  // are not listed here because they cannot be switched off from here.
  hardDenials: Object.freeze([]),
  // The default DAILY budget in USD (ALMANAC-PLAN §2.5). null = no limit —
  // which is what every install before this section had. It is a CEILING,
  // not a spend: a mission may only tighten it with its own budgetUsd
  // (posture semantics — src/budget/budget.mjs). Budget is part of the
  // policy fingerprint (policyVersion): changing the cap stales receipts'
  // "rules this was done under" exactly like a posture change does.
  budget: Object.freeze({ defaultDailyUsd: null }),
});

export class PolicyValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'PolicyValidationError';
  }
}

function clonePolicy(policy) {
  return JSON.parse(JSON.stringify(policy));
}

function policyPathFor(dataDir) {
  return path.join(dataDir, 'policy.json');
}

/** Throws PolicyValidationError on any field/shape it does not recognize. */
function validatePolicyShape(raw) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new PolicyValidationError('policy.json must be a JSON object');
  }
  for (const key of Object.keys(raw)) {
    if (!KNOWN_TOP_FIELDS.includes(key)) {
      throw new PolicyValidationError(`unknown field: "${key}" (expected one of ${KNOWN_TOP_FIELDS.join(', ')})`);
    }
  }
  if (raw.version !== undefined && raw.version !== 1) {
    throw new PolicyValidationError(`unsupported version: ${JSON.stringify(raw.version)} (expected 1)`);
  }
  if (raw.mode !== undefined && !VALID_MODES.includes(raw.mode)) {
    throw new PolicyValidationError(`invalid mode: ${JSON.stringify(raw.mode)} (expected one of ${VALID_MODES.join(', ')})`);
  }
  if (raw.posture !== undefined && !POSTURES.includes(raw.posture)) {
    throw new PolicyValidationError(`invalid posture: ${JSON.stringify(raw.posture)} (expected one of ${POSTURES.join(', ')})`);
  }
  if (raw.hardDenials !== undefined) {
    try {
      validateHardDenials(raw.hardDenials);
    } catch (err) {
      if (err instanceof HardDenialValidationError) throw new PolicyValidationError(err.message);
      throw err;
    }
  }
  if (raw.budget !== undefined) {
    if (raw.budget === null || typeof raw.budget !== 'object' || Array.isArray(raw.budget)) {
      throw new PolicyValidationError('budget must be an object');
    }
    for (const key of Object.keys(raw.budget)) {
      if (!KNOWN_BUDGET_FIELDS.includes(key)) {
        throw new PolicyValidationError(`unknown budget field: "${key}" (expected one of ${KNOWN_BUDGET_FIELDS.join(', ')})`);
      }
      const value = raw.budget[key];
      if (value !== null && (typeof value !== 'number' || !Number.isFinite(value) || value < 0)) {
        throw new PolicyValidationError('budget.defaultDailyUsd must be null or a finite number >= 0');
      }
    }
  }
  if (raw.rules !== undefined) {
    if (raw.rules === null || typeof raw.rules !== 'object' || Array.isArray(raw.rules)) {
      throw new PolicyValidationError('rules must be an object');
    }
    for (const key of Object.keys(raw.rules)) {
      if (!KNOWN_RULE_FIELDS.includes(key)) {
        throw new PolicyValidationError(`unknown rules field: "${key}" (expected one of ${KNOWN_RULE_FIELDS.join(', ')})`);
      }
      if (typeof raw.rules[key] !== 'boolean') {
        throw new PolicyValidationError(`rules.${key} must be a boolean`);
      }
    }
  }
}

/**
 * Loads `<dataDir>/policy.json`. Never throws for a missing file, an
 * unreadable file, or invalid JSON — all three fall back to
 * DEFAULT_POLICY (mode 'observe') with a `reason` field explaining why.
 * DOES throw PolicyValidationError for a well-formed JSON document that
 * violates the schema (unknown field, bad mode, non-boolean rule) — callers
 * that need fail-open behavior even for that case (i.e. the Stop hook path)
 * must catch it themselves; see evaluateStop().
 */
export function loadPolicy(dataDir) {
  const policyPath = policyPathFor(dataDir);
  if (!fs.existsSync(policyPath)) {
    return clonePolicy(DEFAULT_POLICY);
  }

  let raw;
  try {
    raw = fs.readFileSync(policyPath, 'utf8').replace(/^﻿/, ''); // strip a leading BOM, e.g. from files saved by some Windows editors
  } catch (err) {
    return { ...clonePolicy(DEFAULT_POLICY), reason: `could not read policy.json, falling back to observe: ${err.message}` };
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    return { ...clonePolicy(DEFAULT_POLICY), reason: `invalid JSON in policy.json, falling back to observe: ${err.message}` };
  }

  validatePolicyShape(parsed);

  return {
    version: parsed.version ?? DEFAULT_POLICY.version,
    mode: parsed.mode ?? DEFAULT_POLICY.mode,
    rules: {
      requireTaskDoc: parsed.rules?.requireTaskDoc ?? DEFAULT_POLICY.rules.requireTaskDoc,
      requireCommitTask: parsed.rules?.requireCommitTask ?? DEFAULT_POLICY.rules.requireCommitTask,
    },
    posture: parsed.posture ?? DEFAULT_POLICY.posture,
    hardDenials: validateHardDenials(parsed.hardDenials),
    budget: {
      defaultDailyUsd: parsed.budget?.defaultDailyUsd ?? DEFAULT_POLICY.budget.defaultDailyUsd,
    },
  };
}

/**
 * The fail-closed fallback for a policy.json this binary does not fully
 * understand (unknown field, unknown version — anything validatePolicyShape()
 * rejects on a STRUCTURALLY READABLE document). P0.5: the old fail-open
 * loader fell back to DEFAULT_POLICY here, i.e. `posture: 'auto'` with no
 * hard denials — a field written by a newer kaprek silently lifted the
 * ceiling and the denials. Now the ceiling drops to 'ask' instead, and what
 * can still be recognized from the fields present is kept.
 *
 * Never throws: every field is salvaged individually, anything unreadable
 * falls back to the DEFAULT_POLICY value for that field.
 */
function failClosedPolicy(parsed, reason) {
  const salvage = (value, validate) => {
    try {
      return validate(value);
    } catch {
      return null;
    }
  };
  const mode = VALID_MODES.includes(parsed?.mode) ? parsed.mode : DEFAULT_POLICY.mode;
  const rules = {
    requireTaskDoc:
      salvage(parsed?.rules?.requireTaskDoc, (v) => {
        if (typeof v !== 'boolean') throw new Error();
        return v;
      }) ?? DEFAULT_POLICY.rules.requireTaskDoc,
    requireCommitTask:
      salvage(parsed?.rules?.requireCommitTask, (v) => {
        if (typeof v !== 'boolean') throw new Error();
        return v;
      }) ?? DEFAULT_POLICY.rules.requireCommitTask,
  };
  // Hard denials "soweit erkennbar": keep every entry that still validates
  // on its own, drop the rest — a denial from a newer schema is a floor, and
  // keeping the recognizable ones is strictly safer than dropping them all.
  // validateHardDenials() takes the whole array, so each rule is probed in a
  // single-entry array.
  let hardDenials = [];
  if (Array.isArray(parsed?.hardDenials)) {
    hardDenials = parsed.hardDenials
      .map((rule) => {
        const kept = salvage([rule], validateHardDenials);
        return Array.isArray(kept) ? kept[0] : null;
      })
      .filter((rule) => rule !== null);
  }
  // Budget "soweit erkennbar": a salvageable defaultDailyUsd is kept — a
  // money ceiling from a newer schema is a floor the same way a denial is
  // (dropping it would LIFT the cap this binary could still honour).
  const budgetDefaultDailyUsd = salvage(parsed?.budget?.defaultDailyUsd, (v) => {
    if (v !== null && (typeof v !== 'number' || !Number.isFinite(v) || v < 0)) throw new Error();
    return v;
  });
  return {
    version: typeof parsed?.version === 'number' ? parsed.version : DEFAULT_POLICY.version,
    mode,
    rules,
    posture: 'ask',
    hardDenials,
    budget: { defaultDailyUsd: budgetDefaultDailyUsd ?? DEFAULT_POLICY.budget.defaultDailyUsd },
    reason,
  };
}

/**
 * Same as loadPolicy(), but never throws. TWO different fallbacks, by what
 * went wrong (P0.5):
 *
 *   - Missing file, unreadable file, invalid JSON: as before, DEFAULT_POLICY
 *     (fail-open to 'observe'/'auto') — an EMPTY file says nothing, so there
 *     is nothing newer to defer to.
 *   - A structurally readable document this binary does not fully understand
 *     (unknown field, unsupported version, invalid value): FAIL-CLOSED to
 *     `posture: 'ask'` (never 'auto'), keeping every hard denial still
 *     recognizable from the fields present. The validation error is logged
 *     to policy.log with the reason and carried in the `reason` field.
 */
export function loadPolicyFailOpen(dataDir) {
  try {
    return loadPolicy(dataDir);
  } catch (err) {
    if (!(err instanceof PolicyValidationError)) {
      return { ...clonePolicy(DEFAULT_POLICY), reason: `invalid policy.json, falling back to observe: ${err.message}` };
    }
    // Schema error on a readable document. Re-parse (loadPolicy threw only
    // AFTER a successful parse) and degrade fail-closed.
    let parsed = null;
    try {
      parsed = JSON.parse(fs.readFileSync(policyPathFor(dataDir), 'utf8').replace(/^﻿/, ''));
    } catch {
      // Cannot happen in practice (loadPolicy parsed it a moment ago); the
      // null case below still degrades safely.
    }
    const reason = `policy.json failed schema validation, loading fail-closed to posture 'ask': ${err.message}`;
    const policy = parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
      ? failClosedPolicy(parsed, reason)
      : { ...clonePolicy(DEFAULT_POLICY), posture: 'ask', reason };
    logPolicy(dataDir, { event: 'policy-load', outcome: 'fail-closed', reason });
    return policy;
  }
}

/**
 * A short, stable fingerprint of the loaded policy — what a receipt can
 * name as "the rules this was done under". Same input, same string.
 */
export function policyVersion(policy) {
  const canonical = JSON.stringify({
    version: policy?.version ?? null,
    mode: policy?.mode ?? null,
    rules: policy?.rules ?? null,
    posture: policy?.posture ?? null,
    hardDenials: policy?.hardDenials ?? [],
    // Part of the fingerprint since the budget section exists: a changed
    // cap is a changed set of rules, and a receipt must not be able to say
    // "done under $10/day" about a policy that capped $1/day. Always
    // included (null default), so the hash stays deterministic.
    budget: policy?.budget ?? { defaultDailyUsd: null },
  });
  return crypto.createHash('sha256').update(canonical).digest('hex').slice(0, 16);
}

/** Appends one JSONL line to <dataDir>/policy.log. Errors are swallowed — logging must never break the hook. */
function logPolicy(dataDir, entry) {
  try {
    fs.mkdirSync(dataDir, { recursive: true });
    const line = JSON.stringify({ ts: new Date().toISOString(), ...entry });
    fs.appendFileSync(path.join(dataDir, 'policy.log'), `${line}\n`, 'utf8');
  } catch {
    // ignore
  }
}

// Once-marker filenames are the sha256 of the session id rather than the
// raw id, so an unexpected session id shape (path separators, '..') can
// never turn into a path-traversal write under policy-state/.
function markerPathFor(dataDir, sessionId) {
  const hash = crypto.createHash('sha256').update(String(sessionId ?? '')).digest('hex');
  return path.join(dataDir, 'policy-state', hash);
}

function hasOnceMarker(dataDir, sessionId) {
  try {
    return fs.existsSync(markerPathFor(dataDir, sessionId));
  } catch {
    return false;
  }
}

function writeOnceMarker(dataDir, sessionId) {
  try {
    const markerPath = markerPathFor(dataDir, sessionId);
    fs.mkdirSync(path.dirname(markerPath), { recursive: true });
    fs.writeFileSync(markerPath, new Date().toISOString(), 'utf8');
  } catch {
    // ignore — worst case is a repeated block, never a hang or a crash
  }
}

/** A doc counts as empty once none of its fields have been filled in yet. */
function isDocEmpty(doc) {
  return !doc || typeof doc !== 'object' || Object.keys(doc).length === 0;
}

/** Finds the board task (if any) whose sessions[] includes this sessionId. Returns null on any error (fail-open). */
function findLinkedTask(dataDir, sessionId) {
  if (!sessionId) return null;
  try {
    const board = openBoard(dataDir);
    return board.list().find((task) => task.sessions.some((s) => s.sessionId === sessionId)) ?? null;
  } catch {
    return null;
  }
}

/**
 * True if a tool_use block on this transcript line ran a Bash command
 * containing 'git commit'. Scoped to name === 'Bash' with a string
 * `input.command` (mirrors src/parser/parse.mjs's own gitCommits counting)
 * — checking ANY tool_use's whole input (as JSON) would false-positive on
 * e.g. a Read of a file whose path or a Write's file content merely mentions
 * "git commit" without a commit ever actually running.
 */
function lineContainsGitCommitToolUse(rawLine) {
  let parsed;
  try {
    parsed = JSON.parse(rawLine);
  } catch {
    return false;
  }
  const content = parsed?.message?.content;
  if (!Array.isArray(content)) return false;
  for (const block of content) {
    if (block?.type !== 'tool_use' || block.name !== 'Bash') continue;
    if (typeof block.input?.command === 'string' && block.input.command.includes('git commit')) return true;
  }
  return false;
}

/**
 * Streams `transcriptPath` line by line (never a full read — transcripts can
 * be very large) looking for a tool_use Bash call containing 'git commit'.
 * Resolves false (never rejects) on a missing file, an unreadable file, or
 * any stream error — fail-open.
 */
async function transcriptContainsGitCommit(transcriptPath) {
  if (!transcriptPath || typeof transcriptPath !== 'string') return false;

  let stream;
  try {
    stream = fs.createReadStream(transcriptPath, { encoding: 'utf8' });
  } catch {
    return false;
  }

  try {
    const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
    for await (const line of rl) {
      if (line.trim().length === 0) continue;
      if (lineContainsGitCommitToolUse(line)) {
        rl.close();
        return true;
      }
    }
    return false;
  } catch {
    return false;
  } finally {
    stream.destroy();
  }
}

/**
 * Evaluates a Claude Code Stop event against `<dataDir>/policy.json`.
 * Returns `{decision: 'allow'|'warn'|'block', reasons: string[]}` and NEVER
 * throws — every internal failure (bad policy, unreadable transcript,
 * broken board) resolves to `{decision: 'allow', reasons: []}`.
 *
 * requireCommitTask (blocking, subject to policy.mode) fires when the
 * transcript shows a `git commit` but no board task lists this session.
 * requireTaskDoc (warn-only, never escalates to 'block' by itself) fires
 * when the linked task is in_progress with an empty doc.
 *
 * 'observe' mode is log-only, NOT skip-evaluation: both rules are still
 * checked and any violation still lands in `reasons` and in policy.log, so
 * `kaprek hooks status`/policy.log are actually useful for seeing what
 * would happen before switching to 'warn'/'block' — but the returned
 * `decision` is always forced back to 'allow' for this mode.
 *
 * A session that already produced one 'block' decision gets a once-marker
 * under `<dataDir>/policy-state/`; every following call for that session
 * short-circuits to 'allow' so the hook can never block the same session
 * more than once.
 */
export async function evaluateStop({ dataDir, transcriptPath, sessionId }) {
  try {
    const policy = loadPolicyFailOpen(dataDir);

    if (hasOnceMarker(dataDir, sessionId)) {
      return { decision: 'allow', reasons: [] };
    }

    const sawCommit = await transcriptContainsGitCommit(transcriptPath);
    const linkedTask = findLinkedTask(dataDir, sessionId);

    const blockingReasons = [];
    const warnReasons = [];

    if (policy.rules.requireCommitTask && sawCommit && !linkedTask) {
      blockingReasons.push('a git commit was made in this session, but no board task lists this session');
    }
    if (
      policy.rules.requireTaskDoc &&
      linkedTask &&
      linkedTask.status === 'in_progress' &&
      isDocEmpty(linkedTask.doc)
    ) {
      warnReasons.push(`linked task "${linkedTask.title}" is in_progress but its completion doc is still empty`);
    }

    let decision = 'allow';
    if (policy.mode !== 'observe') {
      if (blockingReasons.length > 0) {
        decision = policy.mode; // 'warn' or 'block'
      } else if (warnReasons.length > 0) {
        decision = 'warn'; // requireTaskDoc is a hint only, it never blocks by itself
      }
    }

    const reasons = [...blockingReasons, ...warnReasons];

    if (decision === 'block') {
      writeOnceMarker(dataDir, sessionId);
    }

    logPolicy(dataDir, { sessionId, decision, reasons, mode: policy.mode });

    return { decision, reasons };
  } catch {
    return { decision: 'allow', reasons: [] };
  }
}
