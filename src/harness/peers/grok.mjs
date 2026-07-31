// The Grok peer driver: one prompt in, one schema-constrained answer out.
//
// Verified against the installed CLI (Grok Build 0.2.117). The exact call:
//
//   grok --prompt-file <file> --output-format json
//        --json-schema '{"type":"object", ... status/message ... }'
//        --tools "" --disable-web-search --no-subagents --no-memory
//        --no-plan --permission-mode plan --max-turns 1 --cwd <cwd>
//
// Every flag on that line is doing a specific job:
//   --prompt-file    the prompt goes through a FILE, never argv. A relay
//                    prompt carries whole drafts; argv has length limits and
//                    quoting rules that differ per platform and shell, and a
//                    prompt that gets truncated or mangled by the command
//                    line is the kind of bug that looks like a model problem.
//   --json-schema    constrains the answer to {status, message}. The
//                    dispatcher acts on `status`, so it must not be something
//                    parsed out of prose (see driver.mjs's own note).
//   --tools ""       no tools at all. With --disable-web-search and
//                    --no-subagents this is what "text-only" actually means:
//                    the peer can think and write, and nothing else.
//   --no-memory      no cross-session memory, so a turn depends only on the
//                    prompt the dispatcher assembled and is reproducible from
//                    the transcript.
//   --max-turns 1    one turn per call. The relay decides when there is a
//                    next one; the peer does not get to keep going.
//   --permission-mode plan  belt and braces: even if a tool slipped into the
//                    set, plan mode does not execute.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import {
  PEER_MAX_STDOUT_BYTES,
  PEER_OUTPUT_SCHEMA,
  PEER_TIMEOUT_MS,
  parsePeerAnswer,
  registerPeerDriver,
} from './driver.mjs';

/**
 * Finds the grok binary the same way claude-code.mjs finds claude: an
 * explicit override wins, then a PATH walk on Windows (where a .cmd shim
 * needs `shell: true` and a native .exe does not), then a plain name and let
 * spawn report ENOENT.
 */
export function resolveGrokCli(env = process.env) {
  const override = env.KAPREK_GROK_PATH;
  if (override) return { command: override, useShell: /\.(cmd|bat)$/i.test(override) };
  if (process.platform !== 'win32') return { command: 'grok', useShell: false };

  const dirs = (env.PATH ?? '').split(path.delimiter).filter(Boolean);
  for (const dir of dirs) {
    for (const name of ['grok.exe', 'grok.cmd', 'grok.bat']) {
      const full = path.join(dir, name);
      try {
        if (fs.existsSync(full)) return { command: full, useShell: /\.(cmd|bat)$/i.test(name) };
      } catch {
        // unreadable PATH entry — keep looking
      }
    }
  }
  return { command: 'grok', useShell: false };
}

/** The argv for one turn, minus the binary. Exported so a test can assert the contract rather than trusting a comment. */
export function buildGrokArgs({ promptPath, cwd, maxTurns = 1 }) {
  return [
    '--prompt-file',
    promptPath,
    '--output-format',
    'json',
    '--json-schema',
    JSON.stringify(PEER_OUTPUT_SCHEMA),
    '--tools',
    '',
    '--disable-web-search',
    '--no-subagents',
    '--no-memory',
    '--no-plan',
    '--permission-mode',
    'plan',
    '--max-turns',
    String(maxTurns),
    ...(cwd ? ['--cwd', cwd] : []),
  ];
}

/**
 * Pulls the answer out of what the CLI printed.
 *
 * Grok's JSON output is an envelope: `{text, usage, total_cost_usd, ...}`,
 * where `text` is the schema-constrained answer as a STRING. So there are two
 * parses, and both can fail on their own — an envelope that is not JSON means
 * the CLI failed before the model ran (auth, flags), while an envelope whose
 * `text` is not JSON means the model ignored the schema. The messages say
 * which, because the two need completely different fixes.
 */
export function parseGrokStdout(stdout) {
  let envelope;
  try {
    envelope = JSON.parse(stdout);
  } catch (err) {
    const head = stdout.slice(0, 400).trim();
    throw new Error(`grok did not print JSON (${err.message}); first bytes: ${head || '(empty)'}`);
  }
  const answer = parsePeerAnswer(envelope?.text ?? envelope);
  return {
    ...answer,
    usage: envelope?.usage ?? null,
    // Reported by this version, and passed through as-is. It is still an
    // ESTIMATE: a subscription is not billed per turn (see driver.mjs's
    // PEER_COST_ESTIMATED), so the caller labels it rather than adding it up
    // as money spent. Absent stays null, never 0.
    costUsd: typeof envelope?.total_cost_usd === 'number' ? envelope.total_cost_usd : null,
  };
}

/** Kills a child and, on Windows, the process tree under it — same reasoning as claude-code.mjs::killChildTree(). */
function killTree(child) {
  try {
    child.kill();
  } catch {
    // already gone
  }
  if (!child.pid) return;
  if (process.platform === 'win32') {
    try {
      spawn('taskkill', ['/pid', String(child.pid), '/t', '/f'], { stdio: 'ignore' }).unref();
    } catch {
      // best-effort
    }
    return;
  }
  try {
    process.kill(-child.pid, 'SIGKILL');
  } catch {
    // no process group, or already gone
  }
}

/**
 * Runs one Grok turn.
 *
 * Never rejects for a turn-level failure the way the harness contract also
 * avoids it — but unlike a harness turn there is no partial result worth
 * salvaging here, so a failed turn throws with a message the dispatcher can
 * record as `dispatch.failed`. What it must never do is hang: a timeout kills
 * the tree, and stdout past the cap ends the turn instead of growing until
 * the process runs out of memory.
 */
export async function runGrokTurn({ cwd, prompt, timeoutMs = PEER_TIMEOUT_MS, signal, logDir = null, spawnFn = spawn, env = process.env } = {}) {
  if (typeof prompt !== 'string' || prompt.trim().length === 0) throw new Error('a peer turn needs a prompt');

  const startedAt = Date.now();
  const scratchDir = logDir ?? fs.mkdtempSync(path.join(os.tmpdir(), 'kaprek-peer-'));
  fs.mkdirSync(scratchDir, { recursive: true });
  const stamp = `${startedAt}-${process.pid}`;
  const promptPath = path.join(scratchDir, `grok-prompt-${stamp}.txt`);
  const rawLogPath = path.join(scratchDir, `grok-raw-${stamp}.log`);
  fs.writeFileSync(promptPath, prompt, 'utf8');

  const { command, useShell } = resolveGrokCli(env);
  const args = buildGrokArgs({ promptPath, cwd });

  const result = await new Promise((resolve) => {
    const child = spawnFn(command, args, {
      cwd: cwd ?? process.cwd(),
      shell: useShell,
      windowsHide: true,
      // Own process group on POSIX so the timeout can take the whole tree.
      detached: process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    let overflowed = false;
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener?.('abort', onAbort);
      resolve(value);
    };

    const timer = setTimeout(() => {
      killTree(child);
      finish({ error: `grok did not answer within ${timeoutMs}ms`, stdout, stderr });
    }, timeoutMs);

    const onAbort = () => {
      killTree(child);
      finish({ error: 'the relay run was stopped', stdout, stderr });
    };
    signal?.addEventListener?.('abort', onAbort, { once: true });

    child.stdout?.on('data', (chunk) => {
      if (overflowed) return;
      stdout += chunk;
      if (Buffer.byteLength(stdout, 'utf8') > PEER_MAX_STDOUT_BYTES) {
        overflowed = true;
        killTree(child);
        finish({ error: `grok printed more than ${PEER_MAX_STDOUT_BYTES} bytes`, stdout, stderr });
      }
    });
    child.stderr?.on('data', (chunk) => {
      stderr += chunk;
      if (Buffer.byteLength(stderr, 'utf8') > PEER_MAX_STDOUT_BYTES) stderr = stderr.slice(-4096);
    });

    child.on('error', (err) => finish({ error: `could not start grok: ${err.message}`, stdout, stderr }));
    child.on('close', (code) => {
      if (code === 0) finish({ stdout, stderr });
      else finish({ error: `grok exited with code ${code}${stderr ? `: ${stderr.slice(-400).trim()}` : ''}`, stdout, stderr });
    });
  });

  try {
    fs.writeFileSync(rawLogPath, `--- stdout ---\n${result.stdout ?? ''}\n--- stderr ---\n${result.stderr ?? ''}\n`, 'utf8');
  } catch {
    // The log is a convenience; losing it must not lose the turn.
  }
  try {
    fs.unlinkSync(promptPath);
  } catch {
    // best-effort
  }

  if (result.error) {
    const err = new Error(result.error);
    err.rawLogPath = rawLogPath;
    throw err;
  }

  const parsed = parseGrokStdout(result.stdout);
  return { ...parsed, durationMs: Date.now() - startedAt, rawLogPath };
}

export const grokDriver = registerPeerDriver({
  id: 'grok',
  available(env = process.env) {
    const { command } = resolveGrokCli(env);
    // An absolute path we found on PATH is proof; a bare name is a guess that
    // spawn will settle. Reported honestly rather than shelling out to check.
    return path.isAbsolute(command) ? fs.existsSync(command) : true;
  },
  runTurn: runGrokTurn,
});
