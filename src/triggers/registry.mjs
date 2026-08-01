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
import { assertSafeRelPath, WorkspacePathError } from '../workspace/fs.mjs';

const ID_RE = /^[a-z0-9-]{1,64}$/;

export const TRIGGER_TYPES = ['heartbeat', 'schedule', 'file-watch', 'clipboard', 'saved-prompt'];
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

// file-watch: the debounce window exists because a single save fires several
// fs.watch events on Windows (see runner.mjs's watcher). 100 ms is the floor
// (below that the debounce stops collapsing anything), 60 s the ceiling (a
// longer "wait and see" is a schedule trigger, not a file watcher).
export const FILE_WATCH_EVENTS = ['add', 'change', 'unlink'];
const DEFAULT_DEBOUNCE_MS = 500;
const MIN_DEBOUNCE_MS = 100;
const MAX_DEBOUNCE_MS = 60_000;
const MAX_WATCH_DEPTH = 32;

// clipboard: 1 s floor so a poller can never become a busy loop spawning a
// PowerShell process; 60 s ceiling because a clipboard change nobody notices
// for over a minute is not worth reacting to.
const DEFAULT_POLL_MS = 2000;
const MIN_POLL_MS = 1000;
const MAX_POLL_MS = 60_000;
const MAX_MATCH_PATTERN_LENGTH = 200;

const KNOWN_TOP_FIELDS = ['id', 'type', 'config', 'promptTemplate', 'escalation', 'appScope', 'enabled', 'approvalRequired', 'limits'];
const KNOWN_HEARTBEAT_CONFIG_FIELDS = ['intervalMinutes', 'checklistPath'];
const KNOWN_SCHEDULE_CONFIG_FIELDS = ['everyMinutes', 'dailyAt'];
const KNOWN_FILE_WATCH_CONFIG_FIELDS = ['path', 'events', 'debounceMs', 'maxDepth'];
const KNOWN_CLIPBOARD_CONFIG_FIELDS = ['pollMs', 'matchPattern'];
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

/**
 * `file-watch` config. `path` is relative to the workspace and validated with
 * src/workspace/fs.mjs's OWN guard (assertSafeRelPath) rather than a second,
 * subtly different rule written here — '..', an absolute path and a drive
 * letter are all rejected there already. A path pointing outside the
 * workspace is a validation error, never a "we'll see at watch time": the
 * runner's setup pass applies the remaining half of the guard (resolution +
 * symlink check, which need the actual workspace directory) before it opens a
 * watcher.
 */
function validateFileWatchConfig(config) {
  if (!isPlainObject(config)) fail('config', 'must be an object for type "file-watch"');
  assertNoUnknownFields(config, KNOWN_FILE_WATCH_CONFIG_FIELDS, 'config');

  if (typeof config.path !== 'string' || config.path.trim().length === 0) {
    fail('config.path', 'must be a non-empty string (a path relative to the workspace)');
  }
  try {
    assertSafeRelPath(config.path);
  } catch (err) {
    if (err instanceof WorkspacePathError) fail('config.path', `must stay inside the workspace: ${err.message}`);
    throw err;
  }

  // A relay writes every handoff to <dataDir>/relay/ (see
  // src/relay/dispatcher.mjs). A watcher pointed there would fire on the
  // relay's own output and start a turn that produces more of it: a loop with
  // an extra hop, and one nobody would recognise as a loop while watching it.
  //
  // Today the workspace guard above already makes this unreachable, because
  // relay/ is a sibling of workspace/ rather than a child. This check exists
  // anyway, because that is a fact about the current directory layout and not
  // a decision anyone wrote down - move the artifacts under the workspace one
  // day and the protection would disappear silently.
  if (/^relay(\/|\\|$)/i.test(config.path.trim().replace(/^\.\//, ''))) {
    fail('config.path', 'must not watch the relay directory: a trigger firing on relay output would loop through it');
  }

  let events = FILE_WATCH_EVENTS;
  if (config.events !== undefined) {
    if (!Array.isArray(config.events) || config.events.length === 0 || !config.events.every((e) => FILE_WATCH_EVENTS.includes(e))) {
      fail('config.events', `must be a non-empty array of ${FILE_WATCH_EVENTS.join(', ')}`);
    }
    events = [...new Set(config.events)];
  }

  const debounceMs = config.debounceMs ?? DEFAULT_DEBOUNCE_MS;
  if (typeof debounceMs !== 'number' || !Number.isFinite(debounceMs) || debounceMs < MIN_DEBOUNCE_MS || debounceMs > MAX_DEBOUNCE_MS) {
    fail('config.debounceMs', `must be a number between ${MIN_DEBOUNCE_MS} and ${MAX_DEBOUNCE_MS}`);
  }

  // No default: omitted means "no depth filter at all" (fs.watch's own
  // recursive walk), not some invented ceiling.
  if (config.maxDepth !== undefined) {
    if (!Number.isInteger(config.maxDepth) || config.maxDepth < 1 || config.maxDepth > MAX_WATCH_DEPTH) {
      fail('config.maxDepth', `must be an integer between 1 and ${MAX_WATCH_DEPTH}`);
    }
  }

  return { path: config.path, events, debounceMs, ...(config.maxDepth === undefined ? {} : { maxDepth: config.maxDepth }) };
}

/**
 * `clipboard` config. `matchPattern` is compiled here (in a try/catch, with a
 * length limit) so a broken regex is a 400 at upsert time instead of a
 * surprise throw inside a poll 2 seconds later. It stays OPTIONAL, but a
 * clipboard trigger without one never fires and never even reads the
 * clipboard (see runner.mjs's poller setup) — firing on every copy would turn
 * the feature into a keylogger with extra steps.
 */
function validateClipboardConfig(config) {
  if (!isPlainObject(config)) fail('config', 'must be an object for type "clipboard"');
  assertNoUnknownFields(config, KNOWN_CLIPBOARD_CONFIG_FIELDS, 'config');

  const pollMs = config.pollMs ?? DEFAULT_POLL_MS;
  if (typeof pollMs !== 'number' || !Number.isFinite(pollMs) || pollMs < MIN_POLL_MS || pollMs > MAX_POLL_MS) {
    fail('config.pollMs', `must be a number between ${MIN_POLL_MS} and ${MAX_POLL_MS}`);
  }

  if (config.matchPattern === undefined) return { pollMs };

  if (typeof config.matchPattern !== 'string' || config.matchPattern.length === 0) {
    fail('config.matchPattern', 'must be a non-empty string');
  }
  if (config.matchPattern.length > MAX_MATCH_PATTERN_LENGTH) {
    fail('config.matchPattern', `must not exceed ${MAX_MATCH_PATTERN_LENGTH} characters`);
  }
  try {
    new RegExp(config.matchPattern);
  } catch (err) {
    fail('config.matchPattern', `must be a valid regular expression: ${err.message}`);
  }

  return { pollMs, matchPattern: config.matchPattern };
}

/**
 * `saved-prompt` config: empty by design. This type has no condition of its
 * own — it fires only through POST /api/triggers/<id>/fire (the one-click
 * action the UI needs) and still passes every cap and escalation check on the
 * way. An omitted `config` is accepted as `{}`; anything inside it is an
 * error, since there is nothing to configure.
 */
function validateSavedPromptConfig(config) {
  if (config === undefined) return {};
  if (!isPlainObject(config)) fail('config', 'must be an object (or omitted) for type "saved-prompt"');
  const keys = Object.keys(config);
  if (keys.length > 0) fail(`config.${keys[0]}`, 'unknown field (type "saved-prompt" takes no config fields)');
  return {};
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

/** Routes `config` to its type's own validator. One place to add a type, so a new TRIGGER_TYPES entry without a config rule can't slip through unvalidated. */
function validateConfigForType(type, config) {
  switch (type) {
    case 'heartbeat':
      return validateHeartbeatConfig(config);
    case 'schedule':
      return validateScheduleConfig(config);
    case 'file-watch':
      return validateFileWatchConfig(config);
    case 'clipboard':
      return validateClipboardConfig(config);
    case 'saved-prompt':
      return validateSavedPromptConfig(config);
    default:
      // Unreachable: validateTrigger() checks TRIGGER_TYPES first. Kept as a
      // loud failure rather than a silent `{}` in case the two ever drift.
      return fail('type', `no config validator for type ${type}`);
  }
}

/**
 * Validates a trigger object and returns a normalized copy (defaults filled
 * in, unknown fields already rejected). Throws InvalidTriggerError with a
 * `.field` naming exactly what was wrong, on the first violation found.
 *
 * `knownAppIds` (a Set, or null for "no app registry wired") is what makes
 * `appScope` checkable at all: null keeps the old syntax-only check, a Set
 * rejects any entry that is not an installed app id. The server always passes
 * one (see startServer()); a runner/registry built in isolation may not.
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
export function validateTrigger(obj, { knownAppIds = null } = {}) {
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
    // src/triggers/runner.mjs's notifyPolicyHandler()); what's rejected is a
    // non-array or an array with a non-string/empty entry.
    fail('appScope', 'must be an array of non-empty strings (app ids); use [] for none');
  }
  // Every entry must name an app that actually exists. Without this, an
  // appScope was a free-text field: `["Bash"]` was accepted and used to read
  // like a grant for the CLI's Bash tool (adversarial review Tag 3, Grok P0 /
  // Codex F1). It never reaches the CLI any more (see runner.mjs), but a
  // scope naming something that is not an app is a mistake worth reporting at
  // the moment it is made, not a silent no-op.
  if (knownAppIds !== null) {
    for (const appId of obj.appScope) {
      if (!knownAppIds.has(appId)) {
        fail('appScope', `unknown app id "${appId}" — appScope may only name installed apps (see GET /api/apps)`);
      }
    }
  }
  if (obj.enabled !== undefined && typeof obj.enabled !== 'boolean') {
    fail('enabled', 'must be a boolean');
  }
  if (obj.approvalRequired !== undefined && typeof obj.approvalRequired !== 'boolean') {
    fail('approvalRequired', 'must be a boolean');
  }

  const config = validateConfigForType(obj.type, obj.config);
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
 * Brings one stored entry back inside the ceilings before it is validated.
 * A hand-edited `maxRunsPerDay: 5000` used to be loaded verbatim, because
 * nothing re-validated the file after it was written (adversarial review Tag
 * 3, both peers). Clamping rather than rejecting is deliberate: the user
 * keeps the trigger they configured, just not the number they invented — and
 * the clamp is logged, so it is not a silent correction either.
 */
function clampStoredLimits(entry, report) {
  if (!isPlainObject(entry) || !isPlainObject(entry.limits)) return entry;
  const limits = { ...entry.limits };
  if (typeof limits.maxRunsPerDay === 'number' && limits.maxRunsPerDay > MAX_RUNS_PER_DAY_CEILING) {
    report(`trigger "${entry.id}": maxRunsPerDay ${limits.maxRunsPerDay} exceeds the ceiling, clamped to ${MAX_RUNS_PER_DAY_CEILING}`);
    limits.maxRunsPerDay = MAX_RUNS_PER_DAY_CEILING;
  }
  if (typeof limits.maxCostPerDay === 'number' && limits.maxCostPerDay > MAX_COST_PER_DAY_CEILING) {
    report(`trigger "${entry.id}": maxCostPerDay ${limits.maxCostPerDay} exceeds the ceiling, clamped to ${MAX_COST_PER_DAY_CEILING}`);
    limits.maxCostPerDay = MAX_COST_PER_DAY_CEILING;
  }
  return { ...entry, limits };
}

/**
 * Drops appScope entries naming an app that is not installed. On the WRITE
 * path an unknown app id is an error (see validateTrigger); on the read path
 * it must not be, or a user who uninstalls an app loses every trigger that
 * mentioned it. Fail-closed: the entry disappears from the scope (it grants
 * nothing), the trigger survives, the removal is logged.
 */
function dropUnknownAppScope(entry, knownAppIds, report) {
  if (knownAppIds === null || !isPlainObject(entry) || !Array.isArray(entry.appScope)) return entry;
  const kept = entry.appScope.filter((appId) => knownAppIds.has(appId));
  if (kept.length === entry.appScope.length) return entry;
  const dropped = entry.appScope.filter((appId) => !knownAppIds.has(appId));
  report(`trigger "${entry.id}": dropped unknown app id(s) from appScope: ${dropped.join(', ')}`);
  return { ...entry, appScope: kept };
}

/**
 * Runs every stored entry through the same validation a new trigger goes
 * through, after clamping what can be clamped. An entry that is still invalid
 * afterwards is SKIPPED (with a log line) rather than taking the file down
 * with it — same posture as runs.mjs skipping a corrupt line. This is what
 * makes "the ceilings hold" true across a restart, instead of only at the
 * moment a trigger is created.
 */
function normalizeStoredTriggers(entries, knownAppIds, report) {
  const normalized = [];
  for (const entry of entries) {
    const id = isPlainObject(entry) && typeof entry.id === 'string' ? entry.id : '<unnamed>';
    try {
      const clamped = dropUnknownAppScope(clampStoredLimits(entry, report), knownAppIds, report);
      normalized.push(validateTrigger(clamped, { knownAppIds }));
    } catch (err) {
      report(`trigger "${id}": dropped while loading (${err.message})`);
    }
  }
  return normalized;
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
 * empty, see readTriggersFile()), NORMALIZES every entry through the same
 * validation a new trigger goes through, and returns an API for reading and
 * mutating it. Every mutating call re-validates and rewrites the whole file
 * atomically — trigger count is expected to stay small (a handful per
 * user), so a full rewrite per change is simpler than an append-only log
 * and costs nothing measurable here.
 *
 * @param {string} dataDir
 * @param {object} [options]
 * @param {Set<string>|(() => Set<string>)|null} [options.knownAppIds] -
 *   installed app ids; see validateTrigger(). A FUNCTION is re-evaluated per
 *   use, which is what the server passes: an app installed after the registry
 *   was opened must be scopeable without a restart.
 * @param {(message: string) => void} [options.log] - where load-time
 *   corrections (clamped limits, dropped app ids, skipped entries) are
 *   reported. Defaults to console.warn: a correction the user never hears
 *   about is indistinguishable from the tool ignoring their configuration.
 */
export function openTriggers(dataDir, { knownAppIds = null, log = (message) => console.warn(`triggers: ${message}`) } = {}) {
  const currentAppIds = () => (typeof knownAppIds === 'function' ? knownAppIds() : knownAppIds);
  let triggers = normalizeStoredTriggers(readTriggersFile(dataDir), currentAppIds(), log);

  return {
    list() {
      return triggers.map((t) => ({ ...t }));
    },

    get(id) {
      const trigger = triggers.find((t) => t.id === id);
      return trigger ? { ...trigger } : null;
    },

    /** Validates `trigger` (including its appScope against the installed apps), then inserts it (new id) or replaces the existing entry with the same id. Returns the normalized, stored trigger. */
    upsert(trigger) {
      const validated = validateTrigger(trigger, { knownAppIds: currentAppIds() });
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
