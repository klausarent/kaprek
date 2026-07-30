import { test, expect, beforeEach, afterEach } from 'vitest';
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

test('throws when dataDir is missing', () => {
  expect(() => writeHarnessSettings({})).toThrow();
});
