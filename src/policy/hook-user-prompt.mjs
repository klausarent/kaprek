#!/usr/bin/env node
// Claude Code UserPromptSubmit hook entrypoint: makes kaprek's context
// follow a session that changes working directory mid-conversation — e.g.
// Klaus opens Claude Code in his home directory and only `cd`s into a
// project afterward — instead of only ever looking once, at the moment
// SessionStart fired (see hook-session-start.mjs, session-start.mjs for
// what the context itself contains).
//
// Contract (Claude Code hooks reference, checked 2026-08-29): input JSON on
// stdin carries `session_id`, `cwd`, `transcript_path`, `prompt_id` and
// `user_input`. Context is returned in the same shape SessionStart uses:
// `{"hookSpecificOutput": {"hookEventName": "UserPromptSubmit",
// "additionalContext": "..."}}` on stdout with exit 0; nothing to say means
// no output at all. Exit code 2 here would both BLOCK and DELETE the
// person's prompt — unlike any other kaprek hook, misfiring here is
// destructive, not just unhelpful, so every path below resolves to exit 0
// with no exceptions, and a self-timeout forces that even if something
// above hangs.
//
// This runs on every single prompt, so the common case — a session that has
// not changed directory since its last prompt — has to cost as little as a
// Node start plus one small file read (see prompt-context-state.mjs, kept
// deliberately fs+path only). `buildSessionStartContext` and everything it
// pulls in (mission/memory/chat stores) is only ever loaded with a dynamic
// `await import(...)` in the branch that actually needs it, so a steady
// session working inside one project never loads any of that.
import { getAppDir } from '../lib/appdir.mjs';
import { readContextState, writeContextState, sweepOldContextState } from './prompt-context-state.mjs';

const SELF_TIMEOUT_MS = 1000;

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
  const sessionId = typeof input?.session_id === 'string' ? input.session_id : null;
  if (!cwd || !sessionId) return;

  const dataDir = getAppDir();

  // Fast path: same directory as the last prompt (or the SessionStart hook
  // already recorded it, see hook-session-start.mjs) — nothing to say
  // twice, and nothing heavier than this readFileSync gets loaded.
  const state = readContextState(dataDir, sessionId);
  if (state && state.cwd === cwd) return;

  // Slow path: the directory changed, or this is the first prompt this
  // hook has seen for the session. Only here do the context stores get
  // imported and read.
  const { buildSessionStartContext } = await import('./session-start.mjs');
  const context = buildSessionStartContext({ dataDir, cwd });

  try {
    writeContextState(dataDir, sessionId, cwd);
    sweepOldContextState(dataDir);
  } catch {
    // best case: the next prompt just re-checks and possibly re-emits the same context
  }

  if (context === '') return;
  process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: context } }));
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
