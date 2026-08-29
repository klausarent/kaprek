// Tests for hooks install/uninstall/status. Always runs against a temp
// settings.json (settingsPath is always passed explicitly) — never touches
// the real ~/.claude/settings.json. Run: npx vitest run src/cli/hooks.test.mjs
import { test, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { install, uninstall, status, HOOK_SCRIPT_PATH, SESSION_START_SCRIPT_PATH, SESSION_END_SCRIPT_PATH } from './hooks.mjs';

let tmpDir;
let settingsPath;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kaprek-hooks-test-'));
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
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kaprek-hooks-status-'));
  const result = status({ settingsPath, dataDir });
  expect(result.installed).toBe(false);
  fs.rmSync(dataDir, { recursive: true, force: true });
});

test('status reports installed:true and the active policy mode after install', () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kaprek-hooks-status-'));
  fs.writeFileSync(path.join(dataDir, 'policy.json'), JSON.stringify({ mode: 'warn' }), 'utf8');

  install({ settingsPath });
  const result = status({ settingsPath, dataDir });
  expect(result.installed).toBe(true);
  expect(result.mode).toBe('warn');

  fs.rmSync(dataDir, { recursive: true, force: true });
});

test('status reports the recorded hook script path and that it exists', () => {
  install({ settingsPath });
  const result = status({ settingsPath });
  expect(result.recordedPath).toBe(HOOK_SCRIPT_PATH);
  expect(result.recordedPathMissing).toBe(false);
});

test('status flags a recorded path that no longer exists on disk as stale', () => {
  install({ settingsPath, hookScriptPath: path.join(tmpDir, 'no-such-hook-stop.mjs') });
  const result = status({ settingsPath });
  expect(result.installed).toBe(true);
  expect(result.recordedPathMissing).toBe(true);
});

// ------------------------------------------------------------- atomic write

test('install writes atomically: no leftover temp file, and the target is always valid JSON', () => {
  install({ settingsPath });
  const leftoverTemp = fs.readdirSync(tmpDir).find((f) => f.startsWith('.settings.json.tmp-'));
  expect(leftoverTemp).toBeUndefined();
  expect(() => readJson(settingsPath)).not.toThrow();
});

test('install preserves the existing settings.json file permission bits across the atomic rewrite', () => {
  fs.writeFileSync(settingsPath, JSON.stringify({ someOtherSetting: true }, null, 2), 'utf8');
  fs.chmodSync(settingsPath, 0o600);

  install({ settingsPath });

  if (process.platform === 'win32') {
    // No POSIX permission model on Windows — just confirm the write itself
    // still succeeds with the chmod-preservation code path exercised.
    expect(fs.existsSync(settingsPath)).toBe(true);
  } else {
    const mode = fs.statSync(settingsPath).mode & 0o777;
    expect(mode).toBe(0o600);
  }
});

test('uninstall also writes atomically: no leftover temp file', () => {
  install({ settingsPath });
  uninstall({ settingsPath });
  const leftoverTemp = fs.readdirSync(tmpDir).find((f) => f.startsWith('.settings.json.tmp-'));
  expect(leftoverTemp).toBeUndefined();
  expect(() => readJson(settingsPath)).not.toThrow();
});

// --------------------------------------------------- stable marker matching

test('install replaces a stale-path entry carrying our marker instead of duplicating it (e.g. after an npx cache path change)', () => {
  const packageName = 'kaprek';
  const staleCommand = `node "/old/npx-cache/path/hook-stop.mjs" --managed-by=${packageName}`;
  fs.writeFileSync(
    settingsPath,
    JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command: staleCommand }] }] } }, null, 2),
    'utf8',
  );

  const result = install({ settingsPath, packageName });
  expect(result.alreadyInstalled).toBe(true);

  const settings = readJson(settingsPath);
  expect(settings.hooks.Stop).toHaveLength(1);
  expect(settings.hooks.Stop[0].hooks).toHaveLength(1);
  expect(settings.hooks.Stop[0].hooks[0].command).toContain(HOOK_SCRIPT_PATH);
  expect(settings.hooks.Stop[0].hooks[0].command).not.toContain('/old/npx-cache/path');
});

test('uninstall removes a marker-matched entry even at a stale path', () => {
  const packageName = 'kaprek';
  const staleCommand = `node "/old/npx-cache/path/hook-stop.mjs" --managed-by=${packageName}`;
  fs.writeFileSync(
    settingsPath,
    JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command: staleCommand }] }] } }, null, 2),
    'utf8',
  );

  const result = uninstall({ settingsPath, packageName });
  expect(result.uninstalled).toBe(true);

  const after = readJson(settingsPath);
  expect(after.hooks?.Stop).toBeUndefined();
});

// ------------------------------------------------------------------- BOM

test('a settings.json with a leading BOM is read and modified correctly', () => {
  const bom = '﻿';
  fs.writeFileSync(settingsPath, `${bom}${JSON.stringify({ someOtherSetting: true }, null, 2)}`, 'utf8');

  const result = install({ settingsPath });
  expect(result.alreadyInstalled).toBe(false);

  const settings = readJson(settingsPath);
  expect(settings.someOtherSetting).toBe(true);
  expect(settings.hooks.Stop).toHaveLength(1);
});

// ------------------------------------------------------------ SessionStart

test('install adds the SessionStart hook next to the Stop hook, both under one marker', () => {
  install({ settingsPath });
  const settings = readJson(settingsPath);
  expect(settings.hooks.SessionStart).toHaveLength(1);
  expect(settings.hooks.SessionStart[0].hooks[0].command).toContain(SESSION_START_SCRIPT_PATH);
  expect(settings.hooks.SessionStart[0].hooks[0].command).toContain('--managed-by=');
  expect(settings.hooks.Stop[0].hooks[0].command).toContain(HOOK_SCRIPT_PATH);
});

test('an install from before the SessionStart hook existed gains it, and says which entry was added', () => {
  fs.writeFileSync(settingsPath, JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command: `node "${HOOK_SCRIPT_PATH}" --managed-by=kaprek` }] }] } }), 'utf8');
  const result = install({ settingsPath, packageName: 'kaprek' });
  expect(result.alreadyInstalled).toBe(true);
  expect(result.added).toEqual(['SessionStart', 'SessionEnd']);
  const settings = readJson(settingsPath);
  expect(settings.hooks.Stop).toHaveLength(1);
  expect(settings.hooks.SessionStart).toHaveLength(1);
  // The second run changes nothing and says so.
  const again = install({ settingsPath, packageName: 'kaprek' });
  expect(again.alreadyInstalled).toBe(true);
  expect(again.added).toEqual([]);
  expect(readJson(settingsPath).hooks.SessionStart).toHaveLength(1);
  // A fresh install adds all three.
  fs.rmSync(settingsPath);
  expect(install({ settingsPath, packageName: 'kaprek' }).added).toEqual(['Stop', 'SessionStart', 'SessionEnd']);
});

test('uninstall removes both entries and leaves a foreign SessionStart hook alone', () => {
  fs.writeFileSync(settingsPath, JSON.stringify({ hooks: { SessionStart: [{ matcher: 'startup', hooks: [{ type: 'command', command: 'echo theirs' }] }] } }), 'utf8');
  install({ settingsPath, packageName: 'kaprek' });
  expect(readJson(settingsPath).hooks.SessionStart).toHaveLength(2);
  const result = uninstall({ settingsPath, packageName: 'kaprek' });
  expect(result.uninstalled).toBe(true);
  const settings = readJson(settingsPath);
  expect(settings.hooks.Stop).toBeUndefined();
  expect(settings.hooks.SessionStart).toEqual([{ matcher: 'startup', hooks: [{ type: 'command', command: 'echo theirs' }] }]);
});

test('status reports each event, and a Stop-only install shows SessionStart as missing', () => {
  fs.writeFileSync(settingsPath, JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command: `node "${HOOK_SCRIPT_PATH}" --managed-by=kaprek` }] }] } }), 'utf8');
  const before = status({ settingsPath, dataDir: tmpDir, packageName: 'kaprek' });
  expect(before.installed).toBe(true);
  expect(before.events.Stop.installed).toBe(true);
  expect(before.events.SessionStart.installed).toBe(false);
  install({ settingsPath, packageName: 'kaprek' });
  const after = status({ settingsPath, dataDir: tmpDir, packageName: 'kaprek' });
  expect(after.events.SessionStart).toMatchObject({ installed: true, recordedPath: SESSION_START_SCRIPT_PATH, recordedPathMissing: false });
});

// -------------------------------------------------------------- SessionEnd

test('install adds the SessionEnd hook alongside Stop and SessionStart, all under one marker', () => {
  install({ settingsPath });
  const settings = readJson(settingsPath);
  expect(settings.hooks.SessionEnd).toHaveLength(1);
  expect(settings.hooks.SessionEnd[0].hooks[0].command).toContain(SESSION_END_SCRIPT_PATH);
  expect(settings.hooks.SessionEnd[0].hooks[0].command).toContain('--managed-by=');
});

test('an install from before the SessionEnd hook existed gains it, keeping Stop and SessionStart untouched', () => {
  fs.writeFileSync(
    settingsPath,
    JSON.stringify({
      hooks: {
        Stop: [{ hooks: [{ type: 'command', command: `node "${HOOK_SCRIPT_PATH}" --managed-by=kaprek` }] }],
        SessionStart: [{ hooks: [{ type: 'command', command: `node "${SESSION_START_SCRIPT_PATH}" --managed-by=kaprek` }] }],
      },
    }),
    'utf8',
  );
  const result = install({ settingsPath, packageName: 'kaprek' });
  expect(result.alreadyInstalled).toBe(true);
  expect(result.added).toEqual(['SessionEnd']);
  const settings = readJson(settingsPath);
  expect(settings.hooks.Stop).toHaveLength(1);
  expect(settings.hooks.SessionStart).toHaveLength(1);
  expect(settings.hooks.SessionEnd).toHaveLength(1);
});

test('uninstall removes the SessionEnd entry and leaves a foreign SessionEnd hook alone', () => {
  fs.writeFileSync(settingsPath, JSON.stringify({ hooks: { SessionEnd: [{ hooks: [{ type: 'command', command: 'echo theirs' }] }] } }), 'utf8');
  install({ settingsPath, packageName: 'kaprek' });
  expect(readJson(settingsPath).hooks.SessionEnd).toHaveLength(2);
  const result = uninstall({ settingsPath, packageName: 'kaprek' });
  expect(result.uninstalled).toBe(true);
  const settings = readJson(settingsPath);
  expect(settings.hooks.SessionEnd).toEqual([{ hooks: [{ type: 'command', command: 'echo theirs' }] }]);
});

test('status reports SessionEnd as missing before install and installed after', () => {
  const before = status({ settingsPath, dataDir: tmpDir, packageName: 'kaprek' });
  expect(before.events.SessionEnd.installed).toBe(false);
  install({ settingsPath, packageName: 'kaprek' });
  const after = status({ settingsPath, dataDir: tmpDir, packageName: 'kaprek' });
  expect(after.events.SessionEnd).toMatchObject({ installed: true, recordedPath: SESSION_END_SCRIPT_PATH, recordedPathMissing: false });
});
