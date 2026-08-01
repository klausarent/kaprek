// fake.mjs — a scriptable stand-in harness for tests. Plays back a fixed
// sequence of already-normalized events via onEvent(), never spawns a
// process and never touches the network. Same startTurn() contract as
// claude-code.mjs (see adapter.mjs), so orchestrator/API code can be
// tested end to end against a fully controlled harness.

/**
 * Creates a fake harness backed by a fixed script.
 * @param {{script?: (import('./adapter.mjs').NormalizedEvent | {approval: object})[]}} options
 *   script: normalized events played back through onEvent(), in order. A
 *   'result' event's fields (sessionId, costUsd, usage, isError) become the
 *   resolved TurnResult; a script with no 'result' event resolves with
 *   stopReason 'error', mirroring claude-code.mjs's own "process ended
 *   without a result" case. A `{approval: {toolName, input, ...}}` entry is
 *   not a NormalizedEvent — it calls onApprovalRequest(request) with that
 *   object (defaulted to a minimal valid ApprovalRequest, see below), awaits
 *   the decision, and records it so orchestrator/server tests can assert on
 *   it without a real CLI process — see the harness's `approvalLog` below.
 * @returns {{startTurn: (options: import('./adapter.mjs').StartTurnOptions) => Promise<import('./adapter.mjs').TurnResult>, approvalLog: Array<{request: object, decision: object|null, error: string|null}>}}
 */
export function createFakeHarness({ script = [] } = {}) {
  // Every `{approval: ...}` script entry's request/decision pair, in the
  // order they were processed — lets a test assert exactly what was asked
  // and what onApprovalRequest answered, without a real CLI/control-channel.
  const approvalLog = [];
  let approvalCounter = 0;
  // Every startTurn() call's non-callback options, in order — lets a test
  // assert what the orchestrator actually asked for (cwd, resumed session,
  // prompt) without a real CLI process.
  const startedTurns = [];

  async function startTurn({ sessionId: requestedSessionId, onEvent, onApprovalRequest, signal, ...rest } = {}) {
    startedTurns.push({ sessionId: requestedSessionId ?? null, ...rest });
    let sessionId = requestedSessionId ?? null;
    let costUsd = null;
    let usage = null;
    let isError = false;
    let sawResult = false;

    for (const entry of script) {
      // Yield to the microtask queue so a caller that calls signal's
      // AbortController.abort() from a timer/promise between events can
      // actually interrupt playback, not just abort before/after it.
      await Promise.resolve();
      if (signal?.aborted) {
        return { sessionId, costUsd, usage, stopReason: 'aborted', error: null };
      }

      if ('approval' in entry) {
        approvalCounter += 1;
        const request = { id: `fake-approval-${approvalCounter}`, toolName: 'Bash', input: {}, ...entry.approval };
        if (typeof onApprovalRequest !== 'function') {
          // Same fail-closed contract as claude-code.mjs: no handler means deny.
          approvalLog.push({ request, decision: { behavior: 'deny', message: 'no approval handler configured' }, error: null });
          continue;
        }
        try {
          const decision = await onApprovalRequest(request);
          approvalLog.push({ request, decision, error: null });
        } catch (err) {
          approvalLog.push({ request, decision: null, error: err?.message ?? String(err) });
        }
        continue;
      }

      const event = entry;
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

  return { startTurn, approvalLog, startedTurns };
}
