// Which account the next session starts on.
//
// Klaus' rule of thumb was "switch before 99 %, or the workers die". So an
// account is eligible while its 5-hour window is under `fiveHour` and its
// 7-day window under `sevenDay`; among those the least loaded wins. A window
// whose reset time has passed counts as empty — a snapshot from before the
// reset says nothing about now. Accounts nobody has measured yet go first
// (so they get measured), and on equal load the one seen longest ago wins,
// which spreads sessions instead of pinning them to the first entry.
//
// Over the thresholds but under `full` still runs, flagged; only when every
// account is full is there nothing to start, with the earliest time one frees.

const ALIASES = { '5h': 'fiveHour', five_hour: 'fiveHour', '7d': 'sevenDay', seven_day: 'sevenDay' };

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
 * @param {{accounts: {id:string,label:string,tokenEnv:string|null}[], usable: Set<string>, quotas: Map<string, object>, thresholds: {fiveHour:number, sevenDay:number, full:number}, now?: number}} input
 */
export function pickAccount({ accounts, usable, quotas, thresholds, now = Date.now() }) {
  const rows = accounts
    .map((account, order) => {
      const snap = quotas.get(account.id) ?? null;
      const load = accountLoad(snap, now);
      const f = load.fiveHour ?? 0;
      const s = load.sevenDay ?? 0;
      const seen = Date.parse(snap?.seenAt ?? '');
      return {
        account,
        order,
        load,
        score: Math.max(f, s),
        seenAt: Number.isFinite(seen) ? seen : -Infinity,
        usable: usable.has(account.id),
        eligible: f < thresholds.fiveHour && s < thresholds.sevenDay,
        full: f >= thresholds.full || s >= thresholds.full,
        fullUntil: Math.max(f >= thresholds.full ? resetOf(snap, 'fiveHour') : -Infinity, s >= thresholds.full ? resetOf(snap, 'sevenDay') : -Infinity),
      };
    })
    .filter((r) => r.usable);

  if (rows.length === 0) return { account: null, exhausted: false, reason: 'no-credential', rows };
  const byLoad = (a, b) => a.score - b.score || a.seenAt - b.seenAt || a.order - b.order;

  const eligible = rows.filter((r) => r.eligible).sort(byLoad);
  if (eligible.length) return { account: eligible[0].account, exhausted: false, overThreshold: false, load: eligible[0].load, rows };

  const notFull = rows.filter((r) => !r.full).sort(byLoad);
  if (notFull.length) return { account: notFull[0].account, exhausted: false, overThreshold: true, load: notFull[0].load, rows };

  const frees = rows.map((r) => r.fullUntil).filter(Number.isFinite);
  return { account: null, exhausted: true, reason: 'all-full', retryAt: frees.length ? new Date(Math.min(...frees)).toISOString() : null, rows };
}
