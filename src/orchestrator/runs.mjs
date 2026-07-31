// Run log — an append-only JSONL cost/usage record for chat turns, one line
// per runTurn() call (see run.mjs). Distinct from the chat event log itself:
// runs.jsonl exists so a later cost dashboard can scan turns across ALL
// chats without replaying every chat's own events.jsonl.
import fs from 'node:fs';
import path from 'node:path';

function runsPathFor(dataDir) {
  return path.join(dataDir, 'runs.jsonl');
}

/**
 * Appends one run entry as a JSON line to `<dataDir>/runs.jsonl`. The entry
 * is normalized to a fixed key set (missing fields default to null) so every
 * line has the same shape regardless of which fields a caller happened to
 * pass. `appendFileSync` is a single syscall for a single line — good enough
 * "atomic" for this local, single-writer-per-turn tool; readRuns() below
 * still skips any line that fails to parse, the same defensive stance
 * src/board/store.mjs and src/chats/store.mjs take on their own logs.
 */
export function appendRun(dataDir, entry = {}) {
  const runsPath = runsPathFor(dataDir);
  const line = {
    ts: entry.ts ?? new Date().toISOString(),
    chatId: entry.chatId ?? null,
    harness: entry.harness ?? null,
    model: entry.model ?? null,
    costUsd: entry.costUsd ?? null,
    usage: entry.usage ?? null,
    tokens: entry.tokens ?? null,
    durationMs: entry.durationMs ?? null,
    stopReason: entry.stopReason ?? null,
    // Which of src/harness/timeout.mjs's four clocks fired, only meaningful
    // when stopReason is 'timeout' (see adapter.mjs's TurnResult.timeoutClock
    // doc comment) — panel review Fix-Runde 2, important: without this,
    // runs.jsonl could never distinguish "idle clock (model went silent)"
    // from "absolute clock (approval chain)" from "tool-lease clock (a tool
    // call hung)", the exact diagnosis an unattended Task-3 overnight run
    // needs. Old lines predate this field; readRuns() returns them as-is,
    // so a reader must treat a missing timeoutClock as unknown, not 'none'.
    timeoutClock: entry.timeoutClock ?? null,
    rateLimit: entry.rateLimit ?? null,
    error: entry.error ?? null,
    // Who/what started this turn — 'user' for a normal chat turn, 'trigger'
    // for one started by src/triggers/runner.mjs without any user input.
    // triggerId names WHICH trigger when origin is 'trigger', else null.
    // Old lines predate both fields; readRuns() returns them as-is (no
    // backfill), so a reader must treat a missing origin as 'user'.
    origin: entry.origin ?? 'user',
    triggerId: entry.triggerId ?? null,
    // Set only on a FOLLOW-UP turn: the approval key whose approved action
    // this turn exists to run (see runner.mjs::fireFollowUp). Without it a
    // replay is indistinguishable from an ordinary second run of the same
    // trigger in the same chat, which is exactly what an operator (or an
    // acceptance script) needs to tell apart. Null on every other turn.
    replayOf: entry.replayOf ?? null,
  };
  fs.mkdirSync(dataDir, { recursive: true });
  fs.appendFileSync(runsPath, `${JSON.stringify(line)}\n`, 'utf8');
}

/**
 * Reads `<dataDir>/runs.jsonl` (missing file → empty array). A line that
 * fails to parse is skipped rather than crashing the whole read; `limit`
 * (if given) keeps only the most recent `limit` entries, in file order.
 */
export function readRuns(dataDir, { limit } = {}) {
  const runsPath = runsPathFor(dataDir);
  if (!fs.existsSync(runsPath)) return [];
  const raw = fs.readFileSync(runsPath, 'utf8');
  const lines = raw.split('\n').filter((line) => line.trim().length > 0);

  const runs = [];
  let skipped = 0;
  for (const line of lines) {
    try {
      runs.push(JSON.parse(line));
    } catch {
      skipped += 1;
    }
  }
  if (skipped > 0) {
    console.warn(`runs: skipped ${skipped} corrupt line(s) while loading ${runsPath}`);
  }
  return limit !== undefined ? runs.slice(-limit) : runs;
}
