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
import { getAppDir, getPackageName } from '../lib/appdir.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const HOOK_SCRIPT_PATH = path.resolve(__dirname, '..', 'policy', 'hook-stop.mjs');

const MANAGED_BY_PREFIX = '--managed-by=';

function defaultSettingsPath() {
  return path.join(os.homedir(), '.claude', 'settings.json');
}

function timestamp(date = new Date()) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}

function stripBom(content) {
  return content.replace(/^﻿/, '');
}

function readSettings(settingsPath) {
  if (!fs.existsSync(settingsPath)) return {};
  const raw = stripBom(fs.readFileSync(settingsPath, 'utf8'));
  if (raw.trim().length === 0) return {};
  return JSON.parse(raw);
}

/**
 * Atomic write: write to a temp file in the same directory, then
 * fs.renameSync() over the target. A crash mid-write leaves the temp file
 * behind but never a half-written settings.json (rename is atomic on the
 * same filesystem — the temp file MUST stay in settingsPath's own
 * directory, a cross-volume rename would fail).
 */
function writeSettings(settingsPath, settings) {
  const dir = path.dirname(settingsPath);
  fs.mkdirSync(dir, { recursive: true });
  const tmpPath = path.join(dir, `.${path.basename(settingsPath)}.tmp-${process.pid}-${Date.now()}`);
  fs.writeFileSync(tmpPath, `${JSON.stringify(settings, null, 2)}\n`, 'utf8');
  fs.renameSync(tmpPath, settingsPath);
}

/** Backs up settingsPath to `<settingsPath>.bak-<timestamp>` if it exists. Returns the backup path or undefined. */
function backupSettings(settingsPath) {
  if (!fs.existsSync(settingsPath)) return undefined;
  const backupPath = `${settingsPath}.bak-${timestamp()}`;
  fs.copyFileSync(settingsPath, backupPath);
  return backupPath;
}

function managedByMarker(packageName) {
  return `${MANAGED_BY_PREFIX}${packageName}`;
}

/**
 * Builds the hook command string. The `--managed-by=<packageName>` suffix
 * is a stable identity marker independent of hookScriptPath — the path can
 * shift across reinstalls (e.g. a new npx cache directory) without that
 * turning into a duplicate entry; see isOurHookEntry().
 */
function buildCommand(hookScriptPath, packageName) {
  return `node "${hookScriptPath}" ${managedByMarker(packageName)}`;
}

/** Recognizes our own Stop hook entry by its stable --managed-by marker, not by hookScriptPath (which can change between installs). */
function isOurHookEntry(hook, packageName) {
  return hook?.type === 'command' && typeof hook.command === 'string' && hook.command.includes(managedByMarker(packageName));
}

/** Extracts the recorded hook-stop.mjs path from a command string built by buildCommand(). Returns undefined if the shape is unexpected. */
function extractCommandPath(command) {
  const match = /^node\s+"([^"]+)"\s+--managed-by=/.exec(command ?? '');
  return match ? match[1] : undefined;
}

function findOurHookEntry(settings, packageName) {
  const stopMatchers = settings?.hooks?.Stop;
  if (!Array.isArray(stopMatchers)) return null;
  for (const matcher of stopMatchers) {
    if (!Array.isArray(matcher?.hooks)) continue;
    const hook = matcher.hooks.find((h) => isOurHookEntry(h, packageName));
    if (hook) return hook;
  }
  return null;
}

function hasOurHookInstalled(settings, packageName) {
  return findOurHookEntry(settings, packageName) !== null;
}

/**
 * Idempotently adds ccview's Stop hook to `settingsPath` (default
 * `~/.claude/settings.json`). Backs up the file first (if it exists),
 * leaves any other hooks byte-for-byte untouched. If an entry with our
 * `--managed-by` marker already exists (even at a different path), its
 * command is updated in place rather than adding a duplicate.
 */
export function install({ settingsPath = defaultSettingsPath(), hookScriptPath = HOOK_SCRIPT_PATH, packageName = getPackageName() } = {}) {
  const settings = readSettings(settingsPath);
  const backupPath = backupSettings(settingsPath);
  const command = buildCommand(hookScriptPath, packageName);

  const existingHook = findOurHookEntry(settings, packageName);
  const alreadyInstalled = existingHook !== null;

  if (existingHook) {
    existingHook.command = command; // path may have shifted (e.g. npx cache) — replace, don't duplicate
  } else {
    settings.hooks = settings.hooks ?? {};
    settings.hooks.Stop = Array.isArray(settings.hooks.Stop) ? settings.hooks.Stop : [];
    settings.hooks.Stop.push({ hooks: [{ type: 'command', command }] });
  }

  writeSettings(settingsPath, settings);
  return { installed: true, alreadyInstalled, settingsPath, backupPath, hookScriptPath };
}

/**
 * Removes only ccview's own Stop hook entry (matched by its
 * `--managed-by` marker, regardless of the path recorded in it) from
 * `settingsPath`. Other hooks (Stop or otherwise) are left untouched.
 * Cleans up now-empty matcher entries (`{hooks: []}`) it leaves behind.
 */
export function uninstall({ settingsPath = defaultSettingsPath(), hookScriptPath = HOOK_SCRIPT_PATH, packageName = getPackageName() } = {}) {
  if (!fs.existsSync(settingsPath)) {
    return { uninstalled: false, reason: 'settings file does not exist', settingsPath, hookScriptPath };
  }

  const settings = readSettings(settingsPath);
  if (!hasOurHookInstalled(settings, packageName)) {
    return { uninstalled: false, reason: 'hook not installed', settingsPath, hookScriptPath };
  }

  const backupPath = backupSettings(settingsPath);

  settings.hooks.Stop = settings.hooks.Stop
    .map((matcher) => {
      if (!Array.isArray(matcher?.hooks)) return matcher;
      return { ...matcher, hooks: matcher.hooks.filter((h) => !isOurHookEntry(h, packageName)) };
    })
    .filter((matcher) => !Array.isArray(matcher?.hooks) || matcher.hooks.length > 0);

  if (settings.hooks.Stop.length === 0) delete settings.hooks.Stop;
  if (Object.keys(settings.hooks).length === 0) delete settings.hooks;

  writeSettings(settingsPath, settings);
  return { uninstalled: true, settingsPath, backupPath, hookScriptPath };
}

/**
 * Read-only report: is the hook installed (by marker), what path is
 * currently recorded for it (and whether that path still exists on disk —
 * a missing file means a dead/stale entry), and what policy mode is
 * currently active for dataDir.
 */
export function status({ settingsPath = defaultSettingsPath(), hookScriptPath = HOOK_SCRIPT_PATH, dataDir = getAppDir(), packageName = getPackageName() } = {}) {
  let installed = false;
  let recordedPath;
  let recordedPathMissing = false;
  try {
    const hook = findOurHookEntry(readSettings(settingsPath), packageName);
    if (hook) {
      installed = true;
      recordedPath = extractCommandPath(hook.command);
      if (recordedPath) recordedPathMissing = !fs.existsSync(recordedPath);
    }
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

  return { installed, settingsPath, hookScriptPath, dataDir, mode, policyError, recordedPath, recordedPathMissing };
}
