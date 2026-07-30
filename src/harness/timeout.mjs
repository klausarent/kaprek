// timeout.mjs — pure clock logic for one Claude Code turn. Replaces the old
// single pausable timeoutMs (claude-code.mjs's former DEFAULT_TIMEOUT_MS)
// with four independent budgets, because neither a single overall budget nor
// a single idle timeout alone covers the turns kaprek actually sees:
//   - A single active-total budget (the old model) kills a legitimate
//     six-minute run outright — there is no way to distinguish "still
//     working" from "stuck" with one number.
//   - A pure idle timeout alone would kill a 20-minute `Bash` build that,
//     while it runs, emits NO stream-json lines at all — idle can only ever
//     measure GAPS between events, not a single long-running tool call that
//     never produces intermediate output.
// Hence: idle (gaps with no tool open), tool-lease (one open tool call),
// active-total (the whole turn's own budget) and absolute (a raw wall-clock
// backstop against a CHAIN of approval round-trips — see ABSOLUTE_MS's own
// doc comment) — see createTurnClocks() below for how they interact.
//
// This module is REINE LOGIK over an injected time source: no timer, no IO,
// no process handle. The caller (claude-code.mjs) is the one that owns an
// actual setInterval and calls check() from it, plus once per normalized
// event — that split is what makes the four clocks testable without any
// real waiting (see timeout.test.mjs's fakeClock()).

/** Model-idle budget: how long the model may go silent with no tool open before a turn is considered stuck. */
export const IDLE_MS = 120_000;
/** Tool-lease budget: how long a single open tool call (tool-start with no matching tool-end yet) may run. */
export const TOOL_LEASE_MS = 25 * 60_000;
/** Active-total budget: the turn's own overall budget, counted in active (non-approval-wait) time. */
export const ACTIVE_TOTAL_MS = 35 * 60_000;
// Absolute budget: a RAW, NEVER-paused wall-clock cap — unlike the other
// three, approval-wait time counts fully against this one. Fix-round
// (task-2, panel review): the first version of this file exempted approval
// wait from all four clocks alike, which made `absolute` degenerate into a
// second, strictly-larger threshold on the exact same quantity `active-total`
// already measures — given the default constants below (35min <
// 60min), active-total always fires first and `absolute` could never fire at
// all. That defeated the actual reason `absolute` exists: a backstop against
// a CHAIN of approval round-trips. The caller's own approval timeout (e.g.
// src/server/server.mjs's DEFAULT_APPROVAL_TIMEOUT_MS) only auto-denies ONE
// pending request — it does not stop the agent from immediately asking
// again. A long enough chain of such individually-timed-out round-trips
// would keep active-total (and idle, and tool-lease) paused for almost the
// entire wall-clock duration, while never once tripping any of them, and
// hold the chat's own busy-gate (src/server/server.mjs's handleChatTurn 409)
// closed indefinitely in the process. Only a clock that keeps ticking
// THROUGH approval waits can catch that.
//
// This value is therefore CONTEXT-DEPENDENT, not a fixed default like the
// other three — see adapter.mjs's TurnResult doc comment on the two regimes
// (interactive chat vs. an unattended trigger turn with task-3's overnight
// approval inbox) a caller must pick between when overriding it.
export const ABSOLUTE_MS = 60 * 60_000;

/**
 * A non-finite or non-positive budget disables that clock — check() can
 * never report it. Mirrors the convention claude-code.mjs already used for
 * its own timeoutMs/absoluteTimeoutMs options before this module existed.
 */
function normalizeBudget(ms) {
  return Number.isFinite(ms) && ms > 0 ? ms : null;
}

/**
 * Builds the turn-lifetime clock state for one turn.
 *
 * @param {object} options
 * @param {number} options.idleMs
 * @param {number} options.toolLeaseMs
 * @param {number} options.activeTotalMs
 * @param {number} options.absoluteMs
 * @param {() => number} [options.nowFn] - injected time source, default Date.now
 * @returns {{
 *   onProgress: (kind: 'init'|'assistant-message'|'tool-start'|'tool-end'|'result') => void,
 *   onApprovalStart: () => void,
 *   onApprovalEnd: () => void,
 *   check: () => null | { reason: string, clock: 'idle'|'tool-lease'|'active-total'|'absolute' },
 * }}
 *
 * Approval-wait exemption (idle, tool-lease, active-total ONLY — NOT
 * absolute): a chat's own busy-gate (src/server/server.mjs's handleChatTurn
 * 409) must not be held closed by a turn that is really just waiting on a
 * human, and a slow decision must not kill the turn's own in-flight tool
 * call out from under it. If only active-total paused for that wait — the
 * way the old, single DEFAULT_TIMEOUT_MS did — idle and tool-lease would
 * still tick during the wait and cause exactly that. So: approval-wait time
 * is subtracted from the elapsed time idle/tool-lease/active-total see.
 *
 * `absolute` is deliberately the ONE clock excluded from this exemption —
 * see ABSOLUTE_MS's own doc comment for why (in short: it is the backstop
 * against a CHAIN of individually-auto-denied approval round-trips, which
 * would otherwise never trip any of the other three). It is a raw wall
 * clock: approval-wait time counts fully against it, same as any other
 * time. What bounds a SINGLE pending approval is instead the caller's own
 * approval-specific timeout (src/server/server.mjs's
 * DEFAULT_APPROVAL_TIMEOUT_MS, which resolves onApprovalRequest's promise
 * with an auto-deny — see makeApprovalHandler()) — not a clock in this
 * module. A caller relying on task-3's overnight approval inbox MUST size
 * absoluteMs accordingly (see ABSOLUTE_MS's doc comment and adapter.mjs's
 * TurnResult doc comment) — the default 60-minute ABSOLUTE_MS is sized for
 * an interactive chat, not an unattended overnight wait.
 */
export function createTurnClocks({ idleMs, toolLeaseMs, activeTotalMs, absoluteMs, nowFn = Date.now }) {
  const idleBudget = normalizeBudget(idleMs);
  const toolLeaseBudget = normalizeBudget(toolLeaseMs);
  const activeTotalBudget = normalizeBudget(activeTotalMs);
  const absoluteBudget = normalizeBudget(absoluteMs);

  const startedAt = nowFn();

  // Model-idle reference point: reset by EVERY qualifying progress event
  // (see onProgress()'s own doc comment on what counts), not just ones that
  // happen while no tool is open — simplest to reason about, and harmless,
  // since idleElapsed below is only ever consulted while openToolLeases===0.
  let lastProgressAt = startedAt;
  // Snapshot of pausedSoFar() taken AT lastProgressAt — lets idleElapsed
  // below subtract only the approval-wait time that happened SINCE the last
  // progress event, not the turn's total approval-wait time to date.
  let pausedAtLastProgress = 0;

  // Tool-lease is tracked as an OPEN-LEASE COUNT, not a boolean: the
  // interface's onProgress(kind) carries no tool_use id (see this module's
  // own Schnittstelle), and a real turn can have several tool calls open at
  // once (parallel tool_use blocks in one assistant message, or concurrent
  // subagents — see claude-code.mjs's own handling of concurrent
  // can_use_tool requests). A boolean reset to "closed" by the FIRST
  // tool-end would let idle start ticking while a second tool is still
  // genuinely running. The count starts the lease window on the first
  // tool-start (0->1) and only closes it once every open tool has ended
  // (->0) — see the brief's "Ausgabe während des Laufs verlängert sie
  // nicht": a start/end pair that overlaps an ALREADY-open lease does not
  // move toolLeaseStartedAt.
  let openToolLeases = 0;
  let toolLeaseStartedAt = null;
  let pausedAtLeaseStart = 0;

  // pausedMs: approval-wait time already banked from CLOSED waits.
  // approvalPendingSince: start of the CURRENTLY open wait, if any. Reading
  // pausedSoFar(now) always gives the total approval-wait time elapsed so
  // far, whether or not a wait happens to be open right now.
  let pausedMs = 0;
  let approvalPendingSince = null;
  const pausedSoFar = (now) => pausedMs + (approvalPendingSince !== null ? now - approvalPendingSince : 0);

  /**
   * Records one qualifying progress event. `kind` is one of the five the
   * brief defines as exhaustive: 'init', 'assistant-message' (a NEW
   * assistant message, not a text delta within one — this harness's
   * stream-json transport never surfaces deltas anyway, see
   * claude-code.mjs's mapLine()), 'tool-start', 'tool-end' (only for one
   * that closes an open lease — the caller is expected to only call this
   * for a real tool_result), and 'result'. Explicitly NOT called for
   * rate-limit events or repeated raw lines — see the brief's own
   * "Was als Fortschritt zählt" list.
   */
  function onProgress(kind) {
    const now = nowFn();
    if (kind === 'tool-start') {
      if (openToolLeases === 0) {
        toolLeaseStartedAt = now;
        pausedAtLeaseStart = pausedSoFar(now);
      }
      openToolLeases += 1;
    } else if (kind === 'tool-end') {
      openToolLeases = Math.max(0, openToolLeases - 1);
      if (openToolLeases === 0) toolLeaseStartedAt = null;
    }
    lastProgressAt = now;
    pausedAtLastProgress = pausedSoFar(now);
  }

  /** Marks the start of a human decision wait. A second, overlapping call (concurrent approvals) is a no-op — see onApprovalEnd()'s doc comment on why the caller, not this function, must gate on ALL pending approvals having cleared. */
  function onApprovalStart() {
    if (approvalPendingSince === null) approvalPendingSince = nowFn();
  }

  /**
   * Marks the end of a human decision wait. The CALLER is responsible for
   * only invoking this once every currently-pending approval has resolved
   * (mirrors claude-code.mjs's own pendingApprovalCount gating) — calling it
   * while a second approval is still outstanding would close the pause
   * window early and let the still-pending approval's own wait start
   * counting against every clock again.
   */
  function onApprovalEnd() {
    if (approvalPendingSince === null) return;
    pausedMs += nowFn() - approvalPendingSince;
    approvalPendingSince = null;
  }

  /**
   * Evaluates all four clocks against the current time and returns the
   * first one over budget, or null. Checked in order: idle-or-tool-lease
   * (mutually exclusive, whichever applies given whether a tool is
   * currently open) BEFORE active-total/absolute — on the rare tie where a
   * coarse poll interval lets more than one clock cross its line in the
   * same check() call, the more specific, more immediately actionable cause
   * (the model went silent / one tool call ran long) is reported over the
   * turn's generic overall budget.
   */
  function check() {
    const now = nowFn();
    const paused = pausedSoFar(now);

    if (openToolLeases > 0) {
      if (toolLeaseBudget !== null && toolLeaseStartedAt !== null) {
        const leaseElapsed = now - toolLeaseStartedAt - (paused - pausedAtLeaseStart);
        if (leaseElapsed >= toolLeaseBudget) {
          return { reason: `a tool call ran longer than toolLeaseMs (${toolLeaseBudget}ms)`, clock: 'tool-lease' };
        }
      }
    } else if (idleBudget !== null) {
      const idleElapsed = now - lastProgressAt - (paused - pausedAtLastProgress);
      if (idleElapsed >= idleBudget) {
        return { reason: `no progress for idleMs (${idleBudget}ms) with no tool open`, clock: 'idle' };
      }
    }

    const activeElapsed = now - startedAt - paused;
    if (activeTotalBudget !== null && activeElapsed >= activeTotalBudget) {
      return { reason: `active turn time exceeded activeTotalMs (${activeTotalBudget}ms, approval waits excluded)`, clock: 'active-total' };
    }

    // RAW wall-clock elapsed — deliberately NOT `activeElapsed` (no `paused`
    // subtraction). See ABSOLUTE_MS's own doc comment: this is what lets
    // `absolute` catch a chain of approval round-trips that active-total's
    // approval-wait exemption would otherwise hide from it entirely.
    const rawElapsed = now - startedAt;
    if (absoluteBudget !== null && rawElapsed >= absoluteBudget) {
      return { reason: `turn exceeded the absolute wall-clock cap of absoluteMs (${absoluteBudget}ms) — includes approval-wait time by design`, clock: 'absolute' };
    }

    return null;
  }

  return { onProgress, onApprovalStart, onApprovalEnd, check };
}
