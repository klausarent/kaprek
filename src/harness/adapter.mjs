// Harness adapter contract — the interface every agent-CLI harness
// (claude-code.mjs, fake.mjs, and any future gemini-cli.mjs/codex.mjs) must
// implement. kaprek never talks to a provider API directly: it spawns the
// user's already-installed, already-authenticated CLI as a subprocess and
// speaks newline-delimited JSON over stdio. Login, billing, and model
// choice all stay inside that CLI — this file only documents and helps
// validate the shared shape, it holds no runtime logic of its own.
//
// Contract:
//   startTurn({cwd, prompt, sessionId, mcpConfigPath, permissionMode,
//              allowedTools, onEvent, signal}) -> Promise<TurnResult>
//
// `onEvent` is called synchronously, once per NORMALIZED event, in the
// order the underlying CLI produced them. A harness never REJECTS its
// returned promise for turn-level failures (non-zero exit, malformed
// result, an aborted turn) — those are reported through the resolved
// TurnResult's stopReason/error fields instead, so callers get exactly one
// error-handling path. A harness may still reject on a genuine programming
// error (e.g. spawnFn itself throwing synchronously for a reason unrelated
// to the CLI turn).

/**
 * @typedef {Object} StartTurnOptions
 * @property {string} cwd - working directory for the spawned CLI
 * @property {string} prompt - the user turn to send
 * @property {string} [sessionId] - resume an existing CLI session; omitted starts a fresh one
 * @property {string} [mcpConfigPath] - path to an MCP config file to pass through
 * @property {string} [permissionMode] - CLI permission mode (e.g. 'default', 'acceptEdits')
 * @property {string[]} [allowedTools] - tool names to pre-allow
 * @property {string} [settingsPath] - path to a `--settings` JSON file (see settings.mjs);
 *   used to neutralize the user's own ~/.claude/settings.json hooks for deterministic turns
 * @property {(event: NormalizedEvent) => void} onEvent - called once per normalized event
 * @property {(request: ApprovalRequest) => Promise<ApprovalDecision>} [onApprovalRequest] -
 *   answers a `can_use_tool` control_request from the CLI. Omitted means every request is
 *   auto-denied with 'no approval handler configured' (fail-closed, never fail-open) — see
 *   claude-code.mjs's approval flow. Multiple requests may be in flight concurrently
 *   (subagents each get their own agentId), never serialized.
 * @property {AbortSignal} [signal] - aborts the in-flight turn; the child process is killed
 */

/**
 * @typedef {Object} ApprovalRequest
 * One `can_use_tool` control_request from the CLI, normalized.
 * @property {string} id - the CLI's control_request `request_id`; echoed back in the response
 * @property {string} toolName
 * @property {string} displayName
 * @property {object} input - the tool call's input, exactly as the CLI proposes it
 * @property {string|null} description
 * @property {string|null} agentId - which agent (main or subagent) this request belongs to;
 *   required to tell concurrent requests apart
 * @property {string|null} toolUseId
 * @property {string|null} reasonType - the CLI's `decision_reason_type`
 * @property {string|null} reason - the CLI's `decision_reason`, ANSI escapes stripped
 * @property {object|null} suggestions - the CLI's `permission_suggestions`
 */

/**
 * @typedef {Object} ApprovalDecision
 * Either `{behavior:'allow', updatedInput?: object}` or `{behavior:'deny', message: string}`.
 * @property {'allow'|'deny'} behavior
 * @property {object} [updatedInput] - only meaningful for 'allow'
 * @property {string} [message] - only meaningful for 'deny'
 */

/**
 * @typedef {Object} TurnResult
 * @property {string|null} sessionId - the CLI's session id (from the init or result event)
 * @property {number|null} costUsd - total_cost_usd from the result event, if any
 * @property {object|null} usage - usage object from the result event, if any
 * @property {'result'|'aborted'|'error'|'timeout'} stopReason - how the turn ended. 'timeout'
 *   means one of the four independent clocks in src/harness/timeout.mjs (idle, tool-lease,
 *   active-total, absolute — see createTurnClocks()) elapsed and the child process was
 *   killed; WHICH one is named in `timeoutClock` below, not folded into this string, so a
 *   caller checking `stopReason === 'timeout'` (pre-task-2 code, e.g. an existing
 *   `result.stopReason` comparison) keeps working unchanged
 * @property {'idle'|'tool-lease'|'active-total'|'absolute'} [timeoutClock] - present only
 *   when stopReason is 'timeout'; names which clock fired (see timeout.mjs's own doc
 *   comment on what each one measures). idle/tool-lease/active-total all exclude time
 *   spent waiting on a human approval decision — that SINGLE wait is bounded separately
 *   by the caller's own approval timeout, e.g. src/server/server.mjs's
 *   DEFAULT_APPROVAL_TIMEOUT_MS, which auto-denies one pending request but does not stop
 *   the agent from immediately asking again. 'absolute' is deliberately the ONE exception:
 *   a raw, never-paused wall clock that counts approval-wait time in full, because it is
 *   the backstop against a CHAIN of such round-trips (see timeout.mjs's ABSOLUTE_MS doc
 *   comment). Its right value is therefore CONTEXT-DEPENDENT, not a fixed default:
 *     - Interactive chat (a human is watching, can always just answer sooner): the
 *       ABSOLUTE_MS default (60 minutes) is fine as-is.
 *     - An unattended trigger turn relying on task-3's overnight approval inbox: the
 *       caller MUST override absoluteTimeoutMs to at least the inbox's own approval
 *       deadline + ACTIVE_TOTAL_MS + a buffer — otherwise this raw wall clock kills the
 *       very overnight wait the inbox exists to allow, regardless of how much of that
 *       time was legitimately spent waiting on a human to check the inbox.
 * @property {{message: string}|null} error - set when stopReason is 'error', otherwise null
 *   (including for stopReason 'timeout' — a clock elapsing is not itself an error)
 * @property {number} [droppedLines] - count of oversized CLI output lines refused before
 *   parsing (harness-specific safety limit, see claude-code.mjs::MAX_LINE_BYTES); absent
 *   or 0 when nothing was dropped
 * @property {string[]} [warnings] - non-fatal problems during the turn, e.g. an onEvent
 *   consumer that threw (see claude-code.mjs's safeEmit()) — the turn still ran to
 *   completion despite these
 * @property {boolean} [orphaned] - true when the harness gave up waiting for the child
 *   process to actually exit within its own grace period (see
 *   claude-code.mjs::DEFAULT_KILL_GRACE_MS) after already trying to kill the whole process
 *   tree (see claude-code.mjs::killChildTree()/killChildTreeHard()) — despite the name, this
 *   is NOT only "the child may still be running": by the time this is set the harness has
 *   already sent SIGKILL (POSIX: process-group-wide), so it usually means "reaping the tree
 *   itself may still be in flight", not that no kill was attempted. Can occur with ANY
 *   stopReason, not only 'aborted'/'timeout' (panel review Fix-Runde 3, minor, correcting
 *   this doc comment's own pre-task-2 claim) — e.g. a well-behaved CLI whose stdout/stderr
 *   pipe stayed open past 'result' because it left an unrelated background process (a dev
 *   server) running that inherited it: the turn itself succeeded (stopReason 'result', or
 *   'error' if the result itself was one) and is finished in every way that matters, but
 *   'close' never came within the same grace period, so the leftover process tree is killed
 *   and orphaned is set anyway — see claude-code.mjs::armResultCloseGrace() and its own
 *   regression test (approval.test.mjs) for the concrete scenario
 */

/**
 * @typedef {Object} NormalizedEvent
 * One of, discriminated by `type`:
 *   {type:'init', sessionId, tools, model, permissionMode}
 *   {type:'text', text}
 *   {type:'thinking', text}
 *   {type:'tool-start', id, name, input}
 *   {type:'tool-end', id, result, isError}
 *   {type:'rate-limit', info}
 *   {type:'result', sessionId, costUsd, usage, isError}
 *   {type:'error', message}
 *   {type:'approval', phase:'requested'|'resolved', id, toolName, behavior?}
 * The 'approval' event mirrors an ApprovalRequest's lifecycle (see
 * StartTurnOptions.onApprovalRequest above) so a chat store/UI can see the
 * approval history even though the actual decision flows through the
 * onApprovalRequest callback, not onEvent. `behavior` is only present on
 * 'resolved'. A harness may attach extra fields beyond this minimal shape
 * (e.g. the full request on 'requested') — isNormalizedEvent() below only
 * checks for the required keys, not an exhaustive shape.
 */

/** The full set of normalized event type tags a harness may pass to onEvent. */
export const EVENT_TYPES = Object.freeze([
  'init',
  'text',
  'thinking',
  'tool-start',
  'tool-end',
  'rate-limit',
  'result',
  'error',
  'approval',
]);

/** The full set of stopReason values a harness may resolve startTurn() with. */
export const STOP_REASONS = Object.freeze(['result', 'aborted', 'error', 'timeout']);

/**
 * Structural check used by harness tests: does `event` look like a
 * NormalizedEvent per the contract above? Checks the discriminant and the
 * presence of type-specific required keys, not value types — lets every
 * harness assert its mapped events against one shared definition instead of
 * duplicating the shape list in each test file.
 */
export function isNormalizedEvent(event) {
  if (!event || typeof event !== 'object' || typeof event.type !== 'string') return false;
  if (!EVENT_TYPES.includes(event.type)) return false;
  switch (event.type) {
    case 'init':
      return 'sessionId' in event;
    case 'text':
    case 'thinking':
      return 'text' in event;
    case 'tool-start':
      return 'id' in event && 'name' in event && 'input' in event;
    case 'tool-end':
      return 'id' in event && 'result' in event;
    case 'rate-limit':
      return 'info' in event;
    case 'result':
      return 'sessionId' in event;
    case 'error':
      return 'message' in event;
    case 'approval':
      return 'phase' in event && 'id' in event && 'toolName' in event;
    default:
      return false;
  }
}

/**
 * Structural check for an ApprovalRequest (see StartTurnOptions.onApprovalRequest
 * above) — required keys present, not value types. Used by harness tests so
 * every harness's normalized approval requests can be asserted against one
 * shared definition instead of duplicating the shape list per test file.
 */
export function isApprovalRequest(request) {
  if (!request || typeof request !== 'object') return false;
  return 'id' in request && 'toolName' in request && 'input' in request;
}
