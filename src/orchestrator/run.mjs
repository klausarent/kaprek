// Orchestrator — translates one chat turn into a harness call and a chat-
// store transcript. There is NO turn loop here: a harness's startTurn()
// (see src/harness/adapter.mjs) already runs a full CLI turn end to end and
// resolves once; the orchestrator's job is to feed it a prompt, fan its
// normalized events out into src/chats/store.mjs (in the exact shape
// src/parser/parse.mjs::digestSession() produces, so the existing chat UI
// renders a live turn with zero new components), and log cost/usage to
// runs.jsonl (see runs.mjs).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openChats } from '../chats/store.mjs';
import { appendRun } from './runs.mjs';
import { redactSecrets, truncate } from '../parser/parse.mjs';
import { writeMcpConfig, cleanupMcpConfig } from '../apps/mcp-config.mjs';
import { writeHarnessSettings, mergeAskList } from '../harness/settings.mjs';
import { readKnownTools, learnTools } from '../harness/knownTools.mjs';

// Same defaults as src/parser/parse.mjs::digestSession() — a live chat turn
// must never persist or stream more content, or leak a secret a reloaded
// historical transcript would already have redacted (see
// truncateEvent()/redactSecrets() there). Kept as separate constants (not
// re-exported from parse.mjs) since they're runTurn()'s own defaults, only
// coincidentally identical.
const DEFAULT_MAX_TEXT_LEN = 4000;
const DEFAULT_MAX_TOOL_LEN = 1500;

// This file lives at <packageRoot>/src/orchestrator/run.mjs — derived here
// (not passed in) so callers that already know dataDir don't also have to
// pass packageRoot/the MCP server's own script path just to get the apps
// MCP server wired up (see writeMcpConfig()'s call below).
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = path.resolve(__dirname, '..', '..');
const MCP_SERVER_SCRIPT_PATH = path.join(PACKAGE_ROOT, 'src', 'apps', 'mcp-server.mjs');

/** Redacts (if enabled) then truncates one text field — mirrors parse.mjs::truncateEvent(). */
function sanitizeText(str, maxLen, redact) {
  if (typeof str !== 'string') return str;
  return truncate(redact ? redactSecrets(str) : str, maxLen);
}

/**
 * Redacts secrets inside a tool-call input object's own string values while
 * leaving its shape as an object — used only for the LIVE 'tool-start' event
 * forwarded to onEvent (see web/src/lib/api.ts's ChatStreamEvent, whose
 * `input` stays `Record<string, unknown>`; the client JSON.stringifies it
 * itself for display). Not truncated here: the call is still in flight, with
 * no final persisted size yet — sanitizeToolInput() below applies the actual
 * length limit once the matching tool-end lands.
 */
function redactInputObject(input, redact) {
  if (!redact || input === null || typeof input !== 'object') return input;
  try {
    return JSON.parse(redactSecrets(JSON.stringify(input)));
  } catch {
    return input; // non-JSON-serializable input (rare) — forward unredacted rather than crash the turn
  }
}

/**
 * Turns a tool call's input into the shape actually persisted in the chat
 * store — mirrors src/parser/parse.mjs::truncateEvent()'s 'tool' case
 * exactly: JSON.stringify BEFORE redaction, redaction BEFORE truncation (a
 * secret must never get cut in half by truncation and become "accidentally"
 * unrecognizable — see the comment on SECRET_PATTERNS in parse.mjs). The
 * result is a string, same as a reloaded/historical digest's tool.input —
 * src/chats/store.mjs's EVENT_SHAPES places no type constraint on `input`.
 */
function sanitizeToolInput(input, maxToolLen, redact) {
  if (input === null || input === undefined) return null;
  return sanitizeText(JSON.stringify(input), maxToolLen, redact);
}

/**
 * Sums a harness-agnostic usage object into runs.jsonl's single at-a-glance
 * `tokens` field (the full object is still logged verbatim under `usage`).
 * Different harnesses' CLIs name their usage fields differently — Anthropic:
 * input_tokens/output_tokens/cache_creation_input_tokens/
 * cache_read_input_tokens; an OpenAI-style CLI: prompt_tokens/
 * completion_tokens; some report only a pre-summed total_tokens and nothing
 * else. Rather than hardcode one vendor's field list (which silently sums to
 * null for every other harness), every numeric key ending in `_tokens` or
 * otherwise containing "tokens" is summed. `total_tokens` itself is excluded
 * from that sum and used only as a fallback when no individual field was
 * found — summing it together with the fields it is itself the total of
 * would double-count.
 */
function sumTokens(usage) {
  if (!usage || typeof usage !== 'object') return null;
  let total = 0;
  let found = false;
  let totalTokensValue = null;
  for (const [key, value] of Object.entries(usage)) {
    if (typeof value !== 'number') continue;
    if (key === 'total_tokens') {
      totalTokensValue = value;
      continue;
    }
    if (key.endsWith('_tokens') || key.includes('tokens')) {
      total += value;
      found = true;
    }
  }
  return found ? total : totalTokensValue;
}

function harnessMetaPath(dataDir, chatId) {
  return path.join(dataDir, 'chats', chatId, 'harness.json');
}

/**
 * Reads a chat's `{harness, cliSessionId, updatedAt}` sidecar file, or null
 * if it doesn't exist / is corrupt. Deliberately NOT stored as a chat-store
 * event: src/chats/store.mjs validates every event against a fixed
 * `EVENT_SHAPES` map (user/assistant/thinking/tool) that mirrors the
 * parser's digest output 1:1, and a harness-session pointer isn't a
 * conversation turn — smuggling it in as one would either fail validation
 * or, worse, pass validation and then render as a bogus turn in the chat UI.
 * A parse failure here must not block a turn — it just means we start a
 * fresh CLI session instead of resuming one, same as no sidecar at all.
 */
function readHarnessMeta(dataDir, chatId) {
  const metaPath = harnessMetaPath(dataDir, chatId);
  if (!fs.existsSync(metaPath)) return null;
  try {
    return JSON.parse(fs.readFileSync(metaPath, 'utf8'));
  } catch {
    return null;
  }
}

/** Atomic write (tmp file + rename), matching src/cli/hooks.mjs::writeSettings. */
function writeHarnessMeta(dataDir, chatId, meta) {
  const metaPath = harnessMetaPath(dataDir, chatId);
  const dir = path.dirname(metaPath);
  fs.mkdirSync(dir, { recursive: true });
  const tmpPath = path.join(dir, `.harness.json.tmp-${process.pid}-${Date.now()}`);
  fs.writeFileSync(tmpPath, `${JSON.stringify(meta, null, 2)}\n`, 'utf8');
  fs.renameSync(tmpPath, metaPath);
}

/**
 * Runs one chat turn: creates or reuses a chat, sends `text` through
 * `harness.startTurn()`, and mirrors every normalized event into the chat
 * store as it arrives.
 *
 * @param {object} options
 * @param {string} options.dataDir
 * @param {string} [options.chatId] - resumes an existing chat; a new one is
 *   created (titled from the first 80 chars of `text`) when omitted
 * @param {string} options.text - the user's prompt for this turn
 * @param {{startTurn: Function}} options.harness - e.g. src/harness/claude-code.mjs or fake.mjs
 * @param {string} [options.harnessName] - label stored alongside the chat's
 *   cliSessionId and in the run log (e.g. 'claude-code', 'fake'); `harness`
 *   itself carries no name, see run.test.mjs for why this is a separate arg
 * @param {string} [options.cwd] - working directory passed through to the harness
 * @param {string} [options.permissionMode] - passed straight through to
 *   harness.startTurn() (see adapter.mjs's StartTurnOptions); the CALLER
 *   (src/server/server.mjs::startServer()) owns the actual default, this
 *   layer only forwards whatever it is given, undefined included — see the
 *   SECURITY comment at startServer() for why that default matters
 * @param {string[]} [options.allowedTools] - passed straight through to
 *   harness.startTurn(), same caveat as permissionMode above
 * @param {number} [options.absoluteTimeoutMs] - passed straight through to
 *   harness.startTurn() too, and omitted entirely when undefined so the
 *   harness's own default still applies. This layer holds no opinion on the
 *   value: which wall clock a turn needs depends on what the CALLER knows
 *   about it (see adapter.mjs's TurnResult.timeoutClock doc comment on the
 *   two regimes, and runner.mjs::UNATTENDED_ABSOLUTE_TIMEOUT_MS for the one
 *   caller that overrides it). Added for task 3 for the same reason task 2
 *   had to add `timeoutClock` on the way back: the option died at this
 *   boundary, so a caller could not size the clock at all.
 * @param {(event: import('../harness/adapter.mjs').NormalizedEvent) => void} [options.onEvent] -
 *   called for every adapter event, in order, in addition to the chat-store writes
 *   (e.g. an SSE route forwarding the live turn to a browser); events carry
 *   the SAME redacted/truncated content the chat store persists, see
 *   maxTextLen/maxToolLen/redact below
 * @param {(request: import('../harness/adapter.mjs').ApprovalRequest) => Promise<import('../harness/adapter.mjs').ApprovalDecision>} [options.onApprovalRequest] -
 *   answers a tool-use approval prompt (see src/server/server.mjs's SSE
 *   question/answer route). NOT forwarded to the harness as-is: this layer
 *   wraps it to persist BOTH the request and the decision as 'approval' chat
 *   events first — redaction-before-truncation, same chain as tool input/
 *   result (SECURITY: an approval request carries the proposed tool input,
 *   which can itself contain a secret) — then calls the caller's handler
 *   with the SANITIZED request (never the raw one), so a caller that also
 *   streams the request out over SSE (as server.mjs does) can never leak an
 *   unredacted secret to the browser either. Omitted entirely means no
 *   onApprovalRequest option reaches the harness at all, which is itself
 *   fail-closed (see adapter.mjs/claude-code.mjs: no handler configured -> deny).
 * @param {AbortSignal} [options.signal]
 * @param {number} [options.maxTextLen] - cap on assistant/thinking/user text, see parse.mjs::digestSession()
 * @param {number} [options.maxToolLen] - cap on tool input/result, see parse.mjs::digestSession()
 * @param {boolean} [options.redact] - redact known secret formats before persisting/streaming (default true)
 * @param {'user'|'trigger'} [options.origin] - who started this turn (default
 *   'user'); only affects a NEWLY created chat (see chatId above) and every
 *   runs.jsonl line this turn appends — see src/triggers/runner.mjs, the
 *   only caller that passes 'trigger'
 * @param {string|null} [options.triggerId] - which trigger, when origin is
 *   'trigger'; ignored (forced null) otherwise
 * @param {string|null} [options.replayOf] - the approval key this turn is
 *   replaying, for a follow-up turn started by an approval (see
 *   runner.mjs::fireFollowUp). Written to runs.jsonl and nowhere else: it is
 *   what makes a replay identifiable as one rather than as a second ordinary
 *   run of the same trigger.
 * @param {boolean} [options.silent] - initial value of a newly created
 *   chat's `silent` flag (see src/chats/store.mjs::createChat) — ignored
 *   when resuming an existing chatId, since that chat already has one
 * @param {(chatId: string) => void} [options.onChatResolved] - called ONCE,
 *   synchronously, the moment chatId is known (created or resumed) — always
 *   before `harness.startTurn()` runs, so before any approval request could
 *   possibly fire. Lets a caller that didn't supply `chatId` itself (e.g.
 *   src/triggers/runner.mjs, which lets THIS function auto-create the chat)
 *   still learn the id early enough to bind a chatId-scoped approval handler
 *   or stream a bootstrap SSE frame, without needing to pre-create the chat
 *   itself and duplicate this function's own title/origin/triggerId/silent logic.
 * @returns {Promise<{chatId: string, cliSessionId: string|null, costUsd: number|null, stopReason: string, timeoutClock: string|null, error: {message:string}|null}>}
 *   `timeoutClock` (panel review Fix-Runde 2, important — outside this
 *   task's original file list, see task-2-report.md's Bedenken for the
 *   minimal-footprint scope of this change) names which of
 *   src/harness/timeout.mjs's four clocks fired when stopReason is
 *   'timeout' (see adapter.mjs's TurnResult.timeoutClock doc comment for
 *   the full contract); null otherwise. Passed through verbatim from the
 *   harness's own TurnResult — this function does not itself decide it.
 */
export async function runTurn({
  dataDir,
  chatId,
  text,
  harness,
  harnessName = null,
  cwd,
  permissionMode,
  allowedTools,
  absoluteTimeoutMs,
  onEvent,
  onApprovalRequest,
  signal,
  maxTextLen = DEFAULT_MAX_TEXT_LEN,
  maxToolLen = DEFAULT_MAX_TOOL_LEN,
  redact = true,
  origin = 'user',
  triggerId = null,
  replayOf = null,
  silent = false,
  onChatResolved,
} = {}) {
  const chats = openChats(dataDir);
  const startedAt = Date.now();

  let effectiveChatId = chatId;
  if (!effectiveChatId) {
    const title = text.slice(0, 80).trim();
    const chat = chats.createChat({ ...(title.length > 0 ? { title } : {}), origin, triggerId, silent });
    effectiveChatId = chat.id;
  }

  // Throws ChatNotFoundError for a caller-supplied chatId that doesn't
  // exist — a usage error on the caller's side, not an adapter-level
  // failure, so it is not folded into the {error} result below. Same
  // redact-then-truncate pipeline as every other persisted text field below
  // (parse.mjs::truncateEvent() treats 'user' identically to 'assistant'/
  // 'thinking' — a pasted secret in the user's own prompt is still a secret).
  chats.appendEvent(effectiveChatId, { kind: 'user', text: sanitizeText(text, maxTextLen, redact) });
  // Fired only once the chat is confirmed to exist (the appendEvent() above
  // would have thrown ChatNotFoundError for a bad caller-supplied chatId
  // otherwise) — see the onChatResolved param doc comment above.
  onChatResolved?.(effectiveChatId);

  const priorMeta = readHarnessMeta(dataDir, effectiveChatId);
  const priorSessionId = priorMeta?.cliSessionId ?? undefined;

  // tool-start is buffered here (id -> {name, input, ts}) instead of written
  // immediately: the chat store's 'tool' event carries both the call and its
  // result as ONE event (matching the parser's digest shape), so a
  // matching tool-end is what actually triggers the store write.
  const pendingTools = new Map();
  let cliSessionId = priorSessionId ?? null;
  let model = null;
  let rateLimit = null;

  // Every event forwarded to onEvent below (the SSE live-view path) carries
  // the SAME sanitized content just written to the chat store — never the
  // raw adapter event — so the live stream can never leak a secret or an
  // oversized blob the store itself would have filtered (SECURITY).
  const handleEvent = (event) => {
    switch (event.type) {
      case 'init':
        if (event.sessionId) cliSessionId = event.sessionId;
        if (event.model) model = event.model;
        onEvent?.(event);
        break;
      case 'text': {
        const sanitized = sanitizeText(event.text, maxTextLen, redact);
        chats.appendEvent(effectiveChatId, { kind: 'assistant', text: sanitized });
        onEvent?.({ ...event, text: sanitized });
        break;
      }
      case 'thinking': {
        const sanitized = sanitizeText(event.text, maxTextLen, redact);
        // Current CLIs redact thinking to an empty string plus a signature
        // (verified live against claude-fable-5 AND opus, including
        // --include-partial-messages deltas). The stream still forwards the
        // event — the agent panel uses it as an activity signal — but an
        // empty husk is never persisted: Klaus' first recorded run stored 50
        // thinking events with no text, rendered as 50 empty blocks.
        if (sanitized.trim() !== '') {
          chats.appendEvent(effectiveChatId, { kind: 'thinking', text: sanitized });
        }
        onEvent?.({ ...event, text: sanitized });
        break;
      }
      case 'tool-start':
        pendingTools.set(event.id, { name: event.name, input: event.input, ts: new Date().toISOString() });
        onEvent?.({ ...event, input: redactInputObject(event.input, redact) });
        break;
      case 'tool-end': {
        const started = pendingTools.get(event.id);
        pendingTools.delete(event.id);
        const sanitizedResult = sanitizeText(event.result, maxToolLen, redact);
        // The chat-store 'tool' shape (src/chats/store.mjs::EVENT_SHAPES) has
        // no isError field — it deliberately mirrors src/parser/parse.mjs's
        // historical digest shape 1:1, and adding one there would either
        // fail validation for every reloaded/historical tool event or (worse)
        // silently diverge the two shapes. Rather than break that parser
        // compatibility, an error result gets a plain-text prefix instead, so
        // it still reads as an error in a reloaded transcript. The LIVE SSE
        // event below is unaffected: it forwards `isError` as-is (`...event`
        // already carries it, per adapter.mjs's tool-end contract).
        const storedResult =
          event.isError && typeof sanitizedResult === 'string' ? `[tool error] ${sanitizedResult}` : sanitizedResult;
        chats.appendEvent(effectiveChatId, {
          kind: 'tool',
          ts: started?.ts,
          name: started?.name ?? 'unknown',
          input: sanitizeToolInput(started?.input ?? null, maxToolLen, redact),
          result: storedResult,
        });
        onEvent?.({ ...event, result: sanitizedResult });
        break;
      }
      case 'rate-limit':
        rateLimit = event.info;
        onEvent?.(event);
        break;
      case 'result':
        if (event.sessionId) cliSessionId = event.sessionId;
        onEvent?.(event);
        break;
      case 'approval':
        // Intentionally dropped, not forwarded to onEvent: this is the
        // harness's OWN raw, unsanitized NormalizedEvent (see
        // claude-code.mjs's handleApprovalRequest — 'requested' carries the
        // full request, including tool input, exactly as the CLI proposed
        // it, no redaction applied). The wrappedOnApprovalRequest below is
        // the actual persistence/forwarding path for approvals — it runs
        // BEFORE the caller's own handler and hands out only the sanitized
        // request. Forwarding this raw event here as well (the `default`
        // case used to do exactly that) would (a) leak an unredacted secret
        // straight onto the SSE wire and (b) duplicate the approval prompt
        // the client already gets from the sanitized path (SECURITY,
        // task-6a review Critical #2).
        break;
      default:
        onEvent?.(event); // 'error' — nothing to store, still forwarded
        break;
    }
  };

  // Wraps the caller's onApprovalRequest (if any) so every request/decision
  // is persisted as an 'approval' chat event BEFORE the caller ever sees it
  // — see the SECURITY note on the onApprovalRequest param above. Passed to
  // harness.startTurn() only when the caller actually configured a handler:
  // an always-present-but-no-op wrapper would make claude-code.mjs think a
  // handler exists (it decides `--permission-prompt-tool stdio` from
  // presence alone) and start a control-channel nobody answers.
  const wrappedOnApprovalRequest = onApprovalRequest
    ? async (request) => {
        const sanitizedInput = sanitizeToolInput(request.input, maxToolLen, redact);
        const sanitizedDescription = sanitizeText(request.description, maxToolLen, redact);
        const sanitizedReason = sanitizeText(request.reason, maxToolLen, redact);

        // toolName/displayName are ordinarily short enum-like names (e.g.
        // 'Bash') with nothing to redact, but `suggestions`
        // (permission_suggestions) is derived FROM the tool call — a CLI
        // can suggest an allow-rule string like `Bash(curl -H "Authorization:
        // Bearer …")` that embeds the very secret input carries (task-6a
        // review Important #7) — so every field that can possibly echo the
        // call's arguments goes through the same sanitize chain, not just
        // `input`.
        const sanitizedToolName = sanitizeText(request.toolName, maxToolLen, redact);
        const sanitizedDisplayName = sanitizeText(request.displayName, maxToolLen, redact);
        const sanitizedSuggestions = redactInputObject(request.suggestions, redact);

        chats.appendEvent(effectiveChatId, {
          kind: 'approval',
          phase: 'requested',
          requestId: request.id,
          toolName: sanitizedToolName,
          displayName: sanitizedDisplayName,
          input: sanitizedInput,
          description: sanitizedDescription,
          agentId: request.agentId,
          toolUseId: request.toolUseId,
          reasonType: request.reasonType,
          reason: sanitizedReason,
          suggestions: sanitizeToolInput(request.suggestions, maxToolLen, redact),
        });

        // The caller (e.g. server.mjs, streaming this over SSE) gets the
        // SANITIZED request, never `request` itself — redaction must happen
        // before the data reaches ANY new write site, SSE included.
        const sanitizedRequest = {
          ...request,
          toolName: sanitizedToolName,
          displayName: sanitizedDisplayName,
          input: redactInputObject(request.input, redact),
          description: sanitizedDescription,
          reason: sanitizedReason,
          suggestions: sanitizedSuggestions,
        };

        let decision;
        try {
          decision = await onApprovalRequest(sanitizedRequest);
        } catch (err) {
          chats.appendEvent(effectiveChatId, {
            kind: 'approval',
            phase: 'resolved',
            requestId: request.id,
            toolName: request.toolName,
            behavior: 'error',
            message: sanitizeText(err?.message ?? String(err), maxToolLen, redact),
          });
          // Re-thrown so the harness's own onApprovalRequest catch (see
          // adapter.mjs's contract) still turns this into a control-channel
          // 'error' response instead of silently allowing/denying the tool.
          throw err;
        }

        chats.appendEvent(effectiveChatId, {
          kind: 'approval',
          phase: 'resolved',
          requestId: request.id,
          toolName: request.toolName,
          behavior: decision?.behavior ?? 'deny',
          message: sanitizeText(decision?.message, maxToolLen, redact),
        });

        return decision;
      }
    : undefined;

  // Wired up once per turn: --mcp-config points the CLI at kaprek's own apps
  // MCP server (see mcp-config.mjs), --settings neutralizes the user's own
  // hooks AND permissions.allow list for a deterministic, sandboxed headless
  // turn (see settings.mjs). Both are written under dataDir (mcpConfigPath
  // under a dedicated 'mcp' tmpDir, not the real OS temp dir) so a test's
  // own tmpDir cleanup also removes them — see mcpConfigPath's
  // cleanupMcpConfig() call below for the mcp-config file specifically
  // (settings.json is a stable, idempotently-rewritten path — see
  // settings.mjs's own doc comment for why that closes the concurrent-turn
  // race a naive overwrite-every-time would hit on Windows).
  //
  // SECURITY (task-6a review Critical #3): a failed write here is NOT
  // swallowed and the turn allowed to proceed without --settings — without
  // it, the CLI falls back to reading the user's OWN ~/.claude/settings.json
  // (their real permissions.allow list AND hooks, verified empirically to be
  // used in place of, not merged with, ours), which can silently be far more
  // permissive than kaprek's own fail-closed default. Fail the turn instead.
  // 'trigger' origin (see src/triggers/runner.mjs) gets the STRICTER
  // settings profile — nobody is watching, so every built-in tool (read-only
  // included) is forced through kaprek's own approval handler. A plain user
  // chat turn gets the lighter 'chat' profile (write/outward-effect tools
  // only) so a human isn't asked to approve every Read/Grep. See
  // settings.mjs's own doc comment for why `permissions.ask` is what makes
  // this actually work against the CLI's own auto-approval at the 'Mode'
  // stage (task-7a Fix-Runde 2).
  const settingsProfile = origin === 'trigger' ? 'trigger' : 'chat';
  // Self-learning ask-coverage (task-7a Fix-Runde 3): a hand-maintained
  // ASK_TOOLS_* list goes stale the moment the CLI ships a new built-in
  // tool — readKnownTools() is whatever THIS dataDir has already learned
  // from a previous turn's coverage gap (fails closed to [] if missing/
  // corrupt, see knownTools.mjs), merged on top of the static floor by
  // mergeAskList() so both the --settings file's `ask` array AND this
  // turn's own coverage check (requireAskCoverage below) agree on the exact
  // same list — they can never drift apart.
  const learnedTools = readKnownTools(dataDir);
  const requireAskCoverage = mergeAskList(settingsProfile, learnedTools);

  let mcpConfigPath;
  let settingsPath;
  try {
    const mcpConfigDir = path.join(dataDir, 'mcp');
    fs.mkdirSync(mcpConfigDir, { recursive: true }); // writeMcpConfig() itself does not create tmpDir
    mcpConfigPath = writeMcpConfig({
      dataDir,
      packageRoot: PACKAGE_ROOT,
      serverScriptPath: MCP_SERVER_SCRIPT_PATH,
      tmpDir: mcpConfigDir,
    });
    settingsPath = writeHarnessSettings({ dataDir, profile: settingsProfile, learnedTools });
  } catch (err) {
    const message = `failed to prepare harness config (mcp-config/settings): ${err?.message ?? String(err)}`;
    if (mcpConfigPath) cleanupMcpConfig(mcpConfigPath); // best-effort — writeMcpConfig() itself may have succeeded before writeHarnessSettings() threw
    try {
      appendRun(dataDir, {
        chatId: effectiveChatId,
        harness: harnessName,
        model: null,
        costUsd: null,
        usage: null,
        tokens: null,
        durationMs: Date.now() - startedAt,
        stopReason: 'error',
        rateLimit: null,
        error: { message },
        origin,
        triggerId,
      });
    } catch {
      // best-effort — see appendRun()'s own call further down for the same caveat
    }
    return { chatId: effectiveChatId, cliSessionId, costUsd: null, stopReason: 'error', timeoutClock: null, error: { message } };
  }

  let turnResult;
  try {
    turnResult = await harness.startTurn({
      cwd,
      prompt: text,
      sessionId: priorSessionId,
      permissionMode,
      allowedTools,
      // Spread, not passed as `absoluteTimeoutMs: undefined`: claude-code.mjs
      // reads it as a defaulted destructuring parameter, so an explicit
      // undefined would be indistinguishable from "not given" today but is
      // exactly the kind of thing that stops being true when a harness starts
      // checking `'absoluteTimeoutMs' in options`.
      ...(absoluteTimeoutMs === undefined ? {} : { absoluteTimeoutMs }),
      mcpConfigPath,
      settingsPath,
      onEvent: handleEvent,
      onApprovalRequest: wrappedOnApprovalRequest,
      signal,
      requireAskCoverage,
      // Fail-closed for a trigger turn: an unrecognized built-in tool means
      // this file's ASK_TOOLS_* lists are stale against a newer CLI, which
      // would otherwise let a tool call skip kaprek's own ask-forced gate
      // silently (see settings.mjs's doc comment) — abort rather than run
      // ungated. A plain chat turn only warns (a human is right there).
      strictAskCoverage: origin === 'trigger',
      // Self-heals the NEXT turn for this dataDir even though THIS one still
      // fails closed on a gap (see requireAskCoverage's comment above and
      // claude-code.mjs's learnUnknownTools doc comment) — additive only,
      // never touches `allow` (see knownTools.mjs's own SECURITY note).
      learnUnknownTools: (toolNames) => learnTools(dataDir, toolNames),
    });
  } finally {
    if (mcpConfigPath) cleanupMcpConfig(mcpConfigPath);
  }

  // Robustness (Goose's conversation/mod.rs::fix_conversation): a tool-start
  // whose tool-end never arrived (turn aborted or errored mid-call) must not
  // leave the store silently missing that call — close it out with a null
  // result instead of dropping it.
  for (const started of pendingTools.values()) {
    chats.appendEvent(effectiveChatId, {
      kind: 'tool',
      ts: started.ts,
      name: started.name,
      input: sanitizeToolInput(started.input, maxToolLen, redact),
      result: null,
    });
  }
  pendingTools.clear();

  if (turnResult.sessionId) cliSessionId = turnResult.sessionId;

  if (cliSessionId) {
    writeHarnessMeta(dataDir, effectiveChatId, {
      harness: harnessName,
      cliSessionId,
      updatedAt: new Date().toISOString(),
    });
  }

  // A logging failure must never fail the turn itself — the chat-store
  // writes above already succeeded and are what the user actually sees.
  try {
    appendRun(dataDir, {
      chatId: effectiveChatId,
      harness: harnessName,
      model,
      costUsd: turnResult.costUsd,
      usage: turnResult.usage,
      tokens: sumTokens(turnResult.usage),
      durationMs: Date.now() - startedAt,
      stopReason: turnResult.stopReason,
      // Panel review Fix-Runde 2, important: see this function's own
      // @returns doc comment above — timeoutClock (the brief step-9
      // requirement) died at this exact boundary before this fix.
      timeoutClock: turnResult.timeoutClock ?? null,
      rateLimit,
      error: turnResult.error,
      origin,
      triggerId,
      replayOf,
    });
  } catch {
    // best-effort — see comment above
  }

  return {
    chatId: effectiveChatId,
    cliSessionId,
    costUsd: turnResult.costUsd,
    stopReason: turnResult.stopReason,
    timeoutClock: turnResult.timeoutClock ?? null,
    error: turnResult.error,
  };
}
