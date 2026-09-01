// skip-if preconditions for tick-driven triggers (see DESIGN-SPEC.md, P7).
//
// A schedule/heartbeat trigger may carry one condition; the runner checks it
// AFTER the window claim and BEFORE buildPrompt(), so a condition that is
// merely false skips the turn without spending it, and a condition that
// cannot even be EVALUATED is loud (see runner.mjs — 'condition-error', a
// notification, and a degraded counter) instead of silently disabling the
// trigger.
//
// Two kinds, deliberately no more:
//   - 'file-exists': the path must exist (a file or directory).
//   - 'file-newer-than-last-run': the path's mtime must be newer than the
//     startedAt of the trigger's OWN last run in runs.jsonl — no parallel
//     state file, the run log is already the source of truth (same reasoning
//     as src/triggers/limits.mjs).
//
// `command` is deliberately absent. A probe execution at save time makes the
// save button an exec surface, killing a child process cleanly needs Job
// Object / process-group semantics, and the inherited env/PATH is unchecked
// authority — it comes back as its own package if a use case appears that
// the two file conditions do not cover (DESIGN-SPEC.md, Änderung 4).
import fs from 'node:fs';
import path from 'node:path';
import { isInside } from '../lib/contain.mjs';

export const CONDITION_KINDS = ['file-exists', 'file-newer-than-last-run'];

/** Consecutive condition errors after which a trigger reports `degraded` (see conditionErrorStreak()). */
export const DEGRADED_STREAK_THRESHOLD = 5;

/** Ceiling for a stored condition path. A path is config, not a document. */
export const MAX_CONDITION_PATH_LENGTH = 1024;

/**
 * Resolves a condition path ABSOLUTELY. A relative path is resolved against
 * the mission cwd when there is one, otherwise against `<dataDir>/workspace`
 * — the same directory a trigger turn's harness runs in (see server.mjs's
 * workspaceDir). An absolute path is kept as given; containment is judged at
 * evaluation time against the allowed roots, so an absolute path pointing
 * outside never becomes a working condition.
 */
export function resolveConditionPath(rawPath, { cwd = null, dataDir = null } = {}) {
  if (path.isAbsolute(rawPath)) return path.resolve(rawPath);
  // No base known (a registry built without one) leaves the path as-is,
  // resolved against this process's cwd at most — evaluation re-resolves
  // against the real base anyway.
  const base = cwd && fs.existsSync(cwd) ? cwd : dataDir ? path.join(dataDir, 'workspace') : process.cwd();
  return path.resolve(base, rawPath);
}

/** The roots a condition path may live in: the trigger turn's own cwd and the dedicated workspace. */
function allowedRoots({ cwd = null, dataDir }) {
  const roots = [cwd, path.join(dataDir, 'workspace')].filter((root) => typeof root === 'string' && root.length > 0);
  return [...new Set(roots)];
}

/**
 * Evaluates one condition.
 *
 * @returns {{met: boolean, error: string|null, resolvedPath: string}}
 *   - `met: true`  — the condition holds, the turn may run.
 *   - `met: false` — the condition is simply FALSE: the run is skipped as
 *     `skipped: 'condition'` (no turn, no cost, no notification). A missing
 *     path is an ANSWER here, not a failure — "the file is not there" is
 *     exactly what file-exists asks.
 *   - `error`      — the condition could not be JUDGED: the resolved path
 *     leaves the allowed roots (including via a symlink, judged by
 *     src/lib/contain.mjs's realpath containment) or the stat failed with
 *     something other than "not there". Fail-closed AND loud: the runner
 *     records `skipped: 'condition-error'` and notifies (see runner.mjs).
 */
export function evaluateCondition({ kind, path: rawPath, cwd = null, dataDir, lastRunStartedAt = null }) {
  const roots = allowedRoots({ cwd, dataDir });
  const resolvedPath = resolveConditionPath(rawPath, { cwd, dataDir });

  // realpath containment, not a string comparison — a symlink inside the
  // root pointing OUTSIDE it resolves to its target here and is rejected.
  if (!roots.some((root) => isInside(root, resolvedPath))) {
    return { met: false, error: `condition path is outside the allowed roots: ${resolvedPath}`, resolvedPath };
  }

  let stat;
  try {
    stat = fs.statSync(resolvedPath);
  } catch (err) {
    if (err?.code === 'ENOENT' || err?.code === 'ENOTDIR') {
      // "Nothing there" is a definite answer for both kinds.
      return { met: false, error: null, resolvedPath };
    }
    return { met: false, error: `stat failed: ${err?.message ?? String(err)}`, resolvedPath };
  }

  if (kind === 'file-exists') return { met: true, error: null, resolvedPath };

  // file-newer-than-last-run. No previous run means nothing to be newer
  // than — the first run of a trigger is never skipped by this condition.
  if (lastRunStartedAt === null || !Number.isFinite(lastRunStartedAt)) return { met: true, error: null, resolvedPath };
  return { met: stat.mtimeMs > lastRunStartedAt, error: null, resolvedPath };
}

/**
 * How many of a trigger's most recent runs.jsonl entries are condition
 * errors — counted from the LOG, not from a parallel counter, so it survives
 * a restart and can never drift from what actually happened (same reasoning
 * as limits.mjs). The streak walks backwards over this trigger's entries:
 *   - `skipped: 'condition-error'` (the default skip-on-error path) and a
 *     real run carrying `conditionError` (the `onConditionError: 'run'`
 *     exception) both COUNT;
 *   - a normal run (turned, no conditionError) and a plain
 *     `skipped: 'condition'` (the condition was merely false) both STOP the
 *     streak — a false condition is the feature working, not a fault.
 * Entries of OTHER triggers are ignored, not streak-breaking.
 */
export function conditionErrorStreak(runs, triggerId) {
  let streak = 0;
  for (let i = runs.length - 1; i >= 0; i -= 1) {
    const run = runs[i];
    if (run.triggerId !== triggerId) continue;
    if (run.skipped === 'condition-error' || (run.skipped === null && typeof run.conditionError === 'string')) {
      streak += 1;
      continue;
    }
    break;
  }
  return streak;
}
