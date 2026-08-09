// Reaching an actual peer — the one place that knows a peer id can name
// either a full engine (claude-code, codex) or a peer driver (grok).
//
// Since 0.9.0 a peer sees NO files: the consultation embeds redacted
// snapshots in the prompt (src/council/snapshot.mjs), grok runs with no
// tools at all, and every peer stands in an empty scratch directory instead
// of the mission's — a peer that starts next to a .env has the .env, prompt
// wording notwithstanding. Engines still run in plan mode as the write
// barrier; their harnesses can read, but from the scratch directory there
// is nothing to read, and the package tells them not to try. Klaus' own
// rule stays enforced: never two writers in one working tree.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getEngine } from '../harness/registry.mjs';
import { getPeerDriver } from '../harness/peers/driver.mjs';
import '../harness/peers/grok.mjs'; // registers the grok driver

/**
 * How long a peer may be silent before kaprek gives up on it. Generous
 * because a reviewer's silence means it is thinking, not that it is stuck —
 * the opposite of a chat turn, where two minutes of nothing is a hung CLI.
 */
const PEER_IDLE_MS = 6 * 60 * 1000;

/**
 * An empty directory for a peer to stand in.
 *
 * The old contract handed peers the asker's cwd so they could open the files
 * the package named. With snapshots embedded in the prompt that need is
 * gone, and the cwd became pure liability: it decides what a curious or
 * prompt-injected peer can reach with relative paths. One directory per
 * consultation, best-effort removed by the caller.
 */
function makeScratchDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'kaprek-council-'));
}

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
 * The peer's working directory is an empty scratch dir, never the asker's:
 * everything a peer may see arrives inside the prompt as a redacted
 * snapshot, so standing among the real files grants nothing a review needs
 * and everything a leak does.
 *
 * @returns {(peerId: string, prompt: string, opts: {signal: AbortSignal}) => Promise<string>}
 */
export function makeAskPeer({ timeoutMs } = {}) {
  return async function askPeer(peerId, prompt, { signal } = {}) {
    const scratchCwd = makeScratchDir();
    try {
      return await askInScratch({ peerId, prompt, signal, timeoutMs, cwd: scratchCwd });
    } finally {
      try {
        fs.rmSync(scratchCwd, { recursive: true, force: true });
      } catch {
        // a leftover empty temp dir is not worth failing a verdict over
      }
    }
  };
}

async function askInScratch({ peerId, prompt, signal, timeoutMs, cwd }) {
  const driver = getPeerDriver(peerId);
  if (driver) {
    const result = await driver.runTurn({
      cwd,
      prompt,
      signal,
      ...(timeoutMs ? { timeoutMs } : {}),
      // No tools: with snapshots in the prompt there is nothing left to
      // read, and a text-only turn is the same contract the relay already
      // proves works (one turn, schema-constrained answer). The old
      // read-only tool set existed only so a peer could open the files
      // the package named — that need is gone.
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
    // 'plan' remains as the WRITE barrier: claude's plan mode refuses
    // edits itself, and codex maps this to a read-only SANDBOX (see
    // codex.mjs's mapPermissionMode) — an OS-level guarantee rather than
    // a promise the model makes. Reading is not blocked by it, which is
    // exactly why the peer stands in an empty scratch directory: what an
    // engine could read from here is nothing.
    permissionMode: 'plan',
    onEvent: (event) => {
      if (event.type === 'text') text += event.text;
    },
    signal,
    ...(timeoutMs ? { absoluteTimeoutMs: timeoutMs } : {}),
    // A reviewer is quiet while it reads. Live run: codex died on the
    // IDLE clock at two minutes — not the wall clock — because reading
    // inside its read-only sandbox emits nothing for minutes at a time,
    // and reported "answered with nothing". Raising the wall clock alone
    // fixed nothing; this is the clock that was actually firing.
    idleMs: PEER_IDLE_MS,
    toolLeaseMs: PEER_IDLE_MS,
    timeoutMs: timeoutMs ?? undefined,
  });
  if (turn?.error) throw new Error(turn.error.message);
  // A turn that ended any other way than by finishing produced whatever
  // text it managed before it stopped. Saying "the peer answered with
  // nothing" without saying WHY sends someone hunting through logs.
  if (text.trim() === '' && turn?.stopReason && turn.stopReason !== 'result') {
    throw new Error(`the peer's turn ended as ${turn.stopReason}${turn.timeoutClock ? ` (${turn.timeoutClock} clock)` : ''} before it said anything`);
  }
  return text;
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
