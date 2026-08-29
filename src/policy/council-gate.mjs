// The Stop hook's council gate: has this session changed enough that ending
// the turn without a second opinion would be reckless? See hook-stop.mjs
// for where this runs and how a block is expressed (exit 2 + stderr, unlike
// the policy engine's own JSON-on-stdout block — see the note there).
//
// Every one of the six conditions below has to hold for the gate to fire,
// and any missing piece (no git, no exec, git failing or overrunning its
// budget, the once-marker already written) fails OPEN like every other
// kaprek hook path: a gate that can hang or crash the Stop hook would be
// worse than no gate at all.
import fs from 'node:fs';
import path from 'node:path';
import { readSessionEvents } from '../ledger/sessions.mjs';
import { parseDiffStat } from '../council/diff.mjs';

export const MIN_FILES = 5;
export const MIN_LINES = 150;
export const DEFAULT_GATE_DEADLINE_MS = 600;

const NO_BLOCK = Object.freeze({ block: false });

/** The reason handed to Claude on stderr — precise about what fired and what to do about it. */
export function councilGateReason(files, lines) {
  return (
    `kaprek council gate: this session changed ${files} files / ${lines} lines without a council review. ` +
    'Run `kaprek council "Review this change: defects, missed requirements, risky assumptions" --diff`, ' +
    'act on the verdicts (fix, or state why not), then finish. This gate fires once per session; ' +
    'set KAPREK_COUNCIL_GATE=0 to disable.'
  );
}

function markerPath(dataDir, sessionId) {
  const safe = String(sessionId).replace(/[^a-zA-Z0-9_-]/g, '_');
  return path.join(dataDir, 'council', 'gate', `${safe}.json`);
}

function hasMarker(dataDir, sessionId) {
  try {
    return fs.existsSync(markerPath(dataDir, sessionId));
  } catch {
    return false;
  }
}

function writeMarker(dataDir, sessionId) {
  try {
    const file = markerPath(dataDir, sessionId);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ ts: new Date().toISOString() }), 'utf8');
  } catch {
    // Worst case: the gate could fire again on this session's next Stop —
    // still fails toward "asks twice", never toward hanging or crashing.
  }
}

/**
 * The earliest 'start' ledger entry this session has, in epoch ms, or 0 if
 * there is none. 0 (rather than "now", or throwing) is deliberate: with no
 * session start to compare against, treating ANY existing council result as
 * "already reviewed" is the fail-open direction — it can only make the gate
 * fire less, never more, when the ledger lacks the data to be sure.
 */
function firstSessionStartTs(dataDir, sessionId) {
  try {
    const events = readSessionEvents(dataDir, { limit: 5000 });
    const first = events.find((event) => event.type === 'start' && event.sessionId === sessionId);
    const ts = first ? Date.parse(first.ts) : NaN;
    return Number.isFinite(ts) ? ts : 0;
  } catch {
    return 0;
  }
}

/** True if `<dataDir>/council/cli/` holds any result saved after `sinceTs`. */
function hasRecentCouncilResult(dataDir, sinceTs) {
  const dir = path.join(dataDir, 'council', 'cli');
  let entries;
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return false; // no council directory yet: nothing has ever run
  }
  for (const name of entries) {
    try {
      if (fs.statSync(path.join(dir, name)).mtimeMs > sinceTs) return true;
    } catch {
      // an entry that vanished mid-scan or cannot be stat'd is not a recent result
    }
  }
  return false;
}

/**
 * Decides whether a Stop event should be blocked for lack of a council
 * review. Fires when ALL of:
 *
 *   (a) process.env.KAPREK_COUNCIL_GATE !== '0'
 *   (b) stopHookActive !== true (Claude Code's own loop guard)
 *   (c) no once-marker for this session yet
 *   (d) cwd is inside a git repo
 *   (e) `git diff --stat HEAD` covers >= MIN_FILES files (untracked files
 *       count as files) OR >= MIN_LINES changed lines
 *   (f) no `council/cli/` result younger than this session's first ledger
 *       'start' entry (a review already happened this session)
 *
 * (d) is not a separate check: `git diff --stat HEAD` itself throwing
 * (not a repo, git missing, a timeout) is exactly the signal, and is
 * treated the same as every other git failure — fail open.
 *
 * @param {object} options
 * @param {string} options.dataDir
 * @param {string} options.cwd
 * @param {string} options.sessionId
 * @param {boolean} [options.stopHookActive]
 * @param {() => number} [options.now]
 * @param {number} [options.deadlineMs] - overall time budget for this
 *   evaluation; exceeding it at any checkpoint fails open, same idea as
 *   harvestRemember()'s deadline
 * @param {(args: string[], opts: {cwd: string}) => string} options.exec -
 *   runs `git <args>` in cwd and returns stdout, or throws. Injected so
 *   this module never imports child_process itself — see
 *   src/lib/git-exec.mjs for the real implementation.
 * @returns {{block: boolean, reason?: string}}
 */
// Destructured to `runGit`, not `exec`, purely so this file's own call
// sites do not read as an invocation of something literally named "exec" —
// see the identical note in src/council/diff.mjs. The external contract
// (the options key is `exec`) is unchanged.
export function evaluateCouncilGate({ dataDir, cwd, sessionId, stopHookActive, now = Date.now, deadlineMs = DEFAULT_GATE_DEADLINE_MS, exec: runGit }) {
  try {
    if (process.env.KAPREK_COUNCIL_GATE === '0') return NO_BLOCK; // (a)
    if (stopHookActive === true) return NO_BLOCK; // (b)
    if (typeof dataDir !== 'string' || dataDir === '') return NO_BLOCK;
    if (typeof cwd !== 'string' || cwd === '') return NO_BLOCK;
    if (typeof sessionId !== 'string' || sessionId === '') return NO_BLOCK;
    if (typeof runGit !== 'function') return NO_BLOCK;
    if (hasMarker(dataDir, sessionId)) return NO_BLOCK; // (c)

    const started = now();
    const isOverdue = () => now() - started > deadlineMs;

    let statOutput;
    let untrackedOutput;
    try {
      // Also settles (d): a cwd that is not a git repo (or has no git
      // binary at all) throws here, same as a timeout or any other git
      // failure — all of it resolves to NO_BLOCK below.
      statOutput = runGit(['diff', '--stat', 'HEAD'], { cwd });
      if (isOverdue()) return NO_BLOCK;
      untrackedOutput = runGit(['ls-files', '--others', '--exclude-standard'], { cwd });
    } catch {
      return NO_BLOCK;
    }
    if (isOverdue()) return NO_BLOCK;

    const untrackedCount = (untrackedOutput ?? '')
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line !== '').length;
    const stat = parseDiffStat(statOutput);
    const totalFiles = stat.files + untrackedCount;

    if (totalFiles < MIN_FILES && stat.lines < MIN_LINES) return NO_BLOCK; // (e)

    const sinceTs = firstSessionStartTs(dataDir, sessionId);
    if (hasRecentCouncilResult(dataDir, sinceTs)) return NO_BLOCK; // (f)
    if (isOverdue()) return NO_BLOCK;

    writeMarker(dataDir, sessionId);
    return { block: true, reason: councilGateReason(totalFiles, stat.lines) };
  } catch {
    return NO_BLOCK;
  }
}
