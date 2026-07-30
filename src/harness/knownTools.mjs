// Self-learning registry of built-in CLI tool names claude-code.mjs has
// actually observed in a real `init` event but did not already recognize
// (see settings.mjs's ASK_TOOLS_CHAT/ASK_TOOLS_TRIGGER/KNOWN_READONLY_TOOLS).
// A hand-maintained ask-list goes stale the moment the CLI ships a new
// built-in tool — verified empirically (task-7a Fix-Runde 3 live
// acceptance): CLI 2.1.220 in the actual runtime environment reports
// EnterWorktree/ExitWorktree/Monitor/PowerShell/ReportFindings/
// ScheduleWakeup/SendMessage/Skill/TaskCreate/... none of which were in the
// hand-written lists. This file is what makes kaprek's ask-coverage
// self-heal across CLI updates instead of needing a code change every time
// the CLI adds a tool.
//
// SECURITY: a name learned here is ADDITIVE ONLY, and is merged ONLY into
// `permissions.ask` (see settings.mjs::mergeAskList()) — NEVER into
// `permissions.allow`. Learning a new tool can only ever make kaprek's own
// approval gate cover MORE tools, never grant a tool anything it didn't
// already have; see writeHarnessSettings()'s own doc comment for why `ask`
// (not `allow`) is what actually forces a tool through kaprek's handler.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

function knownToolsPath(dataDir) {
  return path.join(dataDir, 'harness', 'known-tools.json');
}

/**
 * Reads the learned tool names for `dataDir`, sorted. Missing file, corrupt
 * JSON, or an unexpected shape all fall back to an empty list — this file
 * is purely a self-healing aid; its absence or corruption must never crash
 * or block a turn (settings.mjs's static ASK_TOOLS_CHAT/ASK_TOOLS_TRIGGER
 * are always the floor regardless of what this function returns).
 */
export function readKnownTools(dataDir) {
  let raw;
  try {
    raw = fs.readFileSync(knownToolsPath(dataDir), 'utf8');
  } catch {
    return [];
  }
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || !Array.isArray(parsed.tools)) return [];
    return parsed.tools.filter((t) => typeof t === 'string').sort();
  } catch {
    return [];
  }
}

/** Atomic write (tmp + rename), matching every other sidecar file in this codebase (e.g. src/orchestrator/run.mjs::writeHarnessMeta). */
function writeAtomically(dir, filePath, content) {
  fs.mkdirSync(dir, { recursive: true });
  const tmpPath = path.join(dir, `.known-tools.json.tmp-${process.pid}-${Date.now()}-${crypto.randomUUID()}`);
  fs.writeFileSync(tmpPath, content, 'utf8');
  fs.renameSync(tmpPath, filePath);
}

/**
 * Merges `newToolNames` into `<dataDir>/harness/known-tools.json` (created
 * if missing), deduplicated and sorted. MCP tools (`mcp__…`, covered by
 * kaprek's own MCP-scope policy instead — see
 * src/triggers/runner.mjs::notifyPolicyHandler()) are filtered out here
 * defensively, even though a caller should never pass one in the first
 * place (claude-code.mjs's isKnownTool() already treats every `mcp__…` name
 * as known and never routes it to this function).
 *
 * Best-effort: a write failure here is swallowed, never thrown. Learning is
 * an optimization, not a correctness requirement — the turn that triggered
 * it already fails closed on its own (see claude-code.mjs's
 * strictAskCoverage), and a failed learn just means the NEXT turn tries
 * again from the same "unknown" state instead of self-healing immediately.
 *
 * Returns the merged, deduplicated, sorted list (whether or not anything
 * new was actually written).
 */
export function learnTools(dataDir, newToolNames) {
  const merged = new Set(readKnownTools(dataDir));
  let changed = false;
  for (const name of newToolNames ?? []) {
    if (typeof name !== 'string' || name.length === 0) continue;
    if (name.startsWith('mcp__')) continue;
    if (!merged.has(name)) {
      merged.add(name);
      changed = true;
    }
  }
  const tools = [...merged].sort();
  if (!changed) return tools;

  try {
    const filePath = knownToolsPath(dataDir);
    const content = `${JSON.stringify({ version: 1, tools, learnedAt: new Date().toISOString() }, null, 2)}\n`;
    writeAtomically(path.dirname(filePath), filePath, content);
  } catch {
    // best-effort — see doc comment above
  }
  return tools;
}
