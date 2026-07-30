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
