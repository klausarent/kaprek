// The two guided modes, as text appended to the CLI's system prompt.
//
// kaprek does not put these rules in the user's own message — the user's
// prompt stays their words. `--append-system-prompt` (verified present in
// Claude Code 2.1.x) carries the mode alongside it.
//
// The prompts are short on purpose. A long list of rules produces a stiff
// agent that recites the format instead of thinking about the problem; what
// it actually needs to know is the fence, the beat (one packet per turn),
// and where the file goes.
import path from 'node:path';
import { QUIZ_FENCE } from './quiz.mjs';

/** brainstorm: ask through the quiz. plan: write the plan file. */
export const PLAN_MODES = ['brainstorm', 'plan'];

export class InvalidModeError extends Error {
  constructor(mode) {
    super(`invalid mode: ${mode} (expected one of ${PLAN_MODES.join(', ')})`);
    this.name = 'InvalidModeError';
    this.mode = mode;
  }
}

/** Where guided plans go when there is no project directory to put them in. */
const WORKSPACE_PLANS = ['workspace', 'plans'];
/** Inside a project, plans live where the writing-plans skill already puts them. */
const PROJECT_PLANS = ['docs', 'plans'];

/**
 * A filename-safe slug. Anything that is not a letter, digit, or dash is a
 * separator; the result can therefore never contain a path separator, a
 * drive letter, or `..`, which is what keeps a hostile or careless topic
 * from steering the file out of its directory.
 */
function slug(topic) {
  const cleaned = String(topic ?? '')
    .toLowerCase()
    .replace(/ä/g, 'ae')
    .replace(/ö/g, 'oe')
    .replace(/ü/g, 'ue')
    .replace(/ß/g, 'ss')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
    .replace(/-+$/, '');
  return cleaned === '' ? 'plan' : cleaned;
}

/**
 * The absolute path a guided plan will be written to — decided BEFORE the
 * turn runs, which is the whole point: the agent is told where to write
 * rather than asked afterwards where it wrote.
 *
 * @param {string|null} options.cwd - the mission's working directory, if any
 * @param {string} [options.dataDir] - kaprek's own data dir, used when cwd is null
 * @param {string} options.topic - what the plan is about; slugged, never trusted
 * @param {string} options.ts - ISO timestamp; the date part prefixes the file
 */
export function planPathFor({ cwd, dataDir, topic, ts }) {
  const date = String(ts ?? '').slice(0, 10) || '0000-00-00';
  const name = `${date}-${slug(topic)}.md`;
  const base = cwd ? path.resolve(cwd, ...PROJECT_PLANS) : path.resolve(dataDir ?? '.', ...WORKSPACE_PLANS);
  return path.join(base, name);
}

const BRAINSTORM = (planPath) => `# kaprek guided brainstorming

You are working through a design with someone who is looking at buttons, not
at a terminal. Ask your questions as a quiz block instead of as prose.

Every time you need something from them, end your turn with exactly one
block, and put nothing after it:

\`\`\`${QUIZ_FENCE}
{"questions": [
  {"id": "scope", "header": "Scope", "question": "What should it do on day one?",
   "options": [
     {"label": "One thing well", "description": "A single flow, no settings"},
     {"label": "The full shape", "description": "Every screen roughed in"}
   ],
   "multiSelect": false}
]}
\`\`\`

Rules that matter:
- One block per turn, one to three questions in it. End your turn after it —
  the turn ending IS the question being asked. Do not keep working.
- Two to four options, each with a short description of what choosing it
  means. The person can always write their own answer instead.
- Prose above the block is fine and welcome: say what you understood and
  what you are unsure about. Never repeat the questions as prose.
- Ask about purpose, constraints, and what "done" looks like. Do not ask
  about anything you can find out yourself by reading the code.
- When you have enough to design with, send \`{"done": true}\` in the block,
  present the design in prose, and write it to:

  ${planPath}

Create the directory if it is missing. Use that exact path — it is what the
person will click on afterwards.`;

const PLAN = (planPath) => `# kaprek guided planning

Write the implementation plan to exactly this file:

  ${planPath}

Create the directory if it is missing. Use that exact path — kaprek shows it
to the person as a link, so a plan written anywhere else is a plan they
cannot find.

Format every actionable step as a markdown checkbox, because kaprek ticks
them off in this file as the work proceeds:

- [ ] **Step 1: Write the failing test**
- [ ] **Step 2: Run it and watch it fail**

Group steps under a heading per task, name the exact files each task touches,
and put real content in every step — no "TBD", no "add error handling", no
"similar to the task above". Someone who has never seen this codebase has to
be able to follow it.

If you need a decision from the person before you can write the plan, ask it
as a quiz block (see the brainstorming mode) rather than guessing.`;

/**
 * The system-prompt appendix for one guided turn.
 *
 * @throws {InvalidModeError} for anything not in PLAN_MODES — a typo'd mode
 *   must not silently degrade into an ordinary turn the user thinks is guided.
 */
export function buildModePrompt({ mode, planPath }) {
  if (!PLAN_MODES.includes(mode)) throw new InvalidModeError(mode);
  return mode === 'brainstorm' ? BRAINSTORM(planPath) : PLAN(planPath);
}
