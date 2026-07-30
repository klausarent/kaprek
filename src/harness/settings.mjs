// Writes kaprek's own `--settings` file for the Claude Code CLI subprocess
// (see claude-code.mjs's buildArgs()). The CLI otherwise inherits the user's
// real ~/.claude/settings.json, hooks included — a headless turn must not
// run whatever hooks the user has configured for their own interactive
// sessions (verified empirically: an interactive-formatting hook turned a
// turn's output into caveman-speak during acceptance testing). This file
// neutralizes hooks and leaves permissions at the CLI's own 'default' mode,
// with empty allow/deny lists — anything not explicitly handled here is left
// to the onApprovalRequest callback (see adapter.mjs) via `can_use_tool`.
import fs from 'node:fs';
import path from 'node:path';

/**
 * Writes `<dataDir>/harness/settings.json` (atomic tmp+rename, matching
 * src/orchestrator/run.mjs::writeHarnessMeta) and returns its absolute path.
 * Idempotent — safe to call again on every turn.
 *
 * This is ONE fixed path shared across every turn for a given dataDir (see
 * run.mjs's busy-check: only turns for DIFFERENT chats can ever call this
 * concurrently for the same dataDir). Content is fully deterministic, so
 * once the file holds the right bytes there is never a reason to touch it
 * again — a real, observed failure mode (task-6a review) is a concurrent
 * turn's tmp+rename racing another's, which on Windows can throw EPERM when
 * a rename targets a destination another handle still has open. Comparing
 * first and skipping the write entirely when nothing would change turns
 * every turn after the very first one into a pure read with zero mutation,
 * closing that race window rather than papering over it with a try/catch.
 */
export function writeHarnessSettings({ dataDir }) {
  if (!dataDir) throw new Error('writeHarnessSettings requires dataDir');

  const dir = path.join(dataDir, 'harness');
  const settingsPath = path.join(dir, 'settings.json');
  const settings = {
    hooks: {},
    permissions: { defaultMode: 'default', allow: [], deny: [] },
  };
  const content = `${JSON.stringify(settings, null, 2)}\n`;

  try {
    if (fs.readFileSync(settingsPath, 'utf8') === content) return settingsPath;
  } catch {
    // ENOENT (first turn for this dataDir) or unreadable — fall through and write.
  }

  fs.mkdirSync(dir, { recursive: true });
  const tmpPath = path.join(dir, `.settings.json.tmp-${process.pid}-${Date.now()}`);
  fs.writeFileSync(tmpPath, content, 'utf8');
  fs.renameSync(tmpPath, settingsPath);

  return settingsPath;
}
