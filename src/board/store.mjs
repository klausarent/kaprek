// Board store — an append-only JSONL event log with an in-memory projection.
//
// There is no SQLite dependency here yet: board data is small (a handful of
// tasks per project) and append-only fits naturally with a future
// event-sync feature across machines. Every mutation is (1) written as one
// JSON line to <dataDir>/board/events.jsonl, then (2) folded into the
// in-memory projection. The events file is never rewritten, only appended
// to — openBoard() replays it from the start to rebuild the projection.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export const STATUSES = ['backlog', 'in_progress', 'in_review', 'blocked', 'done'];

// English field names for the 7-block completion doc (trigger/outcome/
// approach/course/verification/effort/open), required before a task can
// move to 'done'.
export const DOC_FIELDS = ['trigger', 'outcome', 'approach', 'course', 'verification', 'effort', 'open'];
const DOC_FIELD_MIN_LENGTH = 20;

const UPDATABLE_FIELDS = ['title', 'project', 'tags'];

export class TaskNotFoundError extends Error {
  constructor(taskId) {
    super(`task not found: ${taskId}`);
    this.name = 'TaskNotFoundError';
    this.taskId = taskId;
  }
}

export class InvalidTitleError extends Error {
  constructor() {
    super('title must be a non-empty string');
    this.name = 'InvalidTitleError';
  }
}

export class InvalidProjectError extends Error {
  constructor() {
    super('project must be a string or null');
    this.name = 'InvalidProjectError';
  }
}

export class InvalidTagsError extends Error {
  constructor() {
    super('tags must be an array of strings');
    this.name = 'InvalidTagsError';
  }
}

export class InvalidStatusError extends Error {
  constructor(status) {
    super(`invalid status: ${status} (expected one of ${STATUSES.join(', ')})`);
    this.name = 'InvalidStatusError';
    this.status = status;
  }
}

export class UnknownDocFieldError extends Error {
  constructor(field) {
    super(`unknown doc field: ${field} (expected one of ${DOC_FIELDS.join(', ')})`);
    this.name = 'UnknownDocFieldError';
    this.field = field;
  }
}

export class DocIncompleteError extends Error {
  constructor(missing) {
    super(`doc incomplete for 'done': missing or too short (< ${DOC_FIELD_MIN_LENGTH} chars) field(s): ${missing.join(', ')}`);
    this.name = 'DocIncompleteError';
    this.missing = missing;
  }
}

function eventsPathFor(dataDir) {
  return path.join(dataDir, 'board', 'events.jsonl');
}

/** Deep-clones a plain JSON-ish value so callers can't mutate internal projection state. */
function clone(value) {
  return value === undefined ? value : JSON.parse(JSON.stringify(value));
}

/** Picks only the fields callers are allowed to change via update(). */
function pickUpdatableFields(patch) {
  const result = {};
  for (const key of UPDATABLE_FIELDS) {
    if (key in patch) result[key] = patch[key];
  }
  return result;
}

/** Validates a doc patch's keys against DOC_FIELDS; throws on the first unknown key. */
function assertKnownDocFields(doc) {
  for (const field of Object.keys(doc)) {
    if (!DOC_FIELDS.includes(field)) throw new UnknownDocFieldError(field);
  }
}

/**
 * Returns the DOC_FIELDS entries that are missing or shorter than
 * DOC_FIELD_MIN_LENGTH. Exported so other modules (receipt signing) can
 * reuse the exact 'done' completeness rule instead of duplicating it.
 */
export function missingDocFields(doc) {
  return DOC_FIELDS.filter((field) => {
    const value = doc?.[field];
    return typeof value !== 'string' || value.trim().length < DOC_FIELD_MIN_LENGTH;
  });
}

/** Applies a single event to the projection map, mutating it in place. */
function applyEvent(tasks, event) {
  const { type, taskId, data, ts } = event;
  switch (type) {
    case 'task.created': {
      tasks.set(taskId, {
        id: taskId,
        title: data.title,
        project: data.project ?? null,
        tags: Array.isArray(data.tags) ? data.tags : [],
        status: 'backlog',
        createdAt: ts,
        updatedAt: ts,
        doc: null,
        sessions: [],
        receipt: null,
      });
      break;
    }
    case 'task.updated': {
      const task = tasks.get(taskId);
      if (!task) break;
      const patch = { ...data };
      if ('tags' in patch) patch.tags = Array.isArray(patch.tags) ? patch.tags : [];
      Object.assign(task, patch, { updatedAt: ts });
      break;
    }
    case 'task.status': {
      const task = tasks.get(taskId);
      if (!task) break;
      task.status = data.status;
      task.updatedAt = ts;
      break;
    }
    case 'task.doc': {
      const task = tasks.get(taskId);
      if (!task) break;
      task.doc = { ...(task.doc ?? {}), ...data.doc };
      task.updatedAt = ts;
      break;
    }
    case 'task.session': {
      const task = tasks.get(taskId);
      if (!task) break;
      const alreadyLinked = task.sessions.some(
        (s) => s.projectSlug === data.projectSlug && s.sessionId === data.sessionId,
      );
      if (!alreadyLinked) {
        task.sessions.push({ ...data });
        task.updatedAt = ts;
      }
      break;
    }
    case 'task.receipt': {
      const task = tasks.get(taskId);
      if (!task) break;
      task.receipt = data.receipt;
      task.updatedAt = ts;
      break;
    }
    default:
      // Unknown event type — skip. Keeps older readers forward-compatible
      // with event types introduced by a newer version of this module.
      break;
  }
}

/**
 * Reads events.jsonl (if it exists) and parses each line. A line that fails
 * to parse is skipped rather than crashing the whole load; all skips for one
 * load are summarized in a single console.warn call.
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
    console.warn(`board: skipped ${skipped} corrupt event line(s) while loading ${eventsPath}`);
  }
  return events;
}

/**
 * Opens the board for `dataDir`: loads and folds
 * `<dataDir>/board/events.jsonl` into an in-memory projection, and returns
 * an API for reading and mutating it. Every mutating call appends one event
 * line to the log before updating the projection; the file is never
 * rewritten, only appended to.
 */
export function openBoard(dataDir) {
  const boardDir = path.join(dataDir, 'board');
  const eventsFile = eventsPathFor(dataDir);

  const tasks = new Map();
  for (const event of loadEvents(eventsFile)) {
    applyEvent(tasks, event);
  }

  /** Appends one event to the log and folds it into the projection. */
  function commit(type, taskId, data) {
    const event = { id: crypto.randomUUID(), ts: new Date().toISOString(), type, taskId, data };
    fs.mkdirSync(boardDir, { recursive: true });
    fs.appendFileSync(eventsFile, `${JSON.stringify(event)}\n`, 'utf8');
    applyEvent(tasks, event);
    return event;
  }

  function requireTask(taskId) {
    const task = tasks.get(taskId);
    if (!task) throw new TaskNotFoundError(taskId);
    return task;
  }

  return {
    eventsPath: eventsFile,

    list({ status, project } = {}) {
      return [...tasks.values()]
        .filter((t) => status === undefined || t.status === status)
        .filter((t) => project === undefined || t.project === project)
        .map(clone);
    },

    get(taskId) {
      return clone(requireTask(taskId));
    },

    create({ title, project = null, tags = [] } = {}) {
      if (typeof title !== 'string' || title.trim().length === 0) throw new InvalidTitleError();
      const taskId = crypto.randomUUID();
      commit('task.created', taskId, { title, project, tags });
      return clone(requireTask(taskId));
    },

    update(taskId, patch) {
      requireTask(taskId);
      const fields = pickUpdatableFields(patch ?? {});
      if ('title' in fields && (typeof fields.title !== 'string' || fields.title.trim().length === 0)) {
        throw new InvalidTitleError();
      }
      if ('project' in fields && fields.project !== null && typeof fields.project !== 'string') {
        throw new InvalidProjectError();
      }
      if ('tags' in fields && (!Array.isArray(fields.tags) || !fields.tags.every((tag) => typeof tag === 'string'))) {
        throw new InvalidTagsError();
      }
      commit('task.updated', taskId, fields);
      return clone(requireTask(taskId));
    },

    setStatus(taskId, status) {
      if (!STATUSES.includes(status)) throw new InvalidStatusError(status);
      const task = requireTask(taskId);
      if (status === 'done') {
        const missing = missingDocFields(task.doc);
        if (missing.length > 0) throw new DocIncompleteError(missing);
      }
      commit('task.status', taskId, { status });
      return clone(requireTask(taskId));
    },

    setDoc(taskId, doc) {
      requireTask(taskId);
      assertKnownDocFields(doc ?? {});
      commit('task.doc', taskId, { doc });
      return clone(requireTask(taskId));
    },

    linkSession(taskId, { machine, projectSlug, sessionId }) {
      requireTask(taskId);
      commit('task.session', taskId, { machine, projectSlug, sessionId });
      return clone(requireTask(taskId));
    },

    setReceipt(taskId, receipt) {
      requireTask(taskId);
      commit('task.receipt', taskId, { receipt });
      return clone(requireTask(taskId));
    },
  };
}
