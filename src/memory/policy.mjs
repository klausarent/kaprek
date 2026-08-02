// When the same mistake happens three times, kaprek writes down a rule —
// and then does nothing with it until a person says yes.
//
// THAT LAST PART IS THE WHOLE FEATURE. A system that turns its own observed
// failures into active rules is a system that re-educates itself out of
// sight, and the first wrong pattern it learns is one nobody chose and
// nobody can find. So a proposal is inert: it is stored, shown, and read by
// nothing until it is accepted.
//
// It is also Klaus' own working habit, made explicit. His feedback_*.md
// files exist because a mistake worth not repeating gets written down as a
// rule by hand. This proposes the text; the decision stays where it was.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

/** proposed → accepted | rejected. Only 'accepted' is ever read back into a prompt. */
export const PROPOSAL_STATUSES = ['proposed', 'accepted', 'rejected'];

/** How often the same pattern has to be seen before it is worth proposing anything. */
export const PROPOSE_AFTER = 3;

export class ProposalNotFoundError extends Error {
  constructor(id) {
    super(`no such proposal: ${id}`);
    this.name = 'ProposalNotFoundError';
    this.proposalId = id;
  }
}

function loadEvents(file) {
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    return [];
  }
  return raw
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

function applyEvent(state, event) {
  if (event.type === 'failure.seen') {
    const seen = state.sightings.get(event.data.pattern) ?? [];
    state.sightings.set(event.data.pattern, [...seen, event.data.where]);
    return;
  }
  if (event.type === 'proposal.made') {
    if (!state.proposals.has(event.proposalId)) state.proposals.set(event.proposalId, { id: event.proposalId, status: 'proposed', decidedAt: null, reason: null, ...event.data });
    return;
  }
  const existing = state.proposals.get(event.proposalId);
  if (!existing) return;
  if (event.type === 'proposal.decided') {
    state.proposals.set(event.proposalId, { ...existing, status: event.data.status, reason: event.data.reason ?? null, decidedAt: event.ts });
  }
}

/**
 * Opens the proposal store for `dataDir`.
 *
 * Kept apart from the memory store even though both are append-only logs: a
 * proposal is a question to a person, a memory is something believed. Mixing
 * them would put an unanswered question in front of an agent as if it were
 * a fact.
 */
export function openPolicy(dataDir, { now = Date.now } = {}) {
  const dir = path.join(dataDir, 'memory');
  const eventsFile = path.join(dir, 'policy.jsonl');

  const state = { sightings: new Map(), proposals: new Map() };
  for (const event of loadEvents(eventsFile)) applyEvent(state, event);

  function commit(type, proposalId, data) {
    const event = { id: crypto.randomUUID(), ts: new Date(now()).toISOString(), type, proposalId, data };
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(eventsFile, `${JSON.stringify(event)}\n`, 'utf8');
    applyEvent(state, event);
    return event;
  }

  /** Is there already a live proposal for this pattern? A second one would be noise, not emphasis. */
  function openProposalFor(pattern) {
    return [...state.proposals.values()].find((proposal) => proposal.pattern === pattern && proposal.status === 'proposed') ?? null;
  }

  return {
    /**
     * Records that a known failure pattern happened again, and proposes a
     * rule once it has happened often enough.
     *
     * @param {string} options.pattern - a short stable key ("relay step ran on the wrong engine")
     * @param {string} options.where - chat id, run id, whatever makes it findable
     * @param {string} options.rule - the sentence that would be added, if accepted
     * @returns {{proposal: object}|{seen: number}}
     */
    sawFailure({ pattern, where, rule }) {
      commit('failure.seen', pattern, { pattern, where });
      const seen = state.sightings.get(pattern) ?? [];
      if (seen.length < PROPOSE_AFTER) return { seen: seen.length };
      // Already asked and still unanswered: asking again does not make the
      // answer arrive sooner.
      const existing = openProposalFor(pattern);
      if (existing) return { proposal: { ...existing } };
      // Already answered — including "no". A rejected rule stays rejected;
      // re-proposing it on the next sighting would be nagging.
      const decided = [...state.proposals.values()].find((proposal) => proposal.pattern === pattern && proposal.status !== 'proposed');
      if (decided) return { seen: seen.length };

      const id = crypto.randomUUID();
      commit('proposal.made', id, { pattern, rule, seenIn: [...seen], proposedAt: new Date(now()).toISOString() });
      return { proposal: { ...state.proposals.get(id) } };
    },

    /** Answers a proposal. The only way a rule ever becomes active. */
    decide(proposalId, status, reason = null) {
      if (!state.proposals.has(proposalId)) throw new ProposalNotFoundError(proposalId);
      if (!['accepted', 'rejected'].includes(status)) throw new Error(`a proposal is accepted or rejected, not ${status}`);
      commit('proposal.decided', proposalId, { status, reason });
      return { ...state.proposals.get(proposalId) };
    },

    list({ status = null } = {}) {
      return [...state.proposals.values()].filter((proposal) => status === null || proposal.status === status).map((proposal) => ({ ...proposal }));
    },

    /**
     * The rules a person actually agreed to. This — and only this — is what
     * a prompt may be built from.
     */
    activeRules() {
      return this.list({ status: 'accepted' }).map((proposal) => proposal.rule);
    },
  };
}

/**
 * The rules block for a system prompt, or an empty string.
 *
 * Every line here was accepted by a person, which is why it is phrased as an
 * instruction — unlike the memory block, which is explicitly "what previous
 * turns wrote down, not instructions".
 */
export function buildRulesPrompt(rules = []) {
  if (rules.length === 0) return '';
  return ['## Rules for this machine', '', ...rules.map((rule) => `- ${rule}`), '', 'These were reviewed and accepted by the person you are working for. Follow them.'].join('\n');
}
