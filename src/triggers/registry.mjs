// Trigger registry — the data shape a trigger (see src/triggers/runner.mjs)
// must satisfy, and its persistence at `<dataDir>/triggers.json`.
//
// Same validation posture as src/apps/manifest.mjs: an unknown field is a
// hard error, not silently ignored, so a hand-edited or UI-submitted trigger
// with a typo fails loudly at upsert time instead of quietly doing nothing.
// `escalation` is the field this whole layer exists to protect — see its
// doc comment below — so it gets a mandatory default rather than being left
// truly optional.
import fs from 'node:fs';
import path from 'node:path';

const ID_RE = /^[a-z0-9-]{1,64}$/;

export const TRIGGER_TYPES = ['heartbeat', 'schedule'];
export const ESCALATIONS = ['notify', 'question', 'review'];

// Ceilings a trigger's own `limits` may never exceed, regardless of what a
// caller requests — the last line of defense if src/triggers/limits.mjs's
// per-trigger enforcement is ever misconfigured or bypassed.
const MAX_RUNS_PER_DAY_CEILING = 500;
const MAX_COST_PER_DAY_CEILING = 50;
const DEFAULT_LIMITS = Object.freeze({ maxRunsPerDay: 24, maxCostPerDay: 1.0 });

const MAX_PROMPT_TEMPLATE_LENGTH = 4000;
const DEFAULT_CHECKLIST_PATH = 'CHECKLIST.md';
const DAILY_AT_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

const KNOWN_TOP_FIELDS = ['id', 'type', 'config', 'promptTemplate', 'escalation', 'appScope', 'enabled', 'approvalRequired', 'limits'];
const KNOWN_HEARTBEAT_CONFIG_FIELDS = ['intervalMinutes', 'checklistPath'];
const KNOWN_SCHEDULE_CONFIG_FIELDS = ['everyMinutes', 'dailyAt'];
const KNOWN_LIMITS_FIELDS = ['maxRunsPerDay', 'maxCostPerDay'];

export class InvalidTriggerError extends Error {
  constructor(field, message) {
    super(`${field}: ${message}`);
    this.name = 'InvalidTriggerError';
    this.field = field;
  }
}

function fail(field, message) {
  throw new InvalidTriggerError(field, message);
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function assertNoUnknownFields(obj, known, fieldPrefix) {
  for (const key of Object.keys(obj)) {
    if (!known.includes(key)) {
      fail(fieldPrefix ? `${fieldPrefix}.${key}` : key, `unknown field (expected one of ${known.join(', ')})`);
    }
  }
}

function validateHeartbeatConfig(config) {
  if (!isPlainObject(config)) fail('config', 'must be an object for type "heartbeat"');
  assertNoUnknownFields(config, KNOWN_HEARTBEAT_CONFIG_FIELDS, 'config');
  const { intervalMinutes, checklistPath } = config;
  if (typeof intervalMinutes !== 'number' || !Number.isFinite(intervalMinutes) || intervalMinutes < 5 || intervalMinutes > 1440) {
    fail('config.intervalMinutes', 'must be a number between 5 and 1440');
  }
  if (checklistPath !== undefined && (typeof checklistPath !== 'string' || checklistPath.trim().length === 0)) {
    fail('config.checklistPath', 'must be a non-empty string');
  }
  return { intervalMinutes, checklistPath: checklistPath ?? DEFAULT_CHECKLIST_PATH };
}

function validateScheduleConfig(config) {
  if (!isPlainObject(config)) fail('config', 'must be an object for type "schedule"');
  assertNoUnknownFields(config, KNOWN_SCHEDULE_CONFIG_FIELDS, 'config');
  const hasEvery = config.everyMinutes !== undefined;
  const hasDaily = config.dailyAt !== undefined;
  // Exactly one of the two shapes — never both, never neither. No cron
  // syntax in v1 (see the task brief): a custom parser is only fresh attack
  // surface for a feature nobody asked to write cron for.
  if (hasEvery === hasDaily) {
    fail('config', 'exactly one of "everyMinutes" or "dailyAt" is required');
  }
  if (hasEvery) {
    const { everyMinutes } = config;
    if (typeof everyMinutes !== 'number' || !Number.isFinite(everyMinutes) || everyMinutes < 5 || everyMinutes > 10080) {
      fail('config.everyMinutes', 'must be a number between 5 and 10080');
    }
    return { everyMinutes };
  }
  if (typeof config.dailyAt !== 'string' || !DAILY_AT_RE.test(config.dailyAt)) {
    fail('config.dailyAt', 'must be a 24h "HH:MM" string');
  }
  return { dailyAt: config.dailyAt };
}

function validateLimits(limits) {
  if (limits === undefined) return { ...DEFAULT_LIMITS };
  if (!isPlainObject(limits)) fail('limits', 'must be an object');
  assertNoUnknownFields(limits, KNOWN_LIMITS_FIELDS, 'limits');

  const maxRunsPerDay = limits.maxRunsPerDay ?? DEFAULT_LIMITS.maxRunsPerDay;
  if (typeof maxRunsPerDay !== 'number' || !Number.isFinite(maxRunsPerDay) || maxRunsPerDay <= 0) {
    fail('limits.maxRunsPerDay', 'must be a positive number');
  }
  if (maxRunsPerDay > MAX_RUNS_PER_DAY_CEILING) {
    fail('limits.maxRunsPerDay', `must not exceed ${MAX_RUNS_PER_DAY_CEILING}`);
  }

  const maxCostPerDay = limits.maxCostPerDay ?? DEFAULT_LIMITS.maxCostPerDay;
  if (typeof maxCostPerDay !== 'number' || !Number.isFinite(maxCostPerDay) || maxCostPerDay <= 0) {
    fail('limits.maxCostPerDay', 'must be a positive number');
  }
  if (maxCostPerDay > MAX_COST_PER_DAY_CEILING) {
    fail('limits.maxCostPerDay', `must not exceed ${MAX_COST_PER_DAY_CEILING}`);
  }

  return { maxRunsPerDay, maxCostPerDay };
}

/**
 * Validates a trigger object and returns a normalized copy (defaults filled
 * in, unknown fields already rejected). Throws InvalidTriggerError with a
 * `.field` naming exactly what was wrong, on the first violation found.
 *
 * `escalation` answers "when may this trigger interrupt the user" — the
 * model ambient-agent products use to keep proactivity from becoming spam:
 * 'notify' (a fact, no action taken without separate approval), 'question'
 * (the agent asks before acting), 'review' (the agent prepares, a human
 * approves). It is a mandatory field WITH a default ('notify', the least
 * disruptive) rather than a truly optional one — a trigger author who never
 * thought about escalation gets the safe default, not an error, but the
 * field itself always exists on every stored trigger.
 */
export function validateTrigger(obj) {
  if (!isPlainObject(obj)) fail('<root>', 'trigger must be an object');
  assertNoUnknownFields(obj, KNOWN_TOP_FIELDS, '');

  if (typeof obj.id !== 'string' || !ID_RE.test(obj.id)) {
    fail('id', 'must match [a-z0-9-]{1,64}');
  }
  if (!TRIGGER_TYPES.includes(obj.type)) {
    fail('type', `must be one of ${TRIGGER_TYPES.join(', ')}`);
  }
  if (typeof obj.promptTemplate !== 'string' || obj.promptTemplate.length === 0) {
    fail('promptTemplate', 'must be a non-empty string');
  }
  if (obj.promptTemplate.length > MAX_PROMPT_TEMPLATE_LENGTH) {
    fail('promptTemplate', `must not exceed ${MAX_PROMPT_TEMPLATE_LENGTH} characters`);
  }
  if (obj.escalation !== undefined && !ESCALATIONS.includes(obj.escalation)) {
    fail('escalation', `must be one of ${ESCALATIONS.join(', ')}`);
  }
  if (!Array.isArray(obj.appScope) || !obj.appScope.every((id) => typeof id === 'string' && id.length > 0)) {
    // An empty array is valid (and means "no app may be used" — see
    // src/triggers/runner.mjs's allowedToolsFor()); what's rejected is a
    // non-array or an array with a non-string/empty entry.
    fail('appScope', 'must be an array of non-empty strings (app ids); use [] for none');
  }
  if (obj.enabled !== undefined && typeof obj.enabled !== 'boolean') {
    fail('enabled', 'must be a boolean');
  }
  if (obj.approvalRequired !== undefined && typeof obj.approvalRequired !== 'boolean') {
    fail('approvalRequired', 'must be a boolean');
  }

  const config = obj.type === 'heartbeat' ? validateHeartbeatConfig(obj.config) : validateScheduleConfig(obj.config);
  const limits = validateLimits(obj.limits);
  const escalation = obj.escalation ?? 'notify';

  return {
    id: obj.id,
    type: obj.type,
    config,
    promptTemplate: obj.promptTemplate,
    escalation,
    appScope: [...obj.appScope],
    enabled: obj.enabled ?? false,
    // Default: approval is required the moment escalation says the agent
    // must ask or hand off for review — see the escalation doc comment
    // above. A caller may still opt IN explicitly for 'notify' (e.g. a
    // future policy layer), just never opt OUT of it for 'question'/'review'
    // by omission.
    approvalRequired: obj.approvalRequired ?? escalation !== 'notify',
    limits,
  };
}

function triggersPathFor(dataDir) {
  return path.join(dataDir, 'triggers.json');
}

/**
 * Reads `<dataDir>/triggers.json`. Missing file, corrupt JSON, or an
 * unexpected top-level shape all fall back to an empty list rather than
 * throwing — a broken triggers.json must never take the whole server down
 * (same posture as src/orchestrator/runs.mjs::readRuns() skipping corrupt
 * lines), it just means no trigger fires until the file is fixed.
 */
function readTriggersFile(dataDir) {
  const triggersPath = triggersPathFor(dataDir);
  if (!fs.existsSync(triggersPath)) return [];

  let raw;
  try {
    raw = fs.readFileSync(triggersPath, 'utf8');
  } catch (err) {
    console.warn(`triggers: failed to read ${triggersPath}: ${err.message}`);
    return [];
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    console.warn(`triggers: corrupt JSON in ${triggersPath}, starting from an empty list: ${err.message}`);
    return [];
  }

  if (!isPlainObject(parsed) || !Array.isArray(parsed.triggers)) {
    console.warn(`triggers: unexpected shape in ${triggersPath}, starting from an empty list`);
    return [];
  }
  return parsed.triggers;
}

/** Atomic write (tmp file + rename), matching src/cli/hooks.mjs::writeSettings / src/orchestrator/run.mjs::writeHarnessMeta. */
function writeTriggersFile(dataDir, triggers) {
  const triggersPath = triggersPathFor(dataDir);
  fs.mkdirSync(dataDir, { recursive: true });
  const tmpPath = path.join(dataDir, `.triggers.json.tmp-${process.pid}-${Date.now()}`);
  fs.writeFileSync(tmpPath, `${JSON.stringify({ version: 1, triggers }, null, 2)}\n`, 'utf8');
  fs.renameSync(tmpPath, triggersPath);
}

/**
 * Opens the trigger registry for `dataDir`: loads `triggers.json` (or starts
 * empty, see readTriggersFile()) and returns an API for reading and
 * mutating it. Every mutating call re-validates and rewrites the whole file
 * atomically — trigger count is expected to stay small (a handful per
 * user), so a full rewrite per change is simpler than an append-only log
 * and costs nothing measurable here.
 */
export function openTriggers(dataDir) {
  let triggers = readTriggersFile(dataDir);

  return {
    list() {
      return triggers.map((t) => ({ ...t }));
    },

    get(id) {
      const trigger = triggers.find((t) => t.id === id);
      return trigger ? { ...trigger } : null;
    },

    /** Validates `trigger`, then inserts it (new id) or replaces the existing entry with the same id. Returns the normalized, stored trigger. */
    upsert(trigger) {
      const validated = validateTrigger(trigger);
      const index = triggers.findIndex((t) => t.id === validated.id);
      const next = triggers.slice();
      if (index >= 0) next[index] = validated;
      else next.push(validated);
      writeTriggersFile(dataDir, next);
      triggers = next;
      return { ...validated };
    },

    /** Removes the trigger with `id`, if any. Returns whether one was removed. */
    remove(id) {
      const index = triggers.findIndex((t) => t.id === id);
      if (index < 0) return false;
      const next = triggers.slice();
      next.splice(index, 1);
      writeTriggersFile(dataDir, next);
      triggers = next;
      return true;
    },

    /** Flips `enabled` on the trigger with `id`. Returns the updated trigger, or null if unknown. */
    setEnabled(id, enabled) {
      const index = triggers.findIndex((t) => t.id === id);
      if (index < 0) return null;
      const next = triggers.slice();
      next[index] = { ...next[index], enabled: !!enabled };
      writeTriggersFile(dataDir, next);
      triggers = next;
      return { ...next[index] };
    },
  };
}
