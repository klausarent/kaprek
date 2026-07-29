// Tests for scratchpad artifact preservation. Run: npx vitest run src/artifacts
import { test, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { sweepArtifacts, readArtifactManifest, sweepSessionArtifacts, isSafeRelPath } from './preserve.mjs';

let tmpRoot;
let dataDir;

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'kaprek-artifacts-tmproot-'));
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kaprek-artifacts-data-'));
});

afterEach(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  fs.rmSync(dataDir, { recursive: true, force: true });
});

function scratchpadDir(projectSlug, sessionId) {
  return path.join(tmpRoot, projectSlug, sessionId, 'scratchpad');
}

function writeScratchpadFile(projectSlug, sessionId, relPath, content) {
  const dir = scratchpadDir(projectSlug, sessionId);
  const filePath = path.join(dir, relPath);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, 'utf8');
  return filePath;
}

function artifactsDirFor(projectSlug, sessionId) {
  return path.join(dataDir, 'artifacts', projectSlug, sessionId);
}

test('sweep copies scratchpad files into the artifacts dir and records a correct manifest', () => {
  writeScratchpadFile('proj-a', 'sess-1', 'script.py', 'print("hi")');
  writeScratchpadFile('proj-a', 'sess-1', 'nested/data.json', '{"a":1}');

  const result = sweepArtifacts({ tmpRoot, dataDir });

  expect(result.sessions).toBe(1);
  expect(result.copied).toBe(2);
  expect(result.skipped).toBe(0);
  expect(result.errors).toEqual([]);

  const artifactsDir = artifactsDirFor('proj-a', 'sess-1');
  expect(fs.readFileSync(path.join(artifactsDir, 'script.py'), 'utf8')).toBe('print("hi")');
  expect(fs.readFileSync(path.join(artifactsDir, 'nested', 'data.json'), 'utf8')).toBe('{"a":1}');

  const manifest = readArtifactManifest(dataDir, 'proj-a', 'sess-1');
  expect(manifest.files.length).toBe(2);
  const scriptEntry = manifest.files.find((f) => f.relPath === 'script.py');
  expect(scriptEntry.size).toBe(Buffer.byteLength('print("hi")', 'utf8'));
  expect(typeof scriptEntry.mtimeMs).toBe('number');
  expect(scriptEntry.sha256).toBe(crypto.createHash('sha256').update('print("hi")').digest('hex'));
  expect(typeof scriptEntry.preservedAt).toBe('string');
});

test('idempotent: a second sweep of unchanged files copies nothing', () => {
  writeScratchpadFile('proj-a', 'sess-1', 'script.py', 'print("hi")');
  sweepArtifacts({ tmpRoot, dataDir });

  const second = sweepArtifacts({ tmpRoot, dataDir });
  expect(second.copied).toBe(0);
  expect(second.errors).toEqual([]);
});

test('a changed file (different content/mtime) is re-copied and its manifest entry updated', () => {
  const filePath = writeScratchpadFile('proj-a', 'sess-1', 'script.py', 'print("hi")');
  sweepArtifacts({ tmpRoot, dataDir });
  const firstManifest = readArtifactManifest(dataDir, 'proj-a', 'sess-1');
  const firstSha = firstManifest.files.find((f) => f.relPath === 'script.py').sha256;

  fs.writeFileSync(filePath, 'print("changed")', 'utf8');
  // Force a distinct mtime — some filesystems have coarse mtime resolution,
  // and the manifest's staleness check keys on size+mtime.
  const future = new Date(Date.now() + 60_000);
  fs.utimesSync(filePath, future, future);

  const result = sweepArtifacts({ tmpRoot, dataDir });
  expect(result.copied).toBe(1);

  const artifactsDir = artifactsDirFor('proj-a', 'sess-1');
  expect(fs.readFileSync(path.join(artifactsDir, 'script.py'), 'utf8')).toBe('print("changed")');

  const secondManifest = readArtifactManifest(dataDir, 'proj-a', 'sess-1');
  const secondEntry = secondManifest.files.find((f) => f.relPath === 'script.py');
  expect(secondEntry.sha256).not.toBe(firstSha);
  expect(secondEntry.sha256).toBe(crypto.createHash('sha256').update('print("changed")').digest('hex'));
});

test('a file over maxFileBytes is skipped (not copied) and recorded in the manifest as too-large', () => {
  writeScratchpadFile('proj-a', 'sess-1', 'big.bin', 'x'.repeat(200));

  const result = sweepArtifacts({ tmpRoot, dataDir, maxFileBytes: 100 });

  expect(result.copied).toBe(0);
  expect(result.skipped).toBe(1);
  const artifactsDir = artifactsDirFor('proj-a', 'sess-1');
  expect(fs.existsSync(path.join(artifactsDir, 'big.bin'))).toBe(false);

  const manifest = readArtifactManifest(dataDir, 'proj-a', 'sess-1');
  const entry = manifest.files.find((f) => f.relPath === 'big.bin');
  expect(entry).toEqual({ relPath: 'big.bin', size: 200, skipped: 'too-large' });
});

test('once a session exceeds maxSessionBytes, remaining files are skipped as session-budget', () => {
  // Sorted processing order is by relPath — 'a.txt' is copied first (fits),
  // then 'b.txt' pushes the running total over the 150-byte session budget.
  writeScratchpadFile('proj-a', 'sess-1', 'a.txt', 'x'.repeat(100));
  writeScratchpadFile('proj-a', 'sess-1', 'b.txt', 'y'.repeat(100));

  const result = sweepArtifacts({ tmpRoot, dataDir, maxFileBytes: 1000, maxSessionBytes: 150 });

  expect(result.copied).toBe(1);
  expect(result.skipped).toBe(1);

  const artifactsDir = artifactsDirFor('proj-a', 'sess-1');
  expect(fs.existsSync(path.join(artifactsDir, 'a.txt'))).toBe(true);
  expect(fs.existsSync(path.join(artifactsDir, 'b.txt'))).toBe(false);

  const manifest = readArtifactManifest(dataDir, 'proj-a', 'sess-1');
  const bEntry = manifest.files.find((f) => f.relPath === 'b.txt');
  expect(bEntry).toEqual({ relPath: 'b.txt', size: 100, skipped: 'session-budget' });
});

test('node_modules (and other excluded dirs) are never walked or preserved', () => {
  writeScratchpadFile('proj-a', 'sess-1', 'real.txt', 'keep me');
  writeScratchpadFile('proj-a', 'sess-1', 'node_modules/pkg/index.js', 'module.exports = {}');
  writeScratchpadFile('proj-a', 'sess-1', '.git/HEAD', 'ref: refs/heads/main');

  const result = sweepArtifacts({ tmpRoot, dataDir });

  expect(result.copied).toBe(1);
  const artifactsDir = artifactsDirFor('proj-a', 'sess-1');
  expect(fs.existsSync(path.join(artifactsDir, 'real.txt'))).toBe(true);
  expect(fs.existsSync(path.join(artifactsDir, 'node_modules'))).toBe(false);
  expect(fs.existsSync(path.join(artifactsDir, '.git'))).toBe(false);

  const manifest = readArtifactManifest(dataDir, 'proj-a', 'sess-1');
  expect(manifest.files.map((f) => f.relPath)).toEqual(['real.txt']);
});

test('traversal hardening: isSafeRelPath rejects any relPath escaping via a .. or . segment, or an absolute path', () => {
  expect(isSafeRelPath('plain.txt')).toBe(true);
  expect(isSafeRelPath('sub/plain.txt')).toBe(true);
  expect(isSafeRelPath('..evil.txt')).toBe(true); // odd filename, not an actual traversal segment
  expect(isSafeRelPath('../evil.txt')).toBe(false);
  expect(isSafeRelPath('sub/../../evil.txt')).toBe(false);
  expect(isSafeRelPath('./evil.txt')).toBe(false);
  expect(isSafeRelPath('/etc/passwd')).toBe(false);
  expect(isSafeRelPath('')).toBe(false);
});

test('traversal hardening: a scratchpad symlink pointing outside its own tree is never followed, nothing is written outside the artifacts dir', () => {
  const dir = scratchpadDir('proj-a', 'sess-1');
  fs.mkdirSync(dir, { recursive: true });
  const outsideFile = path.join(tmpRoot, 'outside-secret.txt');
  fs.writeFileSync(outsideFile, 'do not preserve me', 'utf8');

  let symlinkCreated = true;
  try {
    fs.symlinkSync(outsideFile, path.join(dir, 'evil-link.txt'));
  } catch {
    // Creating symlinks can require elevated privileges on Windows — if this
    // platform/user can't, there is nothing for this test to exercise.
    symlinkCreated = false;
  }
  if (!symlinkCreated) return;

  const result = sweepArtifacts({ tmpRoot, dataDir });

  expect(result.copied).toBe(0);
  const artifactsDir = artifactsDirFor('proj-a', 'sess-1');
  expect(fs.existsSync(path.join(artifactsDir, 'evil-link.txt'))).toBe(false);
  expect(fs.existsSync(path.join(dataDir, 'outside-secret.txt'))).toBe(false);
});

test('sweepArtifacts against a nonexistent tmpRoot returns an empty, error-free result', () => {
  const result = sweepArtifacts({ tmpRoot: path.join(tmpRoot, 'does-not-exist'), dataDir });
  expect(result).toEqual({ sessions: 0, copied: 0, skipped: 0, errors: [] });
});

test('readArtifactManifest defaults to { files: [] } when no manifest exists yet', () => {
  expect(readArtifactManifest(dataDir, 'proj-a', 'sess-1')).toEqual({ files: [] });
});

test('sweepSessionArtifacts (single-session entry point used by the Stop hook) preserves just that session', () => {
  writeScratchpadFile('proj-a', 'sess-1', 'keep.txt', 'hook capture');
  writeScratchpadFile('proj-b', 'sess-2', 'other.txt', 'not this one');

  const result = sweepSessionArtifacts({ tmpRoot, dataDir, projectSlug: 'proj-a', sessionId: 'sess-1' });

  expect(result.copied).toBe(1);
  expect(result.errors).toEqual([]);
  expect(fs.existsSync(path.join(artifactsDirFor('proj-a', 'sess-1'), 'keep.txt'))).toBe(true);
  expect(fs.existsSync(artifactsDirFor('proj-b', 'sess-2'))).toBe(false);
});

test('sweepSessionArtifacts is a no-op (fails open) when the session has no scratchpad directory at all', () => {
  const result = sweepSessionArtifacts({ tmpRoot, dataDir, projectSlug: 'proj-a', sessionId: 'no-scratchpad' });
  expect(result).toEqual({ copied: 0, skipped: 0, errors: [] });
});
