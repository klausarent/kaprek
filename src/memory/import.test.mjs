import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { importManifest, looksLikeSecret, parseJsonl } from './import.mjs';
import { openMemory } from './store.mjs';
import { openMissions } from '../missions/store.mjs';

let dataDir;

beforeEach(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kaprek-import-'));
});

afterEach(() => {
  fs.rmSync(dataDir, { recursive: true, force: true });
});

const now = () => Date.parse('2026-08-28T10:00:00.000Z');

const SCOPE_MAP = {
  root: 'person:local',
  scopes: {
    'project:ccview': { parent: 'person:local', cwd: null, label: 'kaprek' },
    'project:kaprek-site': { parent: 'project:ccview', cwd: null },
  },
};

describe('parseJsonl', () => {
  test('parses one row per line', () => {
    const { rows, invalid } = parseJsonl('{"a":1}\n{"a":2}\n');
    expect(rows).toEqual([{ a: 1 }, { a: 2 }]);
    expect(invalid).toBe(0);
  });

  test('counts a broken line instead of throwing', () => {
    const { rows, invalid } = parseJsonl('{"a":1}\nnot json\n{"a":2}\n');
    expect(rows).toEqual([{ a: 1 }, { a: 2 }]);
    expect(invalid).toBe(1);
  });

  test('skips blank lines without counting them as invalid', () => {
    const { rows, invalid } = parseJsonl('{"a":1}\n\n   \n{"a":2}\n');
    expect(rows.length).toBe(2);
    expect(invalid).toBe(0);
  });
});

describe('looksLikeSecret', () => {
  test('catches a bearer token, an sk- key, and a PEM block', () => {
    expect(looksLikeSecret('Authorization: Bearer abcdefghijklmnop')).toBe(true);
    expect(looksLikeSecret('key is sk-abcdefghijklmnopqrstuvwx')).toBe(true);
    expect(looksLikeSecret('-----BEGIN PRIVATE KEY-----\nMIIBVQ==')).toBe(true);
  });

  test('leaves ordinary German prose alone', () => {
    expect(looksLikeSecret('Regel: nie ohne Freigabe posten, weil sonst Kunden verärgert werden.')).toBe(false);
    expect(looksLikeSecret('')).toBe(false);
  });
});

describe('scopes', () => {
  test('are created idempotently — a second import creates none', () => {
    const first = importManifest({ dataDir, scopeMap: SCOPE_MAP, now });
    expect(first.scopesCreated).toBe(3); // person:local + project:ccview + project:kaprek-site

    const second = importManifest({ dataDir, scopeMap: SCOPE_MAP, now });
    expect(second.scopesCreated).toBe(0);

    const memory = openMemory(dataDir, { now });
    const ids = memory.scopes().map((s) => s.id);
    expect(ids).toContain('person:local');
    expect(ids).toContain('project:ccview');
    expect(ids).toContain('project:kaprek-site');
  });
});

describe('facts', () => {
  const facts = [{ scopeId: 'project:ccview', kind: 'fact', text: 'Der Import läuft über importManifest.', origin: 'import:test', confidence: 0.9 }];

  test('a repeated fact confirms rather than duplicates', () => {
    const first = importManifest({ dataDir, scopeMap: SCOPE_MAP, facts, now });
    expect(first.factsNew).toBe(1);
    expect(first.factsConfirmed).toBe(0);

    const second = importManifest({ dataDir, scopeMap: SCOPE_MAP, facts, now: () => now() + 1000 });
    expect(second.factsNew).toBe(0);
    expect(second.factsConfirmed).toBe(1);

    const memory = openMemory(dataDir, { now });
    const stored = memory.list({ scopeId: 'project:ccview' });
    expect(stored.length).toBe(1);
    expect(stored[0].confirmations).toBe(2);
  });

  test('a line that looks like a secret is redacted away, not stored', () => {
    const secretFacts = [{ scopeId: 'project:ccview', kind: 'fact', text: 'Bearer abcdefghijklmnopqrstuv ist der Zugang.', origin: 'import:test' }];
    const result = importManifest({ dataDir, scopeMap: SCOPE_MAP, facts: secretFacts, now });
    expect(result.redacted).toBe(1);
    expect(result.factsNew).toBe(0);
    const memory = openMemory(dataDir, { now });
    expect(memory.list({ scopeId: 'project:ccview' })).toEqual([]);
  });

  test('a fact naming an unknown scope creates it under person:local', () => {
    const result = importManifest({
      dataDir,
      scopeMap: SCOPE_MAP,
      facts: [{ scopeId: 'project:unbekannt', kind: 'fact', text: 'Ein Fakt in einem neuen Scope.', origin: 'import:test' }],
      now,
    });
    expect(result.factsNew).toBe(1);
    expect(result.scopesCreated).toBeGreaterThanOrEqual(1);

    const memory = openMemory(dataDir, { now });
    const scope = memory.scopes().find((s) => s.id === 'project:unbekannt');
    expect(scope).toBeDefined();
    expect(scope.parent).toBe('person:local');
  });
});

describe('missions', () => {
  const projectDir = process.cwd(); // guaranteed to exist

  const missionRow = (title, cwd = projectDir) => ({
    mcId: 'abc123',
    scopeId: 'project:ccview',
    title,
    goal: '[mc:abc123] Import-Modul bauen',
    status: 'active',
    cwd,
    facts: ['Erste Erkenntnis zur Mission.'],
  });

  test('is created once, then updated on a changed title — never duplicated', () => {
    const first = importManifest({ dataDir, scopeMap: SCOPE_MAP, missions: [missionRow('Erster Titel')], now });
    expect(first.missionsNew).toBe(1);
    expect(first.missionsUpdated).toBe(0);

    const second = importManifest({ dataDir, scopeMap: SCOPE_MAP, missions: [missionRow('Geänderter Titel')], now: () => now() + 1000 });
    expect(second.missionsNew).toBe(0);
    expect(second.missionsUpdated).toBe(1);

    const missions = openMissions(dataDir).list();
    expect(missions.length).toBe(1);
    expect(missions[0].title).toBe('Geänderter Titel');

    const memory = openMemory(dataDir, { now });
    const missionScopeId = `mission:${missions[0].id}`;
    expect(memory.scopes().some((s) => s.id === missionScopeId)).toBe(true);
    expect(memory.list({ scopeId: missionScopeId }).map((f) => f.text)).toContain('Erste Erkenntnis zur Mission.');
  });

  test('a cwd that does not exist on disk becomes null, not a thrown error', () => {
    const missingCwd = path.join(dataDir, 'does-not-exist-anywhere');
    const result = importManifest({ dataDir, scopeMap: SCOPE_MAP, missions: [missionRow('Titel', missingCwd)], now });
    expect(result.missionsNew).toBe(1);
    const missions = openMissions(dataDir).list();
    expect(missions[0].cwd).toBeNull();
  });
});

describe('backup', () => {
  test('exists after a real run, not after a dry run', () => {
    const facts = [{ scopeId: 'project:ccview', kind: 'fact', text: 'Ein Fakt für das Backup.', origin: 'import:test' }];

    // Seed the store first, so there is an events.jsonl to back up.
    importManifest({ dataDir, scopeMap: SCOPE_MAP, facts, now });
    const eventsFile = path.join(dataDir, 'memory', 'events.jsonl');
    const beforeBytes = fs.readFileSync(eventsFile);

    const dry = importManifest({ dataDir, scopeMap: SCOPE_MAP, facts: [{ scopeId: 'project:ccview', kind: 'fact', text: 'Ein zweiter, neuer Fakt.', origin: 'import:test' }], dryRun: true, now });
    expect(dry.backup).toEqual([]);
    expect(fs.readFileSync(eventsFile).equals(beforeBytes)).toBe(true); // dry run touched nothing

    const real = importManifest({ dataDir, scopeMap: SCOPE_MAP, facts: [{ scopeId: 'project:ccview', kind: 'fact', text: 'Ein zweiter, neuer Fakt.', origin: 'import:test' }], now: () => now() + 5000 });
    expect(real.backup.length).toBeGreaterThan(0);
    for (const backupPath of real.backup) expect(fs.existsSync(backupPath)).toBe(true);
  });

  test('a dry run still computes the real counters (new vs. confirmed)', () => {
    const facts = [{ scopeId: 'project:ccview', kind: 'fact', text: 'Ein wiederholter Fakt.', origin: 'import:test' }];
    importManifest({ dataDir, scopeMap: SCOPE_MAP, facts, now });

    const dry = importManifest({ dataDir, scopeMap: SCOPE_MAP, facts, dryRun: true, now: () => now() + 1000 });
    expect(dry.factsNew).toBe(0);
    expect(dry.factsConfirmed).toBe(1);

    // The dry run must not actually have confirmed it in the real store.
    const memory = openMemory(dataDir, { now });
    expect(memory.list({ scopeId: 'project:ccview' })[0].confirmations).toBe(1);
  });
});
