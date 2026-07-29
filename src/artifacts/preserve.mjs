// Scratchpad artifact preservation.
//
// Claude Code writes work-product files (scripts, data, images) under
// `<os.tmpdir()>/claude/<projectSlug>/<sessionId>/scratchpad/`, alongside the
// transcript it also writes to `~/.claude/projects`. The transcript survives
// (kaprek's whole reason to exist), but the OS temp directory does not — it
// is routinely wiped by the OS or the user, and scratchpad files disappear
// with it while the transcript that references them lives on. sweepArtifacts()
// copies scratchpad contents into <dataDir>/artifacts/<projectSlug>/<sessionId>/
// so they survive temp cleanup too.
//
// Deliberately NOT redacted (see README's Privacy section): these are work
// products (code, data, images), not chat transcripts, and running secret
// redaction over arbitrary binary/script content would corrupt it. This is
// the one place kaprek preserves content verbatim.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

const DEFAULT_MAX_FILE_BYTES = 25 * 1024 * 1024;
const DEFAULT_MAX_SESSION_BYTES = 100 * 1024 * 1024;

// Directory names never worth preserving: dependency/build/VCS churn that
// dwarfs any actual work product and is trivially regenerable anyway.
const EXCLUDED_DIRS = new Set(['node_modules', '.git', 'dist', '__pycache__']);

function artifactsRootDir(dataDir) {
  return path.join(dataDir, 'artifacts');
}

function sessionArtifactsDir(dataDir, projectSlug, sessionId) {
  return path.join(artifactsRootDir(dataDir), projectSlug, sessionId);
}

function manifestPathFor(dataDir, projectSlug, sessionId) {
  return path.join(sessionArtifactsDir(dataDir, projectSlug, sessionId), 'manifest.json');
}

/** Reads a session's manifest, defaulting to an empty one if missing or corrupt. */
function readManifest(manifestPath) {
  try {
    const parsed = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    if (parsed && Array.isArray(parsed.files)) return parsed;
  } catch {
    // Missing or corrupt manifest — treat as "nothing preserved yet" rather
    // than blocking the sweep; it gets rebuilt below.
  }
  return { files: [] };
}

/** Atomic write: temp file in the same directory, then rename() over the target (see hooks.mjs/receipt.mjs for the same pattern). */
function writeManifestAtomic(manifestPath, manifest) {
  const dir = path.dirname(manifestPath);
  fs.mkdirSync(dir, { recursive: true });
  const tmpPath = path.join(dir, `.manifest.json.tmp-${process.pid}-${Date.now()}`);
  fs.writeFileSync(tmpPath, JSON.stringify(manifest, null, 2), 'utf8');
  fs.renameSync(tmpPath, manifestPath);
}

/**
 * True if `relPath` is safe to join onto an artifacts session directory:
 * relative, non-empty, and containing no '.' or '..' segment. This is
 * defense-in-depth on top of walkScratchpad() never following symlinks
 * (below) — the two together mean a relPath can never point outside the
 * scratchpad dir it was derived from, and this function catches it even if
 * that assumption is ever violated.
 */
function isSafeRelPath(relPath) {
  if (typeof relPath !== 'string' || relPath.length === 0) return false;
  if (path.isAbsolute(relPath)) return false;
  const segments = relPath.split('/');
  return segments.every((seg) => seg.length > 0 && seg !== '.' && seg !== '..');
}

/**
 * Recursively lists files under `dir` (a scratchpad directory), returning
 * `{ fullPath, relPath, size, mtimeMs }` for each, sorted by relPath for
 * deterministic processing order (matters for the session-byte-budget cap
 * below, and makes manifests diff-stable). Symlinks — both files and
 * directories — are never followed: this is the primary traversal guard,
 * since it is the only way a scratchpad walk could otherwise escape its own
 * directory.
 */
function walkScratchpad(dir, baseDir) {
  const results = [];
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return results;
  }
  for (const entry of entries) {
    if (entry.isSymbolicLink()) continue;
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (EXCLUDED_DIRS.has(entry.name)) continue;
      results.push(...walkScratchpad(fullPath, baseDir));
    } else if (entry.isFile()) {
      let stat;
      try {
        stat = fs.statSync(fullPath);
      } catch {
        continue; // gone between readdir and stat — skip, don't fail the sweep
      }
      const relPath = path.relative(baseDir, fullPath).split(path.sep).join('/');
      results.push({ fullPath, relPath, size: stat.size, mtimeMs: stat.mtimeMs });
    }
  }
  return results.sort((a, b) => (a.relPath < b.relPath ? -1 : a.relPath > b.relPath ? 1 : 0));
}

function sha256File(fullPath) {
  return crypto.createHash('sha256').update(fs.readFileSync(fullPath)).digest('hex');
}

/**
 * Sweeps one session's scratchpad directory into its artifacts dir, updating
 * (and returning) its manifest. Isolated per-session so a single session's
 * unreadable scratchpad or write failure can't abort the whole sweep.
 */
function sweepSession({ scratchpadDir, dataDir, projectSlug, sessionId, maxFileBytes, maxSessionBytes, errors }) {
  const artifactsDir = sessionArtifactsDir(dataDir, projectSlug, sessionId);
  const artifactsDirResolved = path.resolve(artifactsDir);
  const manifestPath = manifestPathFor(dataDir, projectSlug, sessionId);
  const manifest = readManifest(manifestPath);
  const manifestByRelPath = new Map(manifest.files.map((f) => [f.relPath, f]));

  const files = walkScratchpad(scratchpadDir, scratchpadDir);
  const nextFiles = [];
  let copied = 0;
  let skipped = 0;
  // Running total of bytes this session actually occupies under artifactsDir
  // this run — both files copied just now and unchanged files kept from the
  // prior manifest count against it, so the budget reflects real disk usage
  // and stays consistent across repeated sweeps, not just this run's copies.
  let sessionBytesUsed = 0;

  for (const file of files) {
    if (!isSafeRelPath(file.relPath)) {
      errors.push({ projectSlug, sessionId, relPath: file.relPath, error: 'unsafe relPath, skipped' });
      continue;
    }

    const destPath = path.join(artifactsDir, file.relPath);
    const destResolved = path.resolve(destPath);
    if (destResolved !== artifactsDirResolved && !destResolved.startsWith(artifactsDirResolved + path.sep)) {
      errors.push({ projectSlug, sessionId, relPath: file.relPath, error: 'destination escapes artifacts dir, skipped' });
      continue;
    }

    const existing = manifestByRelPath.get(file.relPath);
    if (existing && !existing.skipped && existing.size === file.size && existing.mtimeMs === file.mtimeMs) {
      nextFiles.push(existing);
      sessionBytesUsed += file.size;
      continue;
    }

    if (file.size > maxFileBytes) {
      nextFiles.push({ relPath: file.relPath, size: file.size, skipped: 'too-large' });
      skipped += 1;
      continue;
    }

    if (sessionBytesUsed + file.size > maxSessionBytes) {
      nextFiles.push({ relPath: file.relPath, size: file.size, skipped: 'session-budget' });
      skipped += 1;
      continue;
    }

    try {
      fs.mkdirSync(path.dirname(destPath), { recursive: true });
      const sha256 = sha256File(file.fullPath);
      fs.copyFileSync(file.fullPath, destPath);
      nextFiles.push({
        relPath: file.relPath,
        size: file.size,
        mtimeMs: file.mtimeMs,
        sha256,
        preservedAt: new Date().toISOString(),
      });
      sessionBytesUsed += file.size;
      copied += 1;
    } catch (err) {
      errors.push({ projectSlug, sessionId, relPath: file.relPath, error: err.message });
    }
  }

  // Files no longer present in the scratchpad are dropped from the
  // manifest — it mirrors current scratchpad contents, not history.
  writeManifestAtomic(manifestPath, { files: nextFiles });

  return { copied, skipped };
}

/**
 * Walks every `<tmpRoot>/<projectSlug>/<sessionId>/scratchpad/` directory and
 * preserves its contents under `<dataDir>/artifacts/<projectSlug>/<sessionId>/`,
 * tracked by a per-session manifest.json for idempotent re-runs. Never
 * throws — per-file and per-session failures are collected in `errors`.
 *
 * `tmpRoot` defaults to the real OS temp dir's `claude` subfolder; tests
 * MUST override it to a scratch directory of their own.
 */
export function sweepArtifacts({
  tmpRoot = path.join(os.tmpdir(), 'claude'),
  dataDir,
  maxFileBytes = DEFAULT_MAX_FILE_BYTES,
  maxSessionBytes = DEFAULT_MAX_SESSION_BYTES,
} = {}) {
  if (!dataDir) throw new Error('sweepArtifacts requires dataDir');

  const result = { sessions: 0, copied: 0, skipped: 0, errors: [] };

  let projectDirs;
  try {
    projectDirs = fs.readdirSync(tmpRoot, { withFileTypes: true }).filter((e) => e.isDirectory() && !e.isSymbolicLink());
  } catch {
    return result; // no scratchpad root at all yet — nothing to sweep
  }

  for (const projectEntry of projectDirs) {
    const projectSlug = projectEntry.name;
    const projectDir = path.join(tmpRoot, projectSlug);
    let sessionDirs;
    try {
      sessionDirs = fs.readdirSync(projectDir, { withFileTypes: true }).filter((e) => e.isDirectory() && !e.isSymbolicLink());
    } catch {
      continue;
    }

    for (const sessionEntry of sessionDirs) {
      const sessionId = sessionEntry.name;
      const scratchpadDir = path.join(projectDir, sessionId, 'scratchpad');
      if (!fs.existsSync(scratchpadDir)) continue;

      result.sessions += 1;
      const { copied, skipped } = sweepSession({
        scratchpadDir,
        dataDir,
        projectSlug,
        sessionId,
        maxFileBytes,
        maxSessionBytes,
        errors: result.errors,
      });
      result.copied += copied;
      result.skipped += skipped;
    }
  }

  return result;
}

/** Reads a single session's artifact manifest, defaulting to `{ files: [] }` if none exists. */
export function readArtifactManifest(dataDir, projectSlug, sessionId) {
  return readManifest(manifestPathFor(dataDir, projectSlug, sessionId));
}

/**
 * Preserves a single session's scratchpad (used by the Stop hook, which
 * knows only that one session/project pair and must stay fast/best-effort —
 * see hook-stop.mjs). Thin wrapper so the hook doesn't need its own
 * tmpRoot-walking logic.
 */
export function sweepSessionArtifacts({ tmpRoot = path.join(os.tmpdir(), 'claude'), dataDir, projectSlug, sessionId, maxFileBytes = DEFAULT_MAX_FILE_BYTES, maxSessionBytes = DEFAULT_MAX_SESSION_BYTES }) {
  const scratchpadDir = path.join(tmpRoot, projectSlug, sessionId, 'scratchpad');
  const errors = [];
  if (!fs.existsSync(scratchpadDir)) {
    return { copied: 0, skipped: 0, errors };
  }
  const { copied, skipped } = sweepSession({
    scratchpadDir,
    dataDir,
    projectSlug,
    sessionId,
    maxFileBytes,
    maxSessionBytes,
    errors,
  });
  return { copied, skipped, errors };
}

// Exported for direct unit testing of the traversal guard (see
// preserve.test.mjs), without needing to fabricate a real symlink escape on
// every platform kaprek supports.
export { isSafeRelPath };
