// P6b — shape grants: the versioned derivation rule (v1), structural pattern
// matching, oldest-first multi-match, the fingerprint verdict, and the
// preview examples. The exact-half store tests live in grants.test.mjs.
import { test, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  createGrantStore,
  derivePattern,
  describePattern,
  shapeExamples,
  shapeFingerprintVerdict,
  patternCovers,
  DERIVATION_VERSION,
} from './grants.mjs';

const CWD = process.platform === 'win32' ? 'C:\\mission' : '/mission';

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
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'grants-shape-test-'));
});

afterEach(() => {
  fs.rmSync(dataDir, { recursive: true, force: true });
});

test('derivePattern v1 — command form: the head is the first token; deterministic; unsafe heads refused', () => {
  const p = derivePattern({ toolName: 'Bash', input: { command: 'npm  test --silent' }, cwd: CWD });
  expect(p).toEqual({ v: 1, toolName: 'Bash', type: 'command-head', keys: ['command'], head: 'npm' });
  expect(DERIVATION_VERSION).toBe(1);
  // Deterministic: same input, same pattern.
  expect(derivePattern({ toolName: 'Bash', input: { command: 'npm test' }, cwd: CWD })).toEqual(
    derivePattern({ toolName: 'Bash', input: { command: 'npm test' }, cwd: CWD }),
  );
  // Refused: a path-like head would generalise "runs this one script" into
  // something v1 cannot see; shell metacharacters and globs likewise.
  expect(derivePattern({ toolName: 'Bash', input: { command: './scripts/build.sh' }, cwd: CWD })).toBe(null);
  expect(derivePattern({ toolName: 'Bash', input: { command: '"evil" arg' }, cwd: CWD })).toBe(null);
});

test('derivePattern v1 — path form: containing directory of an absolute path INSIDE the mission cwd; everything else refused', () => {
  const p = derivePattern({ toolName: 'Write', input: { file_path: path.join(CWD, 'src', 'a.ts') }, cwd: CWD });
  expect(p).toEqual({ v: 1, toolName: 'Write', type: 'path-prefix', keys: ['file_path'], prefix: path.join(CWD, 'src') });
  // Relative paths, escapes outside the cwd, unknown keys, multi-key inputs,
  // non-string values: not derivable, never guessed.
  expect(derivePattern({ toolName: 'Write', input: { file_path: 'src/a.ts' }, cwd: CWD })).toBe(null);
  expect(derivePattern({ toolName: 'Write', input: { file_path: path.join(CWD, '..', 'escape.txt') }, cwd: CWD })).toBe(null);
  expect(derivePattern({ toolName: 'Write', input: { content: 'hello' }, cwd: CWD })).toBe(null);
  expect(derivePattern({ toolName: 'Write', input: { file_path: 'x', mode: 'w' }, cwd: CWD })).toBe(null);
  expect(derivePattern({ toolName: 'Write', input: { file_path: 7 }, cwd: CWD })).toBe(null);
});

test('shape matching: hits the same form; misses other heads, other key sets, other tools, other scopes, revoked', () => {
  const grants = createGrantStore({ dataDir, salt: 's'.repeat(64) });
  const pattern = derivePattern({ toolName: 'Bash', input: { command: 'npm test' }, cwd: CWD });
  const grant = grants.mint({ ...MINT, match: 'shape', pattern, derivationVersion: DERIVATION_VERSION });

  const hit = derivePattern({ toolName: 'Bash', input: { command: 'npm run build' }, cwd: CWD });
  expect(grants.matchShape({ toolName: 'Bash', inputPattern: hit, scope: 'mission:m1' }).map((g) => g.id)).toEqual([grant.id]);
  // Another head.
  expect(
    grants.matchShape({ toolName: 'Bash', inputPattern: derivePattern({ toolName: 'Bash', input: { command: 'git status' }, cwd: CWD }), scope: 'mission:m1' }),
  ).toHaveLength(0);
  // Another key set, same tool: the pattern names its keys; a different form does not match.
  expect(
    grants.matchShape({ toolName: 'Bash', inputPattern: { v: 1, toolName: 'Bash', type: 'command-head', keys: ['command', 'cwd'], head: 'npm' }, scope: 'mission:m1' }),
  ).toHaveLength(0);
  // Another tool, another scope, no pattern at all.
  expect(grants.matchShape({ toolName: 'Write', inputPattern: hit, scope: 'mission:m1' })).toHaveLength(0);
  expect(grants.matchShape({ toolName: 'Bash', inputPattern: hit, scope: 'mission:other' })).toHaveLength(0);
  expect(grants.matchShape({ toolName: 'Bash', inputPattern: null, scope: 'mission:m1' })).toHaveLength(0);

  // Revoked: never.
  grants.revoke(grant.id, 'revoked-by-user');
  expect(grants.matchShape({ toolName: 'Bash', inputPattern: hit, scope: 'mission:m1' })).toHaveLength(0);
});

test('path-prefix shape: files anywhere under the prefix match; another directory does not', () => {
  const grants = createGrantStore({ dataDir, salt: 's'.repeat(64) });
  const pattern = derivePattern({ toolName: 'Write', input: { file_path: path.join(CWD, 'src', 'a.ts') }, cwd: CWD });
  grants.mint({ ...MINT, toolName: 'Write', match: 'shape', pattern, derivationVersion: DERIVATION_VERSION });

  const hit = derivePattern({ toolName: 'Write', input: { file_path: path.join(CWD, 'src', 'deep', 'b.ts') }, cwd: CWD });
  expect(grants.matchShape({ toolName: 'Write', inputPattern: hit, scope: 'mission:m1' })).toHaveLength(1);
  const miss = derivePattern({ toolName: 'Write', input: { file_path: path.join(CWD, 'docs', 'c.md') }, cwd: CWD });
  expect(grants.matchShape({ toolName: 'Write', inputPattern: miss, scope: 'mission:m1' })).toHaveLength(0);
});

test('several live shape grants matching: the OLDEST wins (matchShape sorts oldest-first)', () => {
  // Two live same-pattern shape grants cannot arise from minting alone (a
  // twin supersedes its older twin), so the backdated record stands in for
  // the multiplicity case (e.g. a future rule change that stops auto-
  // superseding). It also pins the ORDER for any future writer of grants.
  const pattern = derivePattern({ toolName: 'Bash', input: { command: 'npm test' }, cwd: CWD });
  const newer = createGrantStore({ dataDir, salt: 's'.repeat(64) });
  const newerGrant = newer.mint({ ...MINT, match: 'shape', pattern, derivationVersion: DERIVATION_VERSION });
  const fixture = {
    schemaVersion: 1,
    id: 'e-old',
    ts: '1999-01-01T00:00:00.000Z',
    type: 'grant.minted',
    data: { ...MINT, id: 'g-old', match: 'shape', pattern, derivationVersion: DERIVATION_VERSION, createdAt: '1999-01-01T00:00:00.000Z' },
  };
  fs.appendFileSync(path.join(dataDir, 'grants.jsonl'), `${JSON.stringify(fixture)}\n`, 'utf8');

  const reopened = createGrantStore({ dataDir, salt: 's'.repeat(64) });
  const matches = reopened.matchShape({ toolName: 'Bash', inputPattern: pattern, scope: 'mission:m1' });
  expect(matches.map((g) => g.id)).toEqual(['g-old', newerGrant.id]);
  expect(matches[0].createdAt < matches[1].createdAt).toBe(true);
});

test('minting a shape twin supersedes the older shape grant; exact twins and exact matching are untouched by all of this', () => {
  const grants = createGrantStore({ dataDir, salt: 's'.repeat(64) });
  const pattern = derivePattern({ toolName: 'Bash', input: { command: 'npm test' }, cwd: CWD });
  const first = grants.mint({ ...MINT, match: 'shape', pattern, derivationVersion: DERIVATION_VERSION });
  const second = grants.mint({ ...MINT, match: 'shape', pattern, derivationVersion: DERIVATION_VERSION });
  expect(grants.get(first.id).supersededBy).toBe(second.id);

  // Exact beside shape: matched by hash only, no pattern, no derivationVersion.
  const exact = grants.mint({ ...MINT });
  expect(exact.match).toBe('exact');
  expect(exact.pattern).toBe(null);
  expect(exact.derivationVersion).toBe(null);
  expect(grants.match({ toolName: 'Bash', inputHash: MINT.inputHash, scope: 'mission:m1' }).map((g) => g.id)).toEqual([exact.id]);

  // A shape grant without a pattern or without its rule version is refused.
  expect(() => grants.mint({ ...MINT, match: 'shape', pattern: null, derivationVersion: null })).toThrow(/pattern/);
  expect(() => grants.mint({ ...MINT, match: 'shape', pattern, derivationVersion: null })).toThrow(/derivationVersion/);
});

test('shapeFingerprintVerdict: each component individually deviating → stale; posture loosening → reactivation', () => {
  const pattern = derivePattern({ toolName: 'Bash', input: { command: 'npm test' }, cwd: CWD });
  const grant = {
    ...MINT,
    match: 'shape',
    pattern,
    derivationVersion: 1,
    hardDenialsHash: 'b'.repeat(64),
    missionId: 'm1',
    postureAtGrant: 'ask',
    confirmedPosture: 'ask',
  };
  const current = { ceiling: 'ask', denialsHash: 'b'.repeat(64), missionId: 'm1', derivationVersion: 1 };
  expect(shapeFingerprintVerdict(grant, current)).toEqual({ ok: true });

  expect(shapeFingerprintVerdict(grant, { ...current, denialsHash: 'c'.repeat(64) })).toMatchObject({ ok: false, kind: 'stale' });
  expect(shapeFingerprintVerdict(grant, { ...current, missionId: 'm2' })).toMatchObject({ ok: false, kind: 'stale' });
  expect(shapeFingerprintVerdict(grant, { ...current, derivationVersion: 2 })).toMatchObject({ ok: false, kind: 'stale', why: /derivation rule changed/ });
  // Posture: the grant was confirmed under 'ask'. A LOOSER ceiling ('edits')
  // → reactivation; a grant confirmed under the looser 'edits' meeting the
  // tighter 'ask' ceiling → stale.
  expect(shapeFingerprintVerdict(grant, { ...current, ceiling: 'edits' })).toMatchObject({ ok: false, kind: 'reactivation' });
  grant.confirmedPosture = 'edits';
  expect(shapeFingerprintVerdict(grant, { ...current, ceiling: 'ask' })).toMatchObject({ ok: false, kind: 'stale' });
});

test('describePattern and shapeExamples: concrete example inputs whose matches labels are TRUE against the pattern', () => {
  const pattern = derivePattern({ toolName: 'Bash', input: { command: 'npm test' }, cwd: CWD });
  expect(describePattern(pattern, CWD)).toContain('npm');
  const examples = shapeExamples(pattern, CWD);
  expect(examples.length).toBeGreaterThanOrEqual(2);
  expect(examples.some((e) => e.matches)).toBe(true);
  expect(examples.some((e) => !e.matches)).toBe(true);
  for (const e of examples) {
    const derived = derivePattern({ toolName: 'Bash', input: e.input, cwd: CWD });
    expect(patternCovers({ match: 'shape', toolName: 'Bash', pattern }, { toolName: 'Bash', inputPattern: derived })).toBe(e.matches);
  }
  // Path form: same property — every labelled hit really matches, the labelled miss really does not.
  const p2 = derivePattern({ toolName: 'Write', input: { file_path: path.join(CWD, 'src', 'a.ts') }, cwd: CWD });
  for (const e of shapeExamples(p2, CWD)) {
    const derived = derivePattern({ toolName: 'Write', input: e.input, cwd: CWD });
    expect(patternCovers({ match: 'shape', toolName: 'Write', pattern: p2 }, { toolName: 'Write', inputPattern: derived })).toBe(e.matches);
  }
});
