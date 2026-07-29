#!/usr/bin/env node
// Claude Code Stop hook entrypoint for ccview's policy engine.
//
// Contract: Claude Code invokes this as `node <path>/hook-stop.mjs`, piping
// hook input JSON (transcript_path, session_id, stop_hook_active, ...) on
// stdin. A block decision is expressed as `{"decision":"block","reason":
// "..."}` on stdout with exit code 0; an allow decision is silent stdout
// with exit code 0. This script must NEVER exit non-zero and must NEVER
// hang — either would block the user's ability to end a turn. Every path
// is wrapped in try/catch, and a self-timeout forces a clean exit if
// anything takes too long.
import { evaluateStop } from './policy.mjs';
import { getAppDir } from '../lib/appdir.mjs';

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

  const dataDir = getAppDir();
  const result = await evaluateStop({
    dataDir,
    transcriptPath: input?.transcript_path,
    sessionId: input?.session_id,
  });

  if (result.decision === 'block') {
    process.stdout.write(JSON.stringify({ decision: 'block', reason: result.reasons.join('; ') }));
    return;
  }
  // 'warn' has no expressible form in the Stop hook contract (only 'block'
  // is), so it is surfaced on stderr for an interactive terminal and
  // otherwise ignored. 'allow' produces no output at all.
  if (result.decision === 'warn' && result.reasons.length > 0) {
    process.stderr.write(`ccview policy warning: ${result.reasons.join('; ')}\n`);
  }
}

// Hard stop if anything above hangs (e.g. a stuck stream) — forces exit(0)
// rather than leaving Claude Code waiting on this hook forever.
const timeoutTimer = setTimeout(() => {
  process.exit(0);
}, SELF_TIMEOUT_MS);

main()
  .catch(() => {
    // fail-open: any unexpected error resolves to silent allow
  })
  .finally(() => {
    clearTimeout(timeoutTimer);
    process.exitCode = 0;
  });
