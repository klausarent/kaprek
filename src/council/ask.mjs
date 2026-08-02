// Reaching an actual peer — the one place that knows a peer id can name
// either a full engine (claude-code, codex) or a peer driver (grok).
//
// Every path here is READ-ONLY, and not as a matter of prompt wording:
// engines run at the default permission mode with no approval handler, which
// their harnesses treat as deny-everything (see claude-code.mjs's contract
// note), and the grok driver runs in plan mode with read-only tools. Klaus'
// own rule, now enforced instead of documented: never two writers in one
// working tree. Reviews that only read cannot collide, which is exactly why
// they are allowed to run in parallel.
import { getEngine } from '../harness/registry.mjs';
import { getPeerDriver } from '../harness/peers/driver.mjs';
import '../harness/peers/grok.mjs'; // registers the grok driver

/**
 * Builds the askPeer function consultPeers expects.
 *
 * @param {string} options.cwd - where the peer reads from; the same working
 *   directory the asker is in, so "files worth reading" are paths it can
 *   actually open
 * @returns {(peerId: string, prompt: string, opts: {signal: AbortSignal}) => Promise<string>}
 */
export function makeAskPeer({ cwd, timeoutMs } = {}) {
  return async function askPeer(peerId, prompt, { signal } = {}) {
    const driver = getPeerDriver(peerId);
    if (driver) {
      const result = await driver.runTurn({ cwd, prompt, signal, ...(timeoutMs ? { timeoutMs } : {}) });
      // Drivers normalize to {status, message}; the message is the answer.
      return typeof result?.message === 'string' ? result.message : JSON.stringify(result ?? {});
    }

    const engine = getEngine(peerId);
    if (!engine) throw new Error(`no such peer: ${peerId}`);

    let text = '';
    const turn = await engine.startTurn({
      cwd,
      prompt,
      // No onApprovalRequest: both harnesses fail closed without one, so a
      // peer that tries to write is denied by the harness rather than by
      // hoping it read the instruction not to.
      onEvent: (event) => {
        if (event.type === 'text') text += event.text;
      },
      signal,
      ...(timeoutMs ? { absoluteTimeoutMs: timeoutMs } : {}),
    });
    if (turn?.error) throw new Error(turn.error.message);
    return text;
  };
}

/**
 * Peer ids that could actually be reached right now: every registered engine
 * plus every peer driver that reports itself as installed.
 *
 * A driver's `available()` is its own honest answer (grok's checks whether
 * the binary it resolved exists), never a spawn — deciding what to offer in
 * a settings dropdown must not start processes.
 */
export function availablePeerIds({ engineIds = [], env = process.env } = {}) {
  const drivers = [];
  for (const driver of [getPeerDriver('grok')].filter(Boolean)) {
    try {
      if (driver.available?.(env) !== false) drivers.push(driver.id);
    } catch {
      // A driver that cannot say is left out rather than offered and broken.
    }
  }
  return [...new Set([...engineIds, ...drivers])];
}
