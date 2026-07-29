// claude-code.mjs — harness for the Claude Code CLI. Spawns the locally
// installed `claude` binary and speaks newline-delimited JSON over stdio
// (--input-format/--output-format stream-json). No provider API call is
// made here; authentication, billing, and model selection all live inside
// the CLI. See adapter.mjs for the startTurn() contract this implements.
import { spawn as nodeSpawn } from 'node:child_process';
import readline from 'node:readline';

const MAX_STDERR_LEN = 8192;

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
 * @param {import('./adapter.mjs').StartTurnOptions & {spawnFn?: Function}} options
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
} = {}) {
  if (signal?.aborted) {
    return { sessionId: sessionId ?? null, costUsd: null, usage: null, stopReason: 'aborted', error: null };
  }

  const args = buildArgs({ sessionId, mcpConfigPath, permissionMode, allowedTools });

  let child;
  try {
    child = spawnFn('claude', args, {
      cwd,
      // The npm-installed `claude` is a .cmd shim on Windows; spawn() only
      // resolves those through a shell. Still a single argv-array process,
      // not exec() — shell:true here just affects PATH lookup, not how the
      // command is composed.
      shell: process.platform === 'win32',
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
    };
  }

  return new Promise((resolve) => {
    let resolved = false;
    let latestSessionId = sessionId ?? null;
    let costUsd = null;
    let usage = null;
    let sawResult = false;
    let resultIsError = false;
    let stderrBuf = '';
    let aborted = false;
    let graceTimer = null;

    const finish = (result) => {
      if (resolved) return;
      resolved = true;
      if (graceTimer) clearTimeout(graceTimer);
      if (signal) signal.removeEventListener('abort', onAbort);
      resolve(result);
    };

    const finishError = (message) => {
      onEvent?.({ type: 'error', message });
      finish({ sessionId: latestSessionId, costUsd, usage, stopReason: 'error', error: { message } });
    };

    const onAbort = () => {
      aborted = true;
      child.kill();
      // Best-effort grace period, then a second kill() attempt. On Windows
      // there is no real SIGTERM/SIGKILL distinction — libuv maps both to
      // TerminateProcess — so this second call rarely does more than the
      // first. It is not a hard guarantee against a child that has already
      // gone unresponsive; we deliberately do NOT shell out to taskkill to
      // work around that, per the sandboxed-subprocess constraint.
      graceTimer = setTimeout(() => {
        try {
          child.kill('SIGKILL');
        } catch {
          // process already gone
        }
      }, 3000);
    };
    if (signal) signal.addEventListener('abort', onAbort);

    child.on('error', (err) => {
      finishError(err.message);
    });

    child.stderr?.on('data', (chunk) => {
      if (stderrBuf.length < MAX_STDERR_LEN) {
        stderrBuf = (stderrBuf + chunk.toString('utf8')).slice(0, MAX_STDERR_LEN);
      }
    });

    const rl = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
    rl.on('line', (rawLine) => {
      if (resolved) return;
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
          if (event.sessionId) latestSessionId = event.sessionId;
          costUsd = event.costUsd;
          usage = event.usage;
        }
        onEvent?.(event);
      }
    });

    child.on('close', (code) => {
      rl.close();
      if (aborted) {
        finish({ sessionId: latestSessionId, costUsd, usage, stopReason: 'aborted', error: null });
        return;
      }
      if (sawResult) {
        finish({
          sessionId: latestSessionId,
          costUsd,
          usage,
          stopReason: resultIsError ? 'error' : 'result',
          error: resultIsError ? { message: 'claude reported an error result' } : null,
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

    child.stdin?.write(`${JSON.stringify({ type: 'user', message: { role: 'user', content: prompt } })}\n`);
    child.stdin?.end();
  });
}
