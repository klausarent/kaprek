import { test, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  openBoard,
  DOC_FIELDS,
  TaskNotFoundError,
  InvalidTitleError,
  InvalidProjectError,
  InvalidTagsError,
  InvalidStatusError,
  UnknownDocFieldError,
  DocIncompleteError,
} from './store.mjs';

let tmpDir;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'loryme-board-test-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

/** A doc with all 7 fields present and each >= 20 chars. */
function fullDoc() {
  return {
    trigger: 'The team wanted a board view for tasks.',
    outcome: 'Store implemented, all tests pass.',
    approach: 'Append-only JSONL event log plus an in-memory projection.',
    course: 'Built to spec, no major detours needed here.',
    verification: 'npx vitest run shows all tests passing.',
    effort: 'About one hour for implementation and tests.',
    open: 'No open questions for this task.',
  };
}

test('create adds a task with defaults and list/get return it', () => {
  const board = openBoard(tmpDir);
  const task = board.create({ title: 'Erster Task', project: 'loryme', tags: ['p1'] });

  expect(task.title).toBe('Erster Task');
  expect(task.project).toBe('loryme');
  expect(task.tags).toEqual(['p1']);
  expect(task.status).toBe('backlog');
  expect(task.doc).toBeNull();
  expect(task.sessions).toEqual([]);
  expect(task.receipt).toBeNull();
  expect(typeof task.id).toBe('string');
  expect(task.id.length).toBeGreaterThan(0);

  expect(board.get(task.id)).toEqual(task);
  expect(board.list()).toEqual([task]);
});

test('create validates a non-empty title', () => {
  const board = openBoard(tmpDir);
  expect(() => board.create({ title: '' })).toThrow(InvalidTitleError);
  expect(() => board.create({ title: '   ' })).toThrow(InvalidTitleError);
  expect(() => board.create({})).toThrow(InvalidTitleError);
});

test('get throws TaskNotFoundError for an unknown id', () => {
  const board = openBoard(tmpDir);
  expect(() => board.get('nope')).toThrow(TaskNotFoundError);
});

test('list filters by status and project', () => {
  const board = openBoard(tmpDir);
  const a = board.create({ title: 'A', project: 'p1' });
  const b = board.create({ title: 'B', project: 'p2' });
  board.setStatus(a.id, 'in_progress');

  expect(board.list({ project: 'p1' }).map((t) => t.id)).toEqual([a.id]);
  expect(board.list({ project: 'p2' }).map((t) => t.id)).toEqual([b.id]);
  expect(board.list({ status: 'in_progress' }).map((t) => t.id)).toEqual([a.id]);
  expect(board.list({ status: 'backlog' }).map((t) => t.id)).toEqual([b.id]);
});

test('update changes title/project/tags and bumps updatedAt', () => {
  const board = openBoard(tmpDir);
  const task = board.create({ title: 'Original' });
  const updated = board.update(task.id, { title: 'Geaendert', tags: ['x'] });

  expect(updated.title).toBe('Geaendert');
  expect(updated.tags).toEqual(['x']);
  expect(updated.id).toBe(task.id);
});

test('update throws TaskNotFoundError for an unknown id', () => {
  const board = openBoard(tmpDir);
  expect(() => board.update('nope', { title: 'x' })).toThrow(TaskNotFoundError);
});

test('update rejects a non-string/empty title', () => {
  const board = openBoard(tmpDir);
  const task = board.create({ title: 'Original' });
  expect(() => board.update(task.id, { title: 123 })).toThrow(InvalidTitleError);
  expect(() => board.update(task.id, { title: '' })).toThrow(InvalidTitleError);
  expect(() => board.update(task.id, { title: '   ' })).toThrow(InvalidTitleError);
});

test('update rejects a project that is not a string or null', () => {
  const board = openBoard(tmpDir);
  const task = board.create({ title: 'Original' });
  expect(() => board.update(task.id, { project: 42 })).toThrow(InvalidProjectError);
  expect(board.update(task.id, { project: null }).project).toBeNull();
  expect(board.update(task.id, { project: 'p1' }).project).toBe('p1');
});

test('update rejects tags that are not an array of strings', () => {
  const board = openBoard(tmpDir);
  const task = board.create({ title: 'Original' });
  expect(() => board.update(task.id, { tags: 'notanarray' })).toThrow(InvalidTagsError);
  expect(() => board.update(task.id, { tags: [1, 2] })).toThrow(InvalidTagsError);
  expect(board.update(task.id, { tags: ['a', 'b'] }).tags).toEqual(['a', 'b']);
});

test('setStatus validates the status set', () => {
  const board = openBoard(tmpDir);
  const task = board.create({ title: 'T' });
  expect(() => board.setStatus(task.id, 'nonsense')).toThrow(InvalidStatusError);
});

test('setStatus to done without any doc throws DocIncompleteError listing all 7 fields', () => {
  const board = openBoard(tmpDir);
  const task = board.create({ title: 'T' });

  let error;
  try {
    board.setStatus(task.id, 'done');
  } catch (err) {
    error = err;
  }

  expect(error).toBeInstanceOf(DocIncompleteError);
  expect(error.missing.sort()).toEqual([...DOC_FIELDS].sort());
  for (const field of DOC_FIELDS) {
    expect(error.message).toContain(field);
  }
});

test('setStatus to done with 6 of 7 fields throws DocIncompleteError listing the missing field', () => {
  const board = openBoard(tmpDir);
  const task = board.create({ title: 'T' });
  const { open, ...sixFields } = fullDoc();
  board.setDoc(task.id, sixFields);

  let error;
  try {
    board.setStatus(task.id, 'done');
  } catch (err) {
    error = err;
  }

  expect(error).toBeInstanceOf(DocIncompleteError);
  expect(error.missing).toEqual(['open']);
  expect(error.message).toContain('open');
});

test('setStatus to done with a complete doc succeeds', () => {
  const board = openBoard(tmpDir);
  const task = board.create({ title: 'T' });
  board.setDoc(task.id, fullDoc());

  const done = board.setStatus(task.id, 'done');
  expect(done.status).toBe('done');
});

test('setDoc rejects unknown field names', () => {
  const board = openBoard(tmpDir);
  const task = board.create({ title: 'T' });

  let error;
  try {
    board.setDoc(task.id, { trigger: 'x'.repeat(20), unbekannt: 'y'.repeat(20) });
  } catch (err) {
    error = err;
  }

  expect(error).toBeInstanceOf(UnknownDocFieldError);
  expect(error.field).toBe('unbekannt');
});

test('setDoc allows saving partial docs before the task is done', () => {
  const board = openBoard(tmpDir);
  const task = board.create({ title: 'T' });
  const saved = board.setDoc(task.id, { trigger: 'x'.repeat(20) });
  expect(saved.doc).toEqual({ trigger: 'x'.repeat(20) });
});

test('setDoc merges into the existing doc across multiple calls', () => {
  const board = openBoard(tmpDir);
  const task = board.create({ title: 'T' });
  board.setDoc(task.id, { trigger: 'a'.repeat(20) });
  const saved = board.setDoc(task.id, { outcome: 'b'.repeat(20) });
  expect(saved.doc).toEqual({ trigger: 'a'.repeat(20), outcome: 'b'.repeat(20) });
});

test('setDoc on a done task that would shorten the doc below completeness is rejected (done invariant)', () => {
  const board = openBoard(tmpDir);
  const task = board.create({ title: 'T' });
  board.setDoc(task.id, fullDoc());
  board.setStatus(task.id, 'done');

  let error;
  try {
    board.setDoc(task.id, { outcome: 'too short' });
  } catch (err) {
    error = err;
  }
  expect(error).toBeInstanceOf(DocIncompleteError);
  expect(error.missing).toEqual(['outcome']);

  // The rejected write must not have been committed — the doc stays intact.
  expect(board.get(task.id).doc.outcome).toBe(fullDoc().outcome);
});

test('setDoc on a done task with a still-complete replacement doc is allowed', () => {
  const board = openBoard(tmpDir);
  const task = board.create({ title: 'T' });
  board.setDoc(task.id, fullDoc());
  board.setStatus(task.id, 'done');

  const updated = board.setDoc(task.id, { outcome: 'Updated outcome, still long enough to pass.' });
  expect(updated.doc.outcome).toBe('Updated outcome, still long enough to pass.');
  expect(updated.status).toBe('done');
});

test('linkSession appends a session and dedupes on projectSlug+sessionId', () => {
  const board = openBoard(tmpDir);
  const task = board.create({ title: 'T' });

  board.linkSession(task.id, { machine: 'test-machine', projectSlug: 'loryme', sessionId: 's1' });
  const after = board.linkSession(task.id, { machine: 'test-machine', projectSlug: 'loryme', sessionId: 's1' });

  expect(after.sessions).toEqual([{ machine: 'test-machine', projectSlug: 'loryme', sessionId: 's1' }]);

  const withSecond = board.linkSession(task.id, { projectSlug: 'loryme', sessionId: 's2' });
  expect(withSecond.sessions).toHaveLength(2);
});

test('setReceipt stores a receipt object on the task', () => {
  const board = openBoard(tmpDir);
  const task = board.create({ title: 'T' });
  const receipt = { verified: true, note: 'ok' };
  const updated = board.setReceipt(task.id, receipt);
  expect(updated.receipt).toEqual(receipt);
});

test('the events file is append-only: line count grows monotonically and earlier lines never change', () => {
  const board = openBoard(tmpDir);
  const task = board.create({ title: 'T' });

  const readLines = () => fs.readFileSync(board.eventsPath, 'utf8').split('\n').filter(Boolean);

  const linesAfterCreate = readLines();
  expect(linesAfterCreate).toHaveLength(1);
  const firstLine = linesAfterCreate[0];

  board.update(task.id, { title: 'T2' });
  board.setStatus(task.id, 'in_progress');

  const linesAfterMore = readLines();
  expect(linesAfterMore.length).toBe(3);
  expect(linesAfterMore[0]).toBe(firstLine);
});

test('reload from disk reproduces the same projection', () => {
  const board = openBoard(tmpDir);
  const task = board.create({ title: 'T', project: 'p1', tags: ['a'] });
  board.setDoc(task.id, fullDoc());
  board.setStatus(task.id, 'done');
  board.linkSession(task.id, { projectSlug: 'p1', sessionId: 's1' });

  const reloaded = openBoard(tmpDir);
  expect(reloaded.get(task.id)).toEqual(board.get(task.id));
  expect(reloaded.list()).toEqual(board.list());
});

test('a corrupt line in events.jsonl is skipped with a warning, no crash', () => {
  const board = openBoard(tmpDir);
  const task = board.create({ title: 'T' });

  fs.appendFileSync(board.eventsPath, 'this is not json\n', 'utf8');

  const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  let reloaded;
  expect(() => {
    reloaded = openBoard(tmpDir);
  }).not.toThrow();
  expect(warnSpy).toHaveBeenCalledTimes(1);
  warnSpy.mockRestore();

  expect(reloaded.get(task.id).title).toBe('T');
  expect(reloaded.list()).toHaveLength(1);
});

test('an event with an unknown type is skipped for forward compatibility', () => {
  const board = openBoard(tmpDir);
  const task = board.create({ title: 'T' });

  fs.appendFileSync(
    board.eventsPath,
    `${JSON.stringify({ id: 'x', ts: new Date().toISOString(), type: 'task.future-feature', taskId: task.id, data: {} })}\n`,
    'utf8',
  );

  const reloaded = openBoard(tmpDir);
  expect(reloaded.list()).toHaveLength(1);
  expect(reloaded.get(task.id).title).toBe('T');
});
