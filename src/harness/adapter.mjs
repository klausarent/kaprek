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
 * @property {(event: NormalizedEvent) => void} onEvent - called once per normalized event
 * @property {AbortSignal} [signal] - aborts the in-flight turn; the child process is killed
 */

/**
 * @typedef {Object} TurnResult
 * @property {string|null} sessionId - the CLI's session id (from the init or result event)
 * @property {number|null} costUsd - total_cost_usd from the result event, if any
 * @property {object|null} usage - usage object from the result event, if any
 * @property {'result'|'aborted'|'error'|'timeout'} stopReason - how the turn ended; 'timeout'
 *   means the harness's own timeoutMs elapsed and the child process was killed
 * @property {{message: string}|null} error - set when stopReason is 'error', otherwise null
 * @property {number} [droppedLines] - count of oversized CLI output lines refused before
 *   parsing (harness-specific safety limit, see claude-code.mjs::MAX_LINE_BYTES); absent
 *   or 0 when nothing was dropped
 * @property {string[]} [warnings] - non-fatal problems during the turn, e.g. an onEvent
 *   consumer that threw (see claude-code.mjs's safeEmit()) — the turn still ran to
 *   completion despite these
 * @property {boolean} [orphaned] - true only when stopReason is 'aborted'/'timeout' and the
 *   harness gave up waiting for the child process to actually exit (see
 *   claude-code.mjs::DEFAULT_KILL_GRACE_MS) — the child may still be running
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
    default:
      return false;
  }
}
