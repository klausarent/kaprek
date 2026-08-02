// A recipe is the shape of a relay run, written down as data.
//
// Relay v1 had one shape: grok writes, claude reviews, forever, with a gate
// every two rounds. That was deliberate — a soft protocol read out of model
// output is how these loops run away — but it also meant the only way to run
// a different pairing was to change code. A recipe keeps the hard part (the
// budget, the gate, the human) and makes the soft part (who, in what order)
// something a file can say.
//
// WHAT A RECIPE MAY NOT DO. It cannot raise its own ceiling, invent an agent
// that is not installed, or skip a gate. Validation is fail-closed and runs
// BEFORE a run starts: a recipe that is wrong is refused with the field that
// is wrong, rather than discovered halfway through a handoff.
import fs from 'node:fs';
import path from 'node:path';
import { RELAY_MAX_TURNS, RELAY_ROUNDS_PER_GATE } from './dispatcher.mjs';

/**
 * Agents a step may name.
 *
 * 'grok' is a text peer driver; 'claude' and 'codex' are full harnesses that
 * run with tools. The dispatcher decides what that means at run time — this
 * list exists so a typo is caught while the user is still looking at their
 * file, not three minutes into a run.
 */
export const RECIPE_AGENTS = ['grok', 'claude', 'codex'];

/** What kaprek does when a budget runs out or a peer keeps failing. */
export const ESCALATION_LEVELS = ['notify', 'question', 'stop'];

/** The recipe used when a caller names none. */
export const DEFAULT_RECIPE_ID = 'write-review';

/** Thrown by validateRecipe. Carries the offending field so a UI can point at it. */
export class InvalidRecipeError extends Error {
  constructor(field, message) {
    super(message);
    this.name = 'InvalidRecipeError';
    this.field = field;
  }
}

export const BUILTIN_RECIPES = Object.freeze([
  {
    id: DEFAULT_RECIPE_ID,
    title: 'One writes, Claude reviews',
    description: 'The v1 pairing: a peer drafts, Claude says plainly what is wrong with it, back and forth until the gate.',
    steps: [
      { id: 'write', agent: 'grok' },
      { id: 'review', agent: 'claude' },
    ],
    edges: [
      { from: 'write', to: 'review' },
      { from: 'review', to: 'write' },
    ],
    builtin: true,
  },
  {
    id: 'write-review-apply',
    title: 'Draft, review, then apply',
    description: 'A peer drafts, Claude reviews, and Codex applies the result to real files — with a human gate on the step that writes.',
    steps: [
      { id: 'write', agent: 'grok' },
      { id: 'review', agent: 'claude' },
      { id: 'apply', agent: 'codex' },
    ],
    edges: [
      { from: 'write', to: 'review' },
      // The one edge that touches the disk asks first. Everything before it
      // is text passing between two readers.
      { from: 'review', to: 'apply', requiresHuman: true },
      { from: 'apply', to: 'write' },
    ],
    builtin: true,
  },
]);

function positiveInt(value, field) {
  if (!Number.isInteger(value) || value < 1) throw new InvalidRecipeError(field, `${field} must be a whole number of at least 1 (got ${JSON.stringify(value)})`);
  return value;
}

function nonNegativeInt(value, field) {
  if (!Number.isInteger(value) || value < 0) throw new InvalidRecipeError(field, `${field} must be a whole number of 0 or more (got ${JSON.stringify(value)})`);
  return value;
}

function enumValue(value, allowed, field) {
  if (!allowed.includes(value)) throw new InvalidRecipeError(field, `${field} must be one of ${allowed.join(', ')} (got ${JSON.stringify(value)})`);
  return value;
}

/**
 * Checks a recipe and returns it normalized: every default filled in, every
 * edge carrying an explicit requiresHuman.
 *
 * @param {object} recipe
 * @param {string[]} [knownAgents] - override for what may appear in
 *   steps[].agent. Passed by callers that know what is actually installed;
 *   defaults to everything kaprek can drive.
 * @throws {InvalidRecipeError}
 */
export function validateRecipe(recipe, knownAgents = RECIPE_AGENTS) {
  if (typeof recipe !== 'object' || recipe === null || Array.isArray(recipe)) throw new InvalidRecipeError('recipe', 'a recipe must be an object');
  if (typeof recipe.id !== 'string' || recipe.id.trim() === '') throw new InvalidRecipeError('id', 'a recipe needs an id');
  if (typeof recipe.title !== 'string' || recipe.title.trim() === '') throw new InvalidRecipeError('title', 'a recipe needs a title');

  const steps = Array.isArray(recipe.steps) ? recipe.steps : [];
  if (steps.length === 0) throw new InvalidRecipeError('steps', 'steps is empty — a recipe needs at least one step to run');

  const seen = new Set();
  const normalizedSteps = steps.map((step, index) => {
    const field = `steps[${index}]`;
    if (typeof step?.id !== 'string' || step.id.trim() === '') throw new InvalidRecipeError(`${field}.id`, `${field}.id must be a non-empty string`);
    if (seen.has(step.id)) throw new InvalidRecipeError(`${field}.id`, `duplicate step id "${step.id}" — edges could not tell the two apart`);
    seen.add(step.id);
    enumValue(step.agent, knownAgents, `${field}.agent`);
    return { id: step.id, agent: step.agent };
  });

  const edges = Array.isArray(recipe.edges) ? recipe.edges : [];
  const normalizedEdges = edges.map((edge, index) => {
    const field = `edges[${index}]`;
    for (const end of ['from', 'to']) {
      if (!seen.has(edge?.[end])) throw new InvalidRecipeError(`${field}.${end}`, `${field}.${end} names a step that does not exist: ${JSON.stringify(edge?.[end])}`);
    }
    return { from: edge.from, to: edge.to, requiresHuman: edge.requiresHuman === true };
  });

  // REACHABILITY. A step nothing leads to would silently never run, and a
  // recipe that quietly skips a third of itself is worse than one that
  // refuses to start.
  const reachable = new Set([normalizedSteps[0].id]);
  for (let changed = true; changed; ) {
    changed = false;
    for (const edge of normalizedEdges) {
      if (reachable.has(edge.from) && !reachable.has(edge.to)) {
        reachable.add(edge.to);
        changed = true;
      }
    }
  }
  const orphan = normalizedSteps.find((step) => !reachable.has(step.id));
  if (orphan) throw new InvalidRecipeError('edges', `no edge leads to step "${orphan.id}" from the first step, so it would never run`);

  const budgets = recipe.budgets ?? {};
  const escalation = recipe.escalation ?? {};

  return {
    id: recipe.id,
    title: recipe.title,
    description: typeof recipe.description === 'string' ? recipe.description : '',
    steps: normalizedSteps,
    edges: normalizedEdges,
    budgets: {
      maxRounds: positiveInt(budgets.maxRounds ?? RELAY_ROUNDS_PER_GATE, 'budgets.maxRounds'),
      hardMaxTurns: positiveInt(budgets.hardMaxTurns ?? RELAY_MAX_TURNS, 'budgets.hardMaxTurns'),
      // Zero is the default and the honest one: a retry is a decision, not a
      // courtesy kaprek extends on its own.
      retriesPerDispatch: nonNegativeInt(budgets.retriesPerDispatch ?? 0, 'budgets.retriesPerDispatch'),
    },
    escalation: {
      onPeerFailure: enumValue(escalation.onPeerFailure ?? 'stop', ESCALATION_LEVELS, 'escalation.onPeerFailure'),
      onBudget: enumValue(escalation.onBudget ?? 'question', ESCALATION_LEVELS, 'escalation.onBudget'),
    },
    builtin: recipe.builtin === true,
  };
}

/**
 * The recipe catalog for `dataDir`: the built-ins plus every valid
 * `<dataDir>/recipes/*.json`. A user file with a builtin's id replaces it.
 *
 * Invalid files are skipped and counted in one warning — the presets.mjs
 * contract. Bad input in one file must never take the catalog down, because
 * the catalog is what the start dialog is built from.
 */
export function loadRecipes(dataDir) {
  const byId = new Map(BUILTIN_RECIPES.map((recipe) => [recipe.id, validateRecipe(recipe)]));

  const dir = path.join(dataDir, 'recipes');
  let fileNames = [];
  try {
    fileNames = fs.readdirSync(dir).filter((name) => name.endsWith('.json'));
  } catch {
    fileNames = [];
  }

  let skipped = 0;
  for (const name of fileNames.sort()) {
    try {
      const parsed = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8'));
      byId.set(parsed.id, { ...validateRecipe(parsed), builtin: false });
    } catch {
      skipped += 1;
    }
  }
  if (skipped > 0) console.warn(`recipes: skipped ${skipped} invalid recipe file(s) in ${dir}`);
  return [...byId.values()];
}

/**
 * The v1 call shape as a recipe: a ring through the route, no edge gates,
 * the round gate doing what it always did.
 *
 * Exists so `startRun({route, maxRounds})` keeps working unchanged. The 17
 * dispatcher tests written against it are a contract, not scaffolding.
 */
export function routeFromLegacy({ route = [], maxRounds = RELAY_ROUNDS_PER_GATE } = {}) {
  // A route may name the same peer twice; step ids must still be unique, so
  // the position is what identifies a step here.
  const steps = route.map((agent, index) => ({ id: route.indexOf(agent) === index ? agent : `${agent}-${index + 1}`, agent }));
  const edges = steps.map((step, index) => ({
    from: step.id,
    to: steps[(index + 1) % steps.length].id,
    requiresHuman: false,
  }));
  return validateRecipe({
    id: 'legacy-route',
    title: route.join(' → '),
    description: 'The route this run was started with, before recipes existed.',
    steps,
    edges,
    budgets: { maxRounds },
  });
}

/**
 * A walker over a validated recipe: where a run starts and where each step
 * hands off to.
 *
 * Returns the EDGE alongside the target step, because the edge is what
 * carries requiresHuman — the dispatcher has to know it is crossing a gate
 * before it runs the step on the other side.
 */
export function stepsOf(recipe) {
  const byId = new Map(recipe.steps.map((step) => [step.id, step]));
  return {
    first: recipe.steps[0],
    get(id) {
      return byId.get(id) ?? null;
    },
    /**
     * The first edge leaving `stepId`, or null at a dead end. First rather
     * than "pick one": a run has to be reproducible from the log, and a
     * choice made at run time is not.
     */
    next(stepId) {
      const edge = recipe.edges.find((candidate) => candidate.from === stepId);
      if (!edge) return null;
      return { edge, to: byId.get(edge.to) };
    },
  };
}
