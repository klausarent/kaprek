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

const VALID_MODES = ['observe', 'warn', 'block'];
const KNOWN_TOP_FIELDS = ['version', 'mode', 'rules'];
const KNOWN_RULE_FIELDS = ['requireTaskDoc', 'requireCommitTask'];

export const DEFAULT_POLICY = Object.freeze({
  version: 1,
  mode: 'observe',
  rules: Object.freeze({ requireTaskDoc: true, requireCommitTask: true }),
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
  };
}

/** Same as loadPolicy(), but never throws — a schema error also falls back to observe. */
function loadPolicyFailOpen(dataDir) {
  try {
    return loadPolicy(dataDir);
  } catch (err) {
    return { ...clonePolicy(DEFAULT_POLICY), reason: `invalid policy.json, falling back to observe: ${err.message}` };
  }
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

/** True if a tool_use block on this transcript line ran a Bash command containing 'git commit'. */
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
    if (block?.type !== 'tool_use') continue;
    const command = typeof block.input?.command === 'string' ? block.input.command : JSON.stringify(block.input ?? '');
    if (command.includes('git commit')) return true;
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
 * A session that already produced one 'block' decision gets a once-marker
 * under `<dataDir>/policy-state/`; every following call for that session
 * short-circuits to 'allow' so the hook can never block the same session
 * more than once.
 */
export async function evaluateStop({ dataDir, transcriptPath, sessionId }) {
  try {
    const policy = loadPolicyFailOpen(dataDir);

    if (policy.mode === 'observe') {
      logPolicy(dataDir, { sessionId, decision: 'allow', reasons: [], mode: policy.mode });
      return { decision: 'allow', reasons: [] };
    }

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
    if (blockingReasons.length > 0) {
      decision = policy.mode; // 'warn' or 'block' — 'observe' already returned above
    } else if (warnReasons.length > 0) {
      decision = 'warn'; // requireTaskDoc is a hint only, it never blocks by itself
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
