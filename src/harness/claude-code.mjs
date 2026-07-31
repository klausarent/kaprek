// claude-code.mjs — harness for the Claude Code CLI. Spawns the locally
// installed `claude` binary and speaks newline-delimited JSON over stdio
// (--input-format/--output-format stream-json). No provider API call is
// made here; authentication, billing, and model selection all live inside
// the CLI. See adapter.mjs for the startTurn() contract this implements.
import { spawn as nodeSpawn, execFile as nodeExecFile } from 'node:child_process';
import readline from 'node:readline';
import fs from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
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
// IMPORTANT, and the opposite of what this same comment said about
// DEFAULT_TIMEOUT_MS before task-2: idle/tool-lease/active-total now exclude
// time spent waiting on a human approval decision (see timeout.mjs's
// createTurnClocks() doc comment on why: task-3's overnight approval inbox
// would be impossible otherwise) — but ABSOLUTE_MS below is deliberately
// the ONE exception, still a raw, never-paused wall clock (see that
// constant's own doc comment in timeout.mjs for why: it is the backstop
// against a CHAIN of individually-auto-denied approval round-trips, not
// against a single pending one). What bounds a SINGLE approval that never
// gets answered is the CALLER's own approval timeout
// (src/server/server.mjs's DEFAULT_APPROVAL_TIMEOUT_MS, which resolves
// onApprovalRequest with an auto-deny — see makeApprovalHandler()), not a
// clock in this file or in timeout.mjs.
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
 * plain kill() and keep running. The two platform-specific fallbacks below
 * are how we still reach the tree:
 *   - Windows: `taskkill /T /F` walks the process tree by PID.
 *   - POSIX: `process.kill(-pid)` targets the process GROUP id. startTurn()'s
 *     spawn call sets `detached: true` on non-win32 SPECIFICALLY so this
 *     targets a real group (the child becomes its own group leader, and a
 *     shelled-out grandchild inherits that group) — panel review Fix-Runde
 *     2, minor: before that, this call was DOCUMENTED as expected to fail
 *     (ESRCH) in the common case, meaning a hung CLI's own tool-call
 *     subprocess tree outlived every one of the four clocks that exist
 *     specifically to end it; only the TURN's own resolution (orphaned:true)
 *     was actually bounded, not the process itself.
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
      process.kill(-child.pid, 'SIGTERM');
    } catch {
      // no process group under this pid, or already gone
    }
  }
}

/**
 * Escalation for killChildTree(): called only once killGraceMs has already
 * elapsed without a 'close' event, i.e. a plain SIGTERM (killChildTree()'s
 * job) evidently was not enough — sends SIGKILL instead, group-wide on
 * POSIX (same `detached: true` premise as killChildTree()'s own doc
 * comment). The win32 branch is a no-op: `taskkill /T /F` (already run by
 * killChildTree()) is unconditionally forceful, there is no softer-then-
 * harder escalation to make on that platform. Same best-effort contract as
 * killChildTree(): never throws into the caller.
 */
function killChildTreeHard(child) {
  try {
    child.kill('SIGKILL');
  } catch {
    // already exited — nothing to kill
  }
  if (!child.pid || process.platform === 'win32') return;
  try {
    process.kill(-child.pid, 'SIGKILL');
  } catch {
    // no process group under this pid, or already gone
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
 *   clock's budget (timeout.mjs's ABSOLUTE_MS) — a raw, never-paused wall
 *   clock, unlike the other three; see ABSOLUTE_MS's own doc comment and
 *   adapter.mjs's TurnResult doc comment for why the right value here is
 *   context-dependent (interactive chat vs. an unattended trigger turn
 *   relying on task-3's overnight approval inbox)
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
      // POSIX only (panel review Fix-Runde 2, minor) — makes the child its
      // own process-group leader, which is what turns killChildTree()'s
      // `process.kill(-child.pid)` from an expected-to-fail best-effort
      // extra into the primary way a hung Bash/etc. grandchild the CLI
      // shelled out to actually gets reached. `stdio` stays 'pipe' either
      // way — `detached` only affects process-group membership, not stream
      // inheritance. Left false on win32: taskkill /T /F (killChildTree()'s
      // existing Windows path) already walks the tree by PID without it.
      //
      // Deliberate trade-off (panel review Fix-Runde 3, minor, not measured
      // on this Windows worktree — see task-2-report.md's Bedenken): on
      // POSIX this ALSO removes the CLI's tool-call tree from the
      // foreground process group, so a terminal SIGINT (Ctrl+C on this
      // server's own process) no longer reaches it the way it did before
      // this fix — the server itself has no shutdown hook that explicitly
      // aborts in-flight turns (only a per-request client-close abort, see
      // server.mjs), so an operator's Ctrl+C now leaves an active turn's
      // process tree running unsupervised until one of its own four clocks
      // (or the CLI's own stdin-EOF exit, once the server's own process is
      // gone) eventually ends it. Kept `detached: true` anyway: it is what
      // makes killChildTree()'s POSIX group-kill (the fix Fund 8 itself
      // demanded) actually reach the tree at all — reverting it would
      // reopen Fund 8 to close this one. A proper fix (a server-level
      // shutdown hook that aborts running turns, or an explicit
      // process.kill(-pid) on exit) touches bin/cli.mjs/server.mjs, outside
      // this task's file list — tracked as a follow-up, not built here.
      detached: process.platform !== 'win32',
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
    // Give-up timer for the sawResult -> 'close' gap specifically — see
    // armResultCloseGrace()'s own doc comment below for why this exists as
    // a SEPARATE mechanism from killGiveUpTimer (that one only ever runs
    // after requestKill(), which a well-behaved-but-hung-grandchild turn
    // never reaches).
    let resultCloseGraceTimer = null;
    // The four-clock turn-timeout model (task-2) — see timeout.mjs's
    // createTurnClocks() for the actual logic; this harness only feeds it
    // progress/approval events and polls check(), it owns no time math of
    // its own anymore (that used to live here as pauseTimeoutTimer()/
    // startTimeoutTimer(), now gone).
    //
    // nowFn: performance.now() (monotonic, node:perf_hooks), NOT Date.now()
    // (panel review Fix-Runde 2, minor) — Date.now() is a wall clock: an
    // NTP step or manual correction can jump it, forward (instantly
    // inflating every clock's elapsed time — killing an actively-working
    // turn) or backward (handing every clock free extra budget, repeatedly
    // for a host with a badly drifting clock). A long unattended Task-3
    // overnight run is exactly the kind of multi-hour window such a step is
    // likely to fall inside. Deliberate, documented trade-off: a monotonic
    // clock does NOT advance during OS suspend on some platforms, so a
    // suspended host pauses `absolute` too, same as it pauses the other
    // three — accepted rather than giving `absolute` its own, second nowFn
    // (which createTurnClocks() does not currently support and would be a
    // larger interface change for a minor finding).
    const clocks = createTurnClocks({ idleMs, toolLeaseMs, activeTotalMs: timeoutMs, absoluteMs: absoluteTimeoutMs, nowFn: () => performance.now() });
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
    // Tool_use ids this harness itself has seen a tool-start for and not yet
    // seen a matching tool-end for — panel review Fix-Runde 2, minor: a
    // duplicated or orphaned tool_result (same failure class the
    // pendingApprovals dedup below already guards against for
    // control_requests) must not be allowed to close a DIFFERENT, still
    // genuinely-running tool's lease — see the tool-end handling in the
    // line handler below.
    const openToolUseIds = new Set();
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
      // count against idle/tool-lease/active-total (see createTurnClocks()'s
      // doc comment). Deliberately does NOT exempt `absolute` — that clock
      // stays a raw wall clock on purpose (see timeout.mjs's ABSOLUTE_MS
      // doc comment: the backstop against a CHAIN of approval round-trips).
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
        // been answered — a second, still-outstanding request must keep the
        // exempted clocks (idle, active-total) paused. `absolute` never
        // pauses, approval or not: it is the backstop against approval
        // chains (see timeout.mjs).
        if (pendingApprovalCount === 0) clocks.onApprovalEnd();
      }
    };

    const finish = (result) => {
      if (resolved) return;
      resolved = true;
      if (killGiveUpTimer) clearTimeout(killGiveUpTimer);
      if (resultCloseGraceTimer) clearTimeout(resultCloseGraceTimer);
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

    // Builds and applies the finish() payload for a turn that DID see a
    // result event — shared by the normal 'close' path below and
    // armResultCloseGrace()'s give-up path, so both agree on exactly the
    // same stopReason/error derivation. `extra` lets the give-up path add
    // `orphaned: true` without duplicating the rest.
    const finishWithSeenResult = (extra = {}) => {
      const detail = [resultSubtype, resultText].filter(Boolean).join(': ');
      finish({
        sessionId: latestSessionId,
        costUsd,
        usage,
        stopReason: resultIsError ? 'error' : 'result',
        error: resultIsError ? { message: `claude reported an error result${detail ? ` (${detail})` : ''}` } : null,
        ...extra,
      });
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
      if (reason === 'timeout' && clock) {
        timeoutClock = clock;
        // Panel review Fix-Runde 2, important: without this, no
        // NormalizedEvent ever named which clock ended the turn — a chat
        // transcript/SSE stream showed nothing at all, and only the
        // TurnResult (never reaching run.mjs/runs.jsonl before this fix)
        // carried it. `resolved` is still false here, guaranteed (the guard
        // above just returned otherwise) — reusing the existing 'error'
        // NormalizedEvent type (not a new kind) is the minimal integration:
        // src/orchestrator/run.mjs's handleEvent() already forwards an
        // unrecognized/'error' type to its own onEvent via its default
        // case, with zero further wiring needed in THIS file.
        safeEmit({ type: 'error', message: `turn timed out (${clock} clock)` });
      }
      killChildTree(child);
      killGiveUpTimer = setTimeout(() => {
        killChildTreeHard(child); // panel review Fix-Runde 2, minor — escalate before giving up, see that function's own doc comment
        // Panel review Fix-Runde 3, minor: this is the THIRD path that can
        // resolve the turn (besides the 'close' handler and
        // armResultCloseGrace()'s own give-up) — a buffered result line
        // fully processed AFTER this kill was already requested (sawResult
        // becomes true, a normal 'result' event already emitted) but BEFORE
        // 'close' arrives must still win here too, for exactly the same
        // reason the 'close' handler's own mirror-race fix exists (see its
        // doc comment) — without this, a slow-to-close child could resolve
        // as 'timeout' here even though the consumer already received a
        // 'result' event. Deliberately excludes reason 'aborted': an abort
        // is an explicit caller decision and must win regardless of
        // sawResult (see armResultCloseGrace()'s own doc comment on the
        // matching fix for the reverse race).
        if (reason === 'timeout' && sawResult) {
          finishWithSeenResult({ orphaned: true });
          return;
        }
        finish({ sessionId: latestSessionId, costUsd, usage, stopReason: reason, error: null, orphaned: true, ...(timeoutClock ? { timeoutClock } : {}) });
      }, killGraceMs);
    };

    // Panel review Fix-Runde 2, CRITICAL: the sawResult guard in
    // evaluateClocks() above fixes a real spurious-timeout race (a knee-jerk
    // check() landing in the result->close gap), but on its own it traded a
    // BOUNDED race for an UNBOUNDED hang if 'close' never arrives at all —
    // e.g. the CLI's own exit is fine, but a background process it started
    // as a side effect (a dev server left running) inherited its stdout/
    // stderr pipe, and Node only fires 'close' once EVERY inherited stdio
    // stream also closes, not just on process exit. Without a bound here,
    // clockPollTimer runs into that same guard forever, killGiveUpTimer is
    // never armed (only requestKill() does that, and requestKill() is never
    // called), and startTurn()'s promise never settles — reproduced live
    // against this exact harness before this fix (see task-2-report.md's
    // Fix-Runde 2). armResultCloseGrace() is the bound: reuses killGraceMs's
    // magnitude (not the sawResult guard's own timing) so a caller who wants
    // fast give-up on a hung kill also gets fast give-up here, without a new
    // startTurn() option. `child.once('exit', ...)` is registered
    // unconditionally at spawn time (not only after a result) so an 'exit'
    // that happens to be delivered before this function is ever called
    // cannot leave the grace un-armed — in the OVERWHELMINGLY common case
    // ('close' follows 'exit' within the same event-loop pass) this timer
    // never fires at all; finish() (via the normal 'close' -> sawResult
    // path) always clears it first.
    let resultCloseGraceArmed = false;
    const armResultCloseGrace = () => {
      if (resolved || resultCloseGraceArmed) return;
      resultCloseGraceArmed = true;
      resultCloseGraceTimer = setTimeout(() => {
        // reach a lingering grandchild (e.g. a dev server the CLI itself
        // left running) even though the CLI's own exit was fine — same
        // escalation as requestKill()'s give-up path, see killChildTreeHard()'s
        // own doc comment.
        killChildTree(child);
        killChildTreeHard(child);
        // Panel review Fix-Runde 3, minor: the close handler documents
        // 'aborted' as ALWAYS winning, regardless of sawResult (see its own
        // doc comment) — this give-up path is a second, independent timer
        // and did not know that. Sequence this closes: a result arrives and
        // arms this grace; the caller then aborts (requestKill('aborted')
        // arms its OWN, later-firing killGiveUpTimer); if 'close' never
        // comes, THIS timer — armed earlier, so it fires first — used to
        // win and resolve as 'result', silently overriding the caller's
        // explicit abort. Checking killReason here makes 'aborted' win
        // regardless of which give-up timer happens to fire first.
        if (killReason === 'aborted') {
          finish({ sessionId: latestSessionId, costUsd, usage, stopReason: 'aborted', error: null, orphaned: true });
          return;
        }
        finishWithSeenResult({ orphaned: true });
      }, killGraceMs);
    };
    child.once('exit', () => {
      if (sawResult) armResultCloseGrace();
    });

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

        // Panel review Fix-Runde 2+3, important: a dropped line desyncs the
        // clocks' own bookkeeping exactly as much as a dropped can_use_tool
        // request desyncs the approval channel above — it never reaches
        // mapLine(), so it can never call clocks.onProgress(). Left
        // uncompensated in EITHER direction: a dropped tool_use never opens
        // a lease (an actively-running tool judged by idle, 120s, instead of
        // its own 25-minute tool-lease), a dropped tool_result leaves a
        // lease OPEN forever (killing an actively-working turn at
        // TOOL_LEASE_MS instead of ACTIVE_TOTAL_MS, with a misleading
        // timeoutClock), and a dropped result line leaves sawResult false
        // (an actually-successful turn ends as 'timeout' or a confusing
        // generic 'error'). `rawLine` is already fully in memory at this
        // point — readline delivered it whole; this guard only ever
        // prevented JSON.parse/event buffering, never the buffering
        // readline itself already did — so a bounded string scan over the
        // WHOLE line (not just the 4096-byte prefix above) stays
        // memory-safe.
        //
        // (a) Any dropped line proves the CLI is alive and producing
        // SOMETHING — treat it as generic progress (an idle-reset)
        // regardless of its actual type. Harmless while a tool lease is
        // open: idle isn't consulted then anyway (see timeout.mjs's
        // check()).
        clocks.onProgress('assistant-message');
        if (prefix.includes('"type":"assistant"') && prefix.includes('"tool_use"')) {
          // (b) Panel review Fix-Runde 3, important: the mirror image of
          // (c) below, and the exact same class of bug — an oversized
          // tool_use (e.g. an 8MB Write/Bash payload, PRE-allowed via
          // --allowedTools/acceptEdits so no can_use_tool round-trip's own
          // sniff would ever catch it) never opened a lease at all, so the
          // real, still-running tool call was judged by idle (120s) instead
          // of its own 25-minute tool-lease — an actively-working turn
          // killed as a false 'idle' timeout. Ids are recoverable the same
          // way (a)'s can_use_tool sniff recovers request_id: Anthropic's
          // content-block JSON always orders `type` before `id` within one
          // tool_use block.
          const toolUseIds = [...rawLine.matchAll(/"type"\s*:\s*"tool_use"\s*,\s*"id"\s*:\s*"([^"]+)"/g)].map((m) => m[1]);
          for (const id of toolUseIds) {
            openToolUseIds.add(id);
            clocks.onProgress('tool-start');
          }
          if (toolUseIds.length === 0) {
            onEventErrors.push('dropped an oversized assistant/tool_use line with no readable id — tool-lease bookkeeping may be desynced');
          }
        } else if (prefix.includes('"type":"user"') && prefix.includes('"tool_result"')) {
          // (c) A user line can carry SEVERAL tool_result blocks (see
          // mapLine()'s own comment on this) — one dropped line can close
          // MORE than one open lease. Ids are recovered via regex (same
          // technique as (b) above) and run through the SAME id-matching
          // gate the mapLine() path below uses, instead of blindly counting
          // occurrences — panel review Fix-Runde 3, minor: id-less counting
          // left a stale, never-removed entry in openToolUseIds behind,
          // which a LATER genuine duplicate/orphaned tool_result for that
          // same id could then use to close a different tool's still-open
          // lease (exactly the bug the id-gate itself exists to prevent).
          const toolResultIds = [...rawLine.matchAll(/"tool_use_id"\s*:\s*"([^"]+)"/g)].map((m) => m[1]);
          for (const id of toolResultIds) {
            if (openToolUseIds.delete(id)) {
              clocks.onProgress('tool-end');
            } else {
              onEventErrors.push(`ignored a dropped tool-end for an id with no open tool-start (duplicate or orphaned tool_result): ${id}`);
            }
          }
          if (toolResultIds.length === 0) {
            onEventErrors.push('dropped an oversized tool_result line with no readable tool_use_id — tool-lease bookkeeping may be desynced');
          }
        } else if (prefix.includes('"type":"result"')) {
          // (d) Never sets sawResult — the actual costUsd/usage/subtype are
          // unrecoverable from a dropped line, so the turn still finishes
          // through the normal error-on-close path below, just no longer
          // through a MISLEADING 'timeout'. endStdin() lets a well-behaved
          // CLI that is waiting on stdin EOF before exiting still do so (see
          // endStdin()'s own doc comment for why that matters at all).
          endStdin();
          onEventErrors.push('dropped an oversized result line — costUsd/usage/subtype for this turn are unknown');
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
        if (event.type === 'tool-start') {
          // Symmetric to the tool-end guard below: a duplicated assistant
          // line re-announcing an already-open id must not grow the lease
          // count a second time — Set.add() is idempotent but the clock's
          // counter is not, and the single real tool_result then leaves a
          // phantom lease open, turning a 120s idle exit into a 25min
          // tool-lease one (Codex day-4 review, finding 6). An id-less
          // event cannot be deduplicated and keeps counting as before.
          const isDuplicate = event.id != null && openToolUseIds.has(event.id);
          if (isDuplicate) {
            onEventErrors.push(`ignored a tool-start for an already-open id (duplicated assistant line): ${event.id}`);
          } else {
            openToolUseIds.add(event.id);
            clocks.onProgress('tool-start');
          }
        }
        // Panel review Fix-Runde 2, minor: only a tool-end for an id THIS
        // harness itself opened counts as closing a lease — a duplicated or
        // orphaned tool_result (same failure class the pendingApprovals
        // dedup above already guards against for control_requests, just on
        // the tool_result side) must not be allowed to prematurely close a
        // DIFFERENT, still genuinely-running tool's lease window. Openly
        // over-counting (id present, matches) still tolerates the count
        // going to 0 early only when it is ACTUALLY the matching id — see
        // timeout.mjs's own onProgress() doc comment on the open-lease
        // COUNT itself (concurrent tool calls, unrelated to this gate).
        if (event.type === 'tool-end') {
          if (openToolUseIds.delete(event.id)) {
            clocks.onProgress('tool-end');
          } else {
            onEventErrors.push(`ignored a tool-end for an id with no open tool-start (duplicate or orphaned tool_result): ${event.id}`);
          }
        }
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
          // comes until armResultCloseGrace()'s bound kills it — a turn
          // that actually succeeded would incorrectly resolve as 'timeout'.
          endStdin();
          // Bounds the sawResult -> 'close' gap — see armResultCloseGrace()'s
          // own doc comment (defined above, near evaluateClocks()) for why
          // this exists as a SEPARATE mechanism from the four clocks.
          armResultCloseGrace();
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
      // Panel review Fix-Runde 2, minor: a timeout-kill can race a result
      // line that was already fully read from the pipe before requestKill()
      // ran (killReason gets set, but resolved stays false until 'close') —
      // the line handler above still processes that buffered line in full
      // (sawResult=true, a normal 'result' NormalizedEvent already emitted)
      // before this handler ever runs. Resolving as 'timeout' in that case
      // contradicts the result-event a consumer already received; resolving
      // as 'result' instead matches the sawResult-guard's own rationale
      // (see evaluateClocks()'s doc comment) — a turn that already produced
      // its result is done in every way that matters. 'aborted' always wins
      // regardless of sawResult: an abort is an explicit caller decision,
      // not a budget the turn merely happened to still be within.
      if (killReason && !(sawResult && killReason === 'timeout')) {
        finish({ sessionId: latestSessionId, costUsd, usage, stopReason: killReason, error: null, ...(timeoutClock ? { timeoutClock } : {}) });
        return;
      }
      if (sawResult) {
        finishWithSeenResult();
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
