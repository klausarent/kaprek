// Mission store tests — the mission is kaprek's central object (Zielbild M0):
// a goal with a working directory, linked chats, and linked board tasks.
// The store mirrors src/board/store.mjs: append-only events.jsonl, replay on
// open, corrupt lines skipped, unknown event types ignored.
import { expect, test, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  openMissions,
  MISSION_STATUSES,
  MissionNotFoundError,
  InvalidTitleError,
  InvalidStatusError,
  InvalidCwdError,
  InvalidLinkError,
  InvalidPostureError,
} from './store.mjs';

function tmpDataDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'kaprek-missions-'));
}

test('create/list/get roundtrip with defaults', () => {
  const store = openMissions(tmpDataDir());
  const m = store.create({ title: 'Ship the widget' });
  expect(m.status).toBe('active');
  expect(m.cwd).toBeNull();
  expect(m.goal).toBeNull();
  expect(m.preset).toBeNull();
  expect(m.chats).toEqual([]);
  expect(m.tasks).toEqual([]);
  expect(store.list()).toHaveLength(1);
  expect(store.get(m.id).title).toBe('Ship the widget');
});

test('MISSION_STATUSES is the exact lifecycle vocabulary', () => {
  expect(MISSION_STATUSES).toEqual(['active', 'waiting', 'done', 'archived']);
});

test('create rejects an empty title', () => {
  const store = openMissions(tmpDataDir());
  expect(() => store.create({ title: '' })).toThrow(InvalidTitleError);
  expect(() => store.create({})).toThrow(InvalidTitleError);
});

test('cwd must be an absolute path when given', () => {
  const store = openMissions(tmpDataDir());
  expect(() => store.create({ title: 'x', cwd: 'relative/dir' })).toThrow(InvalidCwdError);
  expect(() => store.create({ title: 'x', cwd: 42 })).toThrow(InvalidCwdError);
  const abs = tmpDataDir();
  expect(store.create({ title: 'x', cwd: abs }).cwd).toBe(abs);
});

test('setStatus validates against MISSION_STATUSES', () => {
  const store = openMissions(tmpDataDir());
  const m = store.create({ title: 'x' });
  expect(store.setStatus(m.id, 'waiting').status).toBe('waiting');
  expect(() => store.setStatus(m.id, 'paused')).toThrow(InvalidStatusError);
});

test('get/setStatus on an unknown id throws MissionNotFoundError', () => {
  const store = openMissions(tmpDataDir());
  expect(() => store.get('nope')).toThrow(MissionNotFoundError);
  expect(() => store.setStatus('nope', 'done')).toThrow(MissionNotFoundError);
});

test('update changes title and goal, nothing else', () => {
  const store = openMissions(tmpDataDir());
  const m = store.create({ title: 'x', goal: 'old' });
  const updated = store.update(m.id, { title: 'y', goal: 'new', status: 'done', cwd: '/sneaky' });
  expect(updated.title).toBe('y');
  expect(updated.goal).toBe('new');
  expect(updated.status).toBe('active');
  expect(updated.cwd).toBeNull();
  expect(() => store.update(m.id, { title: '' })).toThrow(InvalidTitleError);
});

test('linkChat is idempotent', () => {
  const store = openMissions(tmpDataDir());
  const m = store.create({ title: 'x' });
  store.linkChat(m.id, 'chat-1');
  store.linkChat(m.id, 'chat-1');
  store.linkChat(m.id, 'chat-2');
  expect(store.get(m.id).chats).toEqual(['chat-1', 'chat-2']);
});

test('linkTask is idempotent and validates its id', () => {
  const store = openMissions(tmpDataDir());
  const m = store.create({ title: 'x' });
  store.linkTask(m.id, 'task-1');
  store.linkTask(m.id, 'task-1');
  expect(store.get(m.id).tasks).toEqual(['task-1']);
  expect(() => store.linkTask(m.id, '')).toThrow(InvalidLinkError);
  expect(() => store.linkChat(m.id, null)).toThrow(InvalidLinkError);
});

test('projection survives reload from disk', () => {
  const dir = tmpDataDir();
  const a = openMissions(dir);
  const m = a.create({ title: 'x', goal: 'g' });
  a.setStatus(m.id, 'waiting');
  a.linkChat(m.id, 'chat-1');
  const b = openMissions(dir);
  const loaded = b.get(m.id);
  expect(loaded.status).toBe('waiting');
  expect(loaded.goal).toBe('g');
  expect(loaded.chats).toEqual(['chat-1']);
});

test('a corrupt event line is skipped with a summary warning, the rest load', () => {
  const dir = tmpDataDir();
  const a = openMissions(dir);
  const m = a.create({ title: 'x' });
  fs.appendFileSync(path.join(dir, 'missions', 'events.jsonl'), '{corrupt\n', 'utf8');
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  const b = openMissions(dir);
  expect(b.get(m.id).title).toBe('x');
  expect(warn).toHaveBeenCalledOnce();
  warn.mockRestore();
});

test('an unknown event type is ignored, not fatal', () => {
  const dir = tmpDataDir();
  const a = openMissions(dir);
  const m = a.create({ title: 'x' });
  fs.appendFileSync(
    path.join(dir, 'missions', 'events.jsonl'),
    `${JSON.stringify({ id: 'e', ts: new Date().toISOString(), type: 'mission.future-thing', missionId: m.id, data: {} })}\n`,
    'utf8',
  );
  const b = openMissions(dir);
  expect(b.get(m.id).title).toBe('x');
});

test('returned missions are clones — mutating them does not corrupt the store', () => {
  const store = openMissions(tmpDataDir());
  const m = store.create({ title: 'x' });
  m.chats.push('sneaky');
  expect(store.get(m.id).chats).toEqual([]);
});

test('list filters by status', () => {
  const store = openMissions(tmpDataDir());
  const a = store.create({ title: 'a' });
  store.create({ title: 'b' });
  store.setStatus(a.id, 'done');
  expect(store.list({ status: 'done' }).map((m) => m.title)).toEqual(['a']);
  expect(store.list({ status: 'active' }).map((m) => m.title)).toEqual(['b']);
});

test('a mission may carry its own posture ceiling, cleared with null, and refuses anything else', () => {
  const store = openMissions(tmpDataDir());
  const plain = store.create({ title: 'plain' });
  expect(plain.posture).toBeNull();
  const strict = store.create({ title: 'strict', posture: 'ask' });
  expect(strict.posture).toBe('ask');
  expect(store.update(strict.id, { posture: 'edits' }).posture).toBe('edits');
  expect(store.update(strict.id, { posture: null }).posture).toBeNull();
  expect(() => store.create({ title: 'x', posture: 'yolo' })).toThrow(InvalidPostureError);
  expect(() => store.update(plain.id, { posture: 'auto-ish' })).toThrow(InvalidPostureError);
});
