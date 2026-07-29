// Manages ccview's Claude Code Stop hook entry in ~/.claude/settings.json.
//
// Pure fs work, no console output — bin/cli.mjs owns printing, this module
// only returns plain result objects so it stays easy to test against a
// temp settings.json (real ~/.claude/settings.json is never touched by
// tests; settingsPath is always overridable).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadPolicy } from '../policy/policy.mjs';
import { getAppDir } from '../lib/appdir.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const HOOK_SCRIPT_PATH = path.resolve(__dirname, '..', 'policy', 'hook-stop.mjs');

function defaultSettingsPath() {
  return path.join(os.homedir(), '.claude', 'settings.json');
}

function timestamp(date = new Date()) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}

function readSettings(settingsPath) {
  if (!fs.existsSync(settingsPath)) return {};
  const raw = fs.readFileSync(settingsPath, 'utf8');
  if (raw.trim().length === 0) return {};
  return JSON.parse(raw);
}

function writeSettings(settingsPath, settings) {
  fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
  fs.writeFileSync(settingsPath, `${JSON.stringify(settings, null, 2)}\n`, 'utf8');
}

/** Backs up settingsPath to `<settingsPath>.bak-<timestamp>` if it exists. Returns the backup path or undefined. */
function backupSettings(settingsPath) {
  if (!fs.existsSync(settingsPath)) return undefined;
  const backupPath = `${settingsPath}.bak-${timestamp()}`;
  fs.copyFileSync(settingsPath, backupPath);
  return backupPath;
}

function buildCommand(hookScriptPath) {
  return `node "${hookScriptPath}"`;
}

/** Recognizes our own Stop hook entry by whether its command contains this package's hook-stop.mjs path (quoting-agnostic). */
function isOurHookEntry(hook, hookScriptPath) {
  return hook?.type === 'command' && typeof hook.command === 'string' && hook.command.includes(hookScriptPath);
}

function hasOurHookInstalled(settings, hookScriptPath) {
  const stopMatchers = settings?.hooks?.Stop;
  if (!Array.isArray(stopMatchers)) return false;
  return stopMatchers.some((matcher) => Array.isArray(matcher?.hooks) && matcher.hooks.some((h) => isOurHookEntry(h, hookScriptPath)));
}

/**
 * Idempotently adds ccview's Stop hook to `settingsPath` (default
 * `~/.claude/settings.json`). Backs up the file first (if it exists),
 * leaves any other hooks byte-for-byte untouched, and does nothing if
 * already installed.
 */
export function install({ settingsPath = defaultSettingsPath(), hookScriptPath = HOOK_SCRIPT_PATH } = {}) {
  const settings = readSettings(settingsPath);
  const backupPath = backupSettings(settingsPath);
  const alreadyInstalled = hasOurHookInstalled(settings, hookScriptPath);

  if (!alreadyInstalled) {
    settings.hooks = settings.hooks ?? {};
    settings.hooks.Stop = Array.isArray(settings.hooks.Stop) ? settings.hooks.Stop : [];
    settings.hooks.Stop.push({ hooks: [{ type: 'command', command: buildCommand(hookScriptPath) }] });
  }

  writeSettings(settingsPath, settings);
  return { installed: true, alreadyInstalled, settingsPath, backupPath, hookScriptPath };
}

/**
 * Removes only ccview's own Stop hook entry from `settingsPath`. Other
 * hooks (Stop or otherwise) are left untouched. Cleans up now-empty
 * matcher entries (`{hooks: []}`) it leaves behind.
 */
export function uninstall({ settingsPath = defaultSettingsPath(), hookScriptPath = HOOK_SCRIPT_PATH } = {}) {
  if (!fs.existsSync(settingsPath)) {
    return { uninstalled: false, reason: 'settings file does not exist', settingsPath, hookScriptPath };
  }

  const settings = readSettings(settingsPath);
  if (!hasOurHookInstalled(settings, hookScriptPath)) {
    return { uninstalled: false, reason: 'hook not installed', settingsPath, hookScriptPath };
  }

  const backupPath = backupSettings(settingsPath);

  settings.hooks.Stop = settings.hooks.Stop
    .map((matcher) => {
      if (!Array.isArray(matcher?.hooks)) return matcher;
      return { ...matcher, hooks: matcher.hooks.filter((h) => !isOurHookEntry(h, hookScriptPath)) };
    })
    .filter((matcher) => !Array.isArray(matcher?.hooks) || matcher.hooks.length > 0);

  if (settings.hooks.Stop.length === 0) delete settings.hooks.Stop;
  if (Object.keys(settings.hooks).length === 0) delete settings.hooks;

  writeSettings(settingsPath, settings);
  return { uninstalled: true, settingsPath, backupPath, hookScriptPath };
}

/** Read-only report: is the hook installed, and what policy mode is currently active for dataDir. */
export function status({ settingsPath = defaultSettingsPath(), hookScriptPath = HOOK_SCRIPT_PATH, dataDir = getAppDir() } = {}) {
  let installed = false;
  try {
    installed = hasOurHookInstalled(readSettings(settingsPath), hookScriptPath);
  } catch {
    installed = false;
  }

  let mode = 'observe';
  let policyError;
  try {
    mode = loadPolicy(dataDir).mode;
  } catch (err) {
    policyError = err.message;
  }

  return { installed, settingsPath, hookScriptPath, dataDir, mode, policyError };
}
