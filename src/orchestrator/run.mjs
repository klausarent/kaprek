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
import { writeHarnessSettings } from '../harness/settings.mjs';

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
 * @returns {Promise<{chatId: string, cliSessionId: string|null, costUsd: number|null, stopReason: string, error: {message:string}|null}>}
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
  onEvent,
  onApprovalRequest,
  signal,
  maxTextLen = DEFAULT_MAX_TEXT_LEN,
  maxToolLen = DEFAULT_MAX_TOOL_LEN,
  redact = true,
} = {}) {
  const chats = openChats(dataDir);
  const startedAt = Date.now();

  let effectiveChatId = chatId;
  if (!effectiveChatId) {
    const title = text.slice(0, 80).trim();
    const chat = chats.createChat(title.length > 0 ? { title } : undefined);
    effectiveChatId = chat.id;
  }

  // Throws ChatNotFoundError for a caller-supplied chatId that doesn't
  // exist — a usage error on the caller's side, not an adapter-level
  // failure, so it is not folded into the {error} result below. Same
  // redact-then-truncate pipeline as every other persisted text field below
  // (parse.mjs::truncateEvent() treats 'user' identically to 'assistant'/
  // 'thinking' — a pasted secret in the user's own prompt is still a secret).
  chats.appendEvent(effectiveChatId, { kind: 'user', text: sanitizeText(text, maxTextLen, redact) });

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
        chats.appendEvent(effectiveChatId, { kind: 'thinking', text: sanitized });
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

        chats.appendEvent(effectiveChatId, {
          kind: 'approval',
          phase: 'requested',
          requestId: request.id,
          toolName: request.toolName,
          displayName: request.displayName,
          input: sanitizedInput,
          description: sanitizedDescription,
          agentId: request.agentId,
          toolUseId: request.toolUseId,
          reasonType: request.reasonType,
          reason: sanitizedReason,
        });

        // The caller (e.g. server.mjs, streaming this over SSE) gets the
        // SANITIZED request, never `request` itself — redaction must happen
        // before the data reaches ANY new write site, SSE included.
        const sanitizedRequest = {
          ...request,
          input: redactInputObject(request.input, redact),
          description: sanitizedDescription,
          reason: sanitizedReason,
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
  // hooks for a deterministic headless turn (see settings.mjs). Both are
  // written under dataDir (mcpConfigPath under a dedicated 'mcp' tmpDir, not
  // the real OS temp dir) so a test's own tmpDir cleanup also removes them —
  // see mcpConfigPath's cleanupMcpConfig() call below for the mcp-config
  // file specifically (settings.json is overwritten in place, nothing to
  // remove).
  //
  // Best-effort, same as appendRun()'s own try/catch further down: a turn
  // must still run (with a slightly less deterministic/tooled CLI, same as
  // omitting these options entirely) if this ONE auxiliary write hiccups —
  // a transient fs error here (e.g. a Windows AV scanner briefly locking a
  // just-written file) must not fail the user-visible turn itself.
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
    settingsPath = writeHarnessSettings({ dataDir });
  } catch {
    mcpConfigPath = undefined;
    settingsPath = undefined;
  }

  let turnResult;
  try {
    turnResult = await harness.startTurn({
      cwd,
      prompt: text,
      sessionId: priorSessionId,
      permissionMode,
      allowedTools,
      mcpConfigPath,
      settingsPath,
      onEvent: handleEvent,
      onApprovalRequest: wrappedOnApprovalRequest,
      signal,
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
      rateLimit,
      error: turnResult.error,
    });
  } catch {
    // best-effort — see comment above
  }

  return {
    chatId: effectiveChatId,
    cliSessionId,
    costUsd: turnResult.costUsd,
    stopReason: turnResult.stopReason,
    error: turnResult.error,
  };
}
