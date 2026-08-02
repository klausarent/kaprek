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

/** What a peer may do: open files, search them, list directories. Nothing else. */
const READ_ONLY_TOOLS = 'read_file,grep,list_dir';
/** Enough turns to actually read what it was pointed at. */
const REVIEW_MAX_TURNS = 40;

/**
 * What a council answer looks like, for drivers that can constrain output to
 * a schema. Mirrors what src/council/consult.mjs::parseVerdict accepts —
 * a peer forced into the RELAY's {status, message} shape had its perfectly
 * good verdict rejected in the first live run.
 */
const VERDICT_SCHEMA = {
  type: 'object',
  properties: {
    verdict: { type: 'string', enum: ['agree', 'concerns', 'disagree'] },
    summary: { type: 'string' },
    risks: { type: 'array', items: { type: 'string' } },
  },
  required: ['verdict', 'summary'],
  additionalProperties: false,
};

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
      const result = await driver.runTurn({
        cwd,
        prompt,
        signal,
        ...(timeoutMs ? { timeoutMs } : {}),
        // A reviewer has to open the files it was pointed at, and needs more
        // than one turn to do it — the first live consultation came back as
        // "max turns reached" from a peer given three files and one turn.
        tools: READ_ONLY_TOOLS,
        maxTurns: REVIEW_MAX_TURNS,
        schema: VERDICT_SCHEMA,
        // The council validates the verdict itself; the driver's own relay
        // shape does not apply here.
        validate: false,
      });
      // Drivers normalize to {status, message}; the message is the answer.
      return typeof result?.message === 'string' ? result.message : JSON.stringify(result ?? {});
    }

    const engine = getEngine(peerId);
    if (!engine) throw new Error(`no such peer: ${peerId}`);

    let text = '';
    const turn = await engine.startTurn({
      cwd,
      prompt,
      // 'plan' means read freely, write nothing, ask nobody. The first live
      // consultation failed exactly here: with no approval handler and no
      // mode, both engines were denied the files they had been pointed at,
      // and answered about a question they could not look into. A peer that
      // cannot read is not a second opinion, it is a guess.
      //
      // Nothing is granted by this that a review should not have: claude's
      // plan mode refuses edits itself, and codex maps this to a read-only
      // SANDBOX (see codex.mjs's mapPermissionMode) — an OS-level guarantee
      // rather than a promise the model makes.
      permissionMode: 'plan',
      onEvent: (event) => {
        if (event.type === 'text') text += event.text;
      },
      signal,
      ...(timeoutMs ? { absoluteTimeoutMs: timeoutMs } : {}),
    });
    if (turn?.error) throw new Error(turn.error.message);
    // A turn that ended any other way than by finishing produced whatever
    // text it managed before it stopped. Saying "the peer answered with
    // nothing" without saying WHY sends someone hunting through logs.
    if (text.trim() === '' && turn?.stopReason && turn.stopReason !== 'result') {
      throw new Error(`the peer's turn ended as ${turn.stopReason}${turn.timeoutClock ? ` (${turn.timeoutClock} clock)` : ''} before it said anything`);
    }
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
