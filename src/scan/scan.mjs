// Fast meta-scan for Claude Code session transcripts.
//
// digestSession() (src/parser/parse.mjs) reads a JSONL transcript fully and is
// the right tool for rendering a single thread. It is the wrong tool for a
// session LIST: transcripts can be 100+ MB, and listing hundreds of them with
// a full parse each would make the UI unusable.
//
// This module derives just enough metadata (title, time window, turn count,
// a machine hint) to render a session list, by reading only a bounded window
// of bytes from the front and back of each file — never the whole file.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { redactSecrets } from '../parser/parse.mjs';

// Byte budgets for the front/back windows. Fixed regardless of file size, so
// a 110 MB transcript costs the same few hundred KB of I/O as a 10 KB one.
const FRONT_BYTES = 256 * 1024;
const BACK_BYTES = 1024 * 1024;

export const CACHE_DIR = path.join(os.tmpdir(), 'loryme-meta-cache');
const CACHE_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

const WIN_USER_RE = /^[A-Za-z]:\\Users\\([^\\/]+)/;
const UNIX_USER_RE = /^\/(?:home|Users)\/([^/]+)/;

/** Splits text into trimmed, non-empty lines. */
function splitLines(text) {
  return text.split('\n').map((line) => line.trim()).filter(Boolean);
}

/** Parses a JSONL line into an object, or null if it is not valid JSON. */
function parseLine(line) {
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}

/**
 * Reads a bounded window from the front and (if needed) the back of a file
 * descriptor. Returns the raw candidate lines plus the total bytes read, so
 * callers can verify the read stayed within budget regardless of file size.
 */
function readWindow(fd, fileSize, { frontMaxBytes = FRONT_BYTES, backMaxBytes = BACK_BYTES } = {}) {
  const frontBudget = Math.min(frontMaxBytes, fileSize);
  const frontBuf = Buffer.alloc(frontBudget);
  const frontBytesRead = frontBudget > 0 ? fs.readSync(fd, frontBuf, 0, frontBudget, 0) : 0;
  const frontReachedEof = frontBytesRead >= fileSize;

  let frontLines = splitLines(frontBuf.toString('utf8', 0, frontBytesRead));
  // If we did not reach EOF, the last line in the window may be cut off
  // mid-JSON — drop it rather than risk a misleading parse.
  if (!frontReachedEof && frontLines.length > 0) frontLines = frontLines.slice(0, -1);

  if (frontReachedEof) {
    // The front window already covers the whole file; no need to read again.
    return { lines: frontLines, bytesRead: frontBytesRead };
  }

  const backBudget = Math.min(backMaxBytes, fileSize);
  const backStart = fileSize - backBudget;
  const backBuf = Buffer.alloc(backBudget);
  const backBytesRead = backBudget > 0 ? fs.readSync(fd, backBuf, 0, backBudget, backStart) : 0;

  let backLines = splitLines(backBuf.toString('utf8', 0, backBytesRead));
  // If the back window does not start at byte 0, its first fragment may be
  // the tail of a line that began before the window — drop it.
  if (backStart > 0 && backLines.length > 0) backLines = backLines.slice(1);

  return { lines: [...frontLines, ...backLines], bytesRead: frontBytesRead + backBytesRead };
}

/** Best-effort hint at which machine wrote a session, derived from a `cwd` field. */
function extractMachineHint(objs) {
  for (const obj of objs) {
    if (typeof obj.cwd !== 'string') continue;
    const winMatch = WIN_USER_RE.exec(obj.cwd);
    if (winMatch) return winMatch[1];
    const unixMatch = UNIX_USER_RE.exec(obj.cwd);
    if (unixMatch) return unixMatch[1];
  }
  return null;
}

/** Extracts the user-visible text from a user message's `content` field. */
function userMessageText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    const textBlock = content.find((block) => block?.type === 'text');
    return typeof textBlock?.text === 'string' ? textBlock.text : null;
  }
  return null;
}

/** Builds { title, startedAt, endedAt, turns, machineHint } from windowed JSONL objects. */
function buildMeta(objs) {
  let title = null; // last ai-title marker wins
  let lastPromptLeafUuid = null;
  let minTs = null;
  let maxTs = null;
  const turnIds = new Set();

  for (const obj of objs) {
    if (obj.type === 'ai-title' && typeof obj.aiTitle === 'string') {
      // Same redaction gate as the last-prompt fallback below — an ai-title
      // marker is free text from Claude Code and can carry secrets, and this
      // meta ends up in the temp cache and the session list API.
      title = redactSecrets(obj.aiTitle);
      continue;
    }
    if (obj.type === 'last-prompt' && typeof obj.leafUuid === 'string') {
      lastPromptLeafUuid = obj.leafUuid;
      continue;
    }
    if (typeof obj.timestamp === 'string') {
      if (minTs === null || obj.timestamp < minTs) minTs = obj.timestamp;
      if (maxTs === null || obj.timestamp > maxTs) maxTs = obj.timestamp;
    }
    if (obj.type === 'assistant' && typeof obj.message?.id === 'string') {
      turnIds.add(obj.message.id);
    }
  }

  // Fallback: no ai-title marker found in the scanned window — try the
  // last-prompt marker's leafUuid, which (when present in the window) points
  // at a user message we can use as a title.
  if (!title && lastPromptLeafUuid) {
    const match = objs.find((obj) => obj.type === 'user' && obj.uuid === lastPromptLeafUuid && !obj.isMeta);
    const text = match ? userMessageText(match.message?.content) : null;
    if (typeof text === 'string' && text.length > 0) {
      const redacted = redactSecrets(text);
      title = redacted.length > 120 ? `${redacted.slice(0, 120)}…` : redacted;
    }
  }

  return {
    title,
    startedAt: minTs,
    endedAt: maxTs,
    // Best-effort: only assistant message ids seen within the scanned front/back
    // window are counted, so this can undercount turns in the untouched middle
    // of very large transcripts. Trades exactness for a bounded read.
    turns: turnIds.size,
    machineHint: extractMachineHint(objs),
  };
}

/** Computes the cache file path for a session file, keyed on path + mtime + size. */
export function cacheFilePathFor(jsonlPath) {
  const stat = fs.statSync(jsonlPath);
  const key = crypto.createHash('sha256').update(`${jsonlPath}|${stat.mtimeMs}|${stat.size}`).digest('hex');
  return path.join(CACHE_DIR, `${key}.json`);
}

function readMetaCache(jsonlPath) {
  try {
    return JSON.parse(fs.readFileSync(cacheFilePathFor(jsonlPath), 'utf8'));
  } catch {
    return null;
  }
}

/**
 * Deletes cache entries older than CACHE_MAX_AGE_MS from CACHE_DIR. Runs
 * once per scan so the cache does not grow unbounded across sessions that
 * were deleted or renamed long ago. Best-effort: any error (missing dir,
 * permissions, a file removed by another process mid-scan) is swallowed —
 * a stale cache must never break the scan itself.
 */
export function evictStaleCache() {
  let entries;
  try {
    entries = fs.readdirSync(CACHE_DIR, { withFileTypes: true });
  } catch {
    return;
  }
  const now = Date.now();
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const filePath = path.join(CACHE_DIR, entry.name);
    try {
      const stat = fs.statSync(filePath);
      if (now - stat.mtimeMs > CACHE_MAX_AGE_MS) {
        fs.unlinkSync(filePath);
      }
    } catch {
      // Best-effort — skip entries we can't stat/delete.
    }
  }
}

function writeMetaCache(jsonlPath, meta) {
  try {
    fs.mkdirSync(CACHE_DIR, { recursive: true });
    fs.writeFileSync(cacheFilePathFor(jsonlPath), JSON.stringify(meta), 'utf8');
  } catch {
    // Cache is best-effort (e.g. permissions, disk full) — must never break a meta read.
  }
}

/**
 * Scans a single session file's front/back windows and returns both the
 * derived meta and the actual bytes read, so callers (and tests) can verify
 * the read stayed within the fixed budget regardless of file size.
 */
export function scanSessionFile(jsonlPath, { cache = true, ...windowOpts } = {}) {
  const stat = fs.statSync(jsonlPath);

  if (cache) {
    const cached = readMetaCache(jsonlPath);
    if (cached) return { meta: cached, bytesRead: 0, fileSize: stat.size, cacheHit: true };
  }

  const fd = fs.openSync(jsonlPath, 'r');
  let window;
  try {
    window = readWindow(fd, stat.size, windowOpts);
  } finally {
    fs.closeSync(fd);
  }

  const objs = window.lines.map(parseLine).filter(Boolean);
  const meta = buildMeta(objs);

  if (cache) writeMetaCache(jsonlPath, meta);

  return { meta, bytesRead: window.bytesRead, fileSize: stat.size, cacheHit: false };
}

/** Reads { title, startedAt, endedAt, turns, machineHint } without a full parse. */
export function readSessionMeta(jsonlPath, opts = {}) {
  return scanSessionFile(jsonlPath, opts).meta;
}

/**
 * Walks `rootDir` (one directory per Claude Code project) and lists its
 * session files without reading any of them.
 */
export function scanProjects(rootDir) {
  evictStaleCache();
  if (!fs.existsSync(rootDir)) return [];

  const projectDirs = fs
    .readdirSync(rootDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory());

  return projectDirs.map((entry) => {
    const dir = path.join(rootDir, entry.name);
    const files = fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((f) => f.isFile() && f.name.endsWith('.jsonl'));

    const sessions = files.map((f) => {
      const filePath = path.join(dir, f.name);
      const stat = fs.statSync(filePath);
      return {
        sessionId: path.basename(f.name, '.jsonl'),
        file: filePath,
        sizeBytes: stat.size,
        mtime: stat.mtime.toISOString(),
      };
    });

    return { projectSlug: entry.name, dir, sessions };
  });
}
