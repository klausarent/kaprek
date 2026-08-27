// Search verdicts: does a hit still point at the world it describes?
//
// A session mentions files. Months later a search finds the session, and the
// question the reader actually has is not "what did this say" but "is this
// still true" — and the cheapest honest answer is whether the files it named
// are still there, and whether they changed since. So the index keeps the
// paths a session mentioned (extracted once, at index time, from the same
// redacted user/assistant text the FTS document holds), and every search
// checks them against the disk at query time: present, changed since the
// session, or gone. Nothing is inferred from content; the verdict is
// fs.stat and a date comparison, the same posture as receipt-verify
// (always against what IS) and memory-stale (marked, never deleted).
//
// The idea is heimdall's (ArihantDeva/heimdall, MIT): rank first, verify
// each hit against the disk second. Its "moved" search and its coverage
// score are deliberately left out — a basename scan per hit costs directory
// walks on every search, and a coverage number the author calls
// "uncalibrated" would be a number for the sake of one.
import fs from 'node:fs';
import path from 'node:path';

/** How many distinct paths one session keeps. Past this the session is a log, not a map. */
export const MAX_PATHS_PER_SESSION = 200;
/** How many of a hit's paths are stat'ed per search. Bounds a search over 50 hits at 2,500 stats. */
export const MAX_PATHS_CHECKED = 50;
/** How many example paths ride along with the counts. */
const MAX_SAMPLE = 5;

const TRAILING_PUNCT = /[.,;:!?)\]}'"`>]+$/;
// Absolute Windows path: drive letter, then at least one separator and a
// name. Ends at whitespace, quotes, or any character NTFS refuses anyway.
const WINDOWS_ABS = /(?<![\w:\\/])([A-Za-z]:[\\/](?:[^\s"'<>|*?`:\\/]+[\\/])*[^\s"'<>|*?`:\\/]+)/g;
// Absolute POSIX path WITH an extension on the last segment: `/etc/hosts`
// is real but so is `/api/plans/status`, and only the extension tells a
// file mention from a route in prose.
const POSIX_ABS = /(?<![\w:./\\])(\/(?:[\w.@-]+\/)+[\w.@-]+\.\w{1,8})/g;
// Relative path with at least one directory and an extension, resolved
// against the session's cwd. `index.mjs` alone is a word; `src/index.mjs`
// is a place.
const RELATIVE = /(?<![\w./\\:@-])((?:[\w.-]+[\\/])+[\w.-]+\.\w{1,8})/g;

function cleaned(raw) {
  return raw.replace(TRAILING_PUNCT, '');
}

/**
 * Every distinct absolute path mentioned in `text`, in order of first
 * appearance, capped. Relative mentions need `cwd` to become absolute; with
 * no cwd they are dropped rather than guessed.
 *
 * @param {string} text
 * @param {{cwd?: string|null, max?: number}} [options]
 * @returns {string[]}
 */
export function extractPaths(text, { cwd = null, max = MAX_PATHS_PER_SESSION } = {}) {
  if (typeof text !== 'string' || text === '') return [];
  const found = [];
  const seen = new Set();
  const add = (candidate) => {
    if (found.length >= max) return;
    const abs = path.resolve(candidate);
    // A path.resolve() of a relative mention with no cwd would anchor it to
    // the PROCESS cwd, which is nobody's project — so relatives only get
    // here when the caller passed a cwd (see below).
    const key = process.platform === 'win32' ? abs.toLowerCase() : abs;
    if (seen.has(key)) return;
    seen.add(key);
    found.push(abs);
  };

  for (const match of text.matchAll(WINDOWS_ABS)) {
    const value = cleaned(match[1]);
    if (value.length > 2 && !/[\\/]$/.test(value)) add(value);
  }
  for (const match of text.matchAll(POSIX_ABS)) add(cleaned(match[1]));
  if (typeof cwd === 'string' && cwd.trim() !== '') {
    for (const match of text.matchAll(RELATIVE)) {
      const value = cleaned(match[1]);
      // A relative mention that is really the tail of an absolute one
      // (`C:\a\b\c.mjs` also matches `b\c.mjs`) is already in `found` after
      // resolution against cwd only by coincidence — but a drive-letter or
      // root-anchored match never reaches this branch, so the tail resolved
      // against cwd is simply a different (usually non-existent) path, and
      // is skipped when it is preceded by a separator (the lookbehind above).
      if (value.includes('..')) continue; // `../x` is a direction, not a place kaprek should stat
      add(path.resolve(cwd, value));
    }
  }
  return found;
}

/**
 * Checks `paths` against the disk. A path counts as `present` when it exists
 * and was not modified after `sessionMtimeMs` (the session file's own last
 * write — everything the session itself wrote is older than that), `changed`
 * when its mtime is later, `gone` when stat fails. A directory is `present`
 * whenever it exists: its mtime moves whenever a child is added, which is
 * not what "changed since the session" means to a reader.
 *
 * @param {string[]} paths
 * @param {{sessionMtimeMs: number, limit?: number, stat?: (p: string) => fs.Stats}} options
 * @returns {{mentioned: number, checked: number, present: number, changed: number, gone: number, sample: Array<{path: string, verdict: 'present'|'changed'|'gone'}>}|null}
 *   null when nothing was mentioned — no verdict is not the same as a clean one.
 */
export function verdictFor(paths, { sessionMtimeMs, limit = MAX_PATHS_CHECKED, stat = fs.statSync } = {}) {
  if (!Array.isArray(paths) || paths.length === 0) return null;
  const checked = paths.slice(0, limit);
  const counts = { present: 0, changed: 0, gone: 0 };
  const verdicts = [];
  for (const p of checked) {
    let verdict;
    try {
      const info = stat(p);
      verdict = !info.isDirectory() && Number.isFinite(sessionMtimeMs) && info.mtimeMs > sessionMtimeMs ? 'changed' : 'present';
    } catch {
      verdict = 'gone';
    }
    counts[verdict] += 1;
    verdicts.push({ path: p, verdict });
  }
  // The sample leads with what a reader needs to know: what is gone, then
  // what moved on, then what is still as it was.
  const order = { gone: 0, changed: 1, present: 2 };
  const sample = [...verdicts].sort((a, b) => order[a.verdict] - order[b.verdict]).slice(0, MAX_SAMPLE);
  return { mentioned: paths.length, checked: checked.length, ...counts, sample };
}
