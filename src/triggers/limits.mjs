// Trigger limits — enforces a trigger's daily run/cost cap by counting its
// own lines in runs.jsonl (see src/orchestrator/runs.mjs), the same log
// every chat turn already writes to. No separate counter/state file: the run
// log is already the source of truth for what actually ran, so deriving the
// cap check from it can never drift out of sync with reality the way a
// parallel counter could (e.g. after a crash mid-turn).
import { readRuns } from '../orchestrator/runs.mjs';

/** Midnight (local time) of the calendar day containing `now`, as epoch ms. */
function startOfLocalDay(now) {
  const d = new Date(now);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

/**
 * `checkLimits({dataDir, trigger, now})` -> `{allowed, reason?, runsToday, costToday}`.
 *
 * Counts every runs.jsonl line with `triggerId === trigger.id` whose `ts`
 * falls in the LOCAL calendar day containing `now` (defaults to real
 * Date.now(), injectable for tests). A run with `costUsd: null` (a harness
 * that doesn't always report cost) still counts toward `maxRunsPerDay` —
 * only `costToday` treats it as 0 — otherwise a harness that simply omits
 * cost data would make the cost cap meaningless (SECURITY: fail-closed,
 * per the task brief).
 */
export function checkLimits({ dataDir, trigger, now = Date.now() }) {
  const dayStart = startOfLocalDay(now);
  const dayEndExclusive = dayStart + 24 * 60 * 60 * 1000;

  const todaysRuns = readRuns(dataDir).filter((run) => {
    if (run.triggerId !== trigger.id) return false;
    const ts = Date.parse(run.ts);
    return Number.isFinite(ts) && ts >= dayStart && ts < dayEndExclusive;
  });

  const runsToday = todaysRuns.length;
  const costToday = todaysRuns.reduce((sum, run) => sum + (typeof run.costUsd === 'number' ? run.costUsd : 0), 0);

  if (runsToday >= trigger.limits.maxRunsPerDay) {
    return { allowed: false, reason: `daily run limit reached (${runsToday}/${trigger.limits.maxRunsPerDay})`, runsToday, costToday };
  }
  if (costToday >= trigger.limits.maxCostPerDay) {
    return { allowed: false, reason: `daily cost limit reached ($${costToday.toFixed(4)}/$${trigger.limits.maxCostPerDay})`, runsToday, costToday };
  }
  return { allowed: true, runsToday, costToday };
}
