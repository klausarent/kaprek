#!/usr/bin/env node
// Claude Code Stop hook entrypoint for kaprek's policy engine.
//
// Contract: Claude Code invokes this as `node <path>/hook-stop.mjs`, piping
// hook input JSON (transcript_path, session_id, stop_hook_active, ...) on
// stdin. Two independent things can block the turn from ending here, each
// through the mechanism Claude Code already gives Stop hooks for it:
//   - the POLICY ENGINE (policy.mjs) blocks via `{"decision":"block",
//     "reason":"..."}` on stdout with exit code 0;
//   - the COUNCIL GATE (council-gate.mjs) blocks via exit code 2 with the
//     reason on stderr — the other block form Claude Code's hooks reference
//     documents, chosen here because there is no existing reusable "block"
//     helper to match the policy engine's JSON shape against, only the
//     inlined write below.
// An allow decision from either is silent (no stdout/stderr) with exit 0.
// This script must NEVER hang — either form of block taking forever would
// be worse than either form of block never firing. Every path is wrapped in
// try/catch, and a self-timeout forces a clean (exit 0, allow) exit if
// anything takes too long.
import path from 'node:path';
import os from 'node:os';
import { evaluateStop } from './policy.mjs';
import { evaluateCouncilGate } from './council-gate.mjs';
import { getAppDir } from '../lib/appdir.mjs';
import { sweepSessionArtifacts } from '../artifacts/preserve.mjs';
import { harvestRemember } from '../memory/harvest.mjs';
import { appendSessionEvent } from '../ledger/sessions.mjs';
import { gitExec } from '../lib/git-exec.mjs';

const SELF_TIMEOUT_MS = 3000;
const hookStart = Date.now();

// A short leash on every individual git call the gate makes: the gate's own
// deadlineMs (600ms default, see council-gate.mjs) bounds how long the gate
// spends overall, but a single hung `git` process could still burn through
// that budget on its own without this — and this hook's SELF_TIMEOUT_MS is
// what stands between that and hanging the user's turn.
const gateExec = (args, options) => gitExec(args, { ...options, timeoutMs: 400 });

// Test-only override, mirroring KAPREK_DATA_DIR (see appdir.mjs): hook-stop.mjs
// runs as a spawned child process (see hook-stop.test.mjs), so its tests need
// a way to point artifact preservation at a scratch tmpRoot from the outside
// rather than the real OS temp dir.
function resolveTmpRoot() {
  return process.env.KAPREK_TMP_ROOT || path.join(os.tmpdir(), 'claude');
}

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

  // Claude Code's own loop guard; our once-marker is the fallback when this
  // field is absent.
  if (input?.stop_hook_active === true) {
    return;
  }

  const dataDir = getAppDir();
  const result = await evaluateStop({
    dataDir,
    transcriptPath: input?.transcript_path,
    sessionId: input?.session_id,
  });

  // The terminal learns: remember-blocks from this session's transcript go
  // into the project's memory scope, and the ledger notes the turn. Both
  // fail open — a hook that cannot write must still let the turn end.
  const cwd = typeof input?.cwd === 'string' ? input.cwd : null;
  try {
    harvestRemember({ dataDir, transcriptPath: input?.transcript_path, sessionId: input?.session_id, cwd, deadlineMs: 1500 });
  } catch {
  }
  try {
    if (typeof input?.session_id === 'string') appendSessionEvent(dataDir, { type: 'stop', sessionId: input.session_id, cwd, transcriptPath: input?.transcript_path ?? null });
  } catch {
  }

  // Council gate: has this session grown large enough that ending the turn
  // without a second opinion would be reckless? See council-gate.mjs for the
  // full set of conditions — every one of them fails toward NOT blocking.
  // Only attempted while there is still meaningfully more than the gate's
  // own default deadline left in this hook's own SELF_TIMEOUT_MS, so a git
  // call added here can never be what pushes an ordinary turn over it.
  if (typeof input?.session_id === 'string' && cwd && Date.now() - hookStart < 2300) {
    try {
      const gate = evaluateCouncilGate({
        dataDir,
        cwd,
        sessionId: input.session_id,
        stopHookActive: input?.stop_hook_active === true,
        exec: gateExec,
      });
      if (gate.block) {
        process.stderr.write(`${gate.reason}\n`);
        return 2;
      }
    } catch {
      // fail-open: a bug in the gate must never block ending the turn
    }
  }

  // Best-effort scratchpad preservation for the ending session. The Stop
  // hook is the one moment kaprek knows a session just ended, making it the
  // best chance to catch a scratchpad before OS temp cleanup removes it —
  // but this must never affect the hook's own fail-open contract, so every
  // failure (bad tmpRoot, permissions, an oversized scratchpad) is swallowed
  // completely. The small session byte budget here keeps this fast within
  // SELF_TIMEOUT_MS; the reindex-triggered sweep (see server.mjs) is the
  // full, unbudgeted pass that picks up anything this misses.
  try {
    const transcriptPath = input?.transcript_path;
    const projectSlug = typeof transcriptPath === 'string' ? path.basename(path.dirname(transcriptPath)) : null;
    if (projectSlug && typeof input?.session_id === 'string') {
      sweepSessionArtifacts({
        tmpRoot: resolveTmpRoot(),
        dataDir,
        projectSlug,
        sessionId: input.session_id,
        maxSessionBytes: 20 * 1024 * 1024,
      });
    }
  } catch {
    // fail-open: artifact preservation must never block ending the turn
  }

  if (result.decision === 'block') {
    process.stdout.write(JSON.stringify({ decision: 'block', reason: result.reasons.join('; ') }));
    return 0;
  }
  // 'warn' has no expressible form in the Stop hook contract (only 'block'
  // is), so it is surfaced on stderr for an interactive terminal and
  // otherwise ignored. 'allow' produces no output at all.
  if (result.decision === 'warn' && result.reasons.length > 0) {
    process.stderr.write(`kaprek policy warning: ${result.reasons.join('; ')}\n`);
  }
  return 0;
}

// Hard stop if anything above hangs (e.g. a stuck stream) — forces exit(0)
// rather than leaving Claude Code waiting on this hook forever.
const timeoutTimer = setTimeout(() => {
  process.exit(0);
}, SELF_TIMEOUT_MS);

main()
  .then((code) => {
    // Every early `return;` above (malformed input, stop_hook_active, no
    // block) resolves `code` to undefined, which maps to 0 — only the
    // council gate's `return 2;` produces a non-zero exit here.
    process.exitCode = typeof code === 'number' ? code : 0;
  })
  .catch(() => {
    // fail-open: any unexpected error resolves to silent allow
    process.exitCode = 0;
  })
  .finally(() => {
    clearTimeout(timeoutTimer);
  });
