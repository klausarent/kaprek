// Peer drivers — the other CLIs kaprek can hand a piece of work to.
//
// A peer is NOT a second harness. src/harness/adapter.mjs describes a
// tool-capable agent: it streams events, asks for approvals, edits files. A
// peer driver describes something deliberately much smaller — one text in,
// one text out, no tools, no shell, no files, no web, no subagents, no
// session to resume. It exists so a relay run can ask another CLI to write or
// review something and get a bounded answer back.
//
// WHY SO NARROW. The relay's worst case has to be money, never damage. A peer
// runs unattended, in a loop, with no human between its turns; the one thing
// that keeps that safe is that a peer cannot DO anything. Claude stays the
// only tool-capable agent in the loop, because Claude is the one whose tool
// calls go through kaprek's approval gate. Pretending a peer has harness
// parity would mean pretending it has that gate too.
//
// Each turn is a fresh call with a curated prompt. No resume, on purpose: a
// relay's context is what the dispatcher decided to include (see
// src/relay/dispatcher.mjs), which is auditable, rather than whatever the
// peer's own session store happens to remember.

/**
 * @typedef {Object} PeerTurnResult
 * @property {'handoff'|'done'|'needs_human'} status - what the peer says
 *   should happen next. Constrained by the output schema the driver enforces,
 *   never parsed out of prose: a soft protocol in free text is the failure
 *   mode this whole contract exists to avoid.
 * @property {string} message - the actual text the peer produced
 * @property {object|null} usage - token counts if the CLI reports them
 * @property {number|null} costUsd - what the CLI CLAIMS this turn cost. Null
 *   when it says nothing, and null is NOT zero: a subscription CLI's numbers
 *   are an estimate at best (see PEER_COST_ESTIMATED), so a caller must label
 *   them as such and must never treat a missing number as free.
 * @property {number} durationMs
 * @property {string|null} rawLogPath - where the raw stdout/stderr of this
 *   turn was written, for the times the parsed result does not explain what
 *   happened
 */

/**
 * @typedef {Object} PeerDriver
 * @property {string} id - 'grok', and later 'codex'
 * @property {() => boolean} available - is the CLI actually installed here?
 * @property {(options: {cwd: string, prompt: string, timeoutMs?: number, signal?: AbortSignal, logDir?: string}) => Promise<PeerTurnResult>} runTurn
 */

/**
 * Every peer's cost figure is an estimate, and every caller has to say so.
 * A subscription CLI bills a plan, not a turn; the per-turn number it prints
 * is derived from token counts at list prices that the subscriber is not
 * actually paying. It is useful as a relative signal ("this turn was ten
 * times the last one") and misleading as an absolute.
 */
export const PEER_COST_ESTIMATED = true;

/** The three answers a peer may give. Anything else is a protocol error and fails closed. */
export const PEER_STATUSES = Object.freeze(['handoff', 'done', 'needs_human']);

/**
 * The output schema every peer is constrained to. Kept here rather than in
 * one driver because it is the relay's protocol, not one CLI's quirk: the
 * dispatcher reads `status` to decide what happens next, so a peer that could
 * answer in prose could steer the run by accident.
 */
export const PEER_OUTPUT_SCHEMA = Object.freeze({
  type: 'object',
  properties: {
    status: { type: 'string', enum: [...PEER_STATUSES] },
    message: { type: 'string' },
  },
  required: ['status', 'message'],
});

/** Hard cap on a peer's stdout. Past this the turn fails cleanly instead of buffering a runaway CLI into memory. */
export const PEER_MAX_STDOUT_BYTES = 1024 * 1024;

/** How long one peer turn may take before it is killed, tree and all. */
export const PEER_TIMEOUT_MS = 10 * 60_000;

/**
 * Validates what a peer claims to have answered. Returns the normalized
 * result or throws — there is no lenient path on purpose: the dispatcher acts
 * on `status`, and guessing what an unparseable answer meant is how a relay
 * ends up in a loop nobody asked for.
 */
export function parsePeerAnswer(raw) {
  let parsed;
  try {
    parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
  } catch (err) {
    throw new Error(`peer answer was not JSON: ${err.message}`);
  }
  if (!parsed || typeof parsed !== 'object') throw new Error('peer answer was not an object');
  if (!PEER_STATUSES.includes(parsed.status)) {
    throw new Error(`peer answer had no usable status (got ${JSON.stringify(parsed.status)}, expected one of ${PEER_STATUSES.join(', ')})`);
  }
  if (typeof parsed.message !== 'string') throw new Error('peer answer had no message string');
  return { status: parsed.status, message: parsed.message };
}

/**
 * The drivers this build knows about, by id. A registry rather than a switch
 * so that adding a peer is one file plus one line here — and so the relay can
 * refuse an unknown peer id at validation time rather than at dispatch time.
 */
const drivers = new Map();

export function registerPeerDriver(driver) {
  if (!driver?.id) throw new Error('a peer driver needs an id');
  drivers.set(driver.id, driver);
  return driver;
}

export function getPeerDriver(id) {
  return drivers.get(id) ?? null;
}

export function listPeerDrivers() {
  return [...drivers.values()];
}
