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
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildSessionStartContext } from './session-start.mjs';
import { getAppDir } from '../lib/appdir.mjs';
import { appendSessionEvent } from '../ledger/sessions.mjs';
import { ensureServerRunning } from '../server/ensure.mjs';
import { syncMemoryDir } from '../memory/sync.mjs';

/** Sources where the session actually starts fresh context for a person to read — not a compaction or a fork mid-conversation, where re-syncing buys nothing. */
const SYNC_SOURCES = ['startup', 'resume', 'clear'];

const SELF_TIMEOUT_MS = 3000;
// A fresh terminal opening (startup) or reattaching to one (resume) is a
// person about to work — that is worth an autostart. compact/clear/fork
// reopen a session that was already running kaprek or wasn't; they get no
// say here, since a mid-session context reset is not "someone just sat
// down".
const AUTOSTART_SOURCES = new Set(['startup', 'resume']);
const CLI_PATH = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'bin', 'cli.mjs');

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

  // Makes kaprek run without a `kaprek` command anyone has to remember — see
  // src/server/ensure.mjs. Its own aliveness check is capped at 300 ms and it
  // never awaits the spawned server coming up, so this cannot be the reason
  // a session start is slow; the try/catch is only for the unexpected.
  if (AUTOSTART_SOURCES.has(input?.source)) {
    try {
      await ensureServerRunning({ dataDir, cliPath: CLI_PATH });
    } catch {
      // best-effort: a session opening must never wait on kaprek starting
    }
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
