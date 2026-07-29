// claude-code.mjs — harness for the Claude Code CLI. Spawns the locally
// installed `claude` binary and speaks newline-delimited JSON over stdio
// (--input-format/--output-format stream-json). No provider API call is
// made here; authentication, billing, and model selection all live inside
// the CLI. See adapter.mjs for the startTurn() contract this implements.
import { spawn as nodeSpawn, execFile as nodeExecFile } from 'node:child_process';
import readline from 'node:readline';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Locates the Claude Code CLI and decides whether a shell is required.
 *
 * Installations differ: the native installer places a real `claude.exe` in
 * `~/.local/bin`, while an npm install leaves a `claude.cmd` shim. Only the
 * shim needs a shell; spawning an .exe through a shell fails in environments
 * where COMSPEC is not resolvable. `KAPREK_CLAUDE_PATH` overrides detection.
 *
 * @returns {{command: string, useShell: boolean}}
 */
export function resolveCli(env = process.env) {
  const override = env.KAPREK_CLAUDE_PATH;
  if (override) {
    return { command: override, useShell: /\.(cmd|bat)$/i.test(override) };
  }

  if (process.platform !== 'win32') return { command: 'claude', useShell: false };

  // Walk PATH for a native executable first, shim second.
  const dirs = (env.PATH ?? '').split(path.delimiter).filter(Boolean);
  const candidates = ['claude.exe', 'claude.cmd', 'claude.bat'];
  for (const dir of dirs) {
    for (const name of candidates) {
      const full = path.join(dir, name);
      try {
        if (fs.existsSync(full)) {
          return { command: full, useShell: /\.(cmd|bat)$/i.test(name) };
        }
      } catch {
        // unreadable PATH entry — keep looking
      }
    }
  }
  // Nothing found: let spawn fail with ENOENT and report it as an error event.
  return { command: 'claude', useShell: false };
}

const MAX_STDERR_LEN = 8192;

// A single stream-json line larger than this is refused (never JSON.parse'd,
// never buffered into an event) — a hung/misbehaving CLI must not be able to
// grow this process's memory unbounded by writing one giant line. Counted in
// TurnResult.droppedLines rather than silently discarded.
const MAX_LINE_BYTES = 8 * 1024 * 1024;

// Default turn timeout: a hung CLI must not hold an SSE request (and this
// turn's chat) open forever. Overridable per call for tests/tuning.
const DEFAULT_TIMEOUT_MS = 300_000;

// Grace period between requesting a kill (abort or timeout) and giving up on
// waiting for the child's 'close' event. A child that ignores its kill signal
// must not keep this promise pending forever — after this window we resolve
// anyway and mark the process as orphaned rather than block the caller.
const DEFAULT_KILL_GRACE_MS = 3000;

/**
 * Best-effort kill of `child` and (on the platforms where a single kill()
 * cannot reach it) its descendants. `child.kill()` (SIGTERM, mapped to
 * TerminateProcess on Windows) only ever terminates the immediate process —
 * if the CLI itself shells out to Bash/etc., those grandchildren survive a
 * plain kill() and keep running detached. `detached` stays false (see
 * startTurn()'s spawn call), so there is no process-group leader to signal
 * as a whole; the two platform-specific fallbacks below are how we still
 * reach the tree:
 *   - Windows: `taskkill /T /F` walks the process tree by PID.
 *   - POSIX: `process.kill(-pid)` targets the process GROUP id. Without
 *     `detached: true` the child was never made its own group leader, so
 *     this call is expected to fail (ESRCH) in the common case — it is kept
 *     as a harmless best-effort extra, not the primary kill path.
 * Errors from either fallback are swallowed: this function's whole purpose
 * is "try harder", never to throw into the caller.
 */
function killChildTree(child) {
  try {
    child.kill();
  } catch {
    // already exited — nothing to kill
  }
  if (!child.pid) return;
  if (process.platform === 'win32') {
    try {
      nodeExecFile('taskkill', ['/PID', String(child.pid), '/T', '/F'], () => {
        // best-effort — a failed taskkill (already gone, access denied, ...)
        // must not surface anywhere; killChildTree() has no return value.
      });
    } catch {
      // execFile itself throwing synchronously is not expected, but guard anyway
    }
  } else {
    try {
      process.kill(-child.pid);
    } catch {
      // no process group under this pid (detached:false), or already gone
    }
  }
}

/** Extracts readable text from a tool_result content field (string or block array); mirrors src/parser/parse.mjs::toolResultText. */
function toolResultText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map((block) => (typeof block === 'string' ? block : (block?.text ?? ''))).join('\n');
  }
  return '';
}

/**
 * Maps one parsed stream-json line to zero or more normalized events (see
 * adapter.mjs::NormalizedEvent). Unknown types/subtypes (system/hook_started,
 * system/hook_response, compact_boundary, ...) map to [] on purpose —
 * kaprek only surfaces the events the contract defines.
 */
function mapLine(obj) {
  if (obj.type === 'system' && obj.subtype === 'init') {
    return [
      {
        type: 'init',
        sessionId: obj.session_id ?? null,
        tools: obj.tools ?? [],
        model: obj.model ?? null,
        permissionMode: obj.permissionMode ?? null,
      },
    ];
  }

  if (obj.type === 'assistant' && obj.message) {
    const events = [];
    for (const block of obj.message.content ?? []) {
      if (block.type === 'text') {
        events.push({ type: 'text', text: block.text ?? '' });
      } else if (block.type === 'thinking') {
        events.push({ type: 'thinking', text: block.thinking ?? '' });
      } else if (block.type === 'tool_use') {
        events.push({ type: 'tool-start', id: block.id, name: block.name, input: block.input ?? {} });
      }
    }
    return events;
  }

  if (obj.type === 'user' && obj.message) {
    const content = obj.message.content;
    // A single stream-json user line can carry SEVERAL tool_result blocks
    // (parallel tool calls answered together) — emit one tool-end each.
    const resultBlocks = Array.isArray(content) ? content.filter((b) => b?.type === 'tool_result') : [];
    return resultBlocks.map((block) => ({
      type: 'tool-end',
      id: block.tool_use_id,
      result: toolResultText(block.content),
      isError: !!block.is_error,
    }));
  }

  if (obj.type === 'rate_limit_event') {
    return [{ type: 'rate-limit', info: obj.rate_limit_info ?? null }];
  }

  if (obj.type === 'result') {
    return [
      {
        type: 'result',
        sessionId: obj.session_id ?? null,
        costUsd: obj.total_cost_usd ?? null,
        usage: obj.usage ?? null,
        isError: !!obj.is_error,
        // Carried through only so a failing turn's finishError() message
        // (see startTurn()'s 'close' handler) can say WHY the CLI failed
        // instead of a generic "claude reported an error result" — not part
        // of adapter.mjs's documented 'result' event fields, both are simply
        // forwarded verbatim like any other extra key on a normalized event.
        subtype: obj.subtype ?? null,
        resultText: typeof obj.result === 'string' ? obj.result : null,
      },
    ];
  }

  return [];
}

/** Builds the claude CLI argv (without the command name itself) for one turn. */
function buildArgs({ sessionId, mcpConfigPath, permissionMode, allowedTools }) {
  const args = ['-p', '--output-format', 'stream-json', '--input-format', 'stream-json', '--verbose'];
  if (sessionId) args.push('--resume', sessionId);
  if (mcpConfigPath) args.push('--mcp-config', mcpConfigPath);
  if (permissionMode) args.push('--permission-mode', permissionMode);
  if (allowedTools && allowedTools.length > 0) args.push('--allowedTools', allowedTools.join(','));
  return args;
}

/**
 * Starts one turn against the Claude Code CLI. See adapter.mjs for the full
 * StartTurnOptions/TurnResult contract. `spawnFn` is injectable (default:
 * node:child_process spawn) so tests can launch a harmless stand-in process
 * instead of the real `claude` binary — no test in this repo ever calls the
 * real CLI.
 * @param {import('./adapter.mjs').StartTurnOptions & {spawnFn?: Function, timeoutMs?: number, killGraceMs?: number}} options
 * @returns {Promise<import('./adapter.mjs').TurnResult>}
 */
export async function startTurn({
  cwd,
  prompt,
  sessionId,
  mcpConfigPath,
  permissionMode,
  allowedTools,
  onEvent,
  signal,
  spawnFn = nodeSpawn,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  killGraceMs = DEFAULT_KILL_GRACE_MS,
} = {}) {
  if (signal?.aborted) {
    return { sessionId: sessionId ?? null, costUsd: null, usage: null, stopReason: 'aborted', error: null, droppedLines: 0, warnings: [] };
  }

  const args = buildArgs({ sessionId, mcpConfigPath, permissionMode, allowedTools });

  const { command, useShell } = resolveCli();

  let child;
  try {
    child = spawnFn(command, args, {
      cwd,
      // shell is only needed for .cmd/.bat shims (npm-style installs). A native
      // executable is spawned directly — using a shell there breaks in
      // environments where COMSPEC cannot be resolved (e.g. some MSYS shells).
      shell: useShell,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  } catch (err) {
    onEvent?.({ type: 'error', message: err.message });
    return {
      sessionId: sessionId ?? null,
      costUsd: null,
      usage: null,
      stopReason: 'error',
      error: { message: err.message },
      droppedLines: 0,
      warnings: [],
    };
  }

  return new Promise((resolve) => {
    let resolved = false;
    let latestSessionId = sessionId ?? null;
    let costUsd = null;
    let usage = null;
    let sawResult = false;
    let resultIsError = false;
    let resultSubtype = null;
    let resultText = null;
    let stderrBuf = '';
    let droppedLines = 0;
    const onEventErrors = [];
    // Set to 'aborted' or 'timeout' once a kill has been requested for that
    // reason — both the 'close' handler and the kill-grace give-up timer
    // (killGiveUpTimer below) consult this to agree on the same stopReason.
    let killReason = null;
    let killGiveUpTimer = null;
    let timeoutTimer = null;

    // Every onEvent() call goes through here: a throwing consumer must never
    // take down this harness (let alone the whole server process) — the
    // error is recorded and surfaced via TurnResult.warnings instead, the
    // turn itself keeps running exactly as if the callback had succeeded.
    const safeEmit = (event) => {
      try {
        onEvent?.(event);
      } catch (err) {
        onEventErrors.push(err?.message ?? String(err));
      }
    };

    const finish = (result) => {
      if (resolved) return;
      resolved = true;
      if (killGiveUpTimer) clearTimeout(killGiveUpTimer);
      if (timeoutTimer) clearTimeout(timeoutTimer);
      if (signal) signal.removeEventListener('abort', onAbort);
      resolve({ droppedLines, warnings: onEventErrors, ...result });
    };

    const finishError = (message) => {
      safeEmit({ type: 'error', message });
      finish({ sessionId: latestSessionId, costUsd, usage, stopReason: 'error', error: { message } });
    };

    // Requests a kill for `reason` ('aborted' | 'timeout'), tries to reach
    // the whole process tree (see killChildTree()), and gives up waiting for
    // the child's own 'close' event after killGraceMs — at that point the
    // turn resolves anyway (marked orphaned) instead of leaving the caller
    // hanging on a child that refuses to die.
    const requestKill = (reason) => {
      if (resolved || killReason) return;
      killReason = reason;
      killChildTree(child);
      killGiveUpTimer = setTimeout(() => {
        finish({ sessionId: latestSessionId, costUsd, usage, stopReason: reason, error: null, orphaned: true });
      }, killGraceMs);
    };

    const onAbort = () => requestKill('aborted');
    if (signal) signal.addEventListener('abort', onAbort);

    if (Number.isFinite(timeoutMs) && timeoutMs > 0) {
      timeoutTimer = setTimeout(() => requestKill('timeout'), timeoutMs);
    }

    child.on('error', (err) => {
      finishError(err.message);
    });

    // EPIPE and friends land here when the CLI exits before/while stdin is
    // being written to below — without this handler an 'error' event with no
    // listener crashes the whole Node process (this server), not just the
    // turn. Guarded with typeof (not just `?.`) since some tests stub stdin
    // as a plain {write, end} object with no .on at all.
    if (typeof child.stdin?.on === 'function') {
      child.stdin.on('error', () => {
        // 'close' (or child.on('error') above) is what actually resolves the
        // turn; this handler exists purely to prevent an unhandled EPIPE.
      });
    }

    child.stderr?.on('data', (chunk) => {
      if (stderrBuf.length < MAX_STDERR_LEN) {
        stderrBuf = (stderrBuf + chunk.toString('utf8')).slice(0, MAX_STDERR_LEN);
      }
    });

    const rl = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
    rl.on('line', (rawLine) => {
      if (resolved) return;
      // Checked BEFORE JSON.parse, on the raw line — a hung/misbehaving CLI
      // must not be able to grow this process's memory via one giant line.
      if (Buffer.byteLength(rawLine, 'utf8') > MAX_LINE_BYTES) {
        droppedLines += 1;
        return;
      }
      const line = rawLine.trim();
      if (!line) return;
      let obj;
      try {
        obj = JSON.parse(line);
      } catch {
        return; // malformed/half-written line: skip, keep going
      }
      for (const event of mapLine(obj)) {
        if (event.type === 'init' && event.sessionId) latestSessionId = event.sessionId;
        if (event.type === 'result') {
          sawResult = true;
          resultIsError = !!event.isError;
          resultSubtype = event.subtype ?? null;
          resultText = event.resultText ?? null;
          if (event.sessionId) latestSessionId = event.sessionId;
          costUsd = event.costUsd;
          usage = event.usage;
        }
        safeEmit(event);
      }
    });

    child.on('close', (code) => {
      rl.close();
      if (killReason) {
        finish({ sessionId: latestSessionId, costUsd, usage, stopReason: killReason, error: null });
        return;
      }
      if (sawResult) {
        const detail = [resultSubtype, resultText].filter(Boolean).join(': ');
        finish({
          sessionId: latestSessionId,
          costUsd,
          usage,
          stopReason: resultIsError ? 'error' : 'result',
          error: resultIsError ? { message: `claude reported an error result${detail ? ` (${detail})` : ''}` } : null,
        });
        return;
      }
      const detail = stderrBuf.trim();
      finishError(
        code === 0
          ? 'claude exited without emitting a result event'
          : `claude exited with code ${code}${detail ? `: ${detail}` : ''}`,
      );
    });

    try {
      child.stdin?.write(`${JSON.stringify({ type: 'user', message: { role: 'user', content: prompt } })}\n`);
      child.stdin?.end();
    } catch {
      // stdin already closed/errored (e.g. the CLI exited immediately) — the
      // 'error'/'close' handlers above take it from here.
    }
  });
}
