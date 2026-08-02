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
