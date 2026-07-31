// Trigger limits — enforces a trigger's daily run/cost cap by counting its
// own lines in runs.jsonl (see src/orchestrator/runs.mjs), the same log
// every chat turn already writes to. No separate counter/state file: the run
// log is already the source of truth for what actually ran, so deriving the
// cap check from it can never drift out of sync with reality the way a
// parallel counter could (e.g. after a crash mid-turn).
import { readRuns } from '../orchestrator/runs.mjs';

/**
 * What one run of UNKNOWN cost is assumed to have cost. A harness that does
 * not report `costUsd` used to contribute $0 to the daily total, which made
 * the cost cap meaningless for exactly the harnesses whose cost we cannot
 * see (adversarial review Tag 3, both peers). Counting an unknown as zero is
 * the one answer that is certainly wrong; this is an ESTIMATE and nothing
 * more — a stand-in used only when the trigger has no cost history of its own
 * to estimate from (see estimatedUnitCost()). Roughly the order of magnitude
 * of a short Sonnet turn in mid-2026; it is deliberately not $0 and not so
 * large that one unknown run exhausts a default $1 cap.
 */
export const UNKNOWN_COST_ESTIMATE_USD = 0.25;

// Global ceilings across ALL triggers together, counted from runs.jsonl's
// `origin === 'trigger'` lines. Per-trigger caps cannot bound a CHAIN: trigger
// A writes a file trigger B watches, B writes back, and every single trigger
// stays inside its own limit while the pair runs all night (adversarial review
// Tag 3: Grok P0 part 2, Codex F3). Provenance marking of trigger-caused
// writes is the real fix and is scheduled separately; until then this is the
// hard brake that makes such a chain finite.
export const MAX_TRIGGER_TURNS_PER_HOUR = 20;
export const MAX_TRIGGER_TURNS_PER_DAY = 100;

/**
 * How many trigger turns may be IN FLIGHT at once, across all triggers.
 *
 * The caps above count finished turns; this one bounds the live ones. It
 * became necessary with the approval inbox: a tick starts every due trigger at
 * once, and each one that raises a question now parks for up to its unattended
 * deadline (hours), holding a `claude` subprocess the whole time. Ten triggers
 * coming due at 3am used to mean ten short turns; it can now mean ten parked
 * processes until morning.
 *
 * Three is deliberately small. A turn that is merely working finishes and
 * frees its slot in minutes; a turn that is parked on a question is waiting
 * for a person, and queueing the rest behind it is the honest response to
 * "nobody has answered the first three yet".
 */
export const MAX_CONCURRENT_TRIGGER_TURNS = 3;

const HOUR_MS = 60 * 60 * 1000;

/** Midnight (local time) of the calendar day containing `now`, as epoch ms. */
function startOfLocalDay(now) {
  const d = new Date(now);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

/** The median of a numeric array (mean of the two middle values for an even count), or null for an empty one. */
function median(values) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/**
 * What to charge for a run whose `costUsd` is null: the median of everything
 * this SAME trigger ever cost when the harness did report a number, or
 * UNKNOWN_COST_ESTIMATE_USD if it never did. The whole log is used, not just
 * today's window — a trigger's turns are the same prompt against the same
 * harness day after day, so yesterday's numbers are the best available
 * predictor of today's, and today alone is often empty at exactly the moment
 * the estimate is needed.
 */
function estimatedUnitCost(runsForTrigger) {
  const known = runsForTrigger.map((run) => run.costUsd).filter((cost) => typeof cost === 'number' && Number.isFinite(cost) && cost >= 0);
  return median(known) ?? UNKNOWN_COST_ESTIMATE_USD;
}

/**
 * `checkLimits({dataDir, trigger, now})` -> `{allowed, reason?, runsToday,
 * costToday, costEstimated}`.
 *
 * Counts every runs.jsonl line with `triggerId === trigger.id` whose `ts`
 * falls in the LOCAL calendar day containing `now` (defaults to real
 * Date.now(), injectable for tests). A run with `costUsd: null` (a harness
 * that doesn't always report cost) counts toward `maxRunsPerDay` AND toward
 * `costToday`, with an estimate rather than a zero — see estimatedUnitCost().
 * `costEstimated` says whether any of today's total came from that estimate,
 * so a caller can show "$0.75 (estimated)" instead of implying a measurement.
 */
export function checkLimits({ dataDir, trigger, now = Date.now(), inFlightRuns = 0 }) {
  const dayStart = startOfLocalDay(now);
  const dayEndExclusive = dayStart + 24 * 60 * 60 * 1000;

  const runsForTrigger = readRuns(dataDir).filter((run) => run.triggerId === trigger.id);
  const todaysRuns = runsForTrigger.filter((run) => {
    const ts = Date.parse(run.ts);
    return Number.isFinite(ts) && ts >= dayStart && ts < dayEndExclusive;
  });

  // A turn that is still running has written no runs.jsonl line yet, so
  // without this it is invisible to every cap it will eventually count
  // against. With the approval inbox a turn can be in flight for HOURS, which
  // turns "invisible for a few minutes" into "a trigger can start its second
  // and third run while the first is still parked on a question" (Grok #1).
  // Counted as a run but at zero cost: the run slot is certain, the cost is
  // not known until the turn ends, and inventing one would be a different lie.
  const runsToday = todaysRuns.length + inFlightRuns;
  const unitCost = estimatedUnitCost(runsForTrigger);
  let costEstimated = false;
  const costToday = todaysRuns.reduce((sum, run) => {
    if (typeof run.costUsd === 'number' && Number.isFinite(run.costUsd)) return sum + run.costUsd;
    costEstimated = true;
    return sum + unitCost;
  }, 0);

  if (runsToday >= trigger.limits.maxRunsPerDay) {
    return { allowed: false, reason: `daily run limit reached (${runsToday}/${trigger.limits.maxRunsPerDay})`, runsToday, costToday, costEstimated };
  }
  if (costToday >= trigger.limits.maxCostPerDay) {
    const estimateNote = costEstimated ? ', partly estimated' : '';
    return {
      allowed: false,
      reason: `daily cost limit reached ($${costToday.toFixed(4)}/$${trigger.limits.maxCostPerDay}${estimateNote})`,
      runsToday,
      costToday,
      costEstimated,
    };
  }
  return { allowed: true, runsToday, costToday, costEstimated };
}

/**
 * `checkGlobalTriggerLimits({dataDir, now})` -> `{allowed, reason?,
 * turnsLastHour, turnsToday}` — the ceiling across ALL triggers together (see
 * MAX_TRIGGER_TURNS_PER_HOUR/_PER_DAY above for why it exists).
 *
 * Counted from the same runs.jsonl every other limit is derived from, over
 * `origin === 'trigger'` lines only: a user's own chat turns are never
 * throttled by this. A line without `origin` predates the field and is a user
 * turn by definition (see runs.mjs), so it does not count either.
 */
export function checkGlobalTriggerLimits({ dataDir, now = Date.now(), inFlightRuns = 0 }) {
  const dayStart = startOfLocalDay(now);
  const dayEndExclusive = dayStart + 24 * HOUR_MS;
  const hourStart = now - HOUR_MS;

  // In-flight turns count against both windows, for the reason in
  // checkLimits() above: they have not been logged yet, and with the inbox
  // they can stay unlogged for hours.
  let turnsLastHour = inFlightRuns;
  let turnsToday = inFlightRuns;
  for (const run of readRuns(dataDir)) {
    if (run.origin !== 'trigger') continue;
    const ts = Date.parse(run.ts);
    if (!Number.isFinite(ts)) continue;
    if (ts >= hourStart) turnsLastHour += 1;
    if (ts >= dayStart && ts < dayEndExclusive) turnsToday += 1;
  }

  if (turnsLastHour >= MAX_TRIGGER_TURNS_PER_HOUR) {
    return {
      allowed: false,
      reason: `global trigger cap reached (${turnsLastHour}/${MAX_TRIGGER_TURNS_PER_HOUR} trigger turns in the last hour, all triggers together)`,
      turnsLastHour,
      turnsToday,
    };
  }
  if (turnsToday >= MAX_TRIGGER_TURNS_PER_DAY) {
    return {
      allowed: false,
      reason: `global trigger cap reached (${turnsToday}/${MAX_TRIGGER_TURNS_PER_DAY} trigger turns today, all triggers together)`,
      turnsLastHour,
      turnsToday,
    };
  }
  return { allowed: true, turnsLastHour, turnsToday };
}
