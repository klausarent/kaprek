// claude-code.mjs — harness for the Claude Code CLI. Spawns the locally
// installed `claude` binary and speaks newline-delimited JSON over stdio
// (--input-format/--output-format stream-json). No provider API call is
// made here; authentication, billing, and model selection all live inside
// the CLI. See adapter.mjs for the startTurn() contract this implements.
import { spawn as nodeSpawn, execFile as nodeExecFile } from 'node:child_process';
import readline from 'node:readline';
import fs from 'node:fs';
import path from 'node:path';
import { KNOWN_READONLY_TOOLS } from './settings.mjs';
import { createTurnClocks, IDLE_MS, TOOL_LEASE_MS, ACTIVE_TOTAL_MS, ABSOLUTE_MS } from './timeout.mjs';

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

// Turn-timeout model (task-2): a hung CLI must not hold an SSE request (and
// this turn's chat) open forever, but a SINGLE overall budget (the old
// DEFAULT_TIMEOUT_MS, 300_000ms) was wrong in both directions at once — it
// killed a legitimate six-minute run, while a pure idle timeout in its place
// would kill a 20-minute `Bash` build that emits no stream-json lines while
// it runs. See timeout.mjs's own doc comment for the full four-clock model
// (idle / tool-lease / active-total / absolute) this now delegates to; the
// four options below are only where each budget's default lives and how a
// caller can override one.
//
// IMPORTANT, and the opposite of what this same comment said before
// task-2: NONE of the four clocks — including ABSOLUTE_MS below — is a raw,
// never-paused wall clock anymore. All four exclude time spent waiting on a
// human approval decision (see timeout.mjs's createTurnClocks() doc comment
// on why: task-3's overnight approval inbox would be impossible otherwise).
// What still bounds an approval that never gets answered is the CALLER's
// own approval timeout (src/server/server.mjs's DEFAULT_APPROVAL_TIMEOUT_MS,
// which resolves onApprovalRequest with an auto-deny — see
// makeApprovalHandler()), not a clock in this file or in timeout.mjs.
const DEFAULT_IDLE_MS = IDLE_MS;
const DEFAULT_TOOL_LEASE_MS = TOOL_LEASE_MS;
// timeoutMs is the pre-task-2 option name, kept as-is (not renamed to e.g.
// activeTotalMs) because claude-code.test.mjs's A1 test — outside this
// task's file list, see task-2-report.md's Abweichungen — already calls
// startTurn({timeoutMs: ...}) and asserts stopReason 'timeout'; it now maps
// onto the active-total clock, the closest match to what timeoutMs used to
// mean (a single active, pausable per-turn budget).
const DEFAULT_TIMEOUT_MS = ACTIVE_TOTAL_MS;
const DEFAULT_ABSOLUTE_TIMEOUT_MS = ABSOLUTE_MS;

// How often the turn polls its own clocks even when no stream-json event
// arrives to trigger a check — the whole reason idle/tool-lease/active-total
// alone would not catch a genuinely silent CLI (see the model comment
// above): a check ONLY driven by onEvent never runs at all if no event ever
// comes. Small relative to IDLE_MS (2 minutes) so a stuck turn is caught
// promptly without any meaningful timer/CPU overhead.
const CLOCK_POLL_INTERVAL_MS = 250;

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

// Strips ANSI escape sequences (e.g. color codes a hook or the CLI itself
// may have embedded in decision_reason) before an ApprovalRequest's `reason`
// is handed to onApprovalRequest — see adapter.mjs's ApprovalRequest typedef.
const ANSI_ESCAPE_RE = /\x1b\[[0-9;]*[a-zA-Z]/g;

/** Removes ANSI escape sequences from `str`; non-strings pass through unchanged. */
function stripAnsi(str) {
  return typeof str === 'string' ? str.replace(ANSI_ESCAPE_RE, '') : str;
}

/**
 * Whether `toolName` (as reported by the CLI's own `init` event) is one
 * kaprek recognizes for ask-coverage purposes (see startTurn()'s
 * `requireAskCoverage`/`strictAskCoverage` options and settings.mjs's own
 * doc comment on WHY `permissions.ask` has to name every tool explicitly).
 * A tool always counts as known if it is either in `requireAskCoverage`
 * (the caller's own ask list for this turn's profile) OR in
 * KNOWN_READONLY_TOOLS (always exempt, regardless of profile — see that
 * constant's doc comment) OR an MCP-provided tool (`mcp__…`, covered by
 * kaprek's own MCP-scope policy instead, see
 * src/triggers/runner.mjs::notifyPolicyHandler()).
 */
function isKnownTool(toolName, requireAskCoverage) {
  if (typeof toolName !== 'string') return true; // malformed — not this check's job to flag
  if (toolName.startsWith('mcp__')) return true;
  if (KNOWN_READONLY_TOOLS.includes(toolName)) return true;
  return requireAskCoverage.includes(toolName);
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

/**
 * Normalizes a `control_request`/`can_use_tool` line's `request` object into
 * the ApprovalRequest shape onApprovalRequest expects (see adapter.mjs).
 * `decision_reason` is stripped of ANSI escapes here, once, so nothing
 * downstream (chat store, SSE, a handler's own logging) ever sees them.
 */
function normalizeApprovalRequest(requestId, request) {
  return {
    id: requestId,
    toolName: request.tool_name,
    displayName: request.display_name ?? request.tool_name,
    input: request.input ?? {},
    description: request.description ?? null,
    agentId: request.agent_id ?? null,
    toolUseId: request.tool_use_id ?? null,
    reasonType: request.decision_reason_type ?? null,
    reason: stripAnsi(request.decision_reason ?? null),
    suggestions: request.permission_suggestions ?? null,
  };
}

/**
 * Builds the claude CLI argv (without the command name itself) for one turn.
 * `--permission-prompt-tool stdio` is only added when an approval handler is
 * actually configured — without one, a nonexistent `can_use_tool` channel
 * would just hang the CLI waiting for a control_response nobody sends.
 *
 * `--allowedTools` is only added for a NON-EMPTY list, and a tool named there
 * is pre-allowed by the CLI: it never reaches `can_use_tool`, so no approval
 * handler ever sees it. That is why a trigger turn passes an empty list (see
 * src/triggers/runner.mjs) — exported so that guarantee can be asserted
 * against the real argv builder rather than restated in a test.
 */
export function buildArgs({ sessionId, mcpConfigPath, permissionMode, allowedTools, settingsPath, hasApprovalHandler }) {
  const args = ['-p', '--output-format', 'stream-json', '--input-format', 'stream-json', '--verbose'];
  if (sessionId) args.push('--resume', sessionId);
  if (mcpConfigPath) args.push('--mcp-config', mcpConfigPath);
  if (permissionMode) args.push('--permission-mode', permissionMode);
  if (allowedTools && allowedTools.length > 0) args.push('--allowedTools', allowedTools.join(','));
  if (settingsPath) args.push('--settings', settingsPath);
  if (hasApprovalHandler) args.push('--permission-prompt-tool', 'stdio');
  return args;
}

/**
 * Starts one turn against the Claude Code CLI. See adapter.mjs for the full
 * StartTurnOptions/TurnResult contract. `spawnFn` is injectable (default:
 * node:child_process spawn) so tests can launch a harmless stand-in process
 * instead of the real `claude` binary — no test in this repo ever calls the
 * real CLI.
 * @param {import('./adapter.mjs').StartTurnOptions & {spawnFn?: Function, idleMs?: number, toolLeaseMs?: number, timeoutMs?: number, absoluteTimeoutMs?: number, killGraceMs?: number, requireAskCoverage?: string[], strictAskCoverage?: boolean}} options
 * @param {number} [options.idleMs] - see timeout.mjs's IDLE_MS
 * @param {number} [options.toolLeaseMs] - see timeout.mjs's TOOL_LEASE_MS
 * @param {number} [options.timeoutMs] - overrides the active-total clock's
 *   budget (timeout.mjs's ACTIVE_TOTAL_MS); named `timeoutMs`, not
 *   `activeTotalMs`, for backward compatibility (see DEFAULT_TIMEOUT_MS's
 *   own doc comment above)
 * @param {number} [options.absoluteTimeoutMs] - overrides the absolute
 *   clock's budget (timeout.mjs's ABSOLUTE_MS)
 * @param {string[]} [options.requireAskCoverage] - the ask list this turn's
 *   `--settings` profile was built from (see settings.mjs's ASK_TOOLS_CHAT/
 *   ASK_TOOLS_TRIGGER). Checked against the CLI's own `init` event's `tools`
 *   list — a built-in tool the CLI reports that is in neither this list nor
 *   KNOWN_READONLY_TOOLS means kaprek's ask-coverage is stale against
 *   whatever CLI version is actually running (task-7a Fix-Runde 2: a tool
 *   NOT forced through `permissions.ask` can bypass kaprek's own approval
 *   gate entirely, see settings.mjs's doc comment). Omitted entirely skips
 *   the check.
 * @param {boolean} [options.strictAskCoverage] - when true (a trigger-
 *   started turn, see run.mjs), a coverage gap KILLS the turn immediately
 *   (stopReason 'error', the child process terminated before any tool call
 *   can run) — nobody is watching a trigger turn, so failing loud beats
 *   failing open. When false (a plain chat turn, a human IS watching), a gap
 *   is only recorded in TurnResult.warnings and the turn continues.
 * @param {(toolNames: string[]) => void} [options.learnUnknownTools] -
 *   called with exactly the unknown, non-MCP tool name(s) the moment a
 *   coverage gap is detected — BEFORE the strict-abort/warning branch below,
 *   so even a turn that itself still fails closed (strictAskCoverage) has
 *   already persisted the gap for the NEXT turn to self-heal from (see
 *   src/harness/knownTools.mjs — run.mjs wires this to knownTools.mjs's
 *   learnTools(dataDir, ...)). Errors thrown by this callback are swallowed
 *   — a learning failure must never change how THIS turn's own coverage gap
 *   is handled.
 */
export async function startTurn({
  cwd,
  prompt,
  sessionId,
  mcpConfigPath,
  permissionMode,
  allowedTools,
  settingsPath,
  onEvent,
  onApprovalRequest,
  signal,
  spawnFn = nodeSpawn,
  idleMs = DEFAULT_IDLE_MS,
  toolLeaseMs = DEFAULT_TOOL_LEASE_MS,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  absoluteTimeoutMs = DEFAULT_ABSOLUTE_TIMEOUT_MS,
  killGraceMs = DEFAULT_KILL_GRACE_MS,
  requireAskCoverage,
  strictAskCoverage = false,
  learnUnknownTools,
} = {}) {
  if (signal?.aborted) {
    return { sessionId: sessionId ?? null, costUsd: null, usage: null, stopReason: 'aborted', error: null, droppedLines: 0, warnings: [] };
  }

  const args = buildArgs({ sessionId, mcpConfigPath, permissionMode, allowedTools, settingsPath, hasApprovalHandler: typeof onApprovalRequest === 'function' });

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
    // Set only when killReason === 'timeout', to which of timeout.mjs's four
    // clocks actually fired — see requestKill()/finish() and adapter.mjs's
    // TurnResult.timeoutClock doc comment.
    let timeoutClock = null;
    let killGiveUpTimer = null;
    // The four-clock turn-timeout model (task-2) — see timeout.mjs's
    // createTurnClocks() for the actual logic; this harness only feeds it
    // progress/approval events and polls check(), it owns no time math of
    // its own anymore (that used to live here as pauseTimeoutTimer()/
    // startTimeoutTimer(), now gone).
    const clocks = createTurnClocks({ idleMs, toolLeaseMs, activeTotalMs: timeoutMs, absoluteMs: absoluteTimeoutMs, nowFn: Date.now });
    // check()'d once per normalized event below AND from this interval — an
    // event-only check would never fire for a turn that produces NO
    // stream-json lines at all (e.g. a long-running `Bash` build mid tool
    // call, see timeout.mjs's own doc comment on why idle alone cannot
    // catch this), since nothing would ever call it.
    //
    // Guarded on sawResult, not just resolved: the CLI's own 'result' line
    // already means the turn is done in every way that matters — all that
    // is left is waiting for the child's 'close' event (see endStdin()'s
    // call below). Without this guard, a check() running in that short gap
    // (from either this same event's own evaluateClocks() call further down
    // the line handler, or the interval firing mid-gap) could still observe
    // activeElapsed just over budget and kill a turn that had ALREADY
    // finished successfully, turning a legitimate 'result' into a spurious
    // 'timeout' — found via a real race in this task's own test suite
    // (approval.test.mjs), not merely theoretical.
    const evaluateClocks = () => {
      if (resolved || sawResult) return;
      const hit = clocks.check();
      if (hit) requestKill('timeout', hit.clock);
    };
    const clockPollTimer = setInterval(evaluateClocks, CLOCK_POLL_INTERVAL_MS);
    // Number of can_use_tool requests currently awaiting a decision — the
    // clocks' approval-wait exemption is started/ended only on the 0->1/1->0
    // transition (see handleApprovalRequest()) so a SECOND, still-pending
    // approval keeps the exemption open even once the first one resolves —
    // mirrors the pre-task-2 pendingApprovalCount gating this replaces.
    let pendingApprovalCount = 0;

    // Tracks request_ids currently awaiting onApprovalRequest — dedups a
    // repeated control_request for the SAME request_id (a duplicate stdout
    // line, or a misbehaving CLI) so it is never answered/processed twice,
    // and doubles as the bookkeeping the turn-end paths clear so a decision
    // resolving after the turn already finished is recognizable as stale.
    const pendingApprovals = new Map();
    // stdin must stay open until the turn actually ends (result/error/abort/
    // timeout), NOT right after the prompt is written — closing it early is
    // what breaks the can_use_tool approval channel (anthropics/claude-code
    // #34046: the CLI treats stdin EOF as "no more control_responses are
    // ever coming" and the whole approval round-trip stops working).
    let stdinEnded = false;
    const endStdin = () => {
      if (stdinEnded) return;
      stdinEnded = true;
      try {
        child.stdin?.end();
      } catch {
        // already closed/errored — nothing to do
      }
    };

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

    // Writes exactly one control_response line for `requestId`. Guarded by
    // stdinEnded so a decision that resolves after the turn has already
    // ended (turn aborted/timed out/finished while onApprovalRequest was
    // still pending) never attempts a write-after-end / EPIPE.
    const writeControlResponse = (requestId, response) => {
      pendingApprovals.delete(requestId);
      if (stdinEnded) return;
      try {
        child.stdin?.write(`${JSON.stringify({ type: 'control_response', response })}\n`);
      } catch {
        // stdin closed/errored concurrently — best effort, same as the
        // prompt write below and the stdin 'error' handler further down.
      }
    };

    // Handles one `can_use_tool` control_request end to end: normalize →
    // await onApprovalRequest → write exactly one control_response. Not
    // awaited by the caller (the readline 'line' handler below) — several
    // requests (e.g. from parallel subagents, each with their own agentId)
    // run concurrently, none of them serialized behind another.
    const handleApprovalRequest = async (requestId, rawRequest) => {
      const request = normalizeApprovalRequest(requestId, rawRequest);
      pendingApprovals.set(requestId, true);
      pendingApprovalCount += 1;
      // Start the clocks' approval-wait exemption the MOMENT the first
      // approval becomes pending — the wait for a user decision must not
      // count against any of the four clocks (see createTurnClocks()'s doc
      // comment on why that now includes the absolute clock too).
      if (pendingApprovalCount === 1) clocks.onApprovalStart();
      safeEmit({ type: 'approval', phase: 'requested', ...request });

      try {
        if (typeof onApprovalRequest !== 'function') {
          // Fail-closed: no handler configured means every request is denied,
          // never silently allowed.
          writeControlResponse(requestId, {
            subtype: 'success',
            request_id: requestId,
            response: { behavior: 'deny', message: 'no approval handler configured', interrupt: false },
          });
          safeEmit({ type: 'approval', phase: 'resolved', id: requestId, toolName: request.toolName, behavior: 'deny' });
          return;
        }

        let decision;
        try {
          decision = await onApprovalRequest(request);
        } catch (err) {
          // A throwing/rejecting handler is our own bug, not a reason to kill
          // the CLI's turn — report it as a control-response error and let the
          // turn keep running (see adapter.mjs's onApprovalRequest contract).
          writeControlResponse(requestId, {
            subtype: 'error',
            request_id: requestId,
            error: err?.message ?? String(err),
          });
          safeEmit({ type: 'approval', phase: 'resolved', id: requestId, toolName: request.toolName, behavior: 'error' });
          return;
        }

        if (decision?.behavior === 'allow') {
          writeControlResponse(requestId, {
            subtype: 'success',
            request_id: requestId,
            response: {
              behavior: 'allow',
              updatedInput: decision.updatedInput ?? request.input,
              toolUseID: request.toolUseId,
            },
          });
          safeEmit({ type: 'approval', phase: 'resolved', id: requestId, toolName: request.toolName, behavior: 'allow' });
          return;
        }

        writeControlResponse(requestId, {
          subtype: 'success',
          request_id: requestId,
          response: { behavior: 'deny', message: decision?.message ?? 'denied', interrupt: false },
        });
        safeEmit({ type: 'approval', phase: 'resolved', id: requestId, toolName: request.toolName, behavior: 'deny' });
      } finally {
        pendingApprovalCount -= 1;
        // Only end the exemption once every currently-pending approval has
        // been answered — a second, still-outstanding request must keep all
        // four clocks paused.
        if (pendingApprovalCount === 0) clocks.onApprovalEnd();
      }
    };

    const finish = (result) => {
      if (resolved) return;
      resolved = true;
      if (killGiveUpTimer) clearTimeout(killGiveUpTimer);
      clearInterval(clockPollTimer);
      if (signal) signal.removeEventListener('abort', onAbort);
      pendingApprovals.clear();
      endStdin();
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
    // hanging on a child that refuses to die. `clock` is only meaningful for
    // reason 'timeout' — which of timeout.mjs's four clocks fired (see
    // evaluateClocks() above and adapter.mjs's TurnResult.timeoutClock).
    const requestKill = (reason, clock) => {
      if (resolved || killReason) return;
      killReason = reason;
      if (reason === 'timeout' && clock) timeoutClock = clock;
      killChildTree(child);
      killGiveUpTimer = setTimeout(() => {
        finish({ sessionId: latestSessionId, costUsd, usage, stopReason: reason, error: null, orphaned: true, ...(timeoutClock ? { timeoutClock } : {}) });
      }, killGraceMs);
    };

    const onAbort = () => requestKill('aborted');
    if (signal) signal.addEventListener('abort', onAbort);

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
        // A dropped line could be an oversized can_use_tool request (e.g. a
        // huge proposed Write input) — if so, the CLI is now waiting on a
        // control_response that will never come, blocking the whole turn
        // until timeoutMs. Never JSON.parse the oversized payload itself
        // (that's exactly what this guard exists to avoid), but a cheap
        // regex over a small PREFIX is enough to recognize the shape and
        // recover the (short, near-the-front) request_id, so we can still
        // answer fail-closed instead of leaving the CLI hanging.
        const prefix = rawLine.slice(0, 4096);
        if (prefix.includes('"control_request"') && prefix.includes('"can_use_tool"')) {
          const match = /"request_id"\s*:\s*"([^"]+)"/.exec(prefix);
          if (match) {
            writeControlResponse(match[1], {
              subtype: 'success',
              request_id: match[1],
              response: { behavior: 'deny', message: 'request too large to process', interrupt: false },
            });
          } else {
            onEventErrors.push('dropped an oversized can_use_tool control_request with no readable request_id');
          }
        }
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

      // control_request is a stdin/stdout control-channel message, not a
      // stream-json turn event — handled here, never passed to mapLine()
      // (which would either drop it silently or, worse, mis-map it as some
      // other event type). Only 'can_use_tool' is a request we understand;
      // any other subtype is ignored but recorded as a warning, never
      // crashes the turn.
      if (obj.type === 'control_request') {
        const requestId = obj.request_id;
        if (obj.request?.subtype !== 'can_use_tool') {
          onEventErrors.push(`ignored control_request subtype: ${obj.request?.subtype ?? 'unknown'}`);
        } else if (typeof requestId !== 'string' || requestId.length === 0) {
          // Answering without a request_id the CLI can match back to its own
          // request is worse than not answering at all — it would never be
          // recognized, so the CLI stays blocked either way; just warn.
          onEventErrors.push('ignored can_use_tool control_request with a missing/invalid request_id');
        } else if (pendingApprovals.has(requestId)) {
          // Dedup: a repeated line for a request_id already in flight (CLI
          // resend, duplicated stdout line) must not be answered/processed
          // twice — see pendingApprovals' doc comment above.
          onEventErrors.push(`ignored duplicate can_use_tool control_request for request_id ${requestId}`);
        } else {
          handleApprovalRequest(requestId, obj.request);
        }
        return;
      }

      // Registered ONCE per raw 'assistant' line, not per mapped event below
      // — a message with several content blocks (e.g. text AND a tool_use)
      // must still only count as ONE 'assistant-message' progress unit (see
      // timeout.mjs's onProgress() doc comment / the brief's "Was als
      // Fortschritt zählt"). This transport never surfaces text DELTAS as
      // separate lines (see mapLine()'s own doc comment), so one line here
      // always is one whole new message.
      if (obj.type === 'assistant' && obj.message) clocks.onProgress('assistant-message');

      for (const event of mapLine(obj)) {
        if (event.type === 'init') {
          clocks.onProgress('init');
          if (event.sessionId) latestSessionId = event.sessionId;
          if (requireAskCoverage) {
            const unknownTools = (event.tools ?? []).filter((t) => !isKnownTool(t, requireAskCoverage));
            if (unknownTools.length > 0) {
              // Learn BEFORE deciding what to do about THIS turn (see
              // learnUnknownTools's own doc comment) — THIS turn's own
              // --settings file was already written from a stale list
              // before the CLI was even spawned, so it still fails closed
              // below regardless; the point is the NEXT turn for this
              // dataDir already has the benefit.
              try {
                learnUnknownTools?.(unknownTools);
              } catch {
                // best-effort — see learnUnknownTools's own doc comment
              }
              const message = `ask-policy coverage gap: CLI reports tool(s) not in the ask list: ${unknownTools.join(', ')} (learned for future turns)`;
              if (strictAskCoverage) {
                // Fail-closed, not fail-open: a tool this harness doesn't
                // recognize could be one that skips permissions.ask entirely
                // on a stale ASK_TOOLS_* list (see settings.mjs) — killing
                // the child NOW (before mapLine() can ever emit a
                // 'tool-start' for it) is what actually stops it, not just
                // resolving this Promise while the process keeps running.
                killChildTree(child);
                finishError(message);
                return;
              }
              onEventErrors.push(message);
            }
          }
        }
        if (event.type === 'tool-start') clocks.onProgress('tool-start');
        // 'tool-end' here is always mapLine()'s mapping of a real tool_result
        // block (see mapLine()'s own doc comment) — this harness does not
        // itself verify it matches a lease createTurnClocks currently thinks
        // is open; timeout.mjs's own count-based tracking (see its
        // onProgress() doc comment) tolerates that without going negative.
        if (event.type === 'tool-end') clocks.onProgress('tool-end');
        if (event.type === 'result') {
          clocks.onProgress('result');
          sawResult = true;
          resultIsError = !!event.isError;
          resultSubtype = event.subtype ?? null;
          resultText = event.resultText ?? null;
          if (event.sessionId) latestSessionId = event.sessionId;
          costUsd = event.costUsd;
          usage = event.usage;
          // stdin must be closed as soon as we've SEEN the result event —
          // not only once the process later closes (see endStdin()'s doc
          // comment / task-6a review Critical #1): a well-behaved CLI that
          // waits for stdin EOF before exiting would otherwise never see
          // that EOF, and this harness would wait on 'close' that never
          // comes until DEFAULT_TIMEOUT_MS kills it — a turn that actually
          // succeeded would incorrectly resolve as 'timeout'.
          endStdin();
        }
        safeEmit(event);
        // Checked once per normalized event, in addition to clockPollTimer
        // above — see that timer's own doc comment for why both are needed.
        evaluateClocks();
      }
    });

    child.on('close', (code) => {
      rl.close();
      // Guards against a double-finish: the ask-coverage-gap path above
      // (killChildTree() + finishError()) resolves the turn WITHOUT going
      // through requestKill()/killReason, so this handler would otherwise
      // still try to interpret the child's own exit and call finishError()
      // a second time once it actually closes.
      if (resolved) return;
      if (killReason) {
        finish({ sessionId: latestSessionId, costUsd, usage, stopReason: killReason, error: null, ...(timeoutClock ? { timeoutClock } : {}) });
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
      // stdin is deliberately NOT closed here — see endStdin() above. It is
      // closed exactly once, from finish(), once the turn actually ends.
    } catch {
      // stdin already closed/errored (e.g. the CLI exited immediately) — the
      // 'error'/'close' handlers above take it from here.
    }
  });
}
