// Tests for hooks install/uninstall/status. Always runs against a temp
// settings.json (settingsPath is always passed explicitly) — never touches
// the real ~/.claude/settings.json. Run: npx vitest run src/cli/hooks.test.mjs
import { test, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { install, uninstall, status, HOOK_SCRIPT_PATH } from './hooks.mjs';

let tmpDir;
let settingsPath;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'loryme-hooks-test-'));
  settingsPath = path.join(tmpDir, 'settings.json');
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function readJson(p) {
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

function findBackup() {
  return fs.readdirSync(tmpDir).find((f) => f.startsWith('settings.json.bak-'));
}

test('install on a missing settings file creates it with a Stop hook entry', () => {
  const result = install({ settingsPath });
  expect(result.installed).toBe(true);
  expect(result.alreadyInstalled).toBe(false);
  expect(fs.existsSync(settingsPath)).toBe(true);

  const settings = readJson(settingsPath);
  expect(settings.hooks.Stop).toHaveLength(1);
  expect(settings.hooks.Stop[0].hooks[0].type).toBe('command');
  expect(settings.hooks.Stop[0].hooks[0].command).toContain(HOOK_SCRIPT_PATH);
});

test('install with no pre-existing file does not create a backup', () => {
  const result = install({ settingsPath });
  expect(result.backupPath).toBeUndefined();
  expect(findBackup()).toBeUndefined();
});

test('install backs up an existing settings.json before writing', () => {
  fs.writeFileSync(settingsPath, JSON.stringify({ someOtherSetting: true }, null, 2), 'utf8');
  const before = fs.readFileSync(settingsPath, 'utf8');

  const result = install({ settingsPath });
  expect(result.backupPath).toBeDefined();
  expect(fs.existsSync(result.backupPath)).toBe(true);
  expect(fs.readFileSync(result.backupPath, 'utf8')).toBe(before);
});

test('install leaves foreign hooks byte-for-byte untouched', () => {
  const foreignSettings = {
    someOtherSetting: 'x',
    hooks: {
      Stop: [{ hooks: [{ type: 'command', command: 'node /some/other/script.mjs' }] }],
      PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'echo hi' }] }],
    },
  };
  fs.writeFileSync(settingsPath, JSON.stringify(foreignSettings, null, 2), 'utf8');

  install({ settingsPath });

  const settings = readJson(settingsPath);
  expect(settings.someOtherSetting).toBe('x');
  expect(settings.hooks.PreToolUse).toEqual(foreignSettings.hooks.PreToolUse);
  expect(settings.hooks.Stop).toContainEqual({ hooks: [{ type: 'command', command: 'node /some/other/script.mjs' }] });
  expect(settings.hooks.Stop).toHaveLength(2);
});

test('install is idempotent: a second call does not duplicate the entry', () => {
  install({ settingsPath });
  const second = install({ settingsPath });
  expect(second.alreadyInstalled).toBe(true);

  const settings = readJson(settingsPath);
  const ourEntries = settings.hooks.Stop.filter((m) => m.hooks.some((h) => h.command.includes(HOOK_SCRIPT_PATH)));
  expect(ourEntries).toHaveLength(1);
});

test('uninstall on a missing settings file reports nothing to remove and does not create it', () => {
  const result = uninstall({ settingsPath });
  expect(result.uninstalled).toBe(false);
  expect(fs.existsSync(settingsPath)).toBe(false);
});

test('uninstall removes only our own Stop hook entry, leaving foreign hooks intact', () => {
  install({ settingsPath });
  const settings = readJson(settingsPath);
  settings.hooks.Stop.push({ hooks: [{ type: 'command', command: 'node /some/other/script.mjs' }] });
  fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2), 'utf8');

  const result = uninstall({ settingsPath });
  expect(result.uninstalled).toBe(true);
  expect(result.backupPath).toBeDefined();

  const after = readJson(settingsPath);
  expect(after.hooks.Stop).toHaveLength(1);
  expect(after.hooks.Stop[0].hooks[0].command).toBe('node /some/other/script.mjs');
});

test('uninstall cleans up an empty hooks.Stop / hooks object it would otherwise leave behind', () => {
  install({ settingsPath });
  uninstall({ settingsPath });

  const after = readJson(settingsPath);
  expect(after.hooks?.Stop).toBeUndefined();
});

test('status reports installed:false when there is no settings file', () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'loryme-hooks-status-'));
  const result = status({ settingsPath, dataDir });
  expect(result.installed).toBe(false);
  fs.rmSync(dataDir, { recursive: true, force: true });
});

test('status reports installed:true and the active policy mode after install', () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'loryme-hooks-status-'));
  fs.writeFileSync(path.join(dataDir, 'policy.json'), JSON.stringify({ mode: 'warn' }), 'utf8');

  install({ settingsPath });
  const result = status({ settingsPath, dataDir });
  expect(result.installed).toBe(true);
  expect(result.mode).toBe('warn');

  fs.rmSync(dataDir, { recursive: true, force: true });
});
