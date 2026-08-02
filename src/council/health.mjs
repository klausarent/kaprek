// Remembering which peer is currently not answering.
//
// A consultation waits ten minutes for a peer before giving up, which is
// right when the peer is thinking and wrong when it is gone. With the
// `always` level that ten minutes is paid on every turn, for a CLI that has
// been broken since this morning.
//
// So a peer that fails repeatedly is skipped for a while — and SAID to be
// skipped, in the answer, with the reason. A quietly dropped peer would turn
// "two engines agreed" into a sentence about one, which is the exact lie the
// whole council exists to avoid.
//
// Deliberately in memory only. A cold start should try everything once: the
// CLI that was broken yesterday is usually the CLI that was updated
// overnight, and a file that remembers otherwise would keep it excluded for
// no reason.

/** Consecutive failures before a peer is rested. Two, because one is a bad minute and three is a wasted afternoon. */
export const FAILURES_BEFORE_REST = 2;

/** How long it is rested for. Long enough to matter at `always`, short enough that a fixed CLI comes back on its own. */
export const REST_MS = 15 * 60 * 1000;

/**
 * Tracks per-peer failures for this process.
 *
 * @param {() => number} [now]
 */
export function createPeerHealth({ now = Date.now, failuresBeforeRest = FAILURES_BEFORE_REST, restMs = REST_MS } = {}) {
  /** peerId -> {failures, restingUntil} */
  const state = new Map();

  function entry(peerId) {
    if (!state.has(peerId)) state.set(peerId, { failures: 0, restingUntil: 0 });
    return state.get(peerId);
  }

  return {
    /** An answer arrived. Everything is forgiven — a peer that works now is a peer that works. */
    succeeded(peerId) {
      state.delete(peerId);
    },

    /** No answer. Two of these in a row and it is rested. */
    failed(peerId) {
      const current = entry(peerId);
      current.failures += 1;
      if (current.failures >= failuresBeforeRest) current.restingUntil = now() + restMs;
      return { ...current };
    },

    /**
     * Whether to ask this peer at all right now, and why not.
     *
     * @returns {{ask: true} | {ask: false, reason: string, until: number}}
     */
    check(peerId) {
      const current = state.get(peerId);
      if (!current || current.restingUntil <= now()) return { ask: true };
      const minutes = Math.max(1, Math.round((current.restingUntil - now()) / 60_000));
      return {
        ask: false,
        until: current.restingUntil,
        reason: `did not answer ${current.failures} times in a row; skipped for about ${minutes} more minute${minutes === 1 ? '' : 's'}`,
      };
    },

    /** For tests and for a settings page that wants to show why somebody is quiet. */
    snapshot() {
      return [...state.entries()].map(([peerId, value]) => ({ peerId, failures: value.failures, restingUntil: value.restingUntil }));
    },
  };
}
