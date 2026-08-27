// Subscription windows, as the CLIs report them.
//
// kaprek runs on subscription CLIs, and a subscription is a window: so
// much until it resets. Both engines say where they stand — Claude Code
// as a `rate_limit_event`, codex as `account/rateLimits/updated` — and
// run.mjs has logged the last such signal of every turn into runs.jsonl
// since M1. Nothing showed it. This reads it back: the latest signal per
// harness, with the few fields a person actually wants (how full, when it
// resets, which window) pulled out of whatever shape the CLI used, and
// the raw object kept alongside because the shapes are theirs, not ours.
//
// Read-only over runs.jsonl. No polling, no extra call to any vendor: a
// window kaprek has not seen since the last turn is reported with the time
// it was seen, which is the honest form of "as of".
import { readRuns } from './runs.mjs';

/** How far back to look. A signal older than this is a memory, not a status. */
const MAX_RUNS = 500;

function asNumber(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/** An epoch (seconds or milliseconds) or an ISO string, as ISO — or null. */
function asIso(value) {
  if (typeof value === 'string' && !Number.isNaN(Date.parse(value))) return new Date(value).toISOString();
  const n = asNumber(value);
  if (n === null || n <= 0) return null;
  // Seconds until roughly the year 2286; milliseconds after that.
  return new Date(n < 1e11 ? n * 1000 : n).toISOString();
}

/** A percentage 0–100 from a ratio (0–1) or a percentage, whichever the CLI sent. */
function asPercent(value) {
  const n = asNumber(value);
  if (n === null || n < 0) return null;
  return Math.round(n <= 1 ? n * 100 : n);
}

/**
 * The few fields worth a badge, from either CLI's shape. Unknown shapes
 * yield nulls, never a throw — the raw object rides along regardless.
 *
 * Claude Code (`rate_limit_info`): status, resetsAt, rateLimitType,
 * utilization. codex (`rateLimits`): planType, primary/secondary windows
 * with usedPercent, windowDurationMins, resetsAt/resetsInSeconds.
 */
export function summarizeRateLimit(info, { now = Date.now } = {}) {
  if (!info || typeof info !== 'object') return { usedPercent: null, resetsAt: null, window: null, status: null, plan: null };
  // codex: the window that is fuller is the one that binds.
  const windows = ['primary', 'secondary'].map((key) => info[key]).filter((w) => w && typeof w === 'object');
  if (windows.length > 0) {
    const binding = windows.reduce((a, b) => ((asPercent(b.usedPercent) ?? -1) > (asPercent(a.usedPercent) ?? -1) ? b : a));
    const resetsAt = asIso(binding.resetsAt) ?? (asNumber(binding.resetsInSeconds) !== null ? new Date(now() + binding.resetsInSeconds * 1000).toISOString() : null);
    const mins = asNumber(binding.windowDurationMins);
    return {
      usedPercent: asPercent(binding.usedPercent),
      resetsAt,
      window: mins !== null ? (mins % 60 === 0 ? `${mins / 60}h` : `${mins}m`) : null,
      status: null,
      plan: typeof info.planType === 'string' ? info.planType : null,
    };
  }
  return {
    usedPercent: asPercent(info.utilization ?? info.usedPercent ?? info.used_percent),
    resetsAt: asIso(info.resetsAt ?? info.resets_at),
    window: typeof info.rateLimitType === 'string' ? info.rateLimitType : typeof info.rate_limit_type === 'string' ? info.rate_limit_type : null,
    status: typeof info.status === 'string' ? info.status : null,
    plan: null,
  };
}

/**
 * The latest rate-limit signal per harness, newest first.
 *
 * @returns {Array<{harness: string, seenAt: string, chatId: string|null, summary: object, info: object}>}
 */
export function latestRateLimits(dataDir, { now = Date.now } = {}) {
  let runs;
  try {
    runs = readRuns(dataDir, { limit: MAX_RUNS });
  } catch {
    return [];
  }
  const byHarness = new Map();
  for (const run of runs) {
    if (!run?.rateLimit || typeof run.rateLimit !== 'object') continue;
    const harness = typeof run.harness === 'string' && run.harness !== '' ? run.harness : 'unknown';
    const prev = byHarness.get(harness);
    if (prev && prev.seenAt >= (run.ts ?? '')) continue;
    byHarness.set(harness, { harness, seenAt: run.ts ?? null, chatId: run.chatId ?? null, summary: summarizeRateLimit(run.rateLimit, { now }), info: run.rateLimit });
  }
  return [...byHarness.values()].sort((a, b) => (a.seenAt < b.seenAt ? 1 : -1));
}
