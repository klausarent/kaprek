// The Codex harness: implements the adapter contract (src/harness/adapter.mjs)
// on top of `codex app-server` — JSON-RPC over stdio, one message per line.
//
// Protocol verified live against codex-cli 0.144.4 (01.08.2026); the recorded
// facts and the full mapping table live in
// ccview-docs/plans/2026-08-01-m1-codex-harness.md. The shape in one breath:
// client sends `initialize`, the `initialized` notification, then
// `thread/start` (or `thread/resume` with a known threadId — Codex persists
// threads on disk, which is what makes resume survive a process boundary),
// then `turn/start`. The server streams notifications (`item/*`, `turn/*`,
// `thread/tokenUsage/updated`) and may send its own REQUESTS back
// (approvals) that block the turn until answered. `turn/completed` ends the
// turn; the harness then ends the child — one turn, one process, exactly the
// lifetime semantics claude-code.mjs has with `claude -p`.
//
// Like every harness: never rejects for turn-level failures; everything is
// reported through the resolved TurnResult.
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';

/**
 * kaprek's permissionMode → Codex {approvalPolicy, sandbox}.
 *
 * `default` maps to the strictest useful row: the sandbox blocks every write,
 * so each write attempt surfaces as an approval request (verified live: a
 * file create under read-only produced item/fileChange/requestApproval), and
 * read-only commands run freely — parity with the Claude harness's stance of
 * "reads run, writes ask". Unknown modes take the strict row too: guessing
 * open is how a new mode name would silently skip the human.
 */
export function mapPermissionMode(mode) {
  if (mode === 'acceptEdits') return { approvalPolicy: 'on-request', sandbox: 'workspace-write' };
  return { approvalPolicy: 'untrusted', sandbox: 'read-only' };
}

/** Grace given to the child to exit after we end stdin post-completion. */
const DEFAULT_KILL_GRACE_MS = 3000;

export async function startTurn({
  cwd,
  prompt,
  sessionId,
  permissionMode,
  onEvent = () => {},
  onApprovalRequest,
  signal,
  spawnFn = spawn,
  killGraceMs = DEFAULT_KILL_GRACE_MS,
} = {}) {
  const warnings = [];
  const safeEmit = (event) => {
    try {
      onEvent(event);
    } catch (err) {
      warnings.push(err?.message ?? String(err));
    }
  };

  const child = spawnFn('codex', ['app-server'], {
    cwd,
    shell: process.platform === 'win32',
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  return new Promise((resolve) => {
    let nextId = 1;
    const pending = new Map(); // request id -> {resolve, reject}
    let threadId = sessionId ?? null;
    let lastUsage = null;
    let settled = false;
    let stderrTail = '';

    // Items currently in flight, by item id. An approval request names only
    // its itemId; the human-readable payload (the command, the diff) arrived
    // on the item/started notification — this cache is what joins the two.
    const itemCache = new Map();
    const outputBuffers = new Map();

    const write = (msg) => {
      try {
        child.stdin.write(`${JSON.stringify(msg)}\n`);
      } catch {
        // stdin already gone — the close handler will settle the turn.
      }
    };
    const request = (method, params) =>
      new Promise((resolveRequest, rejectRequest) => {
        const id = nextId++;
        pending.set(id, { resolve: resolveRequest, reject: rejectRequest });
        write({ jsonrpc: '2.0', id, method, params });
      });
    const notify = (method, params) => write({ jsonrpc: '2.0', method, params });

    const endChild = () => {
      try {
        child.stdin.end();
      } catch {
        // already ended
      }
      const graceTimer = setTimeout(() => {
        try {
          child.kill();
        } catch {
          // already gone
        }
      }, killGraceMs);
      graceTimer.unref?.();
      try {
        child.kill();
      } catch {
        // already gone
      }
    };

    const settle = (result) => {
      if (settled) return;
      settled = true;
      for (const entry of pending.values()) entry.reject(new Error('turn ended'));
      pending.clear();
      endChild();
      resolve({
        sessionId: threadId,
        costUsd: null,
        usage: lastUsage,
        error: null,
        ...(warnings.length ? { warnings } : {}),
        ...result,
      });
    };

    const toolInputFor = (item) => {
      if (item.type === 'commandExecution') return { command: item.command ?? null, cwd: item.cwd ?? null };
      if (item.type === 'fileChange') return { changes: item.changes ?? [] };
      if (item.type === 'mcpToolCall') return { tool: item.tool ?? item.name ?? null, args: item.args ?? null };
      return {};
    };

    const onNotification = (msg) => {
      const { method, params = {} } = msg;
      if (method === 'item/agentMessage/delta') {
        if (params.delta) safeEmit({ type: 'text', text: params.delta });
        return;
      }
      if (method === 'item/reasoning/summaryTextDelta' || method === 'item/reasoning/textDelta') {
        if (params.delta) safeEmit({ type: 'thinking', text: params.delta });
        return;
      }
      if (method === 'item/started') {
        const item = params.item ?? {};
        if (item.type === 'commandExecution' || item.type === 'fileChange' || item.type === 'mcpToolCall') {
          itemCache.set(item.id, item);
          outputBuffers.set(item.id, '');
          safeEmit({ type: 'tool-start', id: item.id, name: item.type, input: toolInputFor(item) });
        }
        return;
      }
      if (method === 'item/commandExecution/outputDelta') {
        if (outputBuffers.has(params.itemId)) {
          outputBuffers.set(params.itemId, outputBuffers.get(params.itemId) + (params.delta ?? ''));
        }
        return;
      }
      if (method === 'item/completed') {
        const item = params.item ?? {};
        if (itemCache.has(item.id)) {
          const output = outputBuffers.get(item.id) ?? '';
          const result = item.type === 'fileChange' ? JSON.stringify(item.changes ?? []) : output;
          safeEmit({ type: 'tool-end', id: item.id, result, isError: item.status !== 'completed' });
          itemCache.delete(item.id);
          outputBuffers.delete(item.id);
        }
        // agentMessage/reasoning completions carry text that already streamed
        // as deltas — emitting them again would double every message.
        return;
      }
      if (method === 'thread/tokenUsage/updated') {
        const total = params.tokenUsage?.total ?? null;
        if (total) {
          lastUsage = {
            input_tokens: total.inputTokens ?? null,
            cached_input_tokens: total.cachedInputTokens ?? null,
            output_tokens: total.outputTokens ?? null,
            reasoning_output_tokens: total.reasoningOutputTokens ?? null,
            total_tokens: total.totalTokens ?? null,
            model_context_window: params.tokenUsage?.modelContextWindow ?? null,
          };
        }
        return;
      }
      if (method === 'account/rateLimits/updated') {
        safeEmit({ type: 'rate-limit', info: params.rateLimits ?? params });
        return;
      }
      if (method === 'error') {
        safeEmit({ type: 'error', message: params.message ?? 'codex reported an error' });
        return;
      }
      if (method === 'turn/completed') {
        const turn = params.turn ?? {};
        const isError = turn.status === 'failed' || Boolean(turn.error);
        safeEmit({ type: 'result', sessionId: threadId, costUsd: null, usage: lastUsage, isError });
        settle({ stopReason: 'result' });
      }
      // Everything else (mcpServer/*, thread/status, warnings, fuzzy search,
      // login noise) is deliberately ignored: unknown notification types must
      // never break a turn (adapter contract).
    };

    // A server->client REQUEST blocks the turn until answered. Task 2 wires
    // the approval bridge; the standing rule is fail-closed: anything not
    // explicitly handled is declined immediately rather than left hanging.
    const onServerRequest = (msg) => {
      warnings.push(`unhandled codex server request declined: ${msg.method}`);
      write({ jsonrpc: '2.0', id: msg.id, result: { decision: 'decline' } });
    };

    const rl = createInterface({ input: child.stdout });
    rl.on('line', (line) => {
      if (!line.trim() || settled) return;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        return;
      }
      if (msg.id !== undefined && msg.method) {
        onServerRequest(msg);
        return;
      }
      if (msg.id !== undefined) {
        const entry = pending.get(msg.id);
        if (!entry) return;
        pending.delete(msg.id);
        if (msg.error) entry.reject(new Error(msg.error.message ?? JSON.stringify(msg.error)));
        else entry.resolve(msg.result);
        return;
      }
      if (msg.method) onNotification(msg);
    });

    const rlErr = createInterface({ input: child.stderr });
    rlErr.on('line', (line) => {
      stderrTail = `${stderrTail}\n${line}`.slice(-2000);
    });

    child.on('error', (err) => {
      settle({ stopReason: 'error', error: { message: `could not start codex: ${err.message}` } });
    });
    child.on('close', (code) => {
      if (settled) return;
      settle({
        stopReason: 'error',
        error: { message: `codex exited with code ${code} before the turn completed${stderrTail ? `: ${stderrTail.trim().slice(-400)}` : ''}` },
      });
    });

    const abort = () => settle({ stopReason: 'aborted' });
    signal?.addEventListener?.('abort', abort, { once: true });

    (async () => {
      try {
        await request('initialize', {
          clientInfo: { name: 'kaprek', version: '0.0.0' },
          capabilities: { experimentalApi: true },
        });
        notify('initialized', {});
        const { approvalPolicy, sandbox } = mapPermissionMode(permissionMode);
        let thread;
        if (sessionId) {
          thread = await request('thread/resume', { threadId: sessionId, cwd, approvalPolicy, sandbox });
          threadId = thread?.thread?.id ?? sessionId;
        } else {
          thread = await request('thread/start', { cwd, approvalPolicy, sandbox, ephemeral: false });
          threadId = thread?.thread?.id ?? null;
        }
        safeEmit({ type: 'init', sessionId: threadId, tools: [], model: null, permissionMode: permissionMode ?? 'default' });
        await request('turn/start', { threadId, input: [{ type: 'text', text: prompt }] });
        // From here the notifications drive the turn to turn/completed.
      } catch (err) {
        if (!settled) settle({ stopReason: 'error', error: { message: err.message } });
      }
    })();
  });
}
