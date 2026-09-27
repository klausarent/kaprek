// The GLM peer driver: one prompt in, one schema-constrained answer out.
//
// Verified against the installed CLI (ZCode CLI 0.16.9, 27.09.2026). ZCode is
// the desktop app that ships GLM-5.3 as its default model under the user's
// GLM Coding Plan (a subscription, same shape as Grok's); its headless entry
// point is a plain node script bundled inside the app, not a PATH command:
//
//   node <install dir>\resources\glm\zcode.cjs
//     -p "<short instruction>"
//     --attach <file1> --attach <file2> ...
//     --mode plan --json
//     --disallowed-tools "Bash Edit Write Read Glob Grep WebFetch WebSearch Task"
//     --cwd <scratch dir>
//
// Every choice on that line is doing a specific job:
//   --mode plan       the ONE thing that keeps a text hand-off from becoming
//                      a write. `-p` defaults to permission mode "yolo" —
//                      verified live, 27.09.2026 — so this flag is never
//                      optional, the same way grok.mjs's --permission-mode
//                      plan is belt and braces rather than a preference.
//   --disallowed-tools strips the tool-capable set by name, same reasoning as
//                      GROK_TEXT_ONLY_DISALLOWED: a peer is a text turn, and
//                      "no tools" has to be enforced, not requested.
//   --attach, not a    ZCode only shows a SINGLE attachment up to ~64 KB
//   single big file    (~610 lines) to the model; past that it is silently
//                      truncated. Splitting a big prompt into several
//                      attachments works — a 114 KB prompt in 3 parts was
//                      read completely, verified live. So the prompt never
//                      goes on the -p line (argv limits, quoting) and never
//                      in one file (the 64 KB wall): it goes out as N files
//                      of at most GLM_ATTACHMENT_MAX_BYTES each, headered
//                      "[Teil k von n]" so the model knows there is more and
//                      in what order to read it (chunkPromptForZcode()).
//   --json             stdout is a JSON envelope, sometimes preceded by plain
//                      log lines ("ZCode Built-in skipped (not-due)") that
//                      are not part of it — parseGlmStdout() reads from the
//                      first '{' onward rather than assuming byte 0 is JSON.
//
// ZCODE_BUILTIN_PROVIDER_CONFIG_FILE. Without this env var the CLI aborts
// before the model ever runs ("无法定位 CLI ZCode Built-in Provider Config",
// verified live). It has to be computed relative to whichever zcode.cjs the
// driver resolved (resources\glm\zcode.cjs -> resources\config\provider\
// zcode-builtin.json, see providerConfigPathFor()) rather than hardcoded,
// because KAPREK_ZCODE_PATH can point anywhere. Set only when the caller has
// not already set one — a deliberate override must win.
//
// Model. The CLI has no --model flag; every turn runs whatever the user's
// ZCode default is (GLM-5.3 as installed, 27.09.2026). Switching to
// GLM-5.3-Flash needs the app-server protocol's `session/setModel`, which is
// a different, stateful integration than this one-shot `-p` driver — out of
// scope here, same way grok.mjs does not manage Grok's own model setting.
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
 * Unlike GROK_MAX_PROMPT_BYTES this is not a technical wall — ZCode's
 * attachment scheme (see chunkPromptForZcode()) can in principle carry an
 * arbitrarily large prompt across enough files. It is kept equal to grok's
 * verified cap anyway: src/council/consult.mjs::fitPackage trims a package
 * per peer to whatever `maxPromptBytes` says, and a council round comparing
 * two peers' verdicts on packages of wildly different size is a worse signal
 * than one comparing two peers who both saw the same trimmed material.
 */
export const GLM_MAX_PROMPT_BYTES = 150_000;

/** The most one ZCode attachment file may weigh, header included. Verified live: a single attachment is shown to the model up to ~64 KB (~610 lines); this stays well under that. */
export const GLM_ATTACHMENT_MAX_BYTES = 40_000;

/**
 * Room reserved inside GLM_ATTACHMENT_MAX_BYTES for the "[Teil k von n]\n"
 * header line. Generous on purpose (the header itself never exceeds ~23
 * bytes short of six-digit part counts) so the body-size math in
 * chunkPromptForZcode() never has to re-measure after adding the header.
 */
const GLM_CHUNK_HEADER_RESERVE_BYTES = 32;

/** What `--disallowed-tools` strips for a text-only turn — the tool-capable set by name, same reasoning as grok.mjs's GROK_TEXT_ONLY_DISALLOWED. */
export const GLM_DISALLOWED_TOOLS = 'Bash Edit Write Read Glob Grep WebFetch WebSearch Task';

/**
 * Where ZCode's CLI entry sits when nothing overrides it: the app's own
 * install directory, resolved the same way an Electron installer lays it
 * out on Windows. `env.LOCALAPPDATA` is honored rather than assumed, and
 * falls back to the usual `%LOCALAPPDATA%` shape under the home directory
 * so a caller that hands in a partial env (a test, for instance) still gets
 * a plausible path rather than `path.join(undefined, ...)` throwing.
 */
export function defaultZcodeCjsPath(env = process.env) {
  const localAppData = env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
  return path.join(localAppData, 'Programs', 'ZCode', 'resources', 'glm', 'zcode.cjs');
}

/**
 * Resolves what to spawn for one GLM turn.
 *
 * `KAPREK_ZCODE_PATH` may name the `zcode.cjs` script itself or a standalone
 * `.exe` built from it; everything else is `node <the resolved entry>`,
 * spawned directly — there is no PATH walk and no npm shim to resolve the
 * way grok.mjs needs one, because ZCode is not installed through npm and
 * this driver never guesses at a bare command name.
 */
export function resolveZcodeCli(env = process.env, { execPath = process.execPath } = {}) {
  const entryPath = env.KAPREK_ZCODE_PATH || defaultZcodeCjsPath(env);
  if (/\.exe$/i.test(entryPath)) return { command: entryPath, argsPrefix: [], entryPath };
  return { command: execPath, argsPrefix: [entryPath], entryPath };
}

/**
 * Where the provider config ZCode needs lives, relative to the entry it was
 * resolved from: `resources\glm\zcode.cjs` (or an `.exe` beside it) sits next
 * to `resources\config\provider\zcode-builtin.json`. Computed rather than
 * hardcoded so a KAPREK_ZCODE_PATH override still finds its own config.
 */
export function providerConfigPathFor(entryPath) {
  return path.join(path.dirname(entryPath), '..', 'config', 'provider', 'zcode-builtin.json');
}

/**
 * Takes as many leading characters of `str` as fit within `maxBytes` of
 * UTF-8, cutting only at character boundaries (a surrogate pair is never
 * split). Used solely by packLines() for the one case that has nowhere
 * else to cut: a single line longer than the whole attachment budget.
 */
function sliceUtf8(str, maxBytes) {
  if (Buffer.byteLength(str, 'utf8') <= maxBytes) return [str, ''];
  let bytes = 0;
  let i = 0;
  while (i < str.length) {
    const codePoint = str.codePointAt(i);
    const char = String.fromCodePoint(codePoint);
    const charBytes = Buffer.byteLength(char, 'utf8');
    if (bytes + charBytes > maxBytes) break;
    bytes += charBytes;
    i += char.length; // 1 normally, 2 across a surrogate pair
  }
  return [str.slice(0, i), str.slice(i)];
}

/**
 * Packs `text` into chunks of at most `limit` UTF-8 bytes, breaking on line
 * boundaries wherever it can — a chunk boundary lands right after a `\n`,
 * never mid-line. The one exception is a single line that alone exceeds
 * `limit`: there is nowhere else to cut it, so it is hard-split by bytes.
 */
function packLines(text, limit) {
  const chunks = [];
  let current = '';
  const lines = text.split('\n');
  lines.forEach((line, idx) => {
    let piece = idx < lines.length - 1 ? `${line}\n` : line;
    while (Buffer.byteLength(piece, 'utf8') > limit) {
      if (current !== '') {
        chunks.push(current);
        current = '';
      }
      const [head, rest] = sliceUtf8(piece, limit);
      chunks.push(head);
      piece = rest;
    }
    if (piece === '') return;
    const candidate = current + piece;
    if (current !== '' && Buffer.byteLength(candidate, 'utf8') > limit) {
      chunks.push(current);
      current = piece;
    } else {
      current = candidate;
    }
  });
  if (current !== '') chunks.push(current);
  return chunks;
}

/**
 * Splits a prompt into ZCode attachment files, each headered `[Teil k von n]`
 * so the model reads them in order and knows when it has seen the whole
 * task. This is what lets an arbitrarily large council package reach the
 * model at all: ZCode only shows a SINGLE attachment up to ~64 KB, and a
 * 114 KB prompt split into 3 parts of ~40 KB was read completely (verified
 * live, 27.09.2026) — grok hits a comparable wall around 24 KB with no
 * equivalent way around it, which is the whole reason --verbatim exists over
 * there instead of a chunking scheme here.
 */
export function chunkPromptForZcode(prompt, { attachmentMaxBytes = GLM_ATTACHMENT_MAX_BYTES } = {}) {
  const bodyLimit = attachmentMaxBytes - GLM_CHUNK_HEADER_RESERVE_BYTES;
  if (bodyLimit <= 0) throw new Error('attachmentMaxBytes is too small to hold a chunk header');
  const bodies = packLines(prompt, bodyLimit);
  const parts = bodies.length ? bodies : [''];
  const n = parts.length;
  return parts.map((body, idx) => `[Teil ${idx + 1} von ${n}]\n${body}`);
}

/**
 * The -p instruction: short on purpose, because the actual task lives in the
 * attachments. States the schema literally rather than trusting the model to
 * remember it from training — the dispatcher acts on `status`, so an answer
 * that drifts from {status, message} is a protocol error (see driver.mjs).
 */
export function buildGlmInstruction(schema = PEER_OUTPUT_SCHEMA, partCount = 1) {
  return (
    `Die angehängten Dateien "Teil 1 von ${partCount}" bis "Teil ${partCount} von ${partCount}" ` +
    'sind zusammen die vollständige Aufgabe. Lies sie in dieser Reihenfolge, benutze keine Tools ' +
    'und starte keinen eigenen Planungs- oder Recherche-Workflow. Antworte NUR mit einem einzigen ' +
    `JSON-Objekt, das exakt diesem Schema entspricht: ${JSON.stringify(schema)} ` +
    '— kein Fließtext davor oder danach, keine Code-Fences.'
  );
}

/**
 * The argv for one turn, minus the binary. Exported so a test can assert the
 * contract rather than trusting a comment.
 */
export function buildGlmArgs({ instruction, attachmentPaths = [], cwd, mode = 'plan', disallowedTools = GLM_DISALLOWED_TOOLS } = {}) {
  const args = ['-p', instruction];
  for (const attachmentPath of attachmentPaths) args.push('--attach', attachmentPath);
  args.push('--mode', mode, '--json', '--disallowed-tools', disallowedTools);
  if (cwd) args.push('--cwd', cwd);
  return args;
}

/** A fenced ```json block around the answer, stripped if present — verified live: the model wraps `response` in one despite the schema being spelled out in the instruction. */
function stripJsonFences(text) {
  const trimmed = text.trim();
  const match = trimmed.match(/^```(?:json)?\s*\n?([\s\S]*?)\n?```$/);
  return match ? match[1].trim() : trimmed;
}

/**
 * Pulls the answer out of what the CLI printed.
 *
 * ZCode's `--json` stdout is a JSON envelope, sometimes preceded by plain log
 * lines that are not part of it ("ZCode Built-in skipped (not-due)") — so the
 * envelope is read from the FIRST '{' onward, not from byte 0. Its `response`
 * field is the model's answer as a STRING, and both parses can fail on their
 * own for different reasons, same as parseGrokStdout(): no '{' at all (or an
 * unparseable envelope) means the CLI failed before the model ran, while a
 * `response` that is not the expected shape means the model ignored the
 * instruction.
 */
export function parseGlmStdout(stdout, { validate = true } = {}) {
  const text = typeof stdout === 'string' ? stdout : '';
  const braceAt = text.indexOf('{');
  const head = () => text.slice(0, 400).trim() || '(empty)';
  if (braceAt === -1) throw new Error(`glm did not print JSON; first bytes: ${head()}`);
  let envelope;
  try {
    envelope = JSON.parse(text.slice(braceAt));
  } catch (err) {
    throw new Error(`glm did not print JSON (${err.message}); first bytes: ${head()}`);
  }
  const responseText = typeof envelope?.response === 'string' ? envelope.response : JSON.stringify(envelope?.response ?? envelope ?? {});
  const stripped = stripJsonFences(responseText);
  // A relay turn must answer in the relay's own {status, message} shape; a
  // COUNCIL turn (src/council/ask.mjs) answers in a different shape entirely
  // and validates it itself — see grok.mjs's parseGrokStdout for the same
  // split and why.
  const answer = validate ? parsePeerAnswer(stripped) : { status: 'done', message: stripped };
  return {
    ...answer,
    usage: envelope?.usage ?? null,
    // ZCode never prints a cost figure at all (a subscription CLI billing a
    // plan, not a turn — see driver.mjs's PEER_COST_ESTIMATED): null, never
    // a guessed number, and never the 0 that would read as "this was free".
    costUsd: null,
  };
}

/** Kills a child and, on Windows, the process tree under it — same reasoning as grok.mjs::killTree() and claude-code.mjs::killChildTree(). */
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
 * Runs one GLM turn.
 *
 * Never rejects for a turn-level failure — same contract as runGrokTurn() —
 * but must never hang: a timeout kills the tree, and stdout past the cap
 * ends the turn instead of growing until the process runs out of memory.
 */
export async function runGlmTurn({ cwd, prompt, timeoutMs = PEER_TIMEOUT_MS, signal, logDir = null, spawnFn = spawn, env = process.env, schema = PEER_OUTPUT_SCHEMA, validate = true } = {}) {
  if (typeof prompt !== 'string' || prompt.trim().length === 0) throw new Error('a peer turn needs a prompt');
  const promptBytes = Buffer.byteLength(prompt, 'utf8');
  if (promptBytes > GLM_MAX_PROMPT_BYTES) {
    throw new Error(`the prompt is ${promptBytes} bytes; keep it under ${GLM_MAX_PROMPT_BYTES} bytes (GLM_MAX_PROMPT_BYTES)`);
  }

  const { command, argsPrefix, entryPath } = resolveZcodeCli(env);
  const providerConfigPath = providerConfigPathFor(entryPath);
  // Pass the caller's env through, plus this one addition — never overwritten
  // when it is already set, so a deliberate override still wins. Without it
  // the CLI aborts before the model ever runs (see the module header).
  const childEnv = { ...env };
  if (!childEnv.ZCODE_BUILTIN_PROVIDER_CONFIG_FILE) childEnv.ZCODE_BUILTIN_PROVIDER_CONFIG_FILE = providerConfigPath;

  const startedAt = Date.now();
  const scratchDir = logDir ?? fs.mkdtempSync(path.join(os.tmpdir(), 'kaprek-peer-'));
  fs.mkdirSync(scratchDir, { recursive: true });
  const stamp = `${startedAt}-${process.pid}`;
  const parts = chunkPromptForZcode(prompt);
  const attachmentPaths = parts.map((part, idx) => {
    const partPath = path.join(scratchDir, `glm-prompt-${stamp}-${idx + 1}.txt`);
    fs.writeFileSync(partPath, part, 'utf8');
    return partPath;
  });
  const rawLogPath = path.join(scratchDir, `glm-raw-${stamp}.log`);

  const instruction = buildGlmInstruction(schema, parts.length);
  const args = [...argsPrefix, ...buildGlmArgs({ instruction, attachmentPaths, cwd })];

  const result = await new Promise((resolve) => {
    const child = spawnFn(command, args, {
      cwd: cwd ?? process.cwd(),
      env: childEnv,
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
      finish({ error: `glm did not answer within ${timeoutMs}ms`, stdout, stderr });
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
        finish({ error: `glm printed more than ${PEER_MAX_STDOUT_BYTES} bytes`, stdout, stderr });
      }
    });
    child.stderr?.on('data', (chunk) => {
      stderr += chunk;
      if (Buffer.byteLength(stderr, 'utf8') > PEER_MAX_STDOUT_BYTES) stderr = stderr.slice(-4096);
    });

    child.on('error', (err) => finish({ error: `could not start glm: ${err.message}`, stdout, stderr }));
    child.on('close', (code) => {
      if (code === 0) finish({ stdout, stderr });
      else finish({ error: `glm exited with code ${code}${stderr ? `: ${stderr.slice(-400).trim()}` : ''}`, stdout, stderr });
    });
  });

  try {
    fs.writeFileSync(rawLogPath, `--- stdout ---\n${result.stdout ?? ''}\n--- stderr ---\n${result.stderr ?? ''}\n`, 'utf8');
  } catch {
    // The log is a convenience; losing it must not lose the turn.
  }
  for (const partPath of attachmentPaths) {
    try {
      fs.unlinkSync(partPath);
    } catch {
      // best-effort
    }
  }

  if (result.error) {
    const err = new Error(result.error);
    err.rawLogPath = rawLogPath;
    throw err;
  }

  const parsed = parseGlmStdout(result.stdout, { validate });
  return { ...parsed, durationMs: Date.now() - startedAt, rawLogPath };
}

export const glmDriver = registerPeerDriver({
  id: 'glm',
  available(env = process.env) {
    // File existence, never a spawn — a settings page deciding what to offer
    // must not start processes (same rule grok.mjs's available() follows).
    const { entryPath } = resolveZcodeCli(env);
    return fs.existsSync(entryPath);
  },
  runTurn: runGlmTurn,
  maxPromptBytes: GLM_MAX_PROMPT_BYTES,
});
