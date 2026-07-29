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
import { openChats } from '../chats/store.mjs';
import { appendRun } from './runs.mjs';
import { redactSecrets, truncate } from '../parser/parse.mjs';

// Same defaults as src/parser/parse.mjs::digestSession() — a live chat turn
// must never persist or stream more content, or leak a secret a reloaded
// historical transcript would already have redacted (see
// truncateEvent()/redactSecrets() there). Kept as separate constants (not
// re-exported from parse.mjs) since they're runTurn()'s own defaults, only
// coincidentally identical.
const DEFAULT_MAX_TEXT_LEN = 4000;
const DEFAULT_MAX_TOOL_LEN = 1500;

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

// Anthropic usage object field names as emitted in a Claude Code CLI
// `result` event's `usage` (see src/harness/claude-code.mjs::mapLine). Summed
// into runs.jsonl's `tokens` field as a single at-a-glance number; the full
// object is still logged verbatim under `usage`.
const USAGE_TOKEN_FIELDS = ['input_tokens', 'output_tokens', 'cache_creation_input_tokens', 'cache_read_input_tokens'];

function computeTokens(usage) {
  if (!usage || typeof usage !== 'object') return null;
  let total = 0;
  let found = false;
  for (const field of USAGE_TOKEN_FIELDS) {
    const value = usage[field];
    if (typeof value === 'number') {
      total += value;
      found = true;
    }
  }
  return found ? total : null;
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
 * @param {(event: import('../harness/adapter.mjs').NormalizedEvent) => void} [options.onEvent] -
 *   called for every adapter event, in order, in addition to the chat-store writes
 *   (e.g. an SSE route forwarding the live turn to a browser); events carry
 *   the SAME redacted/truncated content the chat store persists, see
 *   maxTextLen/maxToolLen/redact below
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
  onEvent,
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
        chats.appendEvent(effectiveChatId, {
          kind: 'tool',
          ts: started?.ts,
          name: started?.name ?? 'unknown',
          input: sanitizeToolInput(started?.input ?? null, maxToolLen, redact),
          result: sanitizedResult,
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

  const turnResult = await harness.startTurn({
    cwd,
    prompt: text,
    sessionId: priorSessionId,
    onEvent: handleEvent,
    signal,
  });

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
      tokens: computeTokens(turnResult.usage),
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
