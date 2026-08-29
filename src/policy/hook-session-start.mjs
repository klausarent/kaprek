#!/usr/bin/env node
// Claude Code SessionStart hook entrypoint: tells a session what kaprek
// knows about the directory it opened in (see session-start.mjs).
//
// Contract (Claude Code hooks reference, checked 2026-08-27): input JSON on
// stdin carries `session_id`, `transcript_path`, `cwd`, `hook_event_name`
// and `source` (startup | resume | clear | compact | fork). Context is
// returned as `{"hookSpecificOutput": {"hookEventName": "SessionStart",
// "additionalContext": "..."}}` on stdout with exit 0. Nothing to say means
// no output at all. Like hook-stop.mjs this script must NEVER exit non-zero
// and must NEVER hang — a session start is not allowed to wait on kaprek —
// so every path is wrapped, and a self-timeout forces a clean exit.
import { buildSessionStartContext } from './session-start.mjs';
import { getAppDir } from '../lib/appdir.mjs';
import { appendSessionEvent } from '../ledger/sessions.mjs';
import { syncMemoryDir } from '../memory/sync.mjs';

/** Sources where the session actually starts fresh context for a person to read — not a compaction or a fork mid-conversation, where re-syncing buys nothing. */
const SYNC_SOURCES = ['startup', 'resume', 'clear'];

const SELF_TIMEOUT_MS = 3000;

function readStdin() {
  return new Promise((resolve) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => {
      data += chunk;
    });
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', () => resolve(data));
  });
}

async function main() {
  const raw = await readStdin();
  let input;
  try {
    input = JSON.parse(raw);
  } catch {
    return; // malformed hook input — fail open, no output
  }
  const cwd = typeof input?.cwd === 'string' ? input.cwd : null;
  if (!cwd) return;

  const dataDir = getAppDir();
  try {
    if (typeof input?.session_id === 'string') appendSessionEvent(dataDir, { type: 'start', sessionId: input.session_id, cwd, transcriptPath: input?.transcript_path ?? null });
  } catch {
  }

  // Before building the context, not after: a fact synced this run should
  // already be there for this same session's own memory block.
  if (SYNC_SOURCES.includes(input?.source)) {
    try {
      syncMemoryDir({ dataDir, deadlineMs: 700 });
    } catch {
    }
  }

  const context = buildSessionStartContext({ dataDir, cwd });
  if (context === '') return;
  process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: context } }));
}

const timeoutTimer = setTimeout(() => {
  process.exit(0);
}, SELF_TIMEOUT_MS);

main()
  .catch(() => {
    // fail-open: any unexpected error resolves to silence
  })
  .finally(() => {
    clearTimeout(timeoutTimer);
    process.exitCode = 0;
  });
