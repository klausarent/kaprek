// Reading and ticking the checkboxes in a plan file.
//
// The plan on disk is the single source of truth for its own steps — kaprek
// keeps no parallel copy. Ticking a box rewrites that one line and leaves
// every other byte alone, so a plan stays a file the user owns, editable in
// their own editor, diffable in their own git, and not a rendering of some
// state we hold elsewhere. This is also why a plan written by hand works in
// the UI without ever having been "created" by kaprek.
//
// The `- [ ]` convention comes from the writing-plans skill's own output
// format, which is what most plans kaprek sees will be written in.

/** A checkbox line: leading space, a bullet, `[ ]` or `[x]`, then the text. */
const STEP_RE = /^(\s*)([-*])\s\[([ xX])\]\s(.*)$/;

/**
 * A fence line: three or more backticks or tildes. CommonMark closes a fence
 * only with the same character and at least as many of them, which is what
 * lets a ```` block contain a ``` one.
 */
const FENCE_RE = /^\s{0,3}(`{3,}|~{3,})\s*(.*)$/;

/**
 * Every top-level fenced block in `lines`.
 *
 * Shared with quiz.mjs, which needs the same answer for a different reason:
 * a ```kaprek-quiz block shown INSIDE a longer ```` fence is someone
 * explaining the protocol, not using it. Nesting is resolved the CommonMark
 * way — a fence closes only on the same character, at least as long, with
 * nothing after it — which is exactly what makes ```` able to contain ```.
 *
 * @returns {Array<{info: string, start: number, end: number|null, body: string}>}
 *   `end` is null for a fence that is never closed (a stream cut off
 *   mid-block); `body` is what sits between the fence lines.
 */
export function scanFences(lines) {
  const blocks = [];
  let open = null;
  for (let i = 0; i < lines.length; i += 1) {
    const match = FENCE_RE.exec(lines[i]);
    if (!match) continue;
    if (open === null) {
      open = { marker: match[1], info: match[2].trim(), start: i };
      continue;
    }
    if (match[1][0] === open.marker[0] && match[1].length >= open.marker.length && match[2].trim() === '') {
      blocks.push({ info: open.info, start: open.start, end: i, body: lines.slice(open.start + 1, i).join('\n') });
      open = null;
    }
  }
  if (open !== null) blocks.push({ info: open.info, start: open.start, end: null, body: lines.slice(open.start + 1).join('\n') });
  return blocks;
}

/**
 * Whether each line sits inside a fenced code block.
 *
 * Codex' adversarial review found this: kaprek's own guided-plan prompt shows
 * the checkbox format inside a fence, so a plan quoting it would grow phantom
 * steps — and ticking one would rewrite the example instead of the step. An
 * unclosed fence swallows everything after it, matching CommonMark and
 * erring towards "not a step" rather than guessing where the author meant to
 * close it.
 */
function fencedLines(lines) {
  const inFence = new Array(lines.length).fill(false);
  for (const block of scanFences(lines)) {
    for (let i = block.start; i <= (block.end ?? lines.length - 1); i += 1) inFence[i] = true;
  }
  return inFence;
}

/**
 * Every checkbox in the document, in order.
 *
 * @param {unknown} markdown
 * @returns {Array<{index: number, line: number, text: string, done: boolean}>}
 *   `line` is the 0-based line number, kept so setStep can find the same
 *   line again without re-deriving it from the text (two steps can be
 *   worded identically).
 */
export function parseSteps(markdown) {
  if (typeof markdown !== 'string') return [];
  const steps = [];
  const lines = markdown.split('\n');
  const fenced = fencedLines(lines);
  for (let line = 0; line < lines.length; line += 1) {
    if (fenced[line]) continue;
    const match = STEP_RE.exec(lines[line]);
    if (!match) continue;
    steps.push({ index: steps.length, line, text: match[4].trim(), done: match[3].toLowerCase() === 'x' });
  }
  return steps;
}

/**
 * Returns the document with step `index` ticked or unticked.
 *
 * @throws {RangeError} when there is no such step — a step that vanished
 *   (the file was edited underneath us) must surface as an error the caller
 *   can report, never as a write that silently hits the wrong line.
 */
export function setStep(markdown, index, done) {
  const steps = parseSteps(markdown);
  const step = steps[index];
  if (!step || index < 0) throw new RangeError(`no step at index ${index} (plan has ${steps.length})`);

  const lines = markdown.split('\n');
  lines[step.line] = lines[step.line].replace(STEP_RE, (_, indent, bullet, __, text) => `${indent}${bullet} [${done ? 'x' : ' '}] ${text}`);
  return lines.join('\n');
}

/** The document's first heading, or null when it has none. */
export function planTitle(markdown) {
  if (typeof markdown !== 'string') return null;
  for (const line of markdown.split('\n')) {
    const match = /^#{1,6}\s+(.+?)\s*$/.exec(line);
    if (match) return match[1];
  }
  return null;
}
