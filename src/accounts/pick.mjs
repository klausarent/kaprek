// Which account the next session starts on.
//
// Klaus' rule of thumb was "switch before 99 %, or the workers die". So an
// account is eligible while its 5-hour window is under `fiveHour` and its
// 7-day window under `sevenDay`; among those the least loaded wins. A window
// whose reset time has passed counts as empty — a snapshot from before the
// reset says nothing about now. On equal load the one seen longest ago wins,
// which spreads sessions instead of pinning them to the first entry.
//
// An account nobody has measured yet is not an empty one: on 19.10.2026 the
// watcher had never run on konto1, picked it first, and it was at 100 % of
// its week from the laptop's sessions. Unmeasured accounts therefore come
// after every measured one with room, and before one over the thresholds
// (an unknown account that turns out full fails in seconds and is filed as
// full; one at 93 % dies halfway through a run).
//
// Over the thresholds but under `full` still runs, flagged; only when every
// account is full is there nothing to start, with the earliest time one frees.
//
// Readings older than `staleMs` are flagged `stale` so `--probe` can measure
// them again (src/harness/probe-account.mjs); the pick itself does not distrust
// them, because an account only kaprek uses stays accurate for hours.
//
// A reading with status 'rejected' (Claude refused the account, often filed by
// `kaprek accounts exec` when a run died on the limit, without fresh windows)
// counts as full until it goes stale; then a probe finds out how it stands.

const ALIASES = { '5h': 'fiveHour', five_hour: 'fiveHour', '7d': 'sevenDay', seven_day: 'sevenDay' };

// An auth error keeps the account out for this long, then it gets one more
// try: a renewed setup-token in ~/.env has to bring it back without anyone
// deleting quota files, and if it still fails it is marked again.
export const AUTH_HOLD_MS = 2 * 60 * 60 * 1000;
export const DEFAULT_STALE_MS = 30 * 60 * 1000;

function effective(window, now) {
  if (!window || typeof window.usedPercent !== 'number') return null;
  const reset = Date.parse(window.resetsAt ?? '');
  if (Number.isFinite(reset) && reset <= now) return 0;
  return window.usedPercent;
}

/** The two plan windows of one snapshot, as they stand at `now`. */
export function accountLoad(snapshot, now = Date.now()) {
  const out = { fiveHour: null, sevenDay: null };
  for (const [name, w] of Object.entries(snapshot?.windows ?? {})) {
    const key = ALIASES[name];
    if (key) out[key] = effective(w, now);
  }
  return out;
}

function resetOf(snapshot, key) {
  for (const [name, w] of Object.entries(snapshot?.windows ?? {})) if (ALIASES[name] === key) return Date.parse(w?.resetsAt ?? '');
  return NaN;
}

/**
 * @param {{accounts: {id:string,label:string,tokenEnv:string|null}[], usable: Set<string>, quotas: Map<string, object>, thresholds: {fiveHour:number, sevenDay:number, full:number}, now?: number, staleMs?: number}} input
 */
export function pickAccount({ accounts, usable, quotas, thresholds, now = Date.now(), staleMs = DEFAULT_STALE_MS }) {
  const rows = accounts
    .map((account, order) => {
      const snap = quotas.get(account.id) ?? null;
      const load = accountLoad(snap, now);
      const f = load.fiveHour ?? 0;
      const s = load.sevenDay ?? 0;
      const seen = Date.parse(snap?.seenAt ?? '');
      const seenAt = Number.isFinite(seen) ? seen : -Infinity;
      const measured = load.fiveHour !== null || load.sevenDay !== null;
      // Last answer was an auth error (expired or revoked setup-token): out for AUTH_HOLD_MS.
      const authHeld = Boolean(snap?.authError) && (!Number.isFinite(seen) || now - seen < AUTH_HOLD_MS);
      const rejected = snap?.status === 'rejected' && Number.isFinite(seen) && now - seen <= staleMs;
      return {
        account,
        order,
        load,
        score: Math.max(f, s),
        seenAt,
        measured,
        stale: !measured || now - seenAt > staleMs,
        usable: usable.has(account.id) && !authHeld,
        eligible: !rejected && f < thresholds.fiveHour && s < thresholds.sevenDay,
        full: rejected || f >= thresholds.full || s >= thresholds.full,
        fullUntil: Math.max(
          f >= thresholds.full ? resetOf(snap, 'fiveHour') : -Infinity,
          s >= thresholds.full ? resetOf(snap, 'sevenDay') : -Infinity,
          rejected ? seen + staleMs : -Infinity,
        ),
      };
    })
    .filter((r) => r.usable);

  if (rows.length === 0) return { account: null, exhausted: false, reason: 'no-credential', rows };
  const byLoad = (a, b) => a.score - b.score || a.seenAt - b.seenAt || a.order - b.order;

  const eligible = rows.filter((r) => r.measured && r.eligible).sort(byLoad);
  if (eligible.length) return { account: eligible[0].account, exhausted: false, overThreshold: false, load: eligible[0].load, rows };

  // A fresh rejection without windows is no unknown: it is full.
  const unmeasured = rows.filter((r) => !r.measured && !r.full).sort(byLoad);
  if (unmeasured.length) return { account: unmeasured[0].account, exhausted: false, overThreshold: false, unmeasured: true, load: unmeasured[0].load, rows };

  const notFull = rows.filter((r) => !r.full).sort(byLoad);
  if (notFull.length) return { account: notFull[0].account, exhausted: false, overThreshold: true, load: notFull[0].load, rows };

  const frees = rows.map((r) => r.fullUntil).filter(Number.isFinite);
  return { account: null, exhausted: true, reason: 'all-full', retryAt: frees.length ? new Date(Math.min(...frees)).toISOString() : null, rows };
}
