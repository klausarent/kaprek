import { test, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  openChats,
  ChatNotFoundError,
  InvalidTitleError,
  InvalidChatMetaError,
  UnknownEventKindError,
  InvalidEventError,
} from './store.mjs';
import { digestSession } from '../parser/parse.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MINI_SESSION_FIXTURE = path.join(__dirname, '..', 'parser', 'fixtures', 'mini-session.jsonl');

let tmpDir;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kaprek-chats-test-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('createChat adds a chat with defaults and list/get return it', () => {
  const chats = openChats(tmpDir);
  const chat = chats.createChat({ title: 'First chat' });

  expect(chat.title).toBe('First chat');
  expect(chat.eventCount).toBe(0);
  expect(typeof chat.id).toBe('string');
  expect(chat.id.length).toBeGreaterThan(0);
  expect(chat.createdAt).toBe(chat.updatedAt);

  expect(chats.get(chat.id)).toEqual(chat);
  expect(chats.list()).toEqual([chat]);
  expect(chats.events(chat.id)).toEqual([]);
});

test('createChat without a title defaults title to null', () => {
  const chats = openChats(tmpDir);
  const chat = chats.createChat();
  expect(chat.title).toBeNull();
});

test('createChat rejects a non-string/empty title when one is given', () => {
  const chats = openChats(tmpDir);
  expect(() => chats.createChat({ title: '' })).toThrow(InvalidTitleError);
  expect(() => chats.createChat({ title: '   ' })).toThrow(InvalidTitleError);
  expect(() => chats.createChat({ title: 42 })).toThrow(InvalidTitleError);
});

test('createChat defaults origin to "user", triggerId to null, silent to false', () => {
  const chats = openChats(tmpDir);
  const chat = chats.createChat({ title: 'T' });
  expect(chat.origin).toBe('user');
  expect(chat.triggerId).toBeNull();
  expect(chat.silent).toBe(false);
});

test('createChat accepts an explicit origin/triggerId/silent and round-trips them through get/list', () => {
  const chats = openChats(tmpDir);
  const chat = chats.createChat({ title: 'Heartbeat check', origin: 'trigger', triggerId: 'heartbeat-1', silent: true });
  expect(chat.origin).toBe('trigger');
  expect(chat.triggerId).toBe('heartbeat-1');
  expect(chat.silent).toBe(true);
  expect(chats.get(chat.id)).toEqual(chat);
  expect(chats.list()).toEqual([chat]);
});

test('createChat rejects an invalid origin/triggerId/silent', () => {
  const chats = openChats(tmpDir);
  expect(() => chats.createChat({ origin: 'robot' })).toThrow(InvalidChatMetaError);
  expect(() => chats.createChat({ triggerId: 42 })).toThrow(InvalidChatMetaError);
  expect(() => chats.createChat({ silent: 'yes' })).toThrow(InvalidChatMetaError);
});

test('setSilent flips a chat\'s silent flag and is visible immediately via get()', () => {
  const chats = openChats(tmpDir);
  const chat = chats.createChat({ title: 'Heartbeat check', origin: 'trigger', triggerId: 'h1' });
  expect(chat.silent).toBe(false);

  const updated = chats.setSilent(chat.id, true);
  expect(updated.silent).toBe(true);
  expect(chats.get(chat.id).silent).toBe(true);

  chats.setSilent(chat.id, false);
  expect(chats.get(chat.id).silent).toBe(false);
});

test('setSilent throws ChatNotFoundError for an unknown chatId, InvalidChatMetaError for a non-boolean', () => {
  const chats = openChats(tmpDir);
  const chat = chats.createChat({ title: 'T' });
  expect(() => chats.setSilent('nope', true)).toThrow(ChatNotFoundError);
  expect(() => chats.setSilent(chat.id, 'yes')).toThrow(InvalidChatMetaError);
});

test('a chat.created line written before origin/triggerId/silent existed still loads with the old defaults', () => {
  const chats = openChats(tmpDir);
  const chat = chats.createChat({ title: 'Old chat' });
  // Simulate a pre-upgrade log line by stripping the new fields directly
  // from the events.jsonl file, then reopening the store fresh.
  const eventsPath = path.join(tmpDir, 'chats', chat.id, 'events.jsonl');
  const wrapper = JSON.parse(fs.readFileSync(eventsPath, 'utf8').trim());
  delete wrapper.data.origin;
  delete wrapper.data.triggerId;
  delete wrapper.data.silent;
  fs.writeFileSync(eventsPath, `${JSON.stringify(wrapper)}\n`, 'utf8');

  const reopened = openChats(tmpDir);
  const reloaded = reopened.get(chat.id);
  expect(reloaded.origin).toBe('user');
  expect(reloaded.triggerId).toBeNull();
  expect(reloaded.silent).toBe(false);
});

test('get throws ChatNotFoundError for an unknown id', () => {
  const chats = openChats(tmpDir);
  expect(() => chats.get('nope')).toThrow(ChatNotFoundError);
});

test('events throws ChatNotFoundError for an unknown id', () => {
  const chats = openChats(tmpDir);
  expect(() => chats.events('nope')).toThrow(ChatNotFoundError);
});

test('appendEvent throws ChatNotFoundError for an unknown chatId', () => {
  const chats = openChats(tmpDir);
  expect(() => chats.appendEvent('nope', { kind: 'user', text: 'hi' })).toThrow(ChatNotFoundError);
});

test('appendEvent folds a user event into the projection', () => {
  const chats = openChats(tmpDir);
  const chat = chats.createChat({ title: 'T' });

  const stored = chats.appendEvent(chat.id, { kind: 'user', text: 'Hello there' });
  expect(stored.kind).toBe('user');
  expect(stored.text).toBe('Hello there');
  expect(typeof stored.ts).toBe('string');

  expect(chats.events(chat.id)).toEqual([stored]);
  expect(chats.get(chat.id).eventCount).toBe(1);
});

test('appendEvent sets ts when not given, and keeps a caller-provided ts', () => {
  const chats = openChats(tmpDir);
  const chat = chats.createChat({ title: 'T' });

  const withoutTs = chats.appendEvent(chat.id, { kind: 'user', text: 'a' });
  expect(typeof withoutTs.ts).toBe('string');
  expect(Number.isNaN(Date.parse(withoutTs.ts))).toBe(false);

  const withTs = chats.appendEvent(chat.id, { kind: 'user', text: 'b', ts: '2026-01-01T00:00:00.000Z' });
  expect(withTs.ts).toBe('2026-01-01T00:00:00.000Z');
});

test('appendEvent defaults optional fields to null (assistant msgId, tool msgId/resultRef)', () => {
  const chats = openChats(tmpDir);
  const chat = chats.createChat({ title: 'T' });

  const assistant = chats.appendEvent(chat.id, { kind: 'assistant', text: 'reply' });
  expect(assistant.msgId).toBeNull();

  const tool = chats.appendEvent(chat.id, { kind: 'tool', name: 'Bash', input: '{"command":"ls"}', result: 'ok' });
  expect(tool.msgId).toBeNull();
  expect(tool.resultRef).toBeNull();
});

test('appendEvent rejects an unknown event kind', () => {
  const chats = openChats(tmpDir);
  const chat = chats.createChat({ title: 'T' });
  expect(() => chats.appendEvent(chat.id, { kind: 'bogus', text: 'x' })).toThrow(UnknownEventKindError);
});

test('appendEvent rejects events missing required fields', () => {
  const chats = openChats(tmpDir);
  const chat = chats.createChat({ title: 'T' });

  expect(() => chats.appendEvent(chat.id, { kind: 'user' })).toThrow(InvalidEventError);
  expect(() => chats.appendEvent(chat.id, { kind: 'thinking' })).toThrow(InvalidEventError);

  let error;
  try {
    chats.appendEvent(chat.id, { kind: 'tool', name: 'Bash' });
  } catch (err) {
    error = err;
  }
  expect(error).toBeInstanceOf(InvalidEventError);
  expect(error.missing.sort()).toEqual(['input', 'result']);
});

test('multiple chats are isolated from each other', () => {
  const chats = openChats(tmpDir);
  const a = chats.createChat({ title: 'A' });
  const b = chats.createChat({ title: 'B' });

  chats.appendEvent(a.id, { kind: 'user', text: 'only in A' });

  expect(chats.events(a.id)).toHaveLength(1);
  expect(chats.events(b.id)).toHaveLength(0);
  expect(chats.list().map((c) => c.id).sort()).toEqual([a.id, b.id].sort());
});

test('the events file is append-only: line count grows monotonically and earlier lines never change', () => {
  const chats = openChats(tmpDir);
  const chat = chats.createChat({ title: 'T' });
  const eventsPath = path.join(tmpDir, 'chats', chat.id, 'events.jsonl');

  const readLines = () => fs.readFileSync(eventsPath, 'utf8').split('\n').filter(Boolean);

  const linesAfterCreate = readLines();
  expect(linesAfterCreate).toHaveLength(1);
  const firstLine = linesAfterCreate[0];

  chats.appendEvent(chat.id, { kind: 'user', text: 'a' });
  chats.appendEvent(chat.id, { kind: 'assistant', text: 'b' });

  const linesAfterMore = readLines();
  expect(linesAfterMore.length).toBe(3);
  expect(linesAfterMore[0]).toBe(firstLine);
});

test('reload from disk reproduces the same projection', () => {
  const chats = openChats(tmpDir);
  const chat = chats.createChat({ title: 'T' });
  chats.appendEvent(chat.id, { kind: 'user', text: 'hi' });
  chats.appendEvent(chat.id, { kind: 'assistant', text: 'hello' });
  chats.appendEvent(chat.id, { kind: 'tool', name: 'Bash', input: '{}', result: 'ok', resultRef: null });

  const reloaded = openChats(tmpDir);
  expect(reloaded.get(chat.id)).toEqual(chats.get(chat.id));
  expect(reloaded.list()).toEqual(chats.list());
  expect(reloaded.events(chat.id)).toEqual(chats.events(chat.id));
});

test('a corrupt line in a chat events.jsonl is skipped with a warning, no crash', () => {
  const chats = openChats(tmpDir);
  const chat = chats.createChat({ title: 'T' });
  chats.appendEvent(chat.id, { kind: 'user', text: 'hi' });

  const eventsPath = path.join(tmpDir, 'chats', chat.id, 'events.jsonl');
  fs.appendFileSync(eventsPath, 'this is not json\n', 'utf8');

  const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  let reloaded;
  expect(() => {
    reloaded = openChats(tmpDir);
  }).not.toThrow();
  expect(warnSpy).toHaveBeenCalledTimes(1);
  warnSpy.mockRestore();

  expect(reloaded.get(chat.id).title).toBe('T');
  expect(reloaded.events(chat.id)).toHaveLength(1);
});

test('a chat directory whose log has no valid chat.created line is skipped entirely on open', () => {
  const chats = openChats(tmpDir);
  const chat = chats.createChat({ title: 'T' });
  const eventsPath = path.join(tmpDir, 'chats', chat.id, 'events.jsonl');
  fs.writeFileSync(eventsPath, 'still not json\n', 'utf8');

  const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  const reloaded = openChats(tmpDir);
  warnSpy.mockRestore();

  expect(reloaded.list()).toEqual([]);
  expect(() => reloaded.get(chat.id)).toThrow(ChatNotFoundError);
});

// Compatibility test: a stored 'tool' event must expose exactly the keys
// src/parser/parse.mjs::digestSession() produces for a 'tool' event, since
// that shape is what web/src/components/EventBlock.tsx renders.
test('a stored tool event has the same keys as a digestSession tool event', async () => {
  const digest = await digestSession(MINI_SESSION_FIXTURE);
  const parserToolEvent = digest.events.find((e) => e.kind === 'tool');
  expect(parserToolEvent, 'fixture must contain at least one tool event').toBeTruthy();

  const chats = openChats(tmpDir);
  const chat = chats.createChat({ title: 'T' });
  const storedToolEvent = chats.appendEvent(chat.id, {
    kind: 'tool',
    name: 'Bash',
    input: '{"command":"ls"}',
    result: 'ok',
  });

  expect(Object.keys(storedToolEvent).sort()).toEqual(Object.keys(parserToolEvent).sort());
});

// --- missionId meta (a chat can belong to a mission) ---

test('createChat stores a missionId and lists it in the summary', () => {
  const chats = openChats(tmpDir);
  const chat = chats.createChat({ title: 'T', missionId: 'mission-1' });
  expect(chat.missionId).toBe('mission-1');
  expect(chats.get(chat.id).missionId).toBe('mission-1');
  expect(chats.list().find((c) => c.id === chat.id).missionId).toBe('mission-1');
});

test('missionId defaults to null and rejects non-string values', () => {
  const chats = openChats(tmpDir);
  expect(chats.createChat({ title: 'T' }).missionId).toBeNull();
  expect(() => chats.createChat({ title: 'T', missionId: 42 })).toThrow(InvalidChatMetaError);
});

test('a chat.created line written before missionId existed loads as null', () => {
  const chatId = 'aaaaaaaa-0000-0000-0000-000000000001';
  const dir = path.join(tmpDir, 'chats', chatId);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'events.jsonl'),
    `${JSON.stringify({ id: 'e1', ts: new Date().toISOString(), type: 'chat.created', data: { title: 'Old', origin: 'user', triggerId: null, silent: false } })}\n`,
    'utf8',
  );
  const chats = openChats(tmpDir);
  expect(chats.get(chatId).missionId).toBeNull();
});
