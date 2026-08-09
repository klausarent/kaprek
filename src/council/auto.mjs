// Consulting a peer WITHOUT being asked: the part of the council that fires
// on its own when the level says so.
//
// The moment that matters is the one right after a plan is written. That is
// where a second opinion is worth most and costs least — the plan is short,
// it is on disk, and nothing has been built on it yet.
//
// THE SHAPE, decided by asking Codex and Grok independently (they agreed):
// the chat turn's stream ends with the turn, and the consultation runs on
// beside it in the same process, with its own lifecycle and its own abort
// controller. Holding the SSE stream open for the minutes a peer needs would
// keep the chat busy, die with the browser tab, and lose the result to any
// proxy that dislikes long responses.
//
// FOUR RULES this module exists to keep:
//   1. Every started consultation reaches a terminal state. A dropped
//      promise would leave a `running` entry nobody ever finishes.
//   2. One per chat at a time. The `always` level would otherwise multiply
//      CLI processes turn by turn.
//   3. Never automatic when there is nobody to ask. A single engine
//      reviewing itself is not a second opinion, and pretending otherwise is
//      the one lie this feature must not tell.
//   4. Only after a plan actually appeared. A guided turn that produced no
//      file has nothing to review, and asking anyway burns two CLIs on an
//      empty package.
import fs from 'node:fs';
import path from 'node:path';
import { consultPeers, DEFAULT_PEER_TIMEOUT_MS } from './consult.mjs';
import { snapshotFiles } from './snapshot.mjs';
import { shouldConsult, councilStatus, suggestAssignment } from './roles.mjs';
import { createPeerHealth } from './health.mjs';
import { sha256Of } from './store.mjs';

/**
 * How many consultations may run at once across all chats. Two peers each,
 * so this is already four CLI processes at the ceiling — enough for a busy
 * session, low enough that a runaway level cannot fork a machine full of
 * them.
 */
export const MAX_CONCURRENT_CONSULTATIONS = 2;

/** Why a consultation did not start. Reported, never silent. */
export const SKIP_REASONS = {
  level: 'the council level does not consult at this moment',
  noPeers: 'no peer is available',
  inFlight: 'this chat already has a consultation running',
  busy: 'too many consultations are already running',
  noPlan: 'the turn produced no plan to review',
};

/** The package a plan review gets. Short on purpose: the plan is the subject, and its snapshot rides along. */
export function planQuestion({ planPath, goal }) {
  return [
    `A plan has just been written to ${planPath}; its snapshot is included below.`,
    goal ? `It came out of this conversation: ${goal}` : null,
    'Say whether it is sound: does it do what it says, is anything load-bearing missing, and is any step going to fail in a way the plan does not anticipate?',
  ]
    .filter(Boolean)
    .join(' ');
}

/**
 * Creates the automatic consultation runner.
 *
 * @param {object} options
 * @param {() => object} options.getConsultations - the store, re-opened per call like the rest of server.mjs does
 * @param {() => {level: string, assignment: object, configured: boolean}} options.readConfig
 * @param {() => string[]} options.availablePeerIds
 * @param {(options: {cwd: string, timeoutMs: number}) => Function} options.makeAskPeer
 * @param {number} [options.timeoutMs] - per peer
 * @param {(message: string) => void} [options.log]
 */
export function createCouncilRunner({
  getConsultations,
  readConfig,
  availablePeerIds,
  makeAskPeer,
  timeoutMs = DEFAULT_PEER_TIMEOUT_MS,
  maxConcurrent = MAX_CONCURRENT_CONSULTATIONS,
  log = () => {},
} = {}) {
  /** consultationId -> {abort, promise}. Only ever holds runs this process is driving. */
  const active = new Map();
  // Who is currently not answering. In memory only: a cold start should try
  // everything once, since the CLI that was broken yesterday is usually the
  // one that was updated overnight.
  const health = createPeerHealth();

  function peersFor() {
    const installed = availablePeerIds();
    const saved = readConfig();
    const assignment = saved.configured ? saved.assignment : suggestAssignment(installed);
    return { level: saved.level, status: councilStatus(assignment) };
  }

  /**
   * Starts a consultation if every condition holds.
   *
   * @returns {{consultation: object}|{skipped: string}} — never throws for a
   *   condition that is simply not met; the caller decides whether a skip is
   *   worth showing.
   */
  function maybeConsult({ chatId, moment, question, planPath = null, cwd, missionId = null, files = [], constraints = [], tried = [] }) {
    const { level, status } = peersFor();
    if (!shouldConsult(level, moment)) return { skipped: SKIP_REASONS.level };
    if (!status.possible) return { skipped: status.reason ?? SKIP_REASONS.noPeers };

    const store = getConsultations();
    if (store.runningFor(chatId)) return { skipped: SKIP_REASONS.inFlight };
    if (active.size >= maxConcurrent) return { skipped: SKIP_REASONS.busy };

    // The plan's fingerprint at the moment it was handed over. What the peers
    // are about to read is what the verdict will be about — anything typed
    // into the file afterwards makes the verdict stale, and the store says so.
    let planSha256 = null;
    if (planPath) {
      try {
        planSha256 = sha256Of(fs.readFileSync(planPath, 'utf8'));
      } catch {
        planSha256 = null;
      }
    }

    const consultation = store.queue({ chatId, moment, question, peers: status.peers, planPath, planSha256, missionId });
    const controller = new AbortController();

    // Materialize here, at queue time: what the peers see is the file as it
    // was when the verdict was commissioned — the same moment planSha256
    // fingerprints. Roots are the asker's cwd plus the plan's own directory
    // (plans live in the dataDir, not the mission tree).
    const { snapshots, refused } = snapshotFiles(planPath ? [planPath, ...files] : files, {
      cwd,
      roots: [cwd, ...(planPath ? [path.dirname(planPath)] : [])],
    });

    const promise = consultPeers({
      peers: status.peers,
      askPeer: makeAskPeer({ timeoutMs }),
      question,
      snapshots,
      refused,
      constraints,
      tried,
      signal: controller.signal,
      timeoutMs,
      health,
    })
      .then((result) => {
        // The prompt and each peer's raw text stay out of the store: the
        // verdicts are the answer, and a full transcript per peer would turn
        // a log meant to be replayed into something nobody opens.
        getConsultations().complete(consultation.id, {
          consensus: result.consensus,
          empty: result.empty,
          agreed: result.agreed,
          dissenting: result.dissenting,
          unreachable: result.unreachable,
          answers: result.answers.map(({ peerId, verdict, summary, risks, error }) => ({ peerId, verdict, summary, risks, error })),
        });
      })
      .catch((err) => {
        // Rule 1: a consultation that throws still ends. consultPeers already
        // absorbs a single peer failing, so reaching here means something
        // structural — and a `running` entry left behind would look, forever,
        // like an answer still on its way.
        try {
          getConsultations().fail(consultation.id, err?.message ?? String(err));
        } catch (storeErr) {
          log(`council: could not record the failure of ${consultation.id} (${storeErr.message})`);
        }
      })
      .finally(() => {
        active.delete(consultation.id);
      });

    active.set(consultation.id, { chatId, abort: () => controller.abort(), promise });
    return { consultation };
  }

  return {
    maybeConsult,

    /** Resolves once this process has stopped driving that consultation. For tests and shutdown. */
    async waitFor(id) {
      const running = active.get(id);
      if (running) await running.promise.catch(() => {});
      return true;
    },

    /**
     * Aborts everything in flight and waits for each to record its end.
     *
     * Called on shutdown so peer CLIs do not outlive the server that started
     * them — Grok's point: an orphaned read-only CLI is invisible and still
     * costs a process.
     */
    async stopAll(reason = 'kaprek is shutting down') {
      const running = [...active.values()];
      for (const entry of running) entry.abort();
      await Promise.all(running.map((entry) => entry.promise.catch(() => {})));
      log(`council: stopped ${running.length} consultation(s) — ${reason}`);
      return running.length;
    },

    activeCount() {
      return active.size;
    },
  };
}
