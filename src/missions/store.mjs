// Mission store — an append-only JSONL event log with an in-memory
// projection, structurally mirroring src/board/store.mjs (one shared log,
// full replay on open, corrupt lines skipped, unknown event types ignored).
//
// The mission is kaprek's central object: what a person wants to achieve.
// It bundles a goal, an optional working directory (the one deliberate door
// out of the <dataDir>/workspace jail — see the chat-turn route), and links
// to the chats and board tasks that carry the work. Chats and tasks remain
// authoritative for their own content; a mission only holds the links.
import fs from 'node:fs';
import { POSTURES, isPosture } from '../policy/guards.mjs';
import path from 'node:path';
import crypto from 'node:crypto';

export const MISSION_STATUSES = ['active', 'waiting', 'done', 'archived'];

const UPDATABLE_FIELDS = ['title', 'goal', 'posture'];

export class MissionNotFoundError extends Error {
  constructor(missionId) {
    super(`mission not found: ${missionId}`);
    this.name = 'MissionNotFoundError';
    this.missionId = missionId;
  }
}

export class InvalidTitleError extends Error {
  constructor() {
    super('title must be a non-empty string');
    this.name = 'InvalidTitleError';
  }
}

export class InvalidStatusError extends Error {
  constructor(status) {
    super(`invalid status: ${status} (expected one of ${MISSION_STATUSES.join(', ')})`);
    this.name = 'InvalidStatusError';
    this.status = status;
  }
}

export class InvalidCwdError extends Error {
  constructor(cwd) {
    super(`cwd must be null or an absolute path, got: ${cwd}`);
    this.name = 'InvalidCwdError';
    this.cwd = cwd;
  }
}

export class InvalidPostureError extends Error {
  constructor(posture) {
    super(`posture must be null or one of ${POSTURES.join(', ')}, got: ${JSON.stringify(posture)}`);
    this.name = 'InvalidPostureError';
    this.posture = posture;
  }
}

export class InvalidGoalError extends Error {
  constructor() {
    super('goal must be a string or null');
    this.name = 'InvalidGoalError';
  }
}

export class InvalidLinkError extends Error {
  constructor(kind) {
    super(`${kind} id must be a non-empty string`);
    this.name = 'InvalidLinkError';
    this.kind = kind;
  }
}

function eventsPathFor(dataDir) {
  return path.join(dataDir, 'missions', 'events.jsonl');
}

/** Deep-clones a plain JSON-ish value so callers can't mutate internal projection state. */
function clone(value) {
  return value === undefined ? value : JSON.parse(JSON.stringify(value));
}

/** Applies a single event to the projection map, mutating it in place. */
function applyEvent(missions, event) {
  const { type, missionId, data, ts } = event;
  switch (type) {
    case 'mission.created': {
      missions.set(missionId, {
        id: missionId,
        title: data.title,
        goal: data.goal ?? null,
        cwd: data.cwd ?? null,
        preset: data.preset ?? null,
        // The mission's own posture ceiling, or null for "the global one".
        // Only ever stricter than global in effect — see policy/guards.mjs.
        posture: data.posture ?? null,
        status: 'active',
        createdAt: ts,
        updatedAt: ts,
        chats: [],
        tasks: [],
      });
      break;
    }
    case 'mission.updated': {
      const mission = missions.get(missionId);
      if (!mission) break;
      const patch = {};
      for (const key of UPDATABLE_FIELDS) {
        if (key in data) patch[key] = data[key];
      }
      Object.assign(mission, patch, { updatedAt: ts });
      break;
    }
    case 'mission.status': {
      const mission = missions.get(missionId);
      if (!mission) break;
      mission.status = data.status;
      mission.updatedAt = ts;
      break;
    }
    case 'mission.chat': {
      const mission = missions.get(missionId);
      if (!mission) break;
      if (!mission.chats.includes(data.chatId)) {
        mission.chats.push(data.chatId);
        mission.updatedAt = ts;
      }
      break;
    }
    case 'mission.task': {
      const mission = missions.get(missionId);
      if (!mission) break;
      if (!mission.tasks.includes(data.taskId)) {
        mission.tasks.push(data.taskId);
        mission.updatedAt = ts;
      }
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
    console.warn(`missions: skipped ${skipped} corrupt event line(s) while loading ${eventsPath}`);
  }
  return events;
}

function assertLinkId(kind, id) {
  if (typeof id !== 'string' || id.trim().length === 0) throw new InvalidLinkError(kind);
}

/**
 * Opens the mission store for `dataDir`: loads and folds
 * `<dataDir>/missions/events.jsonl` into an in-memory projection, and
 * returns an API for reading and mutating it. Every mutating call appends
 * one event line to the log before updating the projection; the file is
 * never rewritten, only appended to.
 */
export function openMissions(dataDir) {
  const missionsDir = path.join(dataDir, 'missions');
  const eventsFile = eventsPathFor(dataDir);

  const missions = new Map();
  for (const event of loadEvents(eventsFile)) {
    applyEvent(missions, event);
  }

  /** Appends one event to the log and folds it into the projection. */
  function commit(type, missionId, data) {
    const event = { id: crypto.randomUUID(), ts: new Date().toISOString(), type, missionId, data };
    fs.mkdirSync(missionsDir, { recursive: true });
    fs.appendFileSync(eventsFile, `${JSON.stringify(event)}\n`, 'utf8');
    applyEvent(missions, event);
    return event;
  }

  function requireMission(missionId) {
    const mission = missions.get(missionId);
    if (!mission) throw new MissionNotFoundError(missionId);
    return mission;
  }

  function assertTitle(title) {
    if (typeof title !== 'string' || title.trim().length === 0) throw new InvalidTitleError();
  }

  function assertPosture(posture) {
    if (posture !== null && !isPosture(posture)) throw new InvalidPostureError(posture);
  }

  function assertCwd(cwd) {
    if (cwd === null) return;
    if (typeof cwd !== 'string' || !path.isAbsolute(cwd)) throw new InvalidCwdError(cwd);
  }

  return {
    eventsPath: eventsFile,

    list({ status } = {}) {
      return [...missions.values()]
        .filter((m) => status === undefined || m.status === status)
        .map(clone);
    },

    get(missionId) {
      return clone(requireMission(missionId));
    },

    create({ title, goal = null, cwd = null, preset = null, posture = null } = {}) {
      assertTitle(title);
      if (goal !== null && typeof goal !== 'string') throw new InvalidGoalError();
      assertCwd(cwd);
      if (preset !== null && typeof preset !== 'string') {
        throw new InvalidLinkError('preset');
      }
      const missionId = crypto.randomUUID();
      assertPosture(posture);
      commit('mission.created', missionId, { title, goal, cwd, preset, posture });
      return clone(requireMission(missionId));
    },

    update(missionId, patch) {
      requireMission(missionId);
      const fields = {};
      for (const key of UPDATABLE_FIELDS) {
        if (patch && key in patch) fields[key] = patch[key];
      }
      if ('title' in fields) assertTitle(fields.title);
      if ('goal' in fields && fields.goal !== null && typeof fields.goal !== 'string') {
        throw new InvalidGoalError();
      }
      if ('posture' in fields) assertPosture(fields.posture);
      commit('mission.updated', missionId, fields);
      return clone(requireMission(missionId));
    },

    setStatus(missionId, status) {
      if (!MISSION_STATUSES.includes(status)) throw new InvalidStatusError(status);
      requireMission(missionId);
      commit('mission.status', missionId, { status });
      return clone(requireMission(missionId));
    },

    linkChat(missionId, chatId) {
      assertLinkId('chat', chatId);
      requireMission(missionId);
      commit('mission.chat', missionId, { chatId });
      return clone(requireMission(missionId));
    },

    linkTask(missionId, taskId) {
      assertLinkId('task', taskId);
      requireMission(missionId);
      commit('mission.task', missionId, { taskId });
      return clone(requireMission(missionId));
    },
  };
}
