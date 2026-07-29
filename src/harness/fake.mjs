// fake.mjs — a scriptable stand-in harness for tests. Plays back a fixed
// sequence of already-normalized events via onEvent(), never spawns a
// process and never touches the network. Same startTurn() contract as
// claude-code.mjs (see adapter.mjs), so orchestrator/API code can be
// tested end to end against a fully controlled harness.

/**
 * Creates a fake harness backed by a fixed script.
 * @param {{script?: import('./adapter.mjs').NormalizedEvent[]}} options
 *   script: normalized events played back through onEvent(), in order. A
 *   'result' event's fields (sessionId, costUsd, usage, isError) become the
 *   resolved TurnResult; a script with no 'result' event resolves with
 *   stopReason 'error', mirroring claude-code.mjs's own "process ended
 *   without a result" case.
 * @returns {{startTurn: (options: import('./adapter.mjs').StartTurnOptions) => Promise<import('./adapter.mjs').TurnResult>}}
 */
export function createFakeHarness({ script = [] } = {}) {
  async function startTurn({ sessionId: requestedSessionId, onEvent, signal } = {}) {
    let sessionId = requestedSessionId ?? null;
    let costUsd = null;
    let usage = null;
    let isError = false;
    let sawResult = false;

    for (const event of script) {
      // Yield to the microtask queue so a caller that calls signal's
      // AbortController.abort() from a timer/promise between events can
      // actually interrupt playback, not just abort before/after it.
      await Promise.resolve();
      if (signal?.aborted) {
        return { sessionId, costUsd, usage, stopReason: 'aborted', error: null };
      }

      onEvent?.(event);

      if (event.type === 'result') {
        sawResult = true;
        if (event.sessionId) sessionId = event.sessionId;
        costUsd = event.costUsd ?? null;
        usage = event.usage ?? null;
        isError = !!event.isError;
      }
    }

    if (signal?.aborted) {
      return { sessionId, costUsd, usage, stopReason: 'aborted', error: null };
    }

    if (!sawResult) {
      return {
        sessionId,
        costUsd,
        usage,
        stopReason: 'error',
        error: { message: 'fake harness script ended without a result event' },
      };
    }

    return {
      sessionId,
      costUsd,
      usage,
      stopReason: isError ? 'error' : 'result',
      error: isError ? { message: 'fake harness script ended in an error result' } : null,
    };
  }

  return { startTurn };
}
