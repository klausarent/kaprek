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
