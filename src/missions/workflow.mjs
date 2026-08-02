// A way of working, written down as one file you can hand to someone.
//
// M5's question is "what is the unit that leaves this machine?" — and the
// answer has to be small enough to read in one sitting and complete enough
// to run. A preset alone is not it: a real workflow is a preset (how the
// mission starts) plus the recipe (who takes part in the handoffs) plus the
// council level (how much second-guessing) plus the memory profile (what a
// newcomer to this work has to know before their first turn).
//
// So a workflow bundles exactly those four, and nothing else. Not chats, not
// runs, not the board, and above all not a data directory: the point is
// something a person can read before they trust it.
//
// WHAT IT MUST NEVER CARRY. A workflow file crosses machines, so anything in
// it is something you have published. Absolute paths (which name a person and
// their disk), tokens, and env values are refused at export rather than
// stripped — silently removing half a field would produce a file that looks
// complete and is not.
import fs from 'node:fs';
import path from 'node:path';

export const WORKFLOW_VERSION = 1;

export class InvalidWorkflowError extends Error {
  constructor(field, message) {
    super(message);
    this.name = 'InvalidWorkflowError';
    this.field = field;
  }
}

/** Anything that looks like it belongs to one machine or one account. */
const SECRET_HINT = /\b([A-Z0-9_]*(?:TOKEN|SECRET|KEY|PASSWORD|CREDENTIAL)[A-Z0-9_]*)\b|\bsk-[A-Za-z0-9]{8,}|\bghp_[A-Za-z0-9]{8,}/;
// Windows drive letters, UNC shares, ~ expansions, and any absolute POSIX
// path — not just the three home directories the first version knew about.
// /opt, /var, /tmp and \\server\share name one machine just as much as
// /home/klaus does. (Grok's review.)
const ABSOLUTE_PATH = /(^|[\s"'(=])([A-Za-z]:[\\/]|\\\\[^\\\s]+\\|~[/\\]|\/[A-Za-z_][\w.-]*\/)/;

/**
 * Refuses text that should not cross a machine boundary.
 *
 * Refusing rather than redacting, on purpose: a workflow with a hole where a
 * path used to be still looks like a workflow, and the person who receives it
 * finds out at run time. The person EXPORTING is the one who can fix it.
 */
/** Walks a value and checks every string in it, wherever it sits. */
function assertEveryString(value, field) {
  if (typeof value === 'string') {
    assertPortable(value, field);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((entry, index) => assertEveryString(entry, `${field}[${index}]`));
    return;
  }
  if (value && typeof value === 'object') {
    for (const [key, entry] of Object.entries(value)) assertEveryString(entry, `${field}.${key}`);
  }
}

function assertPortable(value, field) {
  if (typeof value !== 'string' || value === '') return;
  if (SECRET_HINT.test(value)) {
    throw new InvalidWorkflowError(field, `${field} looks like it contains a secret or names one. A workflow is meant to be shared, so take it out before exporting.`);
  }
  if (ABSOLUTE_PATH.test(value)) {
    throw new InvalidWorkflowError(field, `${field} contains an absolute path, which only means something on your machine. Describe the directory instead of naming it.`);
  }
}

/**
 * Builds a workflow from the parts that are already lying around.
 *
 * @param {object} parts
 * @param {{id: string, title: string, description?: string, goalTemplate?: string, firstPrompt: string}} parts.preset
 * @param {object|null} [parts.recipe] - a validated relay recipe, or null
 * @param {string|null} [parts.councilLevel]
 * @param {string[]} [parts.profile] - what someone new to this work needs to know
 */
export function buildWorkflow({ id, title, description = '', preset, recipe = null, councilLevel = null, profile = [] }) {
  if (typeof id !== 'string' || !/^[a-z0-9][a-z0-9-]*$/.test(id)) {
    throw new InvalidWorkflowError('id', 'a workflow id is lowercase letters, digits and dashes — it becomes a file name');
  }
  if (typeof title !== 'string' || title.trim() === '') throw new InvalidWorkflowError('title', 'a workflow needs a title');
  if (!preset || typeof preset.firstPrompt !== 'string') throw new InvalidWorkflowError('preset', 'a workflow needs a preset with a first prompt');

  // EVERY string that ends up in the file, not the four that were obvious.
  // A path in preset.description or a token in a recipe's title travels just
  // as far as one in the first prompt, and a hand-kept list of fields was
  // already out of step with the shape the day it was written. (Grok's
  // review.)
  assertEveryString({ title, description, preset, recipe, profile }, 'workflow');

  return {
    version: WORKFLOW_VERSION,
    id,
    title: title.trim(),
    description,
    preset: {
      id: preset.id ?? id,
      title: preset.title ?? title,
      description: preset.description ?? '',
      goalTemplate: preset.goalTemplate ?? '',
      firstPrompt: preset.firstPrompt,
    },
    recipe,
    councilLevel,
    // Facts the work depends on, which is what makes a workflow more than a
    // prompt: the person receiving it gets the context the author had.
    profile: [...profile],
  };
}

/** Checks a workflow that arrived from somewhere else. */
export function validateWorkflow(parsed) {
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new InvalidWorkflowError('workflow', 'a workflow file must contain one object');
  if (parsed.version !== WORKFLOW_VERSION) {
    throw new InvalidWorkflowError('version', `this file says version ${parsed.version}, and this kaprek understands version ${WORKFLOW_VERSION}`);
  }
  // Rebuilt through the same door it left by, so an imported workflow cannot
  // carry anything an exported one could not.
  return buildWorkflow({
    id: parsed.id,
    title: parsed.title,
    description: parsed.description ?? '',
    preset: parsed.preset,
    recipe: parsed.recipe ?? null,
    councilLevel: parsed.councilLevel ?? null,
    profile: Array.isArray(parsed.profile) ? parsed.profile.filter((line) => typeof line === 'string') : [],
  });
}

function workflowDir(dataDir) {
  return path.join(dataDir, 'workflows');
}

/** Writes it where the catalog will find it, and returns the path — a workflow is a file you can hand over. */
export function saveWorkflow(dataDir, workflow) {
  const validated = validateWorkflow({ ...workflow, version: WORKFLOW_VERSION });
  const dir = workflowDir(dataDir);
  fs.mkdirSync(dir, { recursive: true });
  const target = path.join(dir, `${validated.id}.json`);
  fs.writeFileSync(target, `${JSON.stringify(validated, null, 2)}\n`, 'utf8');
  return { path: target, workflow: validated };
}

/**
 * Every valid workflow in the data dir.
 *
 * An invalid one is skipped and counted rather than taking the list down —
 * the presets.mjs contract, for the same reason: this list is what a start
 * dialog is built from.
 */
export function loadWorkflows(dataDir) {
  let names = [];
  try {
    names = fs.readdirSync(workflowDir(dataDir)).filter((name) => name.endsWith('.json'));
  } catch {
    return [];
  }

  const workflows = [];
  let skipped = 0;
  for (const name of names.sort()) {
    try {
      workflows.push(validateWorkflow(JSON.parse(fs.readFileSync(path.join(workflowDir(dataDir), name), 'utf8'))));
    } catch {
      skipped += 1;
    }
  }
  if (skipped > 0) console.warn(`workflows: skipped ${skipped} invalid file(s) in ${workflowDir(dataDir)}`);
  return workflows;
}

/**
 * What importing one actually changes, listed before anything is written.
 *
 * A workflow sets the council level and adds a recipe — both of which change
 * how future runs behave. Someone importing a file from a colleague deserves
 * to see that in a sentence rather than discover it later.
 */
export function importSummary(workflow) {
  const lines = [`Adds the way of working "${workflow.title}".`];
  // A hand-edited file can carry a recipe with no steps. That belongs in the
  // 400 the route returns, not in a crash inside the sentence meant to
  // explain the file. (Grok's review.)
  if (Array.isArray(workflow.recipe?.steps) && workflow.recipe.steps.length > 0) {
    const chain = workflow.recipe.steps.map((step) => step.agent).join(' → ');
    const writes = workflow.recipe.steps.filter((step) => step.tools === 'full').map((step) => step.id);
    lines.push(`Relay recipe: ${chain}${writes.length > 0 ? ` (${writes.join(', ')} may change files)` : ''}.`);
  }
  if (workflow.councilLevel) lines.push(`Sets the council level to "${workflow.councilLevel}" for work started from it.`);
  if (workflow.profile.length > 0) lines.push(`Adds ${workflow.profile.length} note(s) to this project's memory.`);
  return lines;
}
