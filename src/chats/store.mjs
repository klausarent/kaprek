// Chat store — an append-only JSONL event log with an in-memory projection,
// one log per chat. Structurally mirrors src/board/store.mjs (append-only
// commit()/applyEvent(), full replay on open, corrupt lines skipped), but
// each chat gets its own file under <dataDir>/chats/<chatId>/events.jsonl
// instead of one shared log: a chat is read/written by id, while the board
// is scanned in bulk by list(), so per-chat files avoid replaying every
// other chat's history just to open one conversation.
//
// Every chat's log carries two kinds of lines, both wrapped the same way
// as board events ({id, ts, type, data}):
//   - one 'chat.created' line — the chat's metadata (title)
//   - zero or more 'chat.event' lines — data is the conversation event
//     exactly as produced by src/parser/parse.mjs::digestSession() (kind:
//     'user'|'assistant'|'thinking'|'tool', see EVENT_SHAPES below), so
//     web/src/components/EventBlock.tsx renders a chat turn without any
//     new UI.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export class ChatNotFoundError extends Error {
  constructor(chatId) {
    super(`chat not found: ${chatId}`);
    this.name = 'ChatNotFoundError';
    this.chatId = chatId;
  }
}

export class InvalidTitleError extends Error {
  constructor() {
    super('title must be a non-empty string');
    this.name = 'InvalidTitleError';
  }
}

export class UnknownEventKindError extends Error {
  constructor(kind) {
    super(`unknown event kind: ${kind} (expected one of ${EVENT_KINDS.join(', ')})`);
    this.name = 'UnknownEventKindError';
    this.kind = kind;
  }
}

export class InvalidEventError extends Error {
  constructor(kind, missing) {
    super(`event of kind '${kind}' is missing required field(s): ${missing.join(', ')}`);
    this.name = 'InvalidEventError';
    this.kind = kind;
    this.missing = missing;
  }
}

// Required/optional fields per event kind, matching the shapes
// src/parser/parse.mjs::digestSession() produces for 'user' | 'assistant'
// | 'thinking' | 'tool' events (see its events.push(...) call sites and the
// DigestEvent union in web/src/lib/api.ts). 'approval' has no historical
// digest counterpart (a live-turn-only concept, see
// src/orchestrator/run.mjs's onApprovalRequest wrapping) — one shape covers
// both lifecycle points of an approval (phase 'requested': displayName/
// input/description/... ; phase 'resolved': behavior/message), all fields
// beyond requestId/toolName/phase optional so either phase validates.
const EVENT_SHAPES = {
  user: { required: ['text'], optional: [] },
  assistant: { required: ['text'], optional: ['msgId'] },
  thinking: { required: ['text'], optional: ['msgId'] },
  tool: { required: ['name', 'input', 'result'], optional: ['msgId', 'resultRef'] },
  approval: {
    required: ['requestId', 'toolName', 'phase'],
    optional: ['displayName', 'input', 'description', 'agentId', 'toolUseId', 'reasonType', 'reason', 'suggestions', 'behavior', 'message'],
  },
};
export const EVENT_KINDS = Object.keys(EVENT_SHAPES);

function eventsPathFor(dataDir, chatId) {
  return path.join(dataDir, 'chats', chatId, 'events.jsonl');
}

/** Deep-clones a plain JSON-ish value so callers can't mutate internal projection state. */
function clone(value) {
  return value === undefined ? value : JSON.parse(JSON.stringify(value));
}

/**
 * Validates a caller-supplied event against EVENT_SHAPES (unknown kind or
 * missing required field throws) and returns a new object with a fixed key
 * set — kind, ts, then the shape's own fields, optional ones defaulted to
 * null — so every stored event has the exact same keys as parser output.
 */
function normalizeEvent(event) {
  if (event === null || typeof event !== 'object') {
    throw new UnknownEventKindError(event === null ? 'null' : typeof event);
  }
  const { kind } = event;
  const shape = EVENT_SHAPES[kind];
  if (!shape) throw new UnknownEventKindError(kind);

  const missing = shape.required.filter((field) => event[field] === undefined);
  if (missing.length > 0) throw new InvalidEventError(kind, missing);

  const ts = event.ts ?? new Date().toISOString();
  const normalized = { kind, ts };
  for (const field of shape.required) normalized[field] = event[field];
  for (const field of shape.optional) normalized[field] = event[field] ?? null;
  return normalized;
}

/** Applies a single wrapper event to a chat projection, mutating it in place. */
function applyEvent(chat, wrapper) {
  const { type, ts, data } = wrapper;
  switch (type) {
    case 'chat.created':
      chat.title = data.title;
      chat.createdAt = ts;
      chat.updatedAt = ts;
      break;
    case 'chat.event':
      chat.events.push(data);
      chat.eventCount = chat.events.length;
      chat.updatedAt = ts;
      break;
    default:
      // Unknown wrapper type — skip. Keeps older readers forward-compatible
      // with wrapper types introduced by a newer version of this module.
      break;
  }
}

/**
 * Reads a chat's events.jsonl (if it exists) and parses each line. A line
 * that fails to parse is skipped rather than crashing the whole load; all
 * skips for one load are summarized in a single console.warn call.
 */
function loadEvents(eventsPath) {
  if (!fs.existsSync(eventsPath)) return [];
  const raw = fs.readFileSync(eventsPath, 'utf8');
  const lines = raw.split('\n').filter((line) => line.trim().length > 0);

  const events = [];
  let skipped = 0;
  for (const line of lines) {
    try {
      events.push(JSON.parse(line));
    } catch {
      skipped += 1;
    }
  }
  if (skipped > 0) {
    console.warn(`chats: skipped ${skipped} corrupt event line(s) while loading ${eventsPath}`);
  }
  return events;
}

/** Strips the internal `events` array off a chat, leaving just its metadata. */
function summarize(chat) {
  return {
    id: chat.id,
    title: chat.title,
    createdAt: chat.createdAt,
    updatedAt: chat.updatedAt,
    eventCount: chat.eventCount,
  };
}

/**
 * Opens chat storage for `dataDir`: scans `<dataDir>/chats/`, replays each
 * chat's own events.jsonl into an in-memory projection, and returns an API
 * for reading and mutating it. Every mutating call appends one wrapper line
 * to the relevant chat's log before updating the projection; a chat's file
 * is never rewritten, only appended to.
 */
export function openChats(dataDir) {
  const chatsDir = path.join(dataDir, 'chats');
  const chats = new Map();

  if (fs.existsSync(chatsDir)) {
    for (const entry of fs.readdirSync(chatsDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const chatId = entry.name;
      const chat = { id: chatId, title: null, createdAt: null, updatedAt: null, eventCount: 0, events: [] };
      for (const wrapper of loadEvents(eventsPathFor(dataDir, chatId))) {
        applyEvent(chat, wrapper);
      }
      // A chat directory whose log has no valid 'chat.created' line (e.g.
      // every line was corrupt) has no meaningful metadata yet — skip it
      // rather than surfacing a half-built chat.
      if (chat.createdAt !== null) chats.set(chatId, chat);
    }
  }

  function requireChat(chatId) {
    const chat = chats.get(chatId);
    if (!chat) throw new ChatNotFoundError(chatId);
    return chat;
  }

  /** Appends one wrapper event to chatId's log and folds it into the projection. */
  function commit(chatId, chat, type, data) {
    const eventsPath = eventsPathFor(dataDir, chatId);
    const wrapper = { id: crypto.randomUUID(), ts: new Date().toISOString(), type, data };
    fs.mkdirSync(path.dirname(eventsPath), { recursive: true });
    fs.appendFileSync(eventsPath, `${JSON.stringify(wrapper)}\n`, 'utf8');
    applyEvent(chat, wrapper);
    return wrapper;
  }

  return {
    createChat({ title } = {}) {
      if (title !== undefined && (typeof title !== 'string' || title.trim().length === 0)) {
        throw new InvalidTitleError();
      }
      const chatId = crypto.randomUUID();
      const chat = { id: chatId, title: null, createdAt: null, updatedAt: null, eventCount: 0, events: [] };
      commit(chatId, chat, 'chat.created', { title: title ?? null });
      chats.set(chatId, chat);
      return summarize(chat);
    },

    list() {
      return [...chats.values()].map(summarize);
    },

    get(chatId) {
      return summarize(requireChat(chatId));
    },

    appendEvent(chatId, event) {
      const chat = requireChat(chatId);
      const normalized = normalizeEvent(event);
      commit(chatId, chat, 'chat.event', normalized);
      return clone(normalized);
    },

    events(chatId) {
      const chat = requireChat(chatId);
      return clone(chat.events);
    },
  };
}
