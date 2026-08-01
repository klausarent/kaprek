// Tests for the trigger registry. Run: npx vitest run src/triggers/registry.test.mjs
import { test, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openTriggers, validateTrigger, InvalidTriggerError } from './registry.mjs';

function validHeartbeat(overrides = {}) {
  return {
    id: 'daily-checkin',
    type: 'heartbeat',
    config: { intervalMinutes: 30 },
    promptTemplate: 'Check the checklist and report anything overdue.',
    appScope: [],
    ...overrides,
  };
}

function validSchedule(overrides = {}) {
  return {
    id: 'nightly-sync',
    type: 'schedule',
    config: { dailyAt: '09:00' },
    promptTemplate: 'Run the nightly sync.',
    appScope: ['notes'],
    ...overrides,
  };
}

function validFileWatch(overrides = {}) {
  return {
    id: 'watch-inbox',
    type: 'file-watch',
    config: { path: 'inbox' },
    promptTemplate: 'These files changed:\n{{files}}',
    appScope: [],
    ...overrides,
  };
}

function validClipboard(overrides = {}) {
  return {
    id: 'watch-clipboard',
    type: 'clipboard',
    config: { matchPattern: 'https?://' },
    promptTemplate: 'Summarize what was copied.',
    appScope: [],
    ...overrides,
  };
}

function validSavedPrompt(overrides = {}) {
  return {
    id: 'weekly-report',
    type: 'saved-prompt',
    config: {},
    promptTemplate: 'Write the weekly report.',
    appScope: [],
    ...overrides,
  };
}

let tmpDir;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kaprek-triggers-registry-test-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ------------------------------------------------------------- validateTrigger

test('validateTrigger accepts a minimal valid heartbeat trigger and fills defaults', () => {
  const trigger = validateTrigger(validHeartbeat());
  expect(trigger.escalation).toBe('notify');
  expect(trigger.enabled).toBe(false);
  expect(trigger.approvalRequired).toBe(false);
  expect(trigger.limits).toEqual({ maxRunsPerDay: 24, maxCostPerDay: 1.0 });
  expect(trigger.config.checklistPath).toBe('CHECKLIST.md');
});

test('validateTrigger accepts a minimal valid schedule trigger', () => {
  expect(() => validateTrigger(validSchedule())).not.toThrow();
});

test('missing escalation defaults to "notify" and approvalRequired to false', () => {
  const trigger = validateTrigger(validHeartbeat());
  expect(trigger.escalation).toBe('notify');
  expect(trigger.approvalRequired).toBe(false);
});

test('escalation "question"/"review" default approvalRequired to true', () => {
  expect(validateTrigger(validHeartbeat({ escalation: 'question' })).approvalRequired).toBe(true);
  expect(validateTrigger(validHeartbeat({ escalation: 'review' })).approvalRequired).toBe(true);
});

test('an explicit approvalRequired overrides the escalation-derived default', () => {
  expect(validateTrigger(validHeartbeat({ escalation: 'review', approvalRequired: false })).approvalRequired).toBe(false);
  expect(validateTrigger(validHeartbeat({ escalation: 'notify', approvalRequired: true })).approvalRequired).toBe(true);
});

test('an unknown top-level field throws InvalidTriggerError naming that field', () => {
  expect(() => validateTrigger(validHeartbeat({ bogus: true }))).toThrow(InvalidTriggerError);
  try {
    validateTrigger(validHeartbeat({ bogus: true }));
  } catch (err) {
    expect(err.field).toBe('bogus');
  }
});

test('an invalid id (uppercase, too long) is rejected', () => {
  expect(() => validateTrigger(validHeartbeat({ id: 'Bad_Id' }))).toThrow(InvalidTriggerError);
  expect(() => validateTrigger(validHeartbeat({ id: 'x'.repeat(65) }))).toThrow(InvalidTriggerError);
});

test('an invalid type is rejected', () => {
  expect(() => validateTrigger(validHeartbeat({ type: 'cron' }))).toThrow(InvalidTriggerError);
});

test('an invalid escalation value is rejected', () => {
  expect(() => validateTrigger(validHeartbeat({ escalation: 'urgent' }))).toThrow(InvalidTriggerError);
});

test('a promptTemplate over 4000 characters is rejected', () => {
  expect(() => validateTrigger(validHeartbeat({ promptTemplate: 'x'.repeat(4001) }))).toThrow(InvalidTriggerError);
});

test('an empty promptTemplate is rejected', () => {
  expect(() => validateTrigger(validHeartbeat({ promptTemplate: '' }))).toThrow(InvalidTriggerError);
});

test('appScope must be an array of non-empty strings, but an empty array is valid', () => {
  expect(() => validateTrigger(validHeartbeat({ appScope: [] }))).not.toThrow();
  expect(() => validateTrigger(validHeartbeat({ appScope: ['notes', 'todo'] }))).not.toThrow();
  expect(() => validateTrigger(validHeartbeat({ appScope: 'notes' }))).toThrow(InvalidTriggerError);
  expect(() => validateTrigger(validHeartbeat({ appScope: [42] }))).toThrow(InvalidTriggerError);
  expect(() => validateTrigger(validHeartbeat({ appScope: [''] }))).toThrow(InvalidTriggerError);
});

test('maxRunsPerDay above the ceiling (500) is rejected', () => {
  expect(() => validateTrigger(validHeartbeat({ limits: { maxRunsPerDay: 501, maxCostPerDay: 1 } }))).toThrow(InvalidTriggerError);
});

test('maxCostPerDay above the ceiling (50) is rejected', () => {
  expect(() => validateTrigger(validHeartbeat({ limits: { maxRunsPerDay: 10, maxCostPerDay: 51 } }))).toThrow(InvalidTriggerError);
});

test('heartbeat config: intervalMinutes out of [5, 1440] is rejected', () => {
  expect(() => validateTrigger(validHeartbeat({ config: { intervalMinutes: 4 } }))).toThrow(InvalidTriggerError);
  expect(() => validateTrigger(validHeartbeat({ config: { intervalMinutes: 1441 } }))).toThrow(InvalidTriggerError);
});

test('heartbeat config: an unknown field is rejected', () => {
  expect(() => validateTrigger(validHeartbeat({ config: { intervalMinutes: 30, cron: '*' } }))).toThrow(InvalidTriggerError);
});

test('schedule config: exactly one of everyMinutes/dailyAt is required — both set is rejected', () => {
  expect(() => validateTrigger(validSchedule({ config: { everyMinutes: 15, dailyAt: '09:00' } }))).toThrow(InvalidTriggerError);
});

test('schedule config: neither everyMinutes nor dailyAt set is rejected', () => {
  expect(() => validateTrigger(validSchedule({ config: {} }))).toThrow(InvalidTriggerError);
});

test('schedule config: everyMinutes out of [5, 10080] is rejected', () => {
  expect(() => validateTrigger(validSchedule({ config: { everyMinutes: 4 } }))).toThrow(InvalidTriggerError);
  expect(() => validateTrigger(validSchedule({ config: { everyMinutes: 10081 } }))).toThrow(InvalidTriggerError);
});

test('schedule config: dailyAt must be a 24h "HH:MM" string', () => {
  expect(() => validateTrigger(validSchedule({ config: { dailyAt: '9:00' } }))).toThrow(InvalidTriggerError);
  expect(() => validateTrigger(validSchedule({ config: { dailyAt: '25:00' } }))).toThrow(InvalidTriggerError);
  expect(() => validateTrigger(validSchedule({ config: { dailyAt: '09:00' } }))).not.toThrow();
});

test('no cron syntax accepted: a "cronExpression"-style config field is rejected as unknown', () => {
  expect(() => validateTrigger(validSchedule({ config: { cronExpression: '0 9 * * *' } }))).toThrow(InvalidTriggerError);
});

// ------------------------------------------------------------- file-watch config

test('file-watch config: a minimal config fills events/debounceMs defaults and leaves maxDepth unset', () => {
  const trigger = validateTrigger(validFileWatch());
  expect(trigger.config).toEqual({ path: 'inbox', events: ['add', 'change', 'unlink'], debounceMs: 500 });
});

test('file-watch config: a path outside the workspace is a validation error, not a runtime surprise', () => {
  for (const badPath of ['../outside', 'sub/../../outside', '/etc/passwd', 'C:\\Windows', './here']) {
    expect(() => validateTrigger(validFileWatch({ config: { path: badPath } }))).toThrow(InvalidTriggerError);
  }
  try {
    validateTrigger(validFileWatch({ config: { path: '../outside' } }));
  } catch (err) {
    expect(err.field).toBe('config.path');
  }
});

test('file-watch config: an empty/missing path is rejected', () => {
  expect(() => validateTrigger(validFileWatch({ config: {} }))).toThrow(InvalidTriggerError);
  expect(() => validateTrigger(validFileWatch({ config: { path: '   ' } }))).toThrow(InvalidTriggerError);
});

test('file-watch config: events must be a non-empty subset of add/change/unlink, and duplicates collapse', () => {
  expect(validateTrigger(validFileWatch({ config: { path: 'inbox', events: ['add', 'add'] } })).config.events).toEqual(['add']);
  expect(() => validateTrigger(validFileWatch({ config: { path: 'inbox', events: [] } }))).toThrow(InvalidTriggerError);
  expect(() => validateTrigger(validFileWatch({ config: { path: 'inbox', events: ['moved'] } }))).toThrow(InvalidTriggerError);
  expect(() => validateTrigger(validFileWatch({ config: { path: 'inbox', events: 'add' } }))).toThrow(InvalidTriggerError);
});

test('file-watch config: debounceMs below 100 or above 60000 is rejected', () => {
  expect(() => validateTrigger(validFileWatch({ config: { path: 'inbox', debounceMs: 99 } }))).toThrow(InvalidTriggerError);
  expect(() => validateTrigger(validFileWatch({ config: { path: 'inbox', debounceMs: 60_001 } }))).toThrow(InvalidTriggerError);
  expect(validateTrigger(validFileWatch({ config: { path: 'inbox', debounceMs: 100 } })).config.debounceMs).toBe(100);
});

test('file-watch config: maxDepth must be an integer in [1, 32] when present', () => {
  expect(validateTrigger(validFileWatch({ config: { path: 'inbox', maxDepth: 2 } })).config.maxDepth).toBe(2);
  expect(() => validateTrigger(validFileWatch({ config: { path: 'inbox', maxDepth: 0 } }))).toThrow(InvalidTriggerError);
  expect(() => validateTrigger(validFileWatch({ config: { path: 'inbox', maxDepth: 1.5 } }))).toThrow(InvalidTriggerError);
  expect(() => validateTrigger(validFileWatch({ config: { path: 'inbox', maxDepth: 33 } }))).toThrow(InvalidTriggerError);
});

test('file-watch config: an unknown config field is rejected', () => {
  expect(() => validateTrigger(validFileWatch({ config: { path: 'inbox', glob: '*.md' } }))).toThrow(InvalidTriggerError);
});

// ------------------------------------------------------------- clipboard config

test('clipboard config: pollMs defaults to 2000 and a trigger is disabled by default (strict opt-in)', () => {
  const trigger = validateTrigger(validClipboard());
  expect(trigger.config.pollMs).toBe(2000);
  expect(trigger.enabled).toBe(false);
});

test('clipboard config: pollMs below 1000 or above 60000 is rejected', () => {
  expect(() => validateTrigger(validClipboard({ config: { pollMs: 999 } }))).toThrow(InvalidTriggerError);
  expect(() => validateTrigger(validClipboard({ config: { pollMs: 60_001 } }))).toThrow(InvalidTriggerError);
  expect(validateTrigger(validClipboard({ config: { pollMs: 1000 } })).config.pollMs).toBe(1000);
});

test('clipboard config: an invalid regex in matchPattern is a validation error, never a crash at poll time', () => {
  expect(() => validateTrigger(validClipboard({ config: { matchPattern: '([unclosed' } }))).toThrow(InvalidTriggerError);
  try {
    validateTrigger(validClipboard({ config: { matchPattern: '([unclosed' } }));
  } catch (err) {
    expect(err.field).toBe('config.matchPattern');
  }
});

test('clipboard config: a matchPattern over 200 characters is rejected', () => {
  // 201 'a's is a perfectly valid regex — rejected purely for its length.
  expect(() => validateTrigger(validClipboard({ config: { matchPattern: 'a'.repeat(201) } }))).toThrow(InvalidTriggerError);
  expect(() => validateTrigger(validClipboard({ config: { matchPattern: 'a'.repeat(200) } }))).not.toThrow();
});

test('clipboard config: matchPattern is optional (a trigger without one is valid but will never fire)', () => {
  const trigger = validateTrigger(validClipboard({ config: {} }));
  expect(trigger.config).toEqual({ pollMs: 2000 });
});

test('clipboard config: an unknown config field is rejected', () => {
  expect(() => validateTrigger(validClipboard({ config: { readImages: true } }))).toThrow(InvalidTriggerError);
});

// ------------------------------------------------------------- saved-prompt config

test('saved-prompt config: an empty or omitted config is valid and normalizes to {}', () => {
  expect(validateTrigger(validSavedPrompt()).config).toEqual({});
  expect(validateTrigger(validSavedPrompt({ config: undefined })).config).toEqual({});
});

test('saved-prompt config: any config field at all is rejected', () => {
  expect(() => validateTrigger(validSavedPrompt({ config: { everyMinutes: 5 } }))).toThrow(InvalidTriggerError);
});

test('all five trigger types round-trip through upsert/get', () => {
  const triggers = openTriggers(tmpDir);
  triggers.upsert(validHeartbeat());
  triggers.upsert(validSchedule());
  triggers.upsert(validFileWatch());
  triggers.upsert(validClipboard());
  triggers.upsert(validSavedPrompt());
  expect(triggers.list().map((t) => t.type).sort()).toEqual(['clipboard', 'file-watch', 'heartbeat', 'saved-prompt', 'schedule']);
});

// ------------------------------------------------------------- openTriggers persistence

test('upsert then list/get round-trips a valid trigger', () => {
  const triggers = openTriggers(tmpDir);
  const stored = triggers.upsert(validHeartbeat());
  expect(stored.id).toBe('daily-checkin');
  expect(triggers.list()).toHaveLength(1);
  expect(triggers.get('daily-checkin')).toEqual(stored);
});

test('upsert with an existing id replaces (not duplicates) the entry', () => {
  const triggers = openTriggers(tmpDir);
  triggers.upsert(validHeartbeat({ enabled: false }));
  triggers.upsert(validHeartbeat({ enabled: true }));
  expect(triggers.list()).toHaveLength(1);
  expect(triggers.get('daily-checkin').enabled).toBe(true);
});

test('upsert of an invalid trigger throws and does not persist it', () => {
  const triggers = openTriggers(tmpDir);
  expect(() => triggers.upsert(validHeartbeat({ id: 'BAD ID' }))).toThrow(InvalidTriggerError);
  expect(triggers.list()).toHaveLength(0);
});

test('remove deletes a trigger and returns true; unknown id returns false', () => {
  const triggers = openTriggers(tmpDir);
  triggers.upsert(validHeartbeat());
  expect(triggers.remove('daily-checkin')).toBe(true);
  expect(triggers.list()).toHaveLength(0);
  expect(triggers.remove('daily-checkin')).toBe(false);
});

test('setEnabled flips enabled and returns the updated trigger; unknown id returns null', () => {
  const triggers = openTriggers(tmpDir);
  triggers.upsert(validHeartbeat({ enabled: false }));
  const updated = triggers.setEnabled('daily-checkin', true);
  expect(updated.enabled).toBe(true);
  expect(triggers.get('daily-checkin').enabled).toBe(true);
  expect(triggers.setEnabled('nope', true)).toBeNull();
});

test('triggers.json persists across reopening openTriggers()', () => {
  openTriggers(tmpDir).upsert(validHeartbeat());
  const reopened = openTriggers(tmpDir);
  expect(reopened.list()).toHaveLength(1);
  expect(reopened.get('daily-checkin').id).toBe('daily-checkin');
});

test('a missing triggers.json yields an empty list, not a crash', () => {
  const triggers = openTriggers(tmpDir);
  expect(triggers.list()).toEqual([]);
});

test('a corrupt triggers.json falls back to an empty list instead of crashing', () => {
  fs.writeFileSync(path.join(tmpDir, 'triggers.json'), '{ not valid json', 'utf8');
  const triggers = openTriggers(tmpDir);
  expect(triggers.list()).toEqual([]);
  // Still usable afterwards — upsert works from the empty in-memory state.
  triggers.upsert(validHeartbeat());
  expect(triggers.list()).toHaveLength(1);
});

test('triggers.json with an unexpected top-level shape falls back to an empty list', () => {
  fs.writeFileSync(path.join(tmpDir, 'triggers.json'), JSON.stringify({ notTheRightShape: [] }), 'utf8');
  const triggers = openTriggers(tmpDir);
  expect(triggers.list()).toEqual([]);
});

test('triggers.json is written atomically as {version, triggers}', () => {
  openTriggers(tmpDir).upsert(validHeartbeat());
  const raw = JSON.parse(fs.readFileSync(path.join(tmpDir, 'triggers.json'), 'utf8'));
  expect(raw.version).toBe(1);
  expect(raw.triggers).toHaveLength(1);
  expect(raw.triggers[0].id).toBe('daily-checkin');
});

// ------------------------------------------------------------- appScope is bound to installed apps

const INSTALLED_APPS = new Set(['notes', 'weather']);

test('appScope: an entry naming an installed app is accepted', () => {
  expect(() => validateTrigger(validHeartbeat({ appScope: ['notes'] }), { knownAppIds: INSTALLED_APPS })).not.toThrow();
});

test('appScope: a CLI tool name is rejected — a scope names apps, never tools', () => {
  // The finding this closes: `["Bash"]` used to be a valid scope AND was
  // handed to the CLI as --allowedTools (adversarial review Tag 3).
  for (const bogus of ['Bash', 'Write', 'WebFetch']) {
    expect(() => validateTrigger(validHeartbeat({ appScope: [bogus] }), { knownAppIds: INSTALLED_APPS })).toThrow(InvalidTriggerError);
  }
  try {
    validateTrigger(validHeartbeat({ appScope: ['Bash'] }), { knownAppIds: INSTALLED_APPS });
  } catch (err) {
    expect(err.field).toBe('appScope');
    expect(err.message).toMatch(/unknown app id "Bash"/);
  }
});

test('appScope: without a known-app list the check is skipped (a registry opened with no app registry wired)', () => {
  expect(() => validateTrigger(validHeartbeat({ appScope: ['anything'] }))).not.toThrow();
});

test('upsert rejects an appScope naming an app that is not installed', () => {
  const triggers = openTriggers(tmpDir, { knownAppIds: INSTALLED_APPS, log: () => {} });
  expect(() => triggers.upsert(validHeartbeat({ appScope: ['Bash'] }))).toThrow(InvalidTriggerError);
  expect(triggers.list()).toHaveLength(0);
});

test('knownAppIds may be a function, re-evaluated per use — an app installed later becomes scopeable without a restart', () => {
  const installed = new Set();
  const triggers = openTriggers(tmpDir, { knownAppIds: () => installed, log: () => {} });
  expect(() => triggers.upsert(validHeartbeat({ appScope: ['notes'] }))).toThrow(InvalidTriggerError);

  installed.add('notes');
  expect(triggers.upsert(validHeartbeat({ appScope: ['notes'] })).appScope).toEqual(['notes']);
});

// ------------------------------------------------------------- load-time revalidation

/** Writes triggers.json directly, past validateTrigger() — the route a hand edit takes. */
function writeRawTriggersFile(triggers) {
  fs.writeFileSync(path.join(tmpDir, 'triggers.json'), JSON.stringify({ version: 1, triggers }, null, 2), 'utf8');
}

function storedHeartbeat(overrides = {}) {
  return {
    id: 'daily-checkin',
    type: 'heartbeat',
    config: { intervalMinutes: 30, checklistPath: 'CHECKLIST.md' },
    promptTemplate: 'Check the checklist.',
    escalation: 'notify',
    appScope: [],
    enabled: true,
    approvalRequired: false,
    limits: { maxRunsPerDay: 24, maxCostPerDay: 1 },
    ...overrides,
  };
}

test('load: limits above the ceilings are clamped to them, not obeyed — and the clamp is logged', () => {
  writeRawTriggersFile([storedHeartbeat({ limits: { maxRunsPerDay: 5000, maxCostPerDay: 999 } })]);
  const messages = [];
  const triggers = openTriggers(tmpDir, { log: (m) => messages.push(m) });

  const loaded = triggers.get('daily-checkin');
  expect(loaded.limits).toEqual({ maxRunsPerDay: 500, maxCostPerDay: 50 });
  expect(messages.some((m) => m.includes('maxRunsPerDay 5000') && m.includes('clamped'))).toBe(true);
  expect(messages.some((m) => m.includes('maxCostPerDay 999') && m.includes('clamped'))).toBe(true);
});

test('load: a clamped trigger keeps working — the user loses the invented number, not the trigger', () => {
  writeRawTriggersFile([storedHeartbeat({ limits: { maxRunsPerDay: 5000, maxCostPerDay: 999 } })]);
  const triggers = openTriggers(tmpDir, { log: () => {} });
  expect(triggers.list()).toHaveLength(1);
  expect(triggers.get('daily-checkin').enabled).toBe(true);
});

test('load: limits inside the ceilings are left exactly as they are', () => {
  writeRawTriggersFile([storedHeartbeat({ limits: { maxRunsPerDay: 7, maxCostPerDay: 0.5 } })]);
  const triggers = openTriggers(tmpDir, { log: () => {} });
  expect(triggers.get('daily-checkin').limits).toEqual({ maxRunsPerDay: 7, maxCostPerDay: 0.5 });
});

test('load: an appScope entry naming an app that is not installed is dropped, the trigger survives', () => {
  // Uninstalling an app must not delete every trigger that mentioned it —
  // but the scope must not keep granting it either.
  writeRawTriggersFile([storedHeartbeat({ appScope: ['notes', 'Bash'] })]);
  const messages = [];
  const triggers = openTriggers(tmpDir, { knownAppIds: INSTALLED_APPS, log: (m) => messages.push(m) });

  expect(triggers.get('daily-checkin').appScope).toEqual(['notes']);
  expect(messages.some((m) => m.includes('dropped unknown app id(s)') && m.includes('Bash'))).toBe(true);
});

test('load: an entry that cannot be repaired is skipped with a log line, the other entries still load', () => {
  writeRawTriggersFile([storedHeartbeat({ id: 'broken', type: 'nonsense' }), storedHeartbeat()]);
  const messages = [];
  const triggers = openTriggers(tmpDir, { log: (m) => messages.push(m) });

  expect(triggers.list().map((t) => t.id)).toEqual(['daily-checkin']);
  expect(messages.some((m) => m.includes('"broken"') && m.includes('dropped while loading'))).toBe(true);
});

test('load: a stored entry is normalized, so a missing optional field comes back with its default', () => {
  const stored = storedHeartbeat();
  delete stored.config.checklistPath;
  writeRawTriggersFile([stored]);
  expect(openTriggers(tmpDir, { log: () => {} }).get('daily-checkin').config.checklistPath).toBe('CHECKLIST.md');
});

test('file-watch config: the relay directory is not a valid source', () => {
  // A relay writes every handoff under <dataDir>/relay/. A watcher pointed
  // there would fire on the relay's own output and start a turn that produces
  // more of it: a loop with an extra hop, and one that would not look like a
  // loop from the inside.
  //
  // The workspace guard above already makes this unreachable today, since
  // relay/ is a sibling of workspace/ rather than a child. This check exists
  // because that is a fact about the current directory layout rather than a
  // decision anyone wrote down.
  for (const badPath of ['relay', 'relay/run-1', 'RELAY/x']) {
    expect(() => validateTrigger(validFileWatch({ config: { path: badPath } }))).toThrow(/relay directory/);
  }
  // A path that merely starts with the same letters is fine: this is about
  // the directory, not about the word.
  expect(() => validateTrigger(validFileWatch({ config: { path: 'relayers/notes' } }))).not.toThrow();
});
