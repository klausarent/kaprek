// The converge protocol: how an agent reports where the work and the plan
// disagree, and how that report becomes steps in the plan file.
//
// "Done" is a claim. A converge turn checks it: the agent reads the plan,
// looks only at the files the plan names, and reports every gap — as a
// fenced block, like the quiz, so kaprek can read it without guessing at
// prose. No gaps means converged, and only a converged plan may be marked
// done (store.mjs enforces that; a person can override it, visibly).
//
// The taxonomy is borrowed from spec-kit's /speckit-converge (MIT): a gap is
// `missing`, `partial`, `contradicts`, or `unrequested` — the last one is
// reported, never deleted, because work nobody asked for is still work
// somebody should know about. The prompt is kaprek's own (plans/prompt.mjs).
import { scanFences } from './markdown.mjs';

/** The info string of the fenced block: ```kaprek-findings */
export const FINDINGS_FENCE = 'kaprek-findings';

export const GAP_TYPES = ['missing', 'partial', 'contradicts', 'unrequested'];
export const SEVERITIES = ['critical', 'high', 'medium', 'low'];

/** Caps — a runaway block must not become a hundred new steps in someone's plan file. */
const MAX_FINDINGS = 40;
const MAX_SHORT = 200;
const MAX_LONG = 600;

function findingsBlocks(text) {
  return scanFences(text.split('\n')).filter((block) => block.info.toLowerCase() === FINDINGS_FENCE);
}

function trimmedString(value, maxLen) {
  if (typeof value !== 'string') return '';
  const trimmed = value.trim().replace(/\s+/g, ' ');
  return trimmed.length > maxLen ? `${trimmed.slice(0, maxLen)}…` : trimmed;
}

/**
 * One finding, or null when there is nothing actionable in it. A finding
 * with no remaining work and no evidence is an opinion, not a gap.
 */
function normalizeFinding(raw, index) {
  if (!raw || typeof raw !== 'object') return null;
  const remainingWork = trimmedString(raw.remainingWork ?? raw.remaining_work ?? raw.work, MAX_LONG);
  const evidence = trimmedString(raw.evidence, MAX_LONG);
  if (remainingWork === '' && evidence === '') return null;
  const gapType = typeof raw.gapType === 'string' && GAP_TYPES.includes(raw.gapType.toLowerCase()) ? raw.gapType.toLowerCase() : 'missing';
  const severity = typeof raw.severity === 'string' && SEVERITIES.includes(raw.severity.toLowerCase()) ? raw.severity.toLowerCase() : 'medium';
  return {
    id: trimmedString(raw.id, 40) || `F${index + 1}`,
    sourceRef: trimmedString(raw.sourceRef ?? raw.source_ref ?? raw.source, MAX_SHORT),
    gapType,
    severity,
    evidence,
    remainingWork: remainingWork === '' ? '(see evidence)' : remainingWork,
  };
}

/**
 * Pulls the findings out of an assistant message.
 *
 * @param {string} text - the assistant's full answer for the turn
 * @returns {{converged: boolean, findings: Array<object>, checked: {requirements: number|null, files: number|null}}|null}
 *   null when there is no usable block. Like the quiz, only the LAST block
 *   counts, and an unclosed or unparseable last block is null rather than
 *   an earlier block promoted to "the result".
 *
 *   `converged` is what the agent CLAIMED only when it is consistent with
 *   the findings: a block that says converged and lists a gap is a block
 *   with a gap. Zero findings without the claim is likewise not converged —
 *   an agent that reports nothing and says nothing has not said the work
 *   is complete.
 */
export function parseFindings(text) {
  if (typeof text !== 'string') return null;
  const blocks = findingsBlocks(text);
  const last = blocks[blocks.length - 1];
  if (!last || last.end === null) return null;

  let payload = null;
  try {
    const parsed = JSON.parse(last.body);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) payload = parsed;
  } catch {
    return null;
  }
  if (!payload) return null;

  const findings = (Array.isArray(payload.findings) ? payload.findings : []).slice(0, MAX_FINDINGS).map(normalizeFinding).filter(Boolean);
  const seen = new Set();
  for (const finding of findings) {
    let id = finding.id;
    for (let n = 2; seen.has(id); n += 1) id = `${finding.id}-${n}`;
    finding.id = id;
    seen.add(id);
  }

  const claimed = payload.converged === true;
  if (!claimed && findings.length === 0) return null;

  const count = (value) => (Number.isInteger(value) && value >= 0 ? value : null);
  return {
    converged: claimed && findings.length === 0,
    findings,
    checked: { requirements: count(payload.checked?.requirements), files: count(payload.checked?.files) },
  };
}

/**
 * The markdown appended to the plan file for one converge round: a heading
 * and one unchecked step per finding, in the same checkbox form the rest of
 * the plan uses, so parseSteps() and the plans page pick them up unchanged.
 * Append-only by design — the agent's findings never rewrite what a person
 * wrote above them.
 */
export function renderFindingsSection({ round, findings, ts }) {
  const date = String(ts ?? '').slice(0, 10);
  const lines = ['', `## Convergence round ${round}${date ? ` (${date})` : ''}`, ''];
  for (const finding of findings) {
    const ref = finding.sourceRef ? `, ${finding.sourceRef}` : '';
    lines.push(`- [ ] **${finding.id} (${finding.severity}, ${finding.gapType}${ref}):** ${finding.remainingWork}${finding.evidence ? ` — ${finding.evidence}` : ''}`);
  }
  lines.push('');
  return lines.join('\n');
}

/** Appends a converge round to a plan document, keeping the file's own line endings. */
export function appendFindingsSection(markdown, section) {
  const doc = typeof markdown === 'string' ? markdown : '';
  const eol = doc.includes('\r\n') ? '\r\n' : '\n';
  const body = section.replace(/\r?\n/g, eol);
  const base = doc === '' || doc.endsWith(eol) ? doc : `${doc}${eol}`;
  return `${base}${body}`;
}
