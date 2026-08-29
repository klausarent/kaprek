#!/usr/bin/env node
// Claude Code SessionEnd hook entrypoint: the one moment kaprek can tell a
// session apart from a headless/cron run that never opened a hook at all —
// see src/ledger/sessions.mjs::readLedgerIndex, which `kaprek resume` reads
// to show only sessions that really ran in a terminal.
//
// Contract (Claude Code hooks reference, checked 2026-08-29): input JSON on
// stdin carries `session_id`, `transcript_path`, `cwd`, `hook_event_name` and
// `session_end_reason` (clear | resume | logout | prompt_input_exit | other).
// SessionEnd cannot block and has nothing to say back — no output shape
// exists for it, unlike SessionStart. Like every kaprek hook this script
// must NEVER exit non-zero and must NEVER hang; its own budget (1000 ms) is
// smaller than the other hooks' because Claude Code's 1.5 s SessionEnd
// budget is shared with whatever other tool also hooked into this event.
// Only appendSessionEvent is imported on purpose — this hook does exactly
// one thing, and every extra import is time this budget cannot afford.
import { appendSessionEvent } from '../ledger/sessions.mjs';
import { getAppDir } from '../lib/appdir.mjs';

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
  if (typeof input?.session_id !== 'string' || input.session_id === '') return;

  const dataDir = getAppDir();
  const cwd = typeof input?.cwd === 'string' ? input.cwd : null;
  const reason = typeof input?.session_end_reason === 'string' ? input.session_end_reason : null;
  try {
    appendSessionEvent(dataDir, { type: 'end', sessionId: input.session_id, cwd, transcriptPath: input?.transcript_path ?? null, reason });
  } catch {
    // fail-open: a hook that cannot write must still let the session end
  }
}

// Hard stop if anything above hangs — forces exit(0) rather than eating into
// the 1.5 s SessionEnd budget other hooks share with this one.
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
