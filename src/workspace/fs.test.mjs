// Tests for the workspace write path. Run: npx vitest run src/workspace/fs.test.mjs
import { test, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { writeFile, readFile, listFiles, WorkspacePathError } from './fs.mjs';

let workspaceDir;
let outsideDir;

beforeEach(() => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kaprek-workspace-test-'));
  workspaceDir = path.join(root, 'workspace');
  outsideDir = path.join(root, 'outside');
  fs.mkdirSync(workspaceDir, { recursive: true });
  fs.mkdirSync(outsideDir, { recursive: true });
});

afterEach(() => {
  fs.rmSync(path.dirname(workspaceDir), { recursive: true, force: true });
});

// --------------------------------------------------------------------- writeFile

test('writeFile writes a file under workspaceDir, creating parent dirs', () => {
  writeFile({ workspaceDir, relPath: 'notes/hello.md', data: '# hi\n' });
  expect(fs.readFileSync(path.join(workspaceDir, 'notes', 'hello.md'), 'utf8')).toBe('# hi\n');
});

test('writeFile overwrites an existing file atomically (no leftover tmp file)', () => {
  writeFile({ workspaceDir, relPath: 'a.txt', data: 'one' });
  writeFile({ workspaceDir, relPath: 'a.txt', data: 'two' });
  expect(fs.readFileSync(path.join(workspaceDir, 'a.txt'), 'utf8')).toBe('two');
  const entries = fs.readdirSync(workspaceDir);
  expect(entries).toEqual(['a.txt']);
});

test('writeFile rejects an absolute relPath', () => {
  expect(() => writeFile({ workspaceDir, relPath: path.join(outsideDir, 'x.txt'), data: 'x' })).toThrow(
    WorkspacePathError,
  );
});

test('writeFile rejects a relPath containing ".." traversal', () => {
  expect(() => writeFile({ workspaceDir, relPath: '../outside/x.txt', data: 'x' })).toThrow(WorkspacePathError);
  expect(fs.existsSync(path.join(outsideDir, 'x.txt'))).toBe(false);
});

test('writeFile rejects a relPath with a drive letter', () => {
  expect(() => writeFile({ workspaceDir, relPath: 'C:\\evil.txt', data: 'x' })).toThrow(WorkspacePathError);
});

test('writeFile rejects an empty relPath', () => {
  expect(() => writeFile({ workspaceDir, relPath: '', data: 'x' })).toThrow(WorkspacePathError);
});

test('writeFile rejects writing through a symlinked directory planted inside the workspace', () => {
  let symlinkCreated = true;
  try {
    fs.symlinkSync(outsideDir, path.join(workspaceDir, 'escape'), 'junction');
  } catch {
    symlinkCreated = false; // e.g. no privilege to create symlinks/junctions on this machine
  }
  if (!symlinkCreated) return;

  expect(() => writeFile({ workspaceDir, relPath: 'escape/x.txt', data: 'x' })).toThrow(WorkspacePathError);
  expect(fs.existsSync(path.join(outsideDir, 'x.txt'))).toBe(false);
});

// --------------------------------------------------------------------- readFile

test('readFile reads back what writeFile wrote', () => {
  writeFile({ workspaceDir, relPath: 'notes/hello.md', data: 'content' });
  expect(readFile({ workspaceDir, relPath: 'notes/hello.md' })).toBe('content');
});

test('readFile rejects ".." traversal', () => {
  fs.writeFileSync(path.join(outsideDir, 'secret.txt'), 'secret', 'utf8');
  expect(() => readFile({ workspaceDir, relPath: '../outside/secret.txt' })).toThrow(WorkspacePathError);
});

test('readFile throws the underlying fs error for a missing file', () => {
  expect(() => readFile({ workspaceDir, relPath: 'missing.txt' })).toThrow();
});

// -------------------------------------------------------------------- listFiles

test('listFiles lists files recursively with workspace-relative paths', () => {
  writeFile({ workspaceDir, relPath: 'notes/a.md', data: 'a' });
  writeFile({ workspaceDir, relPath: 'notes/sub/b.md', data: 'b' });
  writeFile({ workspaceDir, relPath: 'c.md', data: 'c' });

  const files = listFiles({ workspaceDir }).map((f) => f.relPath);
  expect(files.sort()).toEqual(['c.md', 'notes/a.md', 'notes/sub/b.md']);
});

test('listFiles returns [] for a missing subdirectory', () => {
  expect(listFiles({ workspaceDir, relPath: 'nope' })).toEqual([]);
});

test('listFiles rejects ".." traversal', () => {
  expect(() => listFiles({ workspaceDir, relPath: '..' })).toThrow(WorkspacePathError);
});
