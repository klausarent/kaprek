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
import crypto from 'node:crypto';

/** Writes `content` to `settingsPath` via tmp+rename (matching src/orchestrator/run.mjs::writeHarnessMeta). */
function writeAtomically(dir, settingsPath, content) {
  fs.mkdirSync(dir, { recursive: true });
  const tmpPath = path.join(dir, `.settings.json.tmp-${process.pid}-${Date.now()}-${crypto.randomUUID()}`);
  fs.writeFileSync(tmpPath, content, 'utf8');
  fs.renameSync(tmpPath, settingsPath);
}

/**
 * Writes `<dataDir>/harness/settings.json` and returns its absolute path.
 * Idempotent — safe to call again on every turn.
 *
 * This is ONE fixed path shared across every turn for a given dataDir (see
 * run.mjs's busy-check: only turns for DIFFERENT chats can ever call this
 * concurrently for the same dataDir). Content is fully deterministic, so
 * once the file holds the right bytes there is never a reason to touch it
 * again — a real, observed failure mode (task-6a review) is a concurrent
 * turn's tmp+rename racing another's, which on Windows can throw EPERM/EBUSY
 * when a rename targets a destination another handle still has open.
 * Comparing first and skipping the write entirely when nothing would change
 * turns every turn after the very first one into a pure read with zero
 * mutation, closing that race window for the common case rather than just
 * tolerating its failure.
 *
 * For the rare case where a write is still needed AND still races (peer
 * review decision, task-6a review follow-up): one retry against the same
 * fixed path, then a fallback to a turn-UNIQUE file with the identical
 * content. A turn must NEVER proceed without --settings at all — that would
 * let the CLI fall back to the user's own, potentially far more permissive
 * ~/.claude/settings.json (see the module header) — so the fallback file is
 * the last resort before this function gives up and lets the error
 * propagate (src/orchestrator/run.mjs turns that into a turn-level error
 * BEFORE the CLI is ever spawned, never a silent continue).
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
    // ENOENT (first turn for this dataDir, or the file got deleted/corrupted
    // since) or unreadable — fall through and (re)write; self-heals either way.
  }

  try {
    writeAtomically(dir, settingsPath, content);
    return settingsPath;
  } catch {
    // Retry once — a transient EPERM/EBUSY from a concurrent turn's rename
    // racing this one is often gone a moment later.
  }

  try {
    writeAtomically(dir, settingsPath, content);
    return settingsPath;
  } catch {
    // Still failing: fall back to a turn-unique file with the IDENTICAL
    // content, never reused/raced by anything else, so no rename/EPERM
    // concern applies to it at all — a single direct write is enough.
    const fallbackPath = path.join(dir, `settings-${process.pid}-${Date.now()}-${crypto.randomUUID()}.json`);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(fallbackPath, content, 'utf8');
    return fallbackPath;
  }
}
