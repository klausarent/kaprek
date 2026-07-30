// The single write path for app handlers (see src/apps/mcp-server.mjs's
// handler contract: `ctx.workspaceDir` is the only thing a handler may
// touch on disk). A positive-list of three operations instead of a
// sandbox-illusion "give the agent a shell" — see the Tag-2 plan's Global
// Constraints: "Kein Shell-Tool, kein generisches Datei-Lese-Tool."
//
// Hardening (same posture as src/artifacts/preserve.mjs's traversal guard):
//   - relPath must be relative, non-empty, and contain no '.' or '..'
//     segment, no leading slash, no drive letter.
//   - the resolved target must stay under workspaceDir (belt-and-suspenders
//     on top of the relPath check above).
//   - no path component may be a symlink — checked with lstat, which never
//     follows the link being tested, so a symlink planted inside the
//     workspace (or the workspace dir itself being one) can't be used to
//     write/read outside it.
import fs from 'node:fs';
import path from 'node:path';

export class WorkspacePathError extends Error {
  constructor(relPath, reason) {
    super(`unsafe workspace path ${JSON.stringify(relPath)}: ${reason}`);
    this.name = 'WorkspacePathError';
    this.relPath = relPath;
  }
}

/** Throws WorkspacePathError unless relPath is a plain relative path with no '.'/'..' segments, leading slash, or drive letter. Empty string means "workspace root" and is allowed only where the caller says so (listFiles). */
function assertSafeRelPath(relPath, { allowRoot = false } = {}) {
  if (typeof relPath !== 'string') throw new WorkspacePathError(relPath, 'must be a string');
  if (relPath.length === 0) {
    if (allowRoot) return;
    throw new WorkspacePathError(relPath, 'must not be empty');
  }
  if (path.isAbsolute(relPath) || relPath.startsWith('/') || relPath.startsWith('\\')) {
    throw new WorkspacePathError(relPath, 'must not be an absolute path');
  }
  if (/^[a-zA-Z]:/.test(relPath)) {
    throw new WorkspacePathError(relPath, 'must not include a drive letter');
  }
  const segments = relPath.split(/[/\\]/);
  for (const seg of segments) {
    if (seg === '..') throw new WorkspacePathError(relPath, "must not contain '..' segments");
    if (seg === '.') throw new WorkspacePathError(relPath, "must not contain '.' segments");
    if (seg.length === 0) throw new WorkspacePathError(relPath, 'must not contain empty segments (e.g. "//")');
  }
}

/**
 * Verifies the workspace root itself, not just paths under it: every
 * assertSafeRelPath/resolveInsideWorkspace check above assumes workspaceDir
 * IS the real workspace, but nothing enforced that assumption — a junction
 * planted at `<dataDir>/workspace` pointing outside would make every "safe"
 * relPath resolve outside the intended tree. Three checks, all against the
 * root path itself (lstat, which never follows the very link being tested):
 *   - missing entirely: fine — a write is what creates it (see writeFile's
 *     mkdirSync), so this is the normal first-run state, not a violation.
 *   - exists but is a symlink/junction: rejected outright.
 *   - exists as a real directory: its realpath must equal itself (nothing
 *     upstream silently retargeted it after the lstat above ran — same
 *     posture as fs.realpathSync elsewhere in this file).
 * Exported so a caller can validate a workspace root once up front too, not
 * just implicitly on first read/write.
 */
export function assertWorkspaceRoot(workspaceDir) {
  if (typeof workspaceDir !== 'string' || workspaceDir.length === 0) {
    throw new WorkspacePathError(workspaceDir, 'workspace root must be a non-empty string');
  }
  const resolved = path.resolve(workspaceDir);
  let stat;
  try {
    stat = fs.lstatSync(resolved);
  } catch {
    return resolved; // doesn't exist yet — nothing to validate, a write will create a real directory
  }
  if (stat.isSymbolicLink()) {
    throw new WorkspacePathError(workspaceDir, 'workspace root must not be a symlink or junction');
  }
  if (!stat.isDirectory()) {
    throw new WorkspacePathError(workspaceDir, 'workspace root must be a directory');
  }
  let real;
  try {
    real = fs.realpathSync(resolved);
  } catch (err) {
    throw new WorkspacePathError(workspaceDir, `could not resolve workspace root: ${err.message}`);
  }
  if (real !== resolved) {
    throw new WorkspacePathError(workspaceDir, `workspace root resolves to a different real path: ${real}`);
  }
  return resolved;
}

/** Resolves relPath under workspaceDir and confirms the result did not escape workspaceDir (defense in depth on top of assertSafeRelPath's syntactic check). */
function resolveInsideWorkspace(workspaceDir, relPath) {
  const workspaceResolved = path.resolve(workspaceDir);
  const target = path.resolve(workspaceResolved, relPath);
  if (target !== workspaceResolved && !target.startsWith(workspaceResolved + path.sep)) {
    throw new WorkspacePathError(relPath, 'resolves outside the workspace directory');
  }
  return { workspaceResolved, target };
}

/**
 * Walks every existing path component from workspaceResolved down to
 * (and including) target, lstat-ing each. Throws WorkspacePathError the
 * moment one is a symlink. Components that don't exist yet are fine (they
 * are what a write is about to create) and simply stop the walk early.
 */
function assertNoSymlinksInPath(workspaceResolved, target, relPath) {
  const rel = path.relative(workspaceResolved, target);
  const segments = rel === '' ? [] : rel.split(path.sep);
  let current = workspaceResolved;
  for (const seg of segments) {
    current = path.join(current, seg);
    let stat;
    try {
      stat = fs.lstatSync(current);
    } catch {
      return; // doesn't exist yet — nothing further down can exist either
    }
    if (stat.isSymbolicLink()) {
      throw new WorkspacePathError(relPath, `path component is a symlink: ${current}`);
    }
  }
}

function guard(workspaceDir, relPath, opts) {
  assertWorkspaceRoot(workspaceDir);
  assertSafeRelPath(relPath, opts);
  const { workspaceResolved, target } = resolveInsideWorkspace(workspaceDir, relPath);
  assertNoSymlinksInPath(workspaceResolved, target, relPath);
  return target;
}

/**
 * Resolves `<workspaceDir>/<relPath>` through the exact same guard readFile()/
 * writeFile() use (workspace root check, relPath syntax, escape check,
 * symlink walk) and returns the absolute path — for callers that need the
 * LOCATION rather than its content, e.g. the file-watch trigger's fs.watch
 * target (src/triggers/runner.mjs). Throws WorkspacePathError exactly like
 * every other function here; a caller must never hand raw user input to fs
 * itself instead.
 */
export function resolveWorkspacePath({ workspaceDir, relPath }) {
  return guard(workspaceDir, relPath);
}

/**
 * Writes `data` (string or Buffer) to `<workspaceDir>/<relPath>`, creating
 * parent directories as needed. Atomic: written to a temp file in the same
 * directory, then renamed over the target (same pattern as
 * src/receipt/receipt.mjs / src/artifacts/preserve.mjs).
 */
export function writeFile({ workspaceDir, relPath, data }) {
  const target = guard(workspaceDir, relPath);
  const dir = path.dirname(target);
  fs.mkdirSync(dir, { recursive: true });
  const tmpPath = path.join(dir, `.${path.basename(target)}.tmp-${process.pid}-${Date.now()}`);
  fs.writeFileSync(tmpPath, data);
  fs.renameSync(tmpPath, target);
  return { relPath };
}

/** Reads `<workspaceDir>/<relPath>` as utf8 text. Throws WorkspacePathError for an unsafe path, or the underlying fs error (e.g. ENOENT) for a missing file. */
export function readFile({ workspaceDir, relPath }) {
  const target = guard(workspaceDir, relPath);
  return fs.readFileSync(target, 'utf8');
}

/**
 * Lists files under `<workspaceDir>/<relPath>` (default: the workspace
 * root) recursively, returning `{relPath, size, mtimeMs}` for each,
 * relPath given relative to workspaceDir with '/' separators. Symlinked
 * files/directories are skipped rather than followed (same posture as
 * preserve.mjs's walkScratchpad). Returns [] for a missing directory.
 */
export function listFiles({ workspaceDir, relPath = '' } = {}) {
  const target = guard(workspaceDir, relPath, { allowRoot: true });

  const results = [];
  function walk(dir) {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(fullPath);
      } else if (entry.isFile()) {
        let stat;
        try {
          stat = fs.statSync(fullPath);
        } catch {
          continue;
        }
        const rel = path.relative(workspaceDir, fullPath).split(path.sep).join('/');
        results.push({ relPath: rel, size: stat.size, mtimeMs: stat.mtimeMs });
      }
    }
  }
  walk(target);
  return results.sort((a, b) => (a.relPath < b.relPath ? -1 : a.relPath > b.relPath ? 1 : 0));
}

// Exported for direct unit testing of the traversal guard, without needing
// to fabricate a real symlink escape for every check (see fs.test.mjs).
export { assertSafeRelPath };
