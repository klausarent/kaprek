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
  for (let line = 0; line < lines.length; line += 1) {
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
