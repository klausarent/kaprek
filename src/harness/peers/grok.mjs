// The Grok peer driver: one prompt in, one schema-constrained answer out.
//
// Verified against the installed CLI (Grok Build 0.2.117). The exact call:
//
//   grok --prompt-file <file> --verbatim --output-format json
//        --json-schema '{"type":"object", ... status/message ... }'
//        --tools "" --disallowed-tools <file, shell, web and task tools>
//        --disable-web-search --no-subagents --no-memory
//        --no-plan --permission-mode plan --max-turns 1 --cwd <cwd>
//
// Every flag on that line is doing a specific job:
//   --verbatim       the prompt reaches the model as written. Without it the
//                    CLI (0.2.117 and 1.0.13 alike) offloads anything above
//                    ~24 KB into <session>/prompts/prompt_0.txt, shows the
//                    model 20,000 characters plus "read that file first", and
//                    on Windows the percent-encoded session path makes that
//                    read fail — the turn dies as "max turns reached".
//                    Verified 04.09.2026: 155 KB verbatim, one turn, answer.
//   --disallowed-tools  --tools "" does NOT empty the toolset (the log shows
//                    24 tools either way); this list actually removes the
//                    file, shell, web and task tools. Without it a peer that
//                    wants to check something runs python — plan mode cancels
//                    the call, and the cancelled turn is the answer.
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
 * The biggest prompt this driver will hand the CLI, in UTF-8 bytes.
 *
 * History: Grok Build 0.2.117 silently offloaded a long prompt — the model
 * saw the first and last ~10,000 characters, a note that "the full request"
 * sits in <session>/prompts/prompt_0.txt, and an instruction to read_file it
 * before answering. Measured 04.09.2026: 23,971 bytes went through, 25,442
 * were offloaded. On Windows the session directory name is percent-encoded
 * (C%3A%5CUsers…) and read_file cannot open it, so the model spent its one
 * turn on a read that failed and the CLI exited "max turns reached" — ten of
 * twelve council runs on 03./04.09., every one a --diff. 1.0.13 behaves the
 * same. `--verbatim` is the switch: the prompt is sent as written, no
 * offload, and 155,574 bytes came back answered in one turn (1.0.13).
 *
 * So this is no longer the offload threshold but a sanity cap: the largest
 * prompt verified end to end. Above it the council still trims the package
 * for this peer (src/council/consult.mjs::fitPackage) and says so, rather
 * than finding out at answer time what the model does with more.
 */
export const GROK_MAX_PROMPT_BYTES = 150_000;

/**
 * What `--disallowed-tools` strips for a text-only turn. The documented tool
 * ids (README "Tool Filtering") plus `run_terminal_command`, the id the
 * session log actually shows for the shell, and `Agent` (no subagents).
 * `--tools ""` alone leaves all 24 tools in place — verified in the CLI's
 * own log (shell.turn.tool_prep_done tool_count=24) on 0.2.117 and 1.0.13.
 */
export const GROK_TEXT_ONLY_DISALLOWED = 'run_terminal_cmd,run_terminal_command,read_file,grep,list_dir,search_replace,web_search,web_fetch,todo_write,task,Agent';

/**
 * Resolves an npm .cmd shim to the node script it wraps, so the driver can
 * spawn `node <entry> <args>` directly and never needs `shell: true`.
 *
 * Why this exists (tag-5 live acceptance, both bugs reproduced against the
 * real CLI): with shell:true node JOINS argv into one raw cmd.exe line, so
 * the empty-string argument of `--tools ''` vanishes entirely (clap: "a
 * value is required for '--tools <TOOLS>'"), and cmd.exe eats the quotes
 * inside the --json-schema JSON ("invalid JSON: key must be a string").
 * Quoting argv for cmd.exe is a dead end; not needing cmd.exe is the fix.
 *
 * npm's cmd-shim ends in `... "%_prog%"  "%dp0%\<relative entry>" %*`, where
 * %dp0% is the shim's own directory. That line is what this parses. Returns
 * null when the file is unreadable, not shim-shaped, or the entry it names
 * does not exist — the caller then falls back honestly instead of spawning a
 * node command that cannot work.
 */
export function resolveCmdShim(shimPath, { execPath = process.execPath } = {}) {
  let text;
  try {
    text = fs.readFileSync(shimPath, 'utf8');
  } catch {
    return null;
  }
  const match = text.match(/"%dp0%\\([^"]+)"\s+%\*/);
  if (!match) return null;
  const entry = path.join(path.dirname(shimPath), match[1]);
  try {
    if (!fs.existsSync(entry)) return null;
  } catch {
    return null;
  }
  return { command: execPath, argsPrefix: [entry], useShell: false };
}

/**
 * Finds the grok binary the same way claude-code.mjs finds claude: an
 * explicit override wins, then a PATH walk on Windows, then a plain name and
 * let spawn report ENOENT.
 *
 * The Windows walk runs in two passes: a native .exe ANYWHERE on PATH beats
 * a .cmd shim that happens to come earlier (both installs coexist on this
 * machine: ~/.grok/bin/grok.exe and the npm shim in AppData/Roaming/npm),
 * because the exe needs no shell and has none of the quoting problems above.
 * A shim that is found is resolved to its node entry via resolveCmdShim();
 * only when that fails does shell:true survive as the last resort.
 *
 * `argsPrefix` is prepended to the turn's argv by runGrokTurn() — empty for
 * a direct binary, the entry-script path when the command is node itself.
 */
export function resolveGrokCli(env = process.env, { platform = process.platform } = {}) {
  const override = env.KAPREK_GROK_PATH;
  if (override) {
    if (/\.(cmd|bat)$/i.test(override)) {
      return resolveCmdShim(override) ?? { command: override, argsPrefix: [], useShell: true };
    }
    return { command: override, argsPrefix: [], useShell: false };
  }
  if (platform !== 'win32') return { command: 'grok', argsPrefix: [], useShell: false };

  const dirs = (env.PATH ?? '').split(path.delimiter).filter(Boolean);
  for (const dir of dirs) {
    const full = path.join(dir, 'grok.exe');
    try {
      if (fs.existsSync(full)) return { command: full, argsPrefix: [], useShell: false };
    } catch {
      // unreadable PATH entry — keep looking
    }
  }
  for (const dir of dirs) {
    for (const name of ['grok.cmd', 'grok.bat']) {
      const full = path.join(dir, name);
      try {
        if (!fs.existsSync(full)) continue;
      } catch {
        continue;
      }
      return resolveCmdShim(full) ?? { command: full, argsPrefix: [], useShell: true };
    }
  }
  return { command: 'grok', argsPrefix: [], useShell: false };
}

/**
 * The argv for one turn, minus the binary. Exported so a test can assert the
 * contract rather than trusting a comment.
 *
 * `tools` is empty by default — a relay turn is a text hand-off and must not
 * touch the disk. A COUNCIL turn (src/council/ask.mjs) passes the read-only
 * set and a higher turn budget: the first live consultation failed with
 * "max turns reached" because a peer asked to read three files had exactly
 * one turn to do it in. `--permission-mode plan` still forbids writing
 * either way.
 */
export function buildGrokArgs({ promptPath, cwd, maxTurns = 1, tools = '', schema = PEER_OUTPUT_SCHEMA }) {
  return [
    '--prompt-file',
    promptPath,
    '--verbatim',
    '--output-format',
    'json',
    '--json-schema',
    JSON.stringify(schema),
    '--tools',
    tools,
    // An explicit allowlist is the caller's choice; only the text-only
    // default gets the denylist (the allowlist alone does not take).
    ...(tools ? [] : ['--disallowed-tools', GROK_TEXT_ONLY_DISALLOWED]),
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
export function parseGrokStdout(stdout, { validate = true } = {}) {
  let envelope;
  try {
    envelope = JSON.parse(stdout);
  } catch (err) {
    const head = stdout.slice(0, 400).trim();
    throw new Error(`grok did not print JSON (${err.message}); first bytes: ${head || '(empty)'}`);
  }
  // A relay turn must answer in the relay's own {status, message} shape, and
  // parsePeerAnswer enforces it. A COUNCIL turn answers in a different shape
  // entirely (verdict/summary/risks, see src/council/consult.mjs), so it
  // takes the envelope's text as-is and validates it itself — the first live
  // consultation failed here, with a perfectly good verdict rejected for not
  // being a relay hand-off.
  const answer = validate
    ? parsePeerAnswer(envelope?.text ?? envelope)
    : { status: 'done', message: typeof envelope?.text === 'string' ? envelope.text : JSON.stringify(envelope?.text ?? envelope ?? {}) };
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
export async function runGrokTurn({ cwd, prompt, timeoutMs = PEER_TIMEOUT_MS, signal, logDir = null, spawnFn = spawn, env = process.env, maxTurns, tools, schema, validate = true } = {}) {
  if (typeof prompt !== 'string' || prompt.trim().length === 0) throw new Error('a peer turn needs a prompt');
  // Refused here, not left to the CLI: above the threshold grok offloads the
  // prompt into a file it cannot read back and the turn dies as "max turns
  // reached" — an error that says nothing about its cause.
  const promptBytes = Buffer.byteLength(prompt, 'utf8');
  if (promptBytes > GROK_MAX_PROMPT_BYTES) {
    throw new Error(`the prompt is ${promptBytes} bytes; grok 0.2.117 offloads anything above ~24 KB into a file it cannot read back on Windows — keep it under ${GROK_MAX_PROMPT_BYTES} bytes (GROK_MAX_PROMPT_BYTES)`);
  }

  const { command, argsPrefix = [], useShell } = resolveGrokCli(env);
  // The empty --tools '' argument — the default, and what a text-only
  // council turn relies on — VANISHES when cmd.exe joins the argv (see
  // resolveCmdShim's note), and grok then runs with its full default tool
  // set or rejects the flag. Neither is acceptable to discover at answer
  // time: fail here, before anything touches the disk, on the one path
  // that still needs a shell.
  if (useShell && !tools) {
    throw new Error(`the grok CLI resolved to a shell shim (${command}), which cannot pass an empty --tools list; set KAPREK_GROK_PATH to the grok.exe binary`);
  }

  const startedAt = Date.now();
  const scratchDir = logDir ?? fs.mkdtempSync(path.join(os.tmpdir(), 'kaprek-peer-'));
  fs.mkdirSync(scratchDir, { recursive: true });
  const stamp = `${startedAt}-${process.pid}`;
  const promptPath = path.join(scratchDir, `grok-prompt-${stamp}.txt`);
  const rawLogPath = path.join(scratchDir, `grok-raw-${stamp}.log`);
  fs.writeFileSync(promptPath, prompt, 'utf8');

  const args = [...argsPrefix, ...buildGrokArgs({ promptPath, cwd, ...(maxTurns ? { maxTurns } : {}), ...(tools ? { tools } : {}), ...(schema ? { schema } : {}) })];

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

  const parsed = parseGrokStdout(result.stdout, { validate });
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
  maxPromptBytes: GROK_MAX_PROMPT_BYTES,
});
