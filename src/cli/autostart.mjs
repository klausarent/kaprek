// Starting kaprek with the machine — opt-in, reversible, and visible.
//
// The whole feature is one file in the user's startup folder on Windows, one
// .desktop file on Linux, one LaunchAgent plist on macOS. No registry keys,
// no scheduled tasks, no service: those are all harder to find later, and
// "what did that tool install on my machine" has to have a short answer.
//
// WHAT IT DOES NOT DO. It never installs itself silently, never on first
// run, and never as part of anything else — `kaprek autostart install` and
// nothing else turns it on. Uninstall deletes exactly the file install
// wrote, and status prints its path so it can be deleted by hand by someone
// who does not trust the uninstall.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Written into every entry, so uninstall can tell kaprek's file from
 * something else that happens to share the name. Without it, `autostart
 * uninstall` deleted whatever sat at that path. (Codex' review.)
 */
const OWNERSHIP_MARKER = 'written by kaprek autostart';

/** XML text escaping for the plist: an `&` or `<` in a path makes the file invalid. */
function xmlEscape(value) {
  return String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * .desktop Exec escaping. A space splits arguments, and %f/%u are field codes
 * the desktop replaces with file names — a path containing either launches
 * something other than what was meant.
 */
function desktopExec(parts) {
  return parts.map((part) => `"${String(part).replace(/(["\\`$])/g, '\\$1').replace(/%/g, '%%')}"`).join(' ');
}

/** What the entry is called on each platform, so status/uninstall can find it. */
const ENTRY_NAME = {
  win32: 'kaprek.cmd',
  darwin: 'com.kaprek.server.plist',
  linux: 'kaprek.desktop',
};

/** Where an autostart entry belongs on this platform, or null when kaprek does not know. */
export function autostartDir(platform = process.platform, home = os.homedir(), env = process.env) {
  if (platform === 'win32') {
    const appData = env.APPDATA ?? path.join(home, 'AppData', 'Roaming');
    return path.join(appData, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup');
  }
  if (platform === 'darwin') return path.join(home, 'Library', 'LaunchAgents');
  if (platform === 'linux') return path.join(home, '.config', 'autostart');
  return null;
}

export function autostartPath(platform = process.platform, home = os.homedir(), env = process.env) {
  const dir = autostartDir(platform, home, env);
  return dir ? path.join(dir, ENTRY_NAME[platform]) : null;
}

/**
 * The file's contents.
 *
 * `--no-open` in every one of them: something starting with the machine must
 * not also throw a browser window at whoever just logged in.
 *
 * @param {object} options
 * @param {string} options.command - how to launch kaprek (a full path to the
 *   CLI, or just `kaprek` for a global install)
 * @param {string[]} [options.args]
 */
export function autostartFile({ platform = process.platform, command, args = [] }) {
  const argv = ['--no-open', ...args];
  if (platform === 'win32') {
    // start "" /min so the console window does not sit in the way; the empty
    // title argument is start's own quirk and not optional.
    // Each argument quoted: extraArgs is a parameter, and a value carrying a
    // space or an `&` would otherwise change what the startup entry runs.
    // (Grok's review.)
    const quoted = argv.map((entry) => `"${String(entry).replace(/"/g, '')}"`).join(' ');
    return ['@echo off', `rem ${OWNERSHIP_MARKER}`, `start "" /min "${command}" ${quoted}`, ''].join('\r\n');
  }
  if (platform === 'darwin') {
    const programArgs = [command, ...argv].map((entry) => `    <string>${xmlEscape(entry)}</string>`).join('\n');
    return [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
      '<plist version="1.0">',
      '<dict>',
      '  <key>Label</key><string>com.kaprek.server</string>',
      '  <key>ProgramArguments</key>',
      '  <array>',
      programArgs,
      '  </array>',
      '  <key>RunAtLoad</key><true/>',
      `  <key>Comment</key><string>${OWNERSHIP_MARKER}</string>`,
      '</dict>',
      '</plist>',
      '',
    ].join('\n');
  }
  return ['[Desktop Entry]', 'Type=Application', 'Name=kaprek', `Exec=${desktopExec([command, ...argv])}`, 'X-GNOME-Autostart-enabled=true', `Comment=${OWNERSHIP_MARKER}`, ''].join('\n');
}

/** How this machine would launch kaprek, given how it is installed right now. */
export function launchCommand({ platform = process.platform, execPath = process.execPath, scriptPath } = {}) {
  // On Windows a global npm install leaves a kaprek.cmd shim on PATH, which
  // is what a startup .cmd should call. Everywhere else, calling node with
  // the script path is the version that survives a PATH that logins do not
  // have — and a startup entry runs in a shell nobody configured.
  if (platform === 'win32') return { command: 'kaprek', args: [] };
  return { command: execPath, args: [scriptPath] };
}

export function install({ platform = process.platform, home = os.homedir(), env = process.env, scriptPath, extraArgs = [] } = {}) {
  const target = autostartPath(platform, home, env);
  if (!target) throw new Error(`kaprek does not know where autostart entries live on ${platform}`);
  const { command, args } = launchCommand({ platform, scriptPath });
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, autostartFile({ platform, command, args: [...args, ...extraArgs] }), 'utf8');
  if (platform !== 'win32') fs.chmodSync(target, 0o755);
  return { path: target };
}

export function uninstall({ platform = process.platform, home = os.homedir(), env = process.env } = {}) {
  const target = autostartPath(platform, home, env);
  if (!target || !fs.existsSync(target)) return { removed: false, path: target };
  // Only kaprek's own file. Something else at that path belongs to somebody
  // else, and deleting it because it shares a name is not an uninstall.
  // (Codex' review.)
  let contents = '';
  try {
    contents = fs.readFileSync(target, 'utf8');
  } catch {
    return { removed: false, path: target, reason: 'the file could not be read' };
  }
  if (!contents.includes(OWNERSHIP_MARKER)) {
    return { removed: false, path: target, reason: 'that file was not written by kaprek — delete it yourself if you meant to' };
  }
  fs.rmSync(target);
  return { removed: true, path: target };
}

export function status({ platform = process.platform, home = os.homedir(), env = process.env } = {}) {
  const target = autostartPath(platform, home, env);
  return {
    supported: target !== null,
    installed: target !== null && fs.existsSync(target),
    path: target,
    // Printed so someone who does not trust the uninstall can delete it
    // themselves. A tool that puts something in your startup folder owes you
    // the path.
    contents: target && fs.existsSync(target) ? fs.readFileSync(target, 'utf8') : null,
  };
}
