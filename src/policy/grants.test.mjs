// Tests for the standing-grant store (P6a): append-only JSONL, projection on
// open, revocation as an event, schema gate, corruption handling.
import { test, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createGrantStore, inputHashOf } from './grants.mjs';

let dataDir;

const MINT = {
  scope: 'mission:m1',
  toolName: 'Bash',
  inputHash: 'a'.repeat(64),
  postureAtGrant: 'ask',
  hardDenialsHash: 'b'.repeat(64),
  missionId: 'm1',
  createdFromApprovalId: 'c1:1',
};

beforeEach(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'grants-test-'));
});

afterEach(() => {
  fs.rmSync(dataDir, { recursive: true, force: true });
});

test('missing grants.jsonl is an empty store, not an error; the salt is drawn and persisted once', () => {
  const grants = createGrantStore({ dataDir });
  expect(grants.list()).toEqual([]);
  expect(grants.countActive()).toBe(0);
  expect(fs.existsSync(path.join(dataDir, 'grants.jsonl'))).toBe(false);
  // First salt access draws AND persists, so the installation keeps one salt.
  const salt = grants.salt;
  expect(fs.existsSync(path.join(dataDir, 'grants.salt'))).toBe(true);
  expect(createGrantStore({ dataDir }).salt).toBe(salt);
});

test('an empty grants.jsonl file is nothing, not corruption', () => {
  fs.writeFileSync(path.join(dataDir, 'grants.jsonl'), '\n', 'utf8');
  const grants = createGrantStore({ dataDir, salt: 's'.repeat(64) });
  expect(grants.list()).toEqual([]);
});

test('mint, use and revoke are events; the projection counts uses and keeps the revoked record readable', () => {
  const grants = createGrantStore({ dataDir, salt: 's'.repeat(64) });
  const grant = grants.mint(MINT);
  expect(grant).toMatchObject({ scope: 'mission:m1', toolName: 'Bash', match: 'exact', useCount: 0, postureAtGrant: 'ask' });

  grants.use(grant.id);
  grants.use(grant.id);
  let after = grants.get(grant.id);
  expect(after.useCount).toBe(2);
  expect(after.lastUsedAt).toBeTruthy();

  const revoked = grants.revoke(grant.id, 'revoked-by-user');
  expect(revoked.ok).toBe(true);
  after = grants.get(grant.id);
  expect(after.revokedAt).toBeTruthy();
  expect(after.revokedReason).toBe('revoked-by-user');
  // Revocation is an event, never a deletion: the record stays listed.
  expect(grants.list()).toHaveLength(1);
  expect(grants.active()).toHaveLength(0);

  // Revoking twice is idempotent; using a revoked grant is refused.
  expect(grants.revoke(grant.id, 'revoked-by-user').already).toBe(true);
  expect(() => grants.use(grant.id)).toThrow(/revoked/);

  // Every step is its own line in the log — grants.jsonl is the audit trail.
  const lines = fs.readFileSync(path.join(dataDir, 'grants.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  expect(lines.map((l) => l.type)).toEqual(['grant.minted', 'grant.used', 'grant.used', 'grant.revoked']);
});

test('minting an exact twin supersedes the older grant, which stays readable with supersededBy set', () => {
  const grants = createGrantStore({ dataDir, salt: 's'.repeat(64) });
  const first = grants.mint(MINT);
  const second = grants.mint(MINT);
  expect(first.id).not.toBe(second.id);
  expect(grants.get(first.id).supersededBy).toBe(second.id);
  expect(grants.get(second.id).supersededBy).toBe(null);
  expect(grants.match({ toolName: 'Bash', inputHash: MINT.inputHash, scope: 'mission:m1' }).map((g) => g.id)).toEqual([second.id]);
  expect(() => grants.use(first.id)).toThrow(/superseded/);
});

test('match requires toolName, inputHash AND scope to be equal', () => {
  const grants = createGrantStore({ dataDir, salt: 's'.repeat(64) });
  grants.mint(MINT);
  expect(grants.match({ toolName: 'Bash', inputHash: MINT.inputHash, scope: 'mission:m1' })).toHaveLength(1);
  expect(grants.match({ toolName: 'Bash', inputHash: 'c'.repeat(64), scope: 'mission:m1' })).toHaveLength(0);
  expect(grants.match({ toolName: 'Write', inputHash: MINT.inputHash, scope: 'mission:m1' })).toHaveLength(0);
  expect(grants.match({ toolName: 'Bash', inputHash: MINT.inputHash, scope: 'mission:other' })).toHaveLength(0);
  expect(grants.match({ toolName: 'Bash', inputHash: MINT.inputHash, scope: 'global' })).toHaveLength(0);
});

test('the projection is rebuilt from the log after a restart', () => {
  const first = createGrantStore({ dataDir, salt: 's'.repeat(64) });
  const grant = first.mint(MINT);
  first.use(grant.id);
  first.revoke(grant.id, 'revoked-by-user');

  const second = createGrantStore({ dataDir, salt: 's'.repeat(64) });
  const after = second.get(grant.id);
  expect(after.useCount).toBe(1);
  expect(after.revokedReason).toBe('revoked-by-user');
  expect(after.createdAt).toBe(grant.createdAt);
});

test('a corrupt line moves the file aside loudly and the store stays usable', () => {
  const grants = createGrantStore({ dataDir, salt: 's'.repeat(64) });
  const grant = grants.mint(MINT);
  grants.use(grant.id);
  // Simulate a torn final line (crash mid-append).
  fs.appendFileSync(path.join(dataDir, 'grants.jsonl'), '{"schemaVersion":1,"type":"grant.use', 'utf8');

  const warnings = [];
  const reopened = createGrantStore({ dataDir, salt: 's'.repeat(64), log: (m) => warnings.push(m) });
  expect(reopened.list()).toEqual([]);
  expect(warnings.some((m) => m.includes('unreadable line'))).toBe(true);
  const aside = fs.readdirSync(dataDir).find((f) => f.startsWith('grants.corrupt-'));
  expect(aside).toBeTruthy();
  expect(fs.readFileSync(path.join(dataDir, aside), 'utf8')).toContain('grant.minted');
  // And the reopened store can mint again.
  expect(reopened.mint(MINT).id).not.toBe(grant.id);
});

test('a higher schemaVersion opens the store READ-ONLY: listing works, appending throws', () => {
  fs.writeFileSync(
    path.join(dataDir, 'grants.jsonl'),
    `${JSON.stringify({ schemaVersion: 99, id: 'e1', ts: new Date().toISOString(), type: 'grant.minted', data: { ...MINT, id: 'g-future' } })}\n`,
    'utf8',
  );
  const warnings = [];
  const grants = createGrantStore({ dataDir, salt: 's'.repeat(64), log: (m) => warnings.push(m) });
  expect(warnings.some((m) => m.includes('READ-ONLY'))).toBe(true);
  expect(grants.get('g-future').toolName).toBe('Bash');
  expect(grants.countActive()).toBe(1);
  expect(() => grants.mint(MINT)).toThrow(/READ-ONLY/);
  expect(() => grants.use('g-future')).toThrow(/READ-ONLY/);
  expect(() => grants.revoke('g-future', 'revoked-by-user')).toThrow(/READ-ONLY/);
  // The read-only log is not rewritten or deleted.
  expect(fs.existsSync(path.join(dataDir, 'grants.jsonl'))).toBe(true);
});

test('inputHashOf: same input and salt, same hash; different salt or input, different hash; unhashable input, null', () => {
  const salt = 's'.repeat(64);
  const input = { command: 'npm test', b: 2, a: 1 };
  const h = inputHashOf(salt, input);
  expect(h).toMatch(/^[0-9a-f]{64}$/);
  // Key order is not part of the identity (same canonicalisation as the approval store).
  expect(inputHashOf(salt, { a: 1, b: 2, command: 'npm test' })).toBe(h);
  expect(inputHashOf('t'.repeat(64), input)).not.toBe(h);
  expect(inputHashOf(salt, { command: 'npm test ' })).not.toBe(h);
  // A cyclic input cannot fall over: canonicalInput marks the cycle
  // ('[circular]'), so the hash exists and is deterministic — the honest
  // identity of a call the approval store could dedupe but nobody can read.
  const cyclic = {};
  cyclic.self = cyclic;
  const cyclicHash = inputHashOf(salt, cyclic);
  expect(cyclicHash).toMatch(/^[0-9a-f]{64}$/);
  expect(inputHashOf(salt, cyclic)).toBe(cyclicHash);
  // Over-cap input gets no hash at all (mirrors the truncated approval record).
  expect(inputHashOf(salt, { command: 'x'.repeat(1024 * 1024 + 10) })).toBe(null);
});
