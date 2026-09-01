// kaprek doctor — the orchestrator. Runs the read-only checks (checks.mjs),
// and — only with `fix: true` — applies EXACTLY TWO effects, listed before
// they happen:
//   (a) delete orphaned context state files (the same sweepOldContextState()
//       the hook slow path calls, same 7-day condition),
//   (b) trigger a search index rebuild (the existing buildSearchIndex()
//       path) — only when the index on disk is NOT from a newer kaprek;
//       a higher schema version is never rebuilt, never deleted.
// Nothing else is touched. Hooks are NOT fixed in this version. The result
// is a report: { checks: [...], fix, summary } — the CLI owns all printing,
// and the exit code is always 0 (doctor is a report, not a gate).
import { sweepOldContextState } from '../policy/prompt-context-state.mjs';
import { buildSearchIndex, SCHEMA_VERSION } from '../search/index.mjs';
import {
  checkTranscriptDrift,
  checkHooks,
  checkSearchIndex,
  checkPolicy,
  checkPresets,
  checkLedger,
  checkContextState,
  checkGrants,
  checkTriggersDegraded,
  staleContextStateFiles,
  readSearchSchemaVersion,
} from './checks.mjs';

/**
 * Runs every check, optionally applying the two --fix effects first.
 * Returns { checks, fix, summary } — `fix` is { applied: [], skipped: [] }
 * (both empty without `fix`), `summary` counts statuses.
 */
export async function runDoctor({ dataDir, rootDir, settingsPath, fix = false } = {}) {
  // The fix plan is computed BEFORE anything changes, and printed/reported
  // as what WAS done — a fix that lists itself after the fact is a fix
  // nobody can check against what they were told.
  const fixResult = { applied: [], skipped: [] };
  if (fix) {
    // (a) orphaned context state files — listed, then swept with the
    // existing sweep (identical condition: mtime older than 7 days).
    const staleFiles = staleContextStateFiles(dataDir);
    if (staleFiles.length > 0) {
      sweepOldContextState(dataDir);
      fixResult.applied.push(`Deleted ${staleFiles.length} orphaned context state file(s) older than 7 days: ${staleFiles.map((f) => f.split(/[\\/]/).pop()).join(', ')}`);
    } else {
      fixResult.applied.push('No orphaned context state files to delete — nothing swept.');
    }

    // (b) search index rebuild — triggered through the existing reindex
    // path, ONLY at a lower or equal schema version, never a higher one.
    const version = await readSearchSchemaVersion(dataDir);
    if (version === null) {
      fixResult.skipped.push('No search index exists (or its schema is unreadable) — nothing to rebuild.');
    } else if (version > SCHEMA_VERSION) {
      fixResult.skipped.push(`Search index schema ${version} is NEWER than this kaprek writes (${SCHEMA_VERSION}) — never rebuilt, never deleted. Use the newer kaprek version, or delete search.db by hand.`);
    } else {
      const result = await buildSearchIndex({ rootDir, dataDir });
      fixResult.applied.push(`Search index rebuild triggered (schema ${version}): ${result.indexed} indexed, ${result.skipped} unchanged${result.removed ? `, ${result.removed} orphans removed` : ''}.`);
    }
  }

  const checks = [];
  for (const result of await Promise.all([
    checkTranscriptDrift({ rootDir }),
    Promise.resolve(checkHooks({ dataDir, settingsPath })),
    checkSearchIndex({ dataDir }),
    Promise.resolve(checkPolicy({ dataDir })),
    Promise.resolve(checkPresets({ dataDir })),
    Promise.resolve(checkLedger({ dataDir })),
    Promise.resolve(checkContextState({ dataDir })),
    Promise.resolve(checkGrants({ dataDir })),
    checkTriggersDegraded({ dataDir }),
  ])) {
    checks.push(result);
  }

  const summary = {
    total: checks.length,
    ok: checks.filter((c) => c.status === 'ok').length,
    warn: checks.filter((c) => c.status === 'warn').length,
    fail: checks.filter((c) => c.status === 'fail').length,
  };
  return { checks, fix: fixResult, summary };
}
