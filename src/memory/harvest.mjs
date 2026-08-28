// What a terminal session asked kaprek to remember. Until now the
// ```kaprek-remember fence only worked inside kaprek's own chat turns; the
// Stop hook calls this after every turn of a plain Claude Code session, so
// the terminal learns too.
//
// Runs inside a hook with a 3 s budget: reads only the bytes appended since
// the last call (offset per session), stops at its own deadline, and
// remembers which blocks it already wrote (hash per scope+text) so a turn
// that is re-read never writes twice. Never throws.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { openMemory } from './store.mjs';
import { parseRemember } from './protocol.mjs';

const MAX_LINE_BYTES = 4 * 1024 * 1024;

function statePath(dataDir, sessionId) {
  return path.join(dataDir, 'memory', 'harvest', `${sessionId.replace(/[^a-zA-Z0-9_-]/g, '_')}.json`);
}

function readState(file) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    return { offset: Number.isFinite(parsed.offset) ? parsed.offset : 0, hashes: Array.isArray(parsed.hashes) ? parsed.hashes : [] };
  } catch {
    return { offset: 0, hashes: [] };
  }
}

function writeState(file, state) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ offset: state.offset, hashes: state.hashes.slice(-500) }), 'utf8');
}

/** Assistant text blocks in the transcript bytes from `offset` on, as [{ text, endOffset }]. Stops when the clock runs out. */
function readAssistantTexts(transcriptPath, offset, isOverdue) {
  const size = fs.statSync(transcriptPath).size;
  if (size <= offset) return { texts: [], endOffset: offset };
  const fd = fs.openSync(transcriptPath, 'r');
  try {
    const buf = Buffer.alloc(size - offset);
    fs.readSync(fd, buf, 0, buf.length, offset);
    const chunk = buf.toString('utf8');
    const lastNewline = chunk.lastIndexOf('\n');
    if (lastNewline < 0) return { texts: [], endOffset: offset }; // a torn line: wait for the next turn
    const complete = chunk.slice(0, lastNewline);
    const texts = [];
    let consumed = 0;
    for (const line of complete.split('\n')) {
      consumed += Buffer.byteLength(line, 'utf8') + 1;
      if (isOverdue()) return { texts, endOffset: offset + consumed - Buffer.byteLength(line, 'utf8') - 1 };
      if (line.length > MAX_LINE_BYTES || line.trim() === '') continue;
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

export function harvestRemember({ dataDir, transcriptPath, sessionId, cwd, deadlineMs = 1500, now = Date.now }) {
  const empty = { written: 0, skipped: 0, scopeId: null };
  try {
    if (typeof dataDir !== 'string' || typeof transcriptPath !== 'string' || typeof sessionId !== 'string' || sessionId === '') return empty;
    if (typeof cwd !== 'string' || cwd.trim() === '') return empty;
    if (!fs.existsSync(transcriptPath)) return empty;
    const started = now();
    const isOverdue = () => now() - started > deadlineMs;
    const scopeId = `project:${path.basename(cwd)}`;
    const file = statePath(dataDir, sessionId);
    const state = readState(file);
    const { texts, endOffset } = readAssistantTexts(transcriptPath, state.offset, isOverdue);
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
