import { test, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { writeHarnessSettings, ASK_TOOLS_CHAT, ASK_TOOLS_TRIGGER, KNOWN_READONLY_TOOLS } from './settings.mjs';

let tmpDir;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kaprek-harness-settings-test-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('writes <dataDir>/harness/settings-chat.json with neutralized hooks, default mode, and the chat ask list', () => {
  const settingsPath = writeHarnessSettings({ dataDir: tmpDir, profile: 'chat' });

  expect(settingsPath).toBe(path.join(tmpDir, 'harness', 'settings-chat.json'));
  const parsed = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
  expect(parsed).toEqual({
    hooks: {},
    permissions: { defaultMode: 'default', allow: [], deny: [], ask: ASK_TOOLS_CHAT },
  });
});

test('writes <dataDir>/harness/settings-trigger.json with the (larger) trigger ask list', () => {
  const settingsPath = writeHarnessSettings({ dataDir: tmpDir, profile: 'trigger' });

  expect(settingsPath).toBe(path.join(tmpDir, 'harness', 'settings-trigger.json'));
  const parsed = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
  expect(parsed.permissions.ask).toEqual(ASK_TOOLS_TRIGGER);
});

test('the trigger ask list is a strict superset of the chat ask list, plus every read-only tool', () => {
  for (const tool of ASK_TOOLS_CHAT) expect(ASK_TOOLS_TRIGGER).toContain(tool);
  for (const tool of KNOWN_READONLY_TOOLS) {
    expect(ASK_TOOLS_TRIGGER).toContain(tool);
    // The chat profile deliberately leaves read-only tools OUT of its own
    // ask list — asking permission for every Read/Grep would make a chat a
    // human is watching unusable.
    expect(ASK_TOOLS_CHAT).not.toContain(tool);
  }
});

test('the two profiles never overwrite each other — both can exist side by side', () => {
  const chatPath = writeHarnessSettings({ dataDir: tmpDir, profile: 'chat' });
  const triggerPath = writeHarnessSettings({ dataDir: tmpDir, profile: 'trigger' });

  expect(chatPath).not.toBe(triggerPath);
  expect(fs.existsSync(chatPath)).toBe(true);
  expect(fs.existsSync(triggerPath)).toBe(true);
});

test('throws when profile is missing or unknown', () => {
  expect(() => writeHarnessSettings({ dataDir: tmpDir })).toThrow();
  expect(() => writeHarnessSettings({ dataDir: tmpDir, profile: 'bogus' })).toThrow();
});

test('is idempotent — calling it again for the same profile overwrites the same file, no leftover tmp files', () => {
  writeHarnessSettings({ dataDir: tmpDir, profile: 'chat' });
  const secondPath = writeHarnessSettings({ dataDir: tmpDir, profile: 'chat' });

  const entries = fs.readdirSync(path.join(tmpDir, 'harness'));
  expect(entries).toEqual(['settings-chat.json']);
  expect(secondPath).toBe(path.join(tmpDir, 'harness', 'settings-chat.json'));
});

// Regression test for task-6a review Critical #3's underlying race: a
// concurrent turn's tmp+rename against this SAME fixed path can throw EPERM
// on Windows if the destination is still open elsewhere. Content is fully
// deterministic, so once written it never needs to change — a second call
// must be a pure read, no fs.writeFileSync at all, closing that race window
// instead of just tolerating its failure.
test('does not rewrite the file when its content is already up to date (closes the concurrent-turn rename race, see task-6a review)', () => {
  const first = writeHarnessSettings({ dataDir: tmpDir, profile: 'chat' });
  const mtimeBefore = fs.statSync(first).mtimeMs;

  const writeSpy = vi.spyOn(fs, 'writeFileSync');
  const renameSpy = vi.spyOn(fs, 'renameSync');
  const second = writeHarnessSettings({ dataDir: tmpDir, profile: 'chat' });

  expect(second).toBe(first);
  expect(writeSpy).not.toHaveBeenCalled();
  expect(renameSpy).not.toHaveBeenCalled();
  expect(fs.statSync(first).mtimeMs).toBe(mtimeBefore);
  writeSpy.mockRestore();
  renameSpy.mockRestore();
});

test('throws when dataDir is missing', () => {
  expect(() => writeHarnessSettings({ profile: 'chat' })).toThrow();
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

  const settingsPath = writeHarnessSettings({ dataDir: tmpDir, profile: 'chat' });

  expect(settingsPath).toBe(path.join(tmpDir, 'harness', 'settings-chat.json'));
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

  const fallbackPath = writeHarnessSettings({ dataDir: tmpDir, profile: 'chat' });

  expect(fallbackPath).not.toBe(path.join(tmpDir, 'harness', 'settings-chat.json'));
  expect(path.basename(fallbackPath)).toMatch(/^settings-chat-.*\.json$/);
  expect(fs.existsSync(fallbackPath)).toBe(true);
  expect(JSON.parse(fs.readFileSync(fallbackPath, 'utf8'))).toEqual({
    hooks: {},
    permissions: { defaultMode: 'default', allow: [], deny: [], ask: ASK_TOOLS_CHAT },
  });
  // The fixed path was never actually created — every rename attempt
  // failed before ever reaching it.
  expect(fs.existsSync(path.join(tmpDir, 'harness', 'settings-chat.json'))).toBe(false);
  renameSpy.mockRestore();
});

// If even the turn-unique fallback can't be written, this is a genuine,
// unrecoverable failure — the error must propagate (src/orchestrator/run.mjs
// turns that into a turn-level error BEFORE the CLI is ever spawned).
test('throws when even the turn-unique fallback file cannot be written', () => {
  const writeSpy = vi.spyOn(fs, 'writeFileSync').mockImplementation(() => {
    throw new Error('disk full (simulated)');
  });

  expect(() => writeHarnessSettings({ dataDir: tmpDir, profile: 'chat' })).toThrow('disk full (simulated)');

  writeSpy.mockRestore();
});
