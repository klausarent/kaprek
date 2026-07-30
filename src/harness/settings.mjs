// Writes kaprek's own `--settings` file for the Claude Code CLI subprocess
// (see claude-code.mjs's buildArgs()). The CLI otherwise inherits the user's
// real ~/.claude/settings.json, hooks included — a headless turn must not
// run whatever hooks the user has configured for their own interactive
// sessions (verified empirically: an interactive-formatting hook turned a
// turn's output into caveman-speak during acceptance testing). This file
// neutralizes hooks and leaves permissions at the CLI's own 'default' mode,
// with empty allow/deny lists.
//
// `ask` is NOT empty, unlike a first attempt at this file assumed (task-7a
// Fix-Runde 2, live acceptance test against CLI 2.1.220): at the 'default'
// mode, the CLI evaluates a proposed command through its OWN Hooks -> Deny
// -> Ask -> Mode -> Allow -> can_use_tool order, and 'Mode' auto-approves
// whatever IT considers harmless (`echo hello` verified to run with ZERO
// can_use_tool request — kaprek's onApprovalRequest handler was simply never
// asked) BEFORE ever reaching our own handler. `permissions.ask` sits ABOVE
// 'Mode' in that order and forces every listed tool through can_use_tool
// regardless of what the CLI itself would have decided — this is the only
// way kaprek's own approval gate (see src/triggers/runner.mjs's
// notifyPolicyHandler, src/server/server.mjs's makeApprovalHandler) is
// actually consulted for every write/outward-effect tool call, not just the
// subset the CLI happens to find questionable on its own.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

/**
 * Write/outward-effect built-in tools — from a real Claude Code 2.1.220
 * `init` event's `tools` list, filtered to everything that writes, executes
 * a command, or reaches outside the process. This is the CHAT profile's
 * `permissions.ask` list: a human is present for a chat turn, so read-only
 * tools are deliberately left OUT (see KNOWN_READONLY_TOOLS below) — asking
 * permission for every Read/Grep would make the product unusable.
 *
 * MUST be kept in sync with new CLI releases' tool sets — see
 * claude-code.mjs's requireAskCoverage check, which warns (chat) or fails
 * the turn (trigger, see ASK_TOOLS_TRIGGER) when the CLI reports a
 * built-in tool neither list here nor KNOWN_READONLY_TOOLS knows about.
 */
export const ASK_TOOLS_CHAT = [
  'Bash',
  'Write',
  'Edit',
  'NotebookEdit',
  'WebFetch',
  'WebSearch',
  'Task',
  'SlashCommand',
  'KillShell',
  'CronCreate',
  'CronDelete',
  'RemoteTrigger',
  'PushNotification',
  'DesignSync',
  'Artifact',
  'EndConversation',
];

/**
 * Read-only built-in tools — excluded from ASK_TOOLS_CHAT (see its doc
 * comment) but included in ASK_TOOLS_TRIGGER below, and always exempt from
 * claude-code.mjs's requireAskCoverage warning/failure regardless of
 * profile: a tool in this list is never the reason a turn is flagged as
 * "the CLI reports something we don't recognize".
 */
export const KNOWN_READONLY_TOOLS = [
  'Read',
  'Glob',
  'Grep',
  'TodoWrite',
  'ToolSearch',
  'AskUserQuestion',
  'EnterPlanMode',
  'ExitPlanMode',
  'BashOutput',
  'CronList',
];

/**
 * Trigger profile's `permissions.ask` list: EVERY known built-in tool,
 * read-only included. Nobody is watching a trigger-started turn (see
 * src/triggers/runner.mjs) — kaprek's own handler (notifyPolicyHandler for
 * 'notify', the UI handler for 'question'/'review') must decide EVERY tool
 * call, not just the ones a chat's human reviewer would also see live.
 */
export const ASK_TOOLS_TRIGGER = [...ASK_TOOLS_CHAT, ...KNOWN_READONLY_TOOLS];

const PROFILES = { chat: ASK_TOOLS_CHAT, trigger: ASK_TOOLS_TRIGGER };

/** Writes `content` to `settingsPath` via tmp+rename (matching src/orchestrator/run.mjs::writeHarnessMeta). */
function writeAtomically(dir, settingsPath, content) {
  fs.mkdirSync(dir, { recursive: true });
  const tmpPath = path.join(dir, `.settings.json.tmp-${process.pid}-${Date.now()}-${crypto.randomUUID()}`);
  fs.writeFileSync(tmpPath, content, 'utf8');
  fs.renameSync(tmpPath, settingsPath);
}

/**
 * Writes `<dataDir>/harness/settings-<profile>.json` and returns its
 * absolute path. `profile` is required ('chat' | 'trigger', see ASK_TOOLS_CHAT/
 * ASK_TOOLS_TRIGGER above) — each gets its OWN fixed path, never shared,
 * so a chat turn and a trigger turn running concurrently for the same
 * dataDir never race each other's settings file (see run.mjs's busy-check
 * for chats; src/triggers/runner.mjs's loop guard for triggers — the two
 * can still legitimately overlap: a manual trigger fire while a chat is
 * also mid-turn).
 *
 * Idempotent — safe to call again on every turn of the same profile.
 *
 * Content is fully deterministic per profile, so once the file holds the
 * right bytes there is never a reason to touch it again — a real, observed
 * failure mode (task-6a review) is a concurrent turn's tmp+rename racing
 * another's, which on Windows can throw EPERM/EBUSY when a rename targets a
 * destination another handle still has open. Comparing first and skipping
 * the write entirely when nothing would change turns every turn after the
 * very first one (per profile) into a pure read with zero mutation, closing
 * that race window for the common case rather than just tolerating its
 * failure.
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
export function writeHarnessSettings({ dataDir, profile }) {
  if (!dataDir) throw new Error('writeHarnessSettings requires dataDir');
  const ask = PROFILES[profile];
  if (!ask) throw new Error(`writeHarnessSettings requires profile to be one of ${Object.keys(PROFILES).join(', ')} (got ${JSON.stringify(profile)})`);

  const dir = path.join(dataDir, 'harness');
  const settingsPath = path.join(dir, `settings-${profile}.json`);
  const settings = {
    hooks: {},
    permissions: { defaultMode: 'default', allow: [], deny: [], ask },
  };
  const content = `${JSON.stringify(settings, null, 2)}\n`;

  try {
    if (fs.readFileSync(settingsPath, 'utf8') === content) return settingsPath;
  } catch {
    // ENOENT (first turn for this dataDir/profile, or the file got deleted/
    // corrupted since) or unreadable — fall through and (re)write; self-heals either way.
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
    const fallbackPath = path.join(dir, `settings-${profile}-${process.pid}-${Date.now()}-${crypto.randomUUID()}.json`);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(fallbackPath, content, 'utf8');
    return fallbackPath;
  }
}
