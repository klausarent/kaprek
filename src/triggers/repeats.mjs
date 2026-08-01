// Repeat detection — "you have asked for this three times, want it on a
// schedule?"
//
// Klaus' observation from the first recorded run: the work that deserves a
// trigger is exactly the work you keep typing by hand, and you notice it
// about two repetitions later than you should. This module reads the chat
// store's own user turns and reports what someone has now asked for often
// enough that offering an automation is a service rather than a nag.
//
// Deliberately dumb on purpose: no model call, no embedding, no learning.
// A normalized-prefix match over recent user prompts is cheap, explainable,
// and wrong in an obvious way rather than a mysterious one — and the whole
// suggestion is a question a human answers, never an automation that
// creates itself.

/** How many times the same request must appear before it is worth offering. */
export const REPEAT_THRESHOLD = 3;
/** Prompts older than this never count towards a repeat. */
export const REPEAT_WINDOW_DAYS = 30;
/**
 * How many leading WORDS make the comparison key. Words, not characters: a
 * character prefix breaks on a trailing "please" (it shifts nothing, but it
 * lands inside the window and changes the key) — the first six words survive
 * politeness, punctuation, and casing while still telling two different
 * requests apart.
 */
const PREFIX_WORDS = 6;
/** Fewer words than this is a steering turn ("yes", "go on"), not a request. */
const MIN_WORDS = 4;

/** Lowercased, punctuation-free words of a prompt. */
function words(text) {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/)
    .filter(Boolean);
}

/**
 * The comparison key for one prompt: its first six meaningful words. Two
 * prompts that differ only in politeness, casing, or punctuation collapse to
 * the same key; two genuinely different requests do not. Returns '' for
 * anything too short to be a request at all.
 */
export function repeatKey(text) {
  if (typeof text !== 'string') return '';
  const parts = words(text);
  if (parts.length < MIN_WORDS) return '';
  return parts.slice(0, PREFIX_WORDS).join(' ');
}

/**
 * Finds requests repeated at least `threshold` times within the window.
 *
 * @param {Array<{kind: string, text?: string, ts?: string}>} events - chat events, any chats mixed
 * @returns {Array<{key: string, count: number, sample: string, lastTs: string|null}>}
 *   most-repeated first; `sample` is the LATEST phrasing (the one a trigger
 *   would be created from, so the user recognizes their own words).
 */
export function findRepeats(events, { threshold = REPEAT_THRESHOLD, now = Date.now(), windowDays = REPEAT_WINDOW_DAYS } = {}) {
  const cutoff = now - windowDays * 24 * 60 * 60 * 1000;
  const groups = new Map();
  for (const event of events ?? []) {
    if (event?.kind !== 'user' || typeof event.text !== 'string') continue;
    const key = repeatKey(event.text);
    if (key === '') continue; // too short to be a request (see repeatKey)
    const ts = event.ts ? Date.parse(event.ts) : NaN;
    if (Number.isFinite(ts) && ts < cutoff) continue;
    const existing = groups.get(key);
    if (existing) {
      existing.count += 1;
      if (!Number.isFinite(ts) || !Number.isFinite(existing.lastMs) || ts >= existing.lastMs) {
        existing.sample = event.text;
        existing.lastMs = Number.isFinite(ts) ? ts : existing.lastMs;
        existing.lastTs = event.ts ?? existing.lastTs;
      }
    } else {
      groups.set(key, { key, count: 1, sample: event.text, lastTs: event.ts ?? null, lastMs: Number.isFinite(ts) ? ts : null });
    }
  }
  return [...groups.values()]
    .filter((group) => group.count >= threshold)
    .sort((a, b) => b.count - a.count)
    .map(({ key, count, sample, lastTs }) => ({ key, count, sample, lastTs }));
}
