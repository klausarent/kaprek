// The quiz protocol — how an agent asks a question kaprek can render as
// buttons instead of a paragraph.
//
// Klaus, after watching a brainstorming session go by as a wall of prose:
// "Wenn jemand etwas plant oder aktiv brainstormen möchte soll ein Popup
// kommen und der Nutzer kann das mit einem visuellen Quiz machen statt alles
// in einem Text wie hier durchzugehen."
//
// The transport is a fenced block in the agent's own answer rather than a
// tool call. Three reasons, in order of weight:
//   1. The brainstorming skill already ends its turn after every question
//      ("one question at a time"). A turn round-trip IS the natural beat;
//      a tool call would fight it.
//   2. It works with every engine kaprek can drive, Codex included, with no
//      MCP process, no hole in the sandbox, and no dependency on CLI
//      internals that change between releases.
//   3. The approval round-trip stays exactly as it is. A quiz is not a
//      permission, and the two must never be answered by the same widget.
//
// When an agent ignores the protocol, parseQuiz returns null and the text
// stands as it does today. That fail-OPEN is deliberate and is the one place
// in kaprek where it is: an unanswerable question is worse than an ugly one.
// Everything INSIDE a block, by contrast, is validated fail-closed.

import { scanFences } from './markdown.mjs';

/** The info string of the fenced block: ```kaprek-quiz */
export const QUIZ_FENCE = 'kaprek-quiz';

/** Caps — a malformed or runaway block must not become an unusable screen. */
const MAX_QUESTIONS = 10;
const MAX_OPTIONS = 8;
const MAX_LABEL_LEN = 120;
const MAX_QUESTION_LEN = 400;

/**
 * Every top-level fence whose info string is `kaprek-quiz`.
 *
 * Uses markdown.mjs's fence scanner rather than a regex over the raw text:
 * a regex cannot tell a real block from one shown INSIDE a longer ````
 * fence, which is exactly how the protocol gets explained (in this file's
 * own doc comment, in the mode prompt, in the README). Codex' review turned
 * that from a theoretical concern into a reproducible false positive.
 */
function quizBlocks(text) {
  return scanFences(text.split('\n')).filter((block) => block.info.toLowerCase() === QUIZ_FENCE);
}

function trimmedString(value, maxLen) {
  if (typeof value !== 'string') return '';
  const trimmed = value.trim();
  return trimmed.length > maxLen ? `${trimmed.slice(0, maxLen)}…` : trimmed;
}

/** One option, or null when there is nothing clickable about it. */
function normalizeOption(raw) {
  const label = trimmedString(typeof raw === 'string' ? raw : raw?.label, MAX_LABEL_LEN);
  if (label === '') return null;
  const description = trimmedString(raw?.description, MAX_QUESTION_LEN);
  return { label, ...(description === '' ? {} : { description }) };
}

/**
 * One question, or null when it cannot be answered at all: no text, or no
 * options AND no free-text field. Dropping the individual question rather
 * than the whole quiz keeps one sloppy entry from costing the user the other
 * three questions that were fine.
 */
function normalizeQuestion(raw, index) {
  if (!raw || typeof raw !== 'object') return null;
  const question = trimmedString(raw.question ?? raw.text, MAX_QUESTION_LEN);
  if (question === '') return null;

  const options = (Array.isArray(raw.options) ? raw.options : []).slice(0, MAX_OPTIONS).map(normalizeOption).filter(Boolean);
  // Free text is on unless the agent explicitly says otherwise: the whole
  // point of the quiz is to be faster than typing, not to be narrower.
  const allowOther = raw.allowOther !== false;
  // A single option with no way to say anything else is an announcement, not
  // a question — there is nothing for the user to decide.
  if (options.length < 2 && !allowOther) return null;

  return {
    id: trimmedString(raw.id, MAX_LABEL_LEN) || `q${index + 1}`,
    header: trimmedString(raw.header, 32),
    question,
    options,
    multiSelect: raw.multiSelect === true,
    allowOther,
  };
}

/**
 * Pulls the quiz out of an assistant message.
 *
 * @param {string} text - the assistant's full answer for the turn
 * @returns {{questions: Array<object>, done: boolean}|null} null when there
 *   is no usable block: no fence, unparseable JSON, or nothing answerable
 *   left after validation. The LAST block wins, so an agent that shows the
 *   format as an example before asking the real question still works.
 */
export function parseQuiz(text) {
  if (typeof text !== 'string') return null;

  // Only the LAST block is considered, and if it is unclosed or does not
  // parse, the answer is null — never an earlier block. Codex' review caught
  // the difference: "keep the last one that parsed" means an example block
  // followed by a real block cut off mid-stream re-asks the EXAMPLE. A stale
  // question presented as live is worse than no question at all.
  const blocks = quizBlocks(text);
  const last = blocks[blocks.length - 1];
  if (!last || last.end === null) return null;

  let payload = null;
  try {
    const parsed = JSON.parse(last.body);
    if (parsed && typeof parsed === 'object') payload = parsed;
  } catch {
    return null;
  }
  if (!payload) return null;

  const done = payload.done === true || payload.status === 'done';
  const questions = (Array.isArray(payload.questions) ? payload.questions : [])
    .slice(0, MAX_QUESTIONS)
    .map(normalizeQuestion)
    .filter(Boolean);

  // Answers are keyed by id, so two questions sharing one id would share one
  // answer — the second card would silently overwrite the first.
  const seen = new Set();
  for (const question of questions) {
    let id = question.id;
    for (let n = 2; seen.has(id); n += 1) id = `${question.id}-${n}`;
    question.id = id;
    seen.add(id);
  }

  // "done" is a valid quiz with nothing to ask; anything else needs at least
  // one answerable question or there is no reason to show a dialog.
  if (!done && questions.length === 0) return null;
  return { questions, done };
}

/**
 * Renders the user's answers back into the prompt for the next turn.
 *
 * Quotes each question alongside its answer instead of sending bare choices:
 * the agent sees this as an ordinary user message with no memory of which
 * widget produced it, and "Plain text" on its own is not an answer to
 * anything.
 *
 * @param {{questions: Array<object>}} quiz - what parseQuiz returned
 * @param {Record<string, {selected?: string[], other?: string}>} answers - keyed by question id
 */
export function formatAnswers(quiz, answers = {}) {
  const lines = [];
  for (const question of quiz?.questions ?? []) {
    const answer = answers?.[question.id] ?? {};
    const picked = (Array.isArray(answer.selected) ? answer.selected : []).filter((s) => typeof s === 'string' && s.trim() !== '');
    const other = typeof answer.other === 'string' ? answer.other.trim() : '';

    const parts = [];
    if (picked.length > 0) parts.push(picked.join(', '));
    if (other !== '') parts.push(other);
    // An unanswered question is stated as such. Dropping it would let the
    // agent assume it had been answered by the ones that were.
    lines.push(`- ${question.question}\n  ${parts.length > 0 ? parts.join(' — ') : '(skipped)'}`);
  }
  return `My answers:\n\n${lines.join('\n')}`;
}
