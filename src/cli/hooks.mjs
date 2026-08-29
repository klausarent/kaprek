// Manages kaprek's Claude Code hook entries in ~/.claude/settings.json:
// the Stop hook (policy engine, artifact sweep), the SessionStart hook
// (mission, open questions, rules and memory for the directory a session
// opens in — see src/policy/hook-session-start.mjs), and the SessionEnd
// hook (marks that session's ledger entry ended, so `kaprek resume` can
// tell it apart from one still open — see src/policy/hook-session-end.mjs).
// One install, one uninstall, one marker for all three.
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
export const SESSION_START_SCRIPT_PATH = path.resolve(__dirname, '..', 'policy', 'hook-session-start.mjs');
export const SESSION_END_SCRIPT_PATH = path.resolve(__dirname, '..', 'policy', 'hook-session-end.mjs');

/** The events kaprek hooks into, and which script answers each. */
export const HOOK_EVENTS = Object.freeze({ Stop: 'hookScriptPath', SessionStart: 'sessionStartScriptPath', SessionEnd: 'sessionEndScriptPath' });

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
  // Preserve the existing file's permission bits across the rename — a fresh
  // temp file otherwise gets the process's default mode (commonly 0644),
  // which would silently widen a settings.json the user had locked down to
  // e.g. 0600. Windows has no POSIX permission model, so statSync/chmodSync
  // are effectively no-ops there; any error here (no prior file, unsupported
  // platform) is swallowed on purpose — it must never block the write itself.
  try {
    const { mode } = fs.statSync(settingsPath);
    fs.chmodSync(tmpPath, mode);
  } catch {
    // best-effort — nothing to preserve for a settingsPath that doesn't exist yet
  }
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

/** Our entry under one event's matcher list, or null. */
function findOurHookEntry(settings, packageName, event = 'Stop') {
  const matchers = settings?.hooks?.[event];
  if (!Array.isArray(matchers)) return null;
  for (const matcher of matchers) {
    if (!Array.isArray(matcher?.hooks)) continue;
    const hook = matcher.hooks.find((h) => isOurHookEntry(h, packageName));
    if (hook) return hook;
  }
  return null;
}

function hasOurHookInstalled(settings, packageName) {
  return Object.keys(HOOK_EVENTS).some((event) => findOurHookEntry(settings, packageName, event) !== null);
}

/** Adds or refreshes our entry under one event. Returns whether it was already there. */
function upsertEntry(settings, event, command, packageName) {
  const existingHook = findOurHookEntry(settings, packageName, event);
  if (existingHook) {
    existingHook.command = command; // path may have shifted (e.g. npx cache) — replace, don't duplicate
    return true;
  }
  settings.hooks = settings.hooks ?? {};
  settings.hooks[event] = Array.isArray(settings.hooks[event]) ? settings.hooks[event] : [];
  settings.hooks[event].push({ hooks: [{ type: 'command', command }] });
  return false;
}

/**
 * Idempotently adds kaprek's hooks — Stop, SessionStart and SessionEnd — to
 * `settingsPath` (default `~/.claude/settings.json`). Backs up the file
 * first (if it exists), leaves any other hooks byte-for-byte untouched. If
 * an entry with our `--managed-by` marker already exists under an event
 * (even at a different path), its command is updated in place rather than
 * adding a duplicate; an install from before SessionStart or SessionEnd
 * existed gains that entry and keeps the others.
 */
export function install({
  settingsPath = defaultSettingsPath(),
  hookScriptPath = HOOK_SCRIPT_PATH,
  sessionStartScriptPath = SESSION_START_SCRIPT_PATH,
  sessionEndScriptPath = SESSION_END_SCRIPT_PATH,
  packageName = getPackageName(),
} = {}) {
  const settings = readSettings(settingsPath);
  const backupPath = backupSettings(settingsPath);

  const scripts = { hookScriptPath, sessionStartScriptPath, sessionEndScriptPath };
  const already = {};
  for (const [event, key] of Object.entries(HOOK_EVENTS)) {
    already[event] = upsertEntry(settings, event, buildCommand(scripts[key], packageName), packageName);
  }
  // `alreadyInstalled` keeps its old meaning — the Stop hook was there —
  // and `added` names what this run actually put in, so an install from
  // before SessionStart or SessionEnd existed reads as "already installed,
  // SessionEnd added" rather than as either extreme.
  const alreadyInstalled = already.Stop === true;
  const added = Object.entries(already)
    .filter(([, wasThere]) => !wasThere)
    .map(([event]) => event);

  writeSettings(settingsPath, settings);
  return { installed: true, alreadyInstalled, added, settingsPath, backupPath, hookScriptPath, sessionStartScriptPath, sessionEndScriptPath, events: Object.keys(HOOK_EVENTS) };
}

/**
 * Removes only kaprek's own hook entries (matched by the `--managed-by`
 * marker, regardless of the path recorded in them) from `settingsPath`,
 * under every event kaprek hooks into. Other hooks are left untouched.
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

  for (const event of Object.keys(HOOK_EVENTS)) {
    if (!Array.isArray(settings.hooks?.[event])) continue;
    settings.hooks[event] = settings.hooks[event]
      .map((matcher) => {
        if (!Array.isArray(matcher?.hooks)) return matcher;
        return { ...matcher, hooks: matcher.hooks.filter((h) => !isOurHookEntry(h, packageName)) };
      })
      .filter((matcher) => !Array.isArray(matcher?.hooks) || matcher.hooks.length > 0);
    if (settings.hooks[event].length === 0) delete settings.hooks[event];
  }
  if (settings.hooks && Object.keys(settings.hooks).length === 0) delete settings.hooks;

  writeSettings(settingsPath, settings);
  return { uninstalled: true, settingsPath, backupPath, hookScriptPath };
}

/**
 * Read-only report: which of our hooks are installed (by marker), what
 * path is currently recorded for each (and whether that path still exists
 * on disk — a missing file means a dead/stale entry), and what policy mode
 * is currently active for dataDir. `installed`/`recordedPath`/
 * `recordedPathMissing` describe the Stop hook, as they always did;
 * `events` carries the same per event.
 */
export function status({ settingsPath = defaultSettingsPath(), hookScriptPath = HOOK_SCRIPT_PATH, dataDir = getAppDir(), packageName = getPackageName() } = {}) {
  const events = {};
  let settings = {};
  try {
    settings = readSettings(settingsPath);
  } catch {
    settings = null;
  }
  for (const event of Object.keys(HOOK_EVENTS)) {
    const report = { installed: false, recordedPath: undefined, recordedPathMissing: false };
    const hook = settings ? findOurHookEntry(settings, packageName, event) : null;
    if (hook) {
      report.installed = true;
      report.recordedPath = extractCommandPath(hook.command);
      if (report.recordedPath) report.recordedPathMissing = !fs.existsSync(report.recordedPath);
    }
    events[event] = report;
  }
  const { installed, recordedPath, recordedPathMissing } = events.Stop;

  let mode = 'observe';
  let policyError;
  try {
    mode = loadPolicy(dataDir).mode;
  } catch (err) {
    policyError = err.message;
  }

  return { installed, settingsPath, hookScriptPath, dataDir, mode, policyError, recordedPath, recordedPathMissing, events };
}
