// What a terminal session asked kaprek to remember. Until now the
// ```kaprek-remember fence only worked inside kaprek's own chat turns; the
// Stop hook calls this after every turn of a plain Claude Code session, so
// the terminal learns too.
//
// Runs inside a hook with a 3 s budget: reads only the bytes appended since
// the last call (offset per session), stops at its own deadline, and
// remembers which blocks it already wrote (hash per scope+text) so a turn
// that is re-read never writes twice. Never throws.
//
// Every call reads at most one chunk (MAX_CHUNK_BYTES), never the whole
// unread tail: a first run against a transcript that has grown large while
// nobody harvested it must still finish inside the deadline and make
// progress, not fail the same way on every subsequent hook forever. A
// transcript that shrank since the saved offset was written (rotated,
// truncated) is treated as a fresh start.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { openMemory } from './store.mjs';
import { parseRemember } from './protocol.mjs';

export const MAX_LINE_BYTES = 4 * 1024 * 1024;
export const MAX_CHUNK_BYTES = 8 * 1024 * 1024;

// This has to hold: a chunk that starts at a line boundary must always be
// big enough to hold one full line, or seedOffset()'s guarantee — a final
// line short enough to parse is always found on a cold start — breaks
// silently instead of loudly. Checked at call time in harvestRemember (the
// caller may inject smaller limits, e.g. in tests), not at module load: a
// violation is a programming error, but this hook must never throw.

function statePath(dataDir, sessionId) {
  return path.join(dataDir, 'memory', 'harvest', `${sessionId.replace(/[^a-zA-Z0-9_-]/g, '_')}.json`);
}

function readState(file) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    return { offset: Number.isFinite(parsed.offset) ? parsed.offset : 0, hashes: Array.isArray(parsed.hashes) ? parsed.hashes : [], isNew: false };
  } catch {
    return { offset: 0, hashes: [], isNew: true };
  }
}

/**
 * Where a session with no saved (or no longer valid, see the shrink check in
 * harvestRemember) offset should start: the last chunk of the transcript,
 * not byte 0. By the time the Stop hook first runs against a given
 * transcript it can already be tens of megabytes — the turn that triggered
 * the hook is always in the tail, and reading from the start would mean
 * re-decoding the whole history before ever getting there, over and over,
 * one bounded chunk at a time. Older history is deliberately never
 * back-harvested.
 *
 * The guarantee this must uphold: a final line no longer than maxLineBytes
 * is always harvested on a cold start, never silently skipped. Because the
 * caller guarantees maxChunkBytes >= maxLineBytes, such a line's own start
 * can never lie before `size - maxChunkBytes` — so the only newline this
 * probe can find before it is either a genuine earlier line's terminator
 * (safe to land right after) or, in the single edge case where the final
 * line's start coincides exactly with the naive seed, that line's OWN
 * trailing terminator, sitting at the very end of the probe with nothing
 * after it. Advancing past that one would jump straight to `size` and lose
 * an otherwise perfectly harvestable line — worse than not advancing at
 * all — so the `seed + nl + 1 < size` guard below refuses that specific
 * move: if there is nothing after the newline, the naive seed already IS
 * this line's start, and is left alone. A line longer than maxChunkBytes
 * (necessarily already longer than maxLineBytes, so discarded by policy
 * regardless) never triggers this: readAssistantTexts' own maxLineBytes
 * fragment check advances the offset the rest of the way on the very next
 * call, so nothing ever stalls.
 */
function seedOffset(transcriptPath, size, maxChunkBytes) {
  if (size <= maxChunkBytes) return 0;
  let seed = size - maxChunkBytes;
  const fd = fs.openSync(transcriptPath, 'r');
  try {
    const probe = Buffer.alloc(Math.min(maxChunkBytes, size - seed));
    fs.readSync(fd, probe, 0, probe.length, seed);
    const nl = probe.indexOf(0x0a); // '\n'
    if (nl >= 0 && seed + nl + 1 < size) seed += nl + 1; // land on the next full line — but only if one follows
  } finally {
    fs.closeSync(fd);
  }
  return seed;
}

function writeState(file, state) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ offset: state.offset, hashes: state.hashes.slice(-500) }), 'utf8');
}

/** Assistant text blocks in the transcript bytes from `offset` on, as [{ text, endOffset }]. Stops when the clock runs out. */
function readAssistantTexts(transcriptPath, offset, isOverdue, maxChunkBytes, maxLineBytes) {
  const size = fs.statSync(transcriptPath).size;
  if (size <= offset) return { texts: [], endOffset: offset };
  const readSize = Math.min(size - offset, maxChunkBytes);
  const fd = fs.openSync(transcriptPath, 'r');
  try {
    const buf = Buffer.alloc(readSize);
    fs.readSync(fd, buf, 0, buf.length, offset);
    const chunk = buf.toString('utf8');
    const lastNewline = chunk.lastIndexOf('\n');
    if (lastNewline < 0) {
      // No line break anywhere in this window. Two cases:
      //  - the file ends exactly here too: a line still being written this
      //    turn — wait for the next call, so it is read once complete.
      //  - the file continues past this window: since maxChunkBytes >=
      //    maxLineBytes, any line we would ever parse already ends inside
      //    a window that starts at its own beginning — a full window with no
      //    break in it can only be a line already longer than we would
      //    parse. Skip past it: the leftover fragment up to the next '\n'
      //    fails JSON.parse on the next call and is silently skipped there
      //    too, so this always makes progress, never stalls.
      const stillWriting = offset + readSize === size;
      return { texts: [], endOffset: stillWriting ? offset : offset + readSize };
    }
    const complete = chunk.slice(0, lastNewline);
    const texts = [];
    let consumed = 0;
    for (const line of complete.split('\n')) {
      consumed += Buffer.byteLength(line, 'utf8') + 1;
      if (isOverdue()) return { texts, endOffset: offset + consumed - Buffer.byteLength(line, 'utf8') - 1 };
      if (line.length > maxLineBytes || line.trim() === '') continue;
      let parsed;
      try {
        parsed = JSON.parse(line);
      } catch {
        continue;
      }
      if (parsed?.type !== 'assistant') continue;
      const content = parsed?.message?.content;
      if (!Array.isArray(content)) continue;
      for (const part of content) {
        if (part?.type === 'text' && typeof part.text === 'string' && part.text.includes('kaprek-remember')) texts.push(part.text);
      }
    }
    return { texts, endOffset: offset + consumed };
  } finally {
    fs.closeSync(fd);
  }
}

export function harvestRemember({
  dataDir,
  transcriptPath,
  sessionId,
  cwd,
  deadlineMs = 1500,
  now = Date.now,
  maxChunkBytes = MAX_CHUNK_BYTES,
  maxLineBytes = MAX_LINE_BYTES,
}) {
  const empty = { written: 0, skipped: 0, scopeId: null };
  try {
    if (typeof dataDir !== 'string' || typeof transcriptPath !== 'string' || typeof sessionId !== 'string' || sessionId === '') return empty;
    if (typeof cwd !== 'string' || cwd.trim() === '') return empty;
    if (!fs.existsSync(transcriptPath)) return empty;
    if (!fs.statSync(transcriptPath).isFile()) return empty; // a directory (or a socket, a pipe...) is not a transcript
    const started = now();
    const isOverdue = () => now() - started > deadlineMs;
    const scopeId = `project:${path.basename(cwd)}`;
    // This has to hold: a chunk that starts at a line boundary must always
    // be big enough to hold one full line, or seedOffset()'s cold-start
    // guarantee breaks silently instead of loudly. A caller violating this
    // is a programming error, but this hook (called from the Stop hook)
    // must never throw — fail open and report it instead.
    if (maxChunkBytes < maxLineBytes) return { written: 0, skipped: 0, scopeId, error: 'chunk < line' };
    const file = statePath(dataDir, sessionId);
    const state = readState(file);
    const size = fs.statSync(transcriptPath).size;
    // A brand-new session, or one whose saved offset no longer fits a
    // transcript that has shrunk (rotated, truncated) since: treat it like a
    // cold start and re-seed at the tail. The hashes stay — a fact already
    // written is not forgotten just because the file underneath it moved.
    if (state.isNew || state.offset > size) state.offset = seedOffset(transcriptPath, size, maxChunkBytes);
    const { texts, endOffset } = readAssistantTexts(transcriptPath, state.offset, isOverdue, maxChunkBytes, maxLineBytes);
    let written = 0;
    let skipped = 0;
    if (texts.length > 0) {
      const memory = openMemory(dataDir);
      memory.addScope({ id: 'person:local' });
      memory.addScope({ id: scopeId, parent: 'person:local' });
      const known = new Set(state.hashes);
      for (const text of texts) {
        for (const entry of parseRemember(text)) {
          const hash = crypto.createHash('sha256').update(`${scopeId}\n${entry.text}`).digest('hex');
          if (known.has(hash)) {
            skipped++;
            continue;
          }
          memory.remember({ scopeId, text: entry.text, kind: entry.kind, confidence: entry.confidence, origin: `terminal:${sessionId}` });
          known.add(hash);
          written++;
        }
      }
      state.hashes = [...known];
    }
    state.offset = endOffset;
    writeState(file, state);
    return { written, skipped, scopeId };
  } catch {
    return empty;
  }
}
