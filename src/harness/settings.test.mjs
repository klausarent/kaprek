import { test, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { writeHarnessSettings } from './settings.mjs';

let tmpDir;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kaprek-harness-settings-test-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('writes <dataDir>/harness/settings.json with neutralized hooks and default permissions', () => {
  const settingsPath = writeHarnessSettings({ dataDir: tmpDir });

  expect(settingsPath).toBe(path.join(tmpDir, 'harness', 'settings.json'));
  const parsed = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
  expect(parsed).toEqual({
    hooks: {},
    permissions: { defaultMode: 'default', allow: [], deny: [] },
  });
});

test('is idempotent — calling it again overwrites the same file, no leftover tmp files', () => {
  writeHarnessSettings({ dataDir: tmpDir });
  const secondPath = writeHarnessSettings({ dataDir: tmpDir });

  const entries = fs.readdirSync(path.join(tmpDir, 'harness'));
  expect(entries).toEqual(['settings.json']);
  expect(secondPath).toBe(path.join(tmpDir, 'harness', 'settings.json'));
});

// Regression test for task-6a review Critical #3's underlying race: a
// concurrent turn's tmp+rename against this SAME fixed path can throw EPERM
// on Windows if the destination is still open elsewhere. Content is fully
// deterministic, so once written it never needs to change — a second call
// must be a pure read, no fs.writeFileSync at all, closing that race window
// instead of just tolerating its failure.
test('does not rewrite the file when its content is already up to date (closes the concurrent-turn rename race, see task-6a review)', () => {
  const first = writeHarnessSettings({ dataDir: tmpDir });
  const mtimeBefore = fs.statSync(first).mtimeMs;

  const writeSpy = vi.spyOn(fs, 'writeFileSync');
  const renameSpy = vi.spyOn(fs, 'renameSync');
  const second = writeHarnessSettings({ dataDir: tmpDir });

  expect(second).toBe(first);
  expect(writeSpy).not.toHaveBeenCalled();
  expect(renameSpy).not.toHaveBeenCalled();
  expect(fs.statSync(first).mtimeMs).toBe(mtimeBefore);
  writeSpy.mockRestore();
  renameSpy.mockRestore();
});

test('throws when dataDir is missing', () => {
  expect(() => writeHarnessSettings({})).toThrow();
});

// Peer-reviewed follow-up (task-6a review, Settings-Race section): compare-
// before-write alone doesn't help the very FIRST write for a dataDir (no
// prior content to compare against) — that write can still race a
// concurrent turn's own first write. One retry against the same fixed path
// covers a transient EPERM/EBUSY (the destination is often free again a
// moment later).
test('retries once against the fixed path when the rename transiently fails, still returns the fixed (shared) path', () => {
  const realRename = fs.renameSync.bind(fs);
  let calls = 0;
  const renameSpy = vi.spyOn(fs, 'renameSync').mockImplementation((from, to) => {
    calls += 1;
    if (calls === 1) {
      const err = new Error('EPERM: simulated, resource busy or locked');
      err.code = 'EPERM';
      throw err;
    }
    return realRename(from, to);
  });

  const settingsPath = writeHarnessSettings({ dataDir: tmpDir });

  expect(settingsPath).toBe(path.join(tmpDir, 'harness', 'settings.json'));
  expect(calls).toBe(2);
  expect(fs.existsSync(settingsPath)).toBe(true);
  renameSpy.mockRestore();
});

// A turn must NEVER proceed without --settings at all (see this file's own
// doc comment) — if the fixed path keeps failing even after the retry, fall
// back to a turn-unique file with the identical content instead of giving up.
test('falls back to a turn-unique file with identical content when the fixed path keeps failing', () => {
  const renameSpy = vi.spyOn(fs, 'renameSync').mockImplementation(() => {
    const err = new Error('EPERM: simulated, resource busy or locked');
    err.code = 'EPERM';
    throw err;
  });

  const fallbackPath = writeHarnessSettings({ dataDir: tmpDir });

  expect(fallbackPath).not.toBe(path.join(tmpDir, 'harness', 'settings.json'));
  expect(path.basename(fallbackPath)).toMatch(/^settings-.*\.json$/);
  expect(fs.existsSync(fallbackPath)).toBe(true);
  expect(JSON.parse(fs.readFileSync(fallbackPath, 'utf8'))).toEqual({
    hooks: {},
    permissions: { defaultMode: 'default', allow: [], deny: [] },
  });
  // The fixed path was never actually created — every rename attempt
  // failed before ever reaching it.
  expect(fs.existsSync(path.join(tmpDir, 'harness', 'settings.json'))).toBe(false);
  renameSpy.mockRestore();
});

// If even the turn-unique fallback can't be written, this is a genuine,
// unrecoverable failure — the error must propagate (src/orchestrator/run.mjs
// turns that into a turn-level error BEFORE the CLI is ever spawned).
test('throws when even the turn-unique fallback file cannot be written', () => {
  const writeSpy = vi.spyOn(fs, 'writeFileSync').mockImplementation(() => {
    throw new Error('disk full (simulated)');
  });

  expect(() => writeHarnessSettings({ dataDir: tmpDir })).toThrow('disk full (simulated)');

  writeSpy.mockRestore();
});
