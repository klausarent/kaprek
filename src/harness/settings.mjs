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
 * Idempotent — safe to call again on every turn, always overwrites.
 */
export function writeHarnessSettings({ dataDir }) {
  if (!dataDir) throw new Error('writeHarnessSettings requires dataDir');

  const dir = path.join(dataDir, 'harness');
  const settingsPath = path.join(dir, 'settings.json');
  const settings = {
    hooks: {},
    permissions: { defaultMode: 'default', allow: [], deny: [] },
  };

  fs.mkdirSync(dir, { recursive: true });
  const tmpPath = path.join(dir, `.settings.json.tmp-${process.pid}-${Date.now()}`);
  fs.writeFileSync(tmpPath, `${JSON.stringify(settings, null, 2)}\n`, 'utf8');
  fs.renameSync(tmpPath, settingsPath);

  return settingsPath;
}
