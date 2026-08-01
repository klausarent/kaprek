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

export class InvalidChatMetaError extends Error {
  constructor(field, message) {
    super(`${field}: ${message}`);
    this.name = 'InvalidChatMetaError';
    this.field = field;
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
  // One step of an agent-to-agent handoff (see src/relay/dispatcher.mjs).
  // Deliberately a chat event and not a store of its own: a relay run IS a
  // conversation, it belongs in the same append-only log as the turns around
  // it, and it gets the search index and the thread view for free. `eventType`
  // is the discriminator; the rest is optional because a run.created and a
  // message carry very different fields.
  relay: {
    required: ['eventType', 'runId'],
    optional: [
      'from',
      'to',
      'round',
      'turn',
      'textPreview',
      // The body lives in a file under the run's artifact directory, never in
      // this line: a relay payload can be dozens of drafts, and an event log
      // that has to be replayed on every open is the wrong place for it.
      'bodyRef',
      'bodySha256',
      'driver',
      'driverVersion',
      'costUsd',
      'costEstimated',
      'status',
      'reason',
      'goal',
      'route',
      'dispatchId',
      'approvalKey',
    ],
  },
};
export const EVENT_KINDS = Object.keys(EVENT_SHAPES);

// A chat's origin: 'user' for a normal chat turn, 'trigger' for one started
// by src/triggers/runner.mjs without any user input (see createChat()'s
// origin/triggerId/silent params below).
const CHAT_ORIGINS = ['user', 'trigger', 'relay'];

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
      // A chat.created line written before origin/triggerId/silent existed
      // has none of them — default to the values a plain user-started chat
      // always had, so an old chat stays readable and visible.
      chat.origin = data.origin ?? 'user';
      chat.triggerId = data.triggerId ?? null;
      chat.silent = data.silent ?? false;
      chat.missionId = data.missionId ?? null;
      chat.createdAt = ts;
      chat.updatedAt = ts;
      break;
    case 'chat.event':
      chat.events.push(data);
      chat.eventCount = chat.events.length;
      chat.updatedAt = ts;
      break;
    case 'chat.relay':
      // The run's own state, kept on the chat so a reader knows what is going
      // on without replaying every relay event. Written whenever the
      // dispatcher advances the run.
      chat.relay = data.relay ?? null;
      chat.updatedAt = ts;
      break;
    case 'chat.silent':
      // Flips visibility after the fact — see setSilent()'s doc comment:
      // src/triggers/runner.mjs uses this once a heartbeat turn's own
      // response is known, which is only AFTER the chat already exists.
      chat.silent = data.silent;
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
    origin: chat.origin ?? 'user',
    triggerId: chat.triggerId ?? null,
    silent: chat.silent ?? false,
    missionId: chat.missionId ?? null,
    relay: chat.relay ?? null,
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
      const chat = { id: chatId, title: null, origin: 'user', triggerId: null, silent: false, missionId: null, relay: null, createdAt: null, updatedAt: null, eventCount: 0, events: [] };
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
    /**
     * @param {string} [title]
     * @param {'user'|'trigger'} [origin] - who started this chat; 'trigger'
     *   for one created by src/triggers/runner.mjs without user input
     * @param {string|null} [triggerId] - which trigger, when origin is 'trigger'
     * @param {boolean} [silent] - true hides the chat from GET /api/chat/list
     *   by default (see src/server/server.mjs's ?includeSilent=1 handling) —
     *   used for a heartbeat run whose whole point was "nothing to report"
     * @param {string|null} [missionId] - the mission this chat belongs to
     *   (see src/missions/store.mjs); the server links the chat onto the
     *   mission via linkChat() in the same request that creates it
     */
    createChat({ title, origin = 'user', triggerId = null, silent = false, missionId = null } = {}) {
      if (title !== undefined && (typeof title !== 'string' || title.trim().length === 0)) {
        throw new InvalidTitleError();
      }
      if (!CHAT_ORIGINS.includes(origin)) {
        throw new InvalidChatMetaError('origin', `must be one of ${CHAT_ORIGINS.join(', ')}`);
      }
      if (triggerId !== null && typeof triggerId !== 'string') {
        throw new InvalidChatMetaError('triggerId', 'must be a string or null');
      }
      if (typeof silent !== 'boolean') {
        throw new InvalidChatMetaError('silent', 'must be a boolean');
      }
      if (missionId !== null && typeof missionId !== 'string') {
        throw new InvalidChatMetaError('missionId', 'must be a string or null');
      }
      const chatId = crypto.randomUUID();
      const chat = { id: chatId, title: null, origin: 'user', triggerId: null, silent: false, missionId: null, relay: null, createdAt: null, updatedAt: null, eventCount: 0, events: [] };
      commit(chatId, chat, 'chat.created', { title: title ?? null, origin, triggerId, silent, missionId });
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

    /**
     * Flips a chat's `silent` flag after creation — appends a 'chat.silent'
     * wrapper line rather than rewriting 'chat.created' (this log is
     * append-only, see the module doc comment). Needed because whether a
     * heartbeat trigger's run counts as "silent" is only known once the
     * agent's response has arrived, which is necessarily AFTER createChat()
     * already ran (see src/triggers/runner.mjs).
     */
    setSilent(chatId, silent) {
      const chat = requireChat(chatId);
      if (typeof silent !== 'boolean') {
        throw new InvalidChatMetaError('silent', 'must be a boolean');
      }
      commit(chatId, chat, 'chat.silent', { silent });
      return summarize(chat);
    },

    /**
     * Records the state of the relay run this chat is hosting (see
     * src/relay/dispatcher.mjs). Same append-only treatment as setSilent
     * above: the run advances after the chat exists, so its state arrives as
     * further lines rather than as a rewrite.
     *
     * Kept as one opaque object rather than a set of columns because the
     * dispatcher owns its shape, and this store's job here is to persist and
     * replay it, not to have an opinion about rounds and vouchers.
     */
    setRelay(chatId, relay) {
      const chat = requireChat(chatId);
      if (relay !== null && (typeof relay !== 'object' || Array.isArray(relay))) {
        throw new InvalidChatMetaError('relay', 'must be an object or null');
      }
      commit(chatId, chat, 'chat.relay', { relay: relay === null ? null : clone(relay) });
      return summarize(chat);
    },
  };
}
