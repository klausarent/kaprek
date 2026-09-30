// Where Claude Code keeps its config and session transcripts. Claude Code
// itself honours CLAUDE_CONFIG_DIR, so kaprek must too — otherwise a second
// config (a machine that runs Claude with someone else's config dir) would
// have kaprek scanning, hooking and syncing the wrong ~/.claude.
import os from 'node:os';
import path from 'node:path';

/** Claude Code's config dir: CLAUDE_CONFIG_DIR when set, else ~/.claude. */
export function claudeConfigDir({ env = process.env, homedir = os.homedir() } = {}) {
  const v = typeof env.CLAUDE_CONFIG_DIR === 'string' ? env.CLAUDE_CONFIG_DIR.trim() : '';
  // A relative value would resolve against whatever cwd the reader has; pin it once.
  return v !== '' ? path.resolve(v) : path.join(homedir, '.claude');
}

/**
 * The home directory that config belongs to: the parent of a `.claude`
 * config dir (C:\Users\a\.claude -> C:\Users\a), else the OS home. Memory
 * folders are keyed by the slug of that directory.
 */
export function claudeUserHome({ env = process.env, homedir = os.homedir() } = {}) {
  const dir = claudeConfigDir({ env, homedir });
  return path.basename(dir).toLowerCase() === '.claude' ? path.dirname(dir) : homedir;
}
