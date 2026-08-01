// Preset loader tests — presets are data, not code: two generic built-ins
// plus user-supplied JSON files from <dataDir>/presets/. A user file may
// override a builtin by id. Invalid files are skipped with one summary
// warning; the built-ins always survive.
import { expect, test, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { loadPresets, BUILTIN_PRESETS } from './presets.mjs';

function tmpDataDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'kaprek-presets-'));
}

function writePreset(dir, name, body) {
  fs.mkdirSync(path.join(dir, 'presets'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'presets', name), typeof body === 'string' ? body : JSON.stringify(body));
}

test('builtins are returned when no user presets exist', () => {
  const presets = loadPresets(tmpDataDir());
  expect(presets.map((p) => p.id)).toEqual(BUILTIN_PRESETS.map((p) => p.id));
  expect(presets.every((p) => p.builtin === true)).toBe(true);
});

test('the two builtins are blank and guided-feature, both fully shaped', () => {
  const ids = BUILTIN_PRESETS.map((p) => p.id);
  expect(ids).toEqual(['blank', 'guided-feature']);
  for (const p of BUILTIN_PRESETS) {
    expect(typeof p.title).toBe('string');
    expect(typeof p.firstPrompt).toBe('string');
    expect(typeof p.goalTemplate).toBe('string');
    expect(typeof p.description).toBe('string');
  }
});

test('a valid user preset file is merged and marked non-builtin', () => {
  const dir = tmpDataDir();
  writePreset(dir, 'my.json', { id: 'my-flow', title: 'My flow', firstPrompt: 'Do the thing.' });
  const presets = loadPresets(dir);
  const mine = presets.find((p) => p.id === 'my-flow');
  expect(mine).toMatchObject({ title: 'My flow', builtin: false, description: '', goalTemplate: '' });
});

test('a user file with a builtin id overrides the builtin', () => {
  const dir = tmpDataDir();
  writePreset(dir, 'blank.json', { id: 'blank', title: 'My blank', firstPrompt: 'Start.' });
  const presets = loadPresets(dir);
  const blanks = presets.filter((p) => p.id === 'blank');
  expect(blanks).toHaveLength(1);
  expect(blanks[0]).toMatchObject({ title: 'My blank', builtin: false });
});

test('an invalid JSON file is skipped with one warning, builtins survive', () => {
  const dir = tmpDataDir();
  writePreset(dir, 'bad.json', '{not json');
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  expect(loadPresets(dir).length).toBe(BUILTIN_PRESETS.length);
  expect(warn).toHaveBeenCalledOnce();
  warn.mockRestore();
});

test('a file missing a required field is skipped', () => {
  const dir = tmpDataDir();
  writePreset(dir, 'incomplete.json', { id: 'x', title: 'No prompt' });
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  expect(loadPresets(dir).find((p) => p.id === 'x')).toBeUndefined();
  warn.mockRestore();
});

test('non-json files in the presets dir are ignored silently', () => {
  const dir = tmpDataDir();
  writePreset(dir, 'notes.txt', 'not a preset');
  expect(loadPresets(dir).length).toBe(BUILTIN_PRESETS.length);
});
