// Council roles — who orchestrates, who thinks, who works, who disagrees.
//
// Klaus, on why kaprek needs this at all: "Die Rückfragen mit den anderen
// KIs finden noch nicht statt. Das sollte entweder standardmäßig oder
// optional geschehen. … Nicht jeder arbeitet mit Claude als Main so wie ich."
//
// So there are no model names in here. A role is a job; which engine does
// that job is the user's decision, defaulted from whatever is installed on
// their machine. Someone running Codex as their main engine and Claude as a
// second opinion gets the identical machinery with the assignment flipped —
// and Grok, Kimi, or whatever ships next hooks into the same four slots.
//
// `peer` is the only role that may hold more than one engine. Two peers that
// contradict each other are the point, not a problem to be resolved before
// showing it to a human.

/**
 * lead     orchestrates: splits the work, synthesizes the answers
 * thinker  architecture, algorithms, the analysis worth paying for
 * worker   boilerplate, tests, mechanical edits
 * peer     independent second opinion, adversarial review (many allowed)
 */
export const COUNCIL_ROLES = ['lead', 'thinker', 'worker', 'peer'];

/**
 * How eagerly kaprek asks a peer WITHOUT being asked. The button to consult
 * one is always there; this only governs what happens on its own.
 *   off        never
 *   plans      when a plan has just been written (the default)
 *   decisions  the same, for now — see below
 *   always     that, plus after every ordinary turn
 *
 * HONEST NOTE ON 'decisions': the moment exists and is respected, but
 * nothing in kaprek currently reports one. A turn does not know it just made
 * an architecture decision, and guessing from the text would produce a
 * setting that fires on the word "decided". Until something can say so
 * truthfully, 'decisions' behaves exactly like 'plans' — which is written
 * down here rather than left for someone to discover by watching nothing
 * happen.
 */
export const COUNCIL_LEVELS = ['off', 'plans', 'decisions', 'always'];

/** What each level covers, beyond 'manual' which every level covers. */
const LEVEL_MOMENTS = {
  off: [],
  plans: ['plan'],
  decisions: ['plan', 'decision'],
  always: ['plan', 'decision', 'turn'],
};

/**
 * A default assignment from the engines that are actually installed.
 *
 * The FIRST engine offered becomes the lead. Not "claude-code if present" —
 * the caller decides the order (from a scan of what is installed, or from
 * the user's own preference), and this function stays ignorant of which
 * vendor is which.
 *
 * @param {string[]} availableIds - engine ids, in preference order
 */
export function suggestAssignment(availableIds = []) {
  const ids = [...new Set(availableIds.filter((id) => typeof id === 'string' && id.trim() !== ''))];
  const lead = ids[0] ?? null;
  return {
    lead,
    // With a second engine present, thinking goes to it: the value of a
    // council is in not having one mind do every job.
    thinker: ids[1] ?? lead,
    worker: ids[ids.length - 1] ?? lead,
    // Everything that is not the lead can disagree with the lead.
    peer: ids.slice(1),
  };
}

/**
 * Whether this assignment can actually produce a second opinion, and why not
 * when it cannot.
 *
 * Deliberately explicit about the one-engine case. A single model asked to
 * review its own answer is not a second opinion, and presenting it as one
 * would be the most expensive kind of quiet lie this feature could tell.
 */
export function councilStatus(assignment) {
  const peers = (assignment?.peer ?? []).filter((id) => id && id !== assignment?.lead);
  if (peers.length > 0) return { possible: true, peers, reason: null };
  if (!assignment?.lead) return { possible: false, peers: [], reason: 'No engine is set up yet.' };
  return {
    possible: false,
    peers: [],
    reason: 'Only one engine is installed, so there is no second opinion to get — a model reviewing its own answer is not one.',
  };
}

/**
 * Checks an assignment against what is installed.
 *
 * @returns {{ok: boolean, errors: string[], assignment: object}} `assignment`
 *   is the cleaned-up version (duplicate peers collapsed) and is only
 *   meaningful when ok.
 */
export function validateAssignment(assignment, availableIds = []) {
  const errors = [];
  const available = new Set(availableIds);
  const peer = [...new Set((Array.isArray(assignment?.peer) ? assignment.peer : []).filter(Boolean))];

  for (const role of ['lead', 'thinker', 'worker']) {
    const id = assignment?.[role];
    if (!id) errors.push(`${role} is not set`);
    else if (!available.has(id)) errors.push(`${role} names an engine that is not installed: ${id}`);
  }
  for (const id of peer) {
    if (!available.has(id)) errors.push(`peer names an engine that is not installed: ${id}`);
  }
  if (assignment?.lead && peer.includes(assignment.lead)) {
    errors.push(`the lead (${assignment.lead}) cannot also be a peer — asking one model to be its own second opinion defeats the point`);
  }

  return { ok: errors.length === 0, errors, assignment: { ...assignment, peer } };
}

/**
 * Whether `level` consults a peer at this `moment` on its own.
 *
 * 'manual' — the "get a second opinion" button — is true at every level
 * including 'off': the setting governs what kaprek does unasked, never what
 * a person may ask for.
 *
 * An unrecognized level consults nothing. Failing towards silence is right
 * here: the cost of a missed automatic consultation is a click, the cost of
 * an unwanted one is somebody's tokens.
 */
export function shouldConsult(level, moment) {
  if (moment === 'manual') return true;
  return (LEVEL_MOMENTS[level] ?? []).includes(moment);
}
