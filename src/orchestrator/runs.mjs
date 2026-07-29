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
    rateLimit: entry.rateLimit ?? null,
    error: entry.error ?? null,
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
