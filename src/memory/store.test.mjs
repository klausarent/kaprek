import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { InvalidMemoryError, MAX_AGE_MS, MemoryNotFoundError, openMemory } from './store.mjs';

let dataDir;
let clock;

beforeEach(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kaprek-memory-'));
  clock = Date.parse('2026-08-02T10:00:00.000Z');
});

afterEach(() => {
  fs.rmSync(dataDir, { recursive: true, force: true });
});

const now = () => clock;

/** klaus -> kaprek -> {m3, codex}, plus luca -> spiel as a separate tree. */
function seeded() {
  const memory = openMemory(dataDir, { now });
  memory.addScope({ id: 'person:klaus' });
  memory.addScope({ id: 'project:kaprek', parent: 'person:klaus' });
  memory.addScope({ id: 'mission:m3', parent: 'project:kaprek' });
  memory.addScope({ id: 'agent:codex', parent: 'project:kaprek' });
  memory.addScope({ id: 'person:luca' });
  memory.addScope({ id: 'project:spiel', parent: 'person:luca' });
  return memory;
}

describe('remember', () => {
  test('writes a fact with its age and its origin', () => {
    const memory = seeded();
    const fact = memory.remember({ scopeId: 'project:kaprek', text: 'The relay resumes only its own session.', origin: 'chat:abc' });
    expect(fact.kind).toBe('fact');
    expect(fact.stale).toBe(false);
    expect(fact.origin).toBe('chat:abc');
  });

  test('refuses a memory with no owner', () => {
    const memory = seeded();
    expect(() => memory.remember({ scopeId: 'project:nope', text: 'x', origin: 'y' })).toThrow(/unknown scope/);
  });

  test('refuses a memory nobody can trace', () => {
    const memory = seeded();
    expect(() => memory.remember({ scopeId: 'person:klaus', text: 'x', origin: '' })).toThrow(InvalidMemoryError);
  });

  test('refuses nonsense confidence', () => {
    const memory = seeded();
    expect(() => memory.remember({ scopeId: 'person:klaus', text: 'x', origin: 'o', confidence: 2 })).toThrow(/confidence/);
  });
});

describe('recall', () => {
  test('an agent reads what another wrote in the shared project — without copy-paste', () => {
    const memory = seeded();
    // Claude, working in the mission, writes down what it learned.
    memory.remember({ scopeId: 'project:kaprek', text: 'codex needs its own session id', origin: 'mission:m3' });
    // Codex, a different engine and a different scope under the same project.
    const seen = memory.recall({ scopeId: 'agent:codex' }).map((entry) => entry.text);
    expect(seen).toContain('codex needs its own session id');
  });

  test('the other tree sees nothing of it — the M3 acceptance', () => {
    const memory = seeded();
    memory.remember({ scopeId: 'project:kaprek', text: 'the company invoice template lives in X', origin: 'chat:1' });
    memory.remember({ scopeId: 'person:klaus', text: 'a private note', origin: 'chat:1' });
    expect(memory.recall({ scopeId: 'project:spiel' })).toEqual([]);
  });

  test('a parent does not read into its children', () => {
    const memory = seeded();
    memory.remember({ scopeId: 'mission:m3', text: 'only this mission knows', origin: 'chat:2' });
    expect(memory.recall({ scopeId: 'person:klaus' })).toEqual([]);
  });

  test('profiles come before facts, whatever their age', () => {
    const memory = seeded();
    memory.remember({ scopeId: 'project:kaprek', text: 'a fact', origin: 'o' });
    clock += 1000;
    memory.remember({ scopeId: 'project:kaprek', text: 'kaprek is a local agent workspace', kind: 'profile', origin: 'o' });
    // Written later, still first: a caller taking the top N gets the profile.
    expect(memory.recall({ scopeId: 'project:kaprek' })[0].kind).toBe('profile');
  });

  test('evidence stays out of the way until it is asked for', () => {
    const memory = seeded();
    memory.remember({ scopeId: 'project:kaprek', text: 'see the turn that proved it', kind: 'evidence', origin: 'o', evidenceRef: { sessionId: 's1', eventIndex: 42 } });
    expect(memory.recall({ scopeId: 'project:kaprek' })).toEqual([]);
    const withEvidence = memory.recall({ scopeId: 'project:kaprek', includeEvidence: true });
    // A pointer, never an excerpt.
    expect(withEvidence[0].evidenceRef).toEqual({ sessionId: 's1', eventIndex: 42 });
  });

  test('filters by text when asked', () => {
    const memory = seeded();
    memory.remember({ scopeId: 'project:kaprek', text: 'grok answers with a schema', origin: 'o' });
    memory.remember({ scopeId: 'project:kaprek', text: 'codex reads slowly', origin: 'o' });
    expect(memory.recall({ scopeId: 'project:kaprek', query: 'codex' }).map((entry) => entry.text)).toEqual(['codex reads slowly']);
  });
});

describe('freshness', () => {
  test('a fact goes stale after 90 days, and still comes back', () => {
    const memory = seeded();
    const fact = memory.remember({ scopeId: 'project:kaprek', text: 'npm token lives in .env', origin: 'o' });
    clock += MAX_AGE_MS + 1;

    const recalled = memory.recall({ scopeId: 'project:kaprek' });
    // Still there — dropping it silently would be an agent that forgets on a
    // schedule, which is worse than one that says "this is old".
    expect(recalled).toHaveLength(1);
    expect(recalled[0].stale).toBe(true);
    expect(memory.get(fact.id).stale).toBe(true);
  });

  test('verifying it clears the badge', () => {
    const memory = seeded();
    const fact = memory.remember({ scopeId: 'project:kaprek', text: 'still true', origin: 'o' });
    clock += MAX_AGE_MS + 1;
    expect(memory.get(fact.id).stale).toBe(true);

    memory.verify(fact.id);
    expect(memory.get(fact.id).stale).toBe(false);
  });
});

describe('provenance (P4b)', () => {
  test('a turn write carries sourceKind turn plus its chatId', () => {
    const memory = seeded();
    const fact = memory.remember({ scopeId: 'project:kaprek', text: 'the relay resumes its own session', origin: 'chat:c1', sourceKind: 'turn', chatId: 'c1' });
    expect(fact.sourceKind).toBe('turn');
    expect(fact.chatId).toBe('c1');
    expect(fact.path).toBe(null);
  });

  test('a file write carries sourceKind file plus its path, redacted', () => {
    const memory = seeded();
    // The secret surfaced inside the path string; the store redacts the
    // provenance like every other text it writes down — the path yes, the
    // file's contents never.
    const fact = memory.remember({
      scopeId: 'project:kaprek',
      text: 'the nightly deploy runs at 03:00 UTC',
      origin: 'memory-sync:project_kaprek.md',
      sourceKind: 'file',
      path: 'C:\\Users\\klaus\\.claude\\Bearer sk-a1b2c3d4e5f6g7h8\\memory\\project_kaprek.md',
      pathRange: { from: 3, to: 9 },
    });
    expect(fact.sourceKind).toBe('file');
    expect(fact.path).toBe('C:\\Users\\klaus\\.claude\\Bearer [REDACTED]\\memory\\project_kaprek.md');
    expect(fact.pathRange).toEqual({ from: 3, to: 9 });
  });

  test('an import write starts unverified, and only Still true stamps it', () => {
    const memory = seeded();
    const fact = memory.remember({ scopeId: 'project:kaprek', text: 'a guess from an old note', origin: 'import:notes', sourceKind: 'import', unverified: true });
    expect(fact.lastVerifiedAt).toBe(null);
    expect(fact.unverified).toBe(true);
    expect(fact.stale).toBe(false); // unconfirmed, not stale — different mark, different corner

    // Re-importing the same line confirms the count but not the clock.
    const again = memory.remember({ scopeId: 'project:kaprek', text: 'a guess from an old note', origin: 'import:notes', sourceKind: 'import', unverified: true });
    expect(again.confirmed).toBe(true);
    expect(memory.get(fact.id).lastVerifiedAt).toBe(null);

    // "Still true" — the existing verify path — is what stamps it.
    memory.verify(fact.id);
    const verified = memory.get(fact.id);
    expect(verified.lastVerifiedAt).toBe(new Date(clock).toISOString());
    expect(verified.unverified).toBe(false);
  });

  test('a manual write carries sourceKind manual, and an unknown sourceKind is refused', () => {
    const memory = seeded();
    const fact = memory.remember({ scopeId: 'project:kaprek', text: 'written by hand', origin: 'person', sourceKind: 'manual' });
    expect(fact.sourceKind).toBe('manual');
    expect(() => memory.remember({ scopeId: 'project:kaprek', text: 'x', origin: 'o', sourceKind: 'vibes' })).toThrow(InvalidMemoryError);
  });

  test('a provenance path survives the event log round trip', () => {
    const memory = seeded();
    memory.remember({ scopeId: 'project:kaprek', text: 'replayed later', origin: 'import:x', sourceKind: 'import', path: 'C:\\notes\\old.md', unverified: true });
    const reopened = openMemory(dataDir, { now });
    const [entry] = reopened.list({ scopeId: 'project:kaprek' });
    expect(entry.sourceKind).toBe('import');
    expect(entry.path).toBe('C:\\notes\\old.md');
    expect(entry.unverified).toBe(true);
  });
});

describe('forget', () => {
  test('is an event, not a deleted line', () => {
    const memory = seeded();
    const fact = memory.remember({ scopeId: 'project:kaprek', text: 'wrong thing', origin: 'o' });
    memory.forget(fact.id, 'it turned out to be false');

    expect(memory.recall({ scopeId: 'project:kaprek' })).toEqual([]);
    // The withdrawal is worth as much as the belief was.
    const withForgotten = memory.recall({ scopeId: 'project:kaprek', includeForgotten: true });
    expect(withForgotten[0]).toMatchObject({ forgotten: true, forgottenReason: 'it turned out to be false' });
  });

  test('refuses to forget something it never knew', () => {
    expect(() => seeded().forget('nope')).toThrow(MemoryNotFoundError);
  });
});

describe('replay', () => {
  test('survives a reopen, scopes and all', () => {
    const first = seeded();
    const fact = first.remember({ scopeId: 'mission:m3', text: 'the edge gate asks before the far side runs', origin: 'chat:9' });
    first.forget(fact.id, 'superseded');
    first.remember({ scopeId: 'mission:m3', text: 'the edge voucher buys one passage', origin: 'chat:9' });

    const second = openMemory(dataDir, { now });
    expect(second.scopes().map((scope) => scope.id)).toContain('mission:m3');
    expect(second.recall({ scopeId: 'mission:m3' }).map((entry) => entry.text)).toEqual(['the edge voucher buys one passage']);
    expect(second.get(fact.id).forgotten).toBe(true);
  });

  test('a corrupt line does not hide the memories after it', () => {
    const memory = seeded();
    memory.remember({ scopeId: 'person:klaus', text: 'first', origin: 'o' });
    fs.appendFileSync(path.join(dataDir, 'memory', 'events.jsonl'), '{not json\n', 'utf8');
    memory.remember({ scopeId: 'person:klaus', text: 'second', origin: 'o' });

    expect(openMemory(dataDir, { now }).recall({ scopeId: 'person:klaus' }).map((entry) => entry.text)).toEqual(['second', 'first']);
  });
});

// ------------------------------------------------------------- confirmations

test('learning the same fact again confirms it instead of duplicating it — count, sources and clock move', () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kaprek-memory-confirm-'));
  let clock = Date.parse('2026-05-01T10:00:00.000Z');
  const memory = openMemory(dataDir, { now: () => clock });
  memory.addScope({ id: 'person:local' });
  memory.addScope({ id: 'project:p', parent: 'person:local' });
  const first = memory.remember({ scopeId: 'project:p', text: 'Deploys go through wrangler.', kind: 'fact', origin: 'chat:a', confidence: 0.6 });
  expect(first).toMatchObject({ confirmations: 1, origins: ['chat:a'] });

  // 100 days later, another agent learns it — differently capitalised, no full stop.
  clock += 100 * 24 * 60 * 60 * 1000;
  expect(memory.list({ scopeId: 'project:p' })[0].stale).toBe(true);
  const again = memory.remember({ scopeId: 'project:p', text: 'deploys go through  wrangler', kind: 'fact', origin: 'chat:b', confidence: 0.9 });
  expect(again.id).toBe(first.id);
  expect(again.confirmed).toBe(true);
  expect(again).toMatchObject({ confirmations: 2, origins: ['chat:a', 'chat:b'], confidence: 0.9, stale: false });
  expect(memory.list({ scopeId: 'project:p' })).toHaveLength(1);

  // The same origin confirming again counts, but is listed once.
  expect(memory.remember({ scopeId: 'project:p', text: 'Deploys go through wrangler.', kind: 'fact', origin: 'chat:b' })).toMatchObject({ confirmations: 3, origins: ['chat:a', 'chat:b'] });

  // A different kind, a different scope, or a withdrawn fact is a new entry.
  memory.addScope({ id: 'project:q', parent: 'person:local' });
  expect(memory.remember({ scopeId: 'project:q', text: 'Deploys go through wrangler.', kind: 'fact', origin: 'chat:c' }).id).not.toBe(first.id);
  expect(memory.remember({ scopeId: 'project:p', text: 'Deploys go through wrangler.', kind: 'profile', origin: 'chat:c' }).id).not.toBe(first.id);
  memory.forget(first.id, 'wrong');
  expect(memory.remember({ scopeId: 'project:p', text: 'Deploys go through wrangler.', kind: 'fact', origin: 'chat:d' }).id).not.toBe(first.id);

  // Replay keeps the count.
  const reopened = openMemory(dataDir, { now: () => clock });
  expect(reopened.list({ scopeId: 'project:p' }).find((f) => f.id === first.id)).toMatchObject({ confirmations: 3, forgotten: true });
  fs.rmSync(dataDir, { recursive: true, force: true });
});

// --------------------------------------------- P0.5: schema gate (newer log = read-only)

test('P0.5: every written event carries schemaVersion: 1', () => {
  const memory = openMemory(dataDir, { now });
  memory.addScope({ id: 'person:klaus' });
  const line = JSON.parse(fs.readFileSync(path.join(dataDir, 'memory', 'events.jsonl'), 'utf8').trim());
  expect(line.schemaVersion).toBe(1);
});

test('P0.5: a log with a higher schemaVersion opens READ-ONLY — reads work, every append refuses, the file is untouched', () => {
  const dir = path.join(dataDir, 'memory');
  fs.mkdirSync(dir, { recursive: true });
  const events = [
    { schemaVersion: 1, id: 'e1', ts: '2026-08-01T10:00:00.000Z', type: 'scope.created', memoryId: 'person:alt', data: { id: 'person:alt' } },
    // One event a newer kaprek wrote — enough to put the whole log past us.
    { schemaVersion: 99, id: 'e2', ts: '2026-08-02T10:00:00.000Z', type: 'scope.created', memoryId: 'person:neu', data: { id: 'person:neu', futureField: true } },
  ];
  const before = `${events.map((e) => JSON.stringify(e)).join('\n')}\n`;
  fs.writeFileSync(path.join(dir, 'events.jsonl'), before, 'utf8');

  const memory = openMemory(dataDir, { now });
  // Reading and projection work — including the event this binary only
  // partially understands (unknown `data` fields ride along harmlessly).
  expect(memory.scopes().map((s) => s.id)).toEqual(['person:alt', 'person:neu']);

  // Every mutating path refuses with the honest "newer kaprek" message.
  const newerSchema = /newer kaprek version \(schema version 99 > 1\)/;
  expect(() => memory.addScope({ id: 'person:x' })).toThrow(newerSchema);
  expect(() => memory.remember({ scopeId: 'person:alt', text: 'x', kind: 'fact', origin: 'chat:c' })).toThrow(newerSchema);

  // Nothing was appended: byte-identical.
  expect(fs.readFileSync(path.join(dir, 'events.jsonl'), 'utf8')).toBe(before);
});

test('P0.5: events without a schemaVersion field count as version 1 — an old log stays fully writable (backwards-readable)', () => {
  const dir = path.join(dataDir, 'memory');
  fs.mkdirSync(dir, { recursive: true });
  const legacy = { id: 'e1', ts: '2026-08-01T10:00:00.000Z', type: 'scope.created', memoryId: 'person:alt', data: { id: 'person:alt' } };
  fs.writeFileSync(path.join(dir, 'events.jsonl'), `${JSON.stringify(legacy)}\n`, 'utf8');

  const memory = openMemory(dataDir, { now });
  expect(memory.scopes().map((s) => s.id)).toEqual(['person:alt']);
  expect(() => memory.addScope({ id: 'person:neu' })).not.toThrow();
  expect(memory.scopes().map((s) => s.id)).toEqual(['person:alt', 'person:neu']);
});
