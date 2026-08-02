import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PROPOSE_AFTER, ProposalNotFoundError, buildRulesPrompt, openPolicy } from './policy.mjs';

let dataDir;

beforeEach(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kaprek-policy-'));
});

afterEach(() => {
  fs.rmSync(dataDir, { recursive: true, force: true });
});

const now = () => Date.parse('2026-08-02T10:00:00.000Z');

const failure = (where) => ({
  pattern: 'relay step ran on the wrong engine',
  where,
  rule: 'A relay step names its engine in the recipe; never fall back to the default one.',
});

describe('sawFailure', () => {
  test('says nothing until the same thing has happened often enough', () => {
    const policy = openPolicy(dataDir, { now });
    expect(policy.sawFailure(failure('chat:1'))).toEqual({ seen: 1 });
    expect(policy.sawFailure(failure('chat:2'))).toEqual({ seen: 2 });
    expect(policy.sawFailure(failure('chat:3')).proposal.rule).toMatch(/names its engine/);
    expect(PROPOSE_AFTER).toBe(3);
  });

  test('proposes once, not once per sighting', () => {
    const policy = openPolicy(dataDir, { now });
    for (let i = 0; i < 6; i += 1) policy.sawFailure(failure(`chat:${i}`));
    expect(policy.list()).toHaveLength(1);
  });

  test('carries where it was seen, so the proposal can be checked', () => {
    const policy = openPolicy(dataDir, { now });
    for (const where of ['chat:1', 'chat:2', 'chat:3']) policy.sawFailure(failure(where));
    // All three, including the one that triggered the proposal — a reviewer
    // asking "where did this happen?" wants every place, not all but one.
    expect(policy.list()[0].seenIn).toEqual(['chat:1', 'chat:2', 'chat:3']);
  });

  test('a rejected rule is not proposed again on the next sighting', () => {
    const policy = openPolicy(dataDir, { now });
    for (const where of ['chat:1', 'chat:2', 'chat:3']) policy.sawFailure(failure(where));
    policy.decide(policy.list()[0].id, 'rejected', 'that was my own test setup, not a real pattern');

    policy.sawFailure(failure('chat:4'));
    // Asking again after a no is nagging, not diligence.
    expect(policy.list()).toHaveLength(1);
    expect(policy.list()[0].status).toBe('rejected');
  });
});

describe('a proposal is inert until somebody says yes', () => {
  test('proposed rules are not active rules', () => {
    const policy = openPolicy(dataDir, { now });
    for (const where of ['chat:1', 'chat:2', 'chat:3']) policy.sawFailure(failure(where));
    // The whole point: kaprek noticed, wrote it down, and changed nothing.
    expect(policy.activeRules()).toEqual([]);
  });

  test('accepting it is what makes it a rule', () => {
    const policy = openPolicy(dataDir, { now });
    for (const where of ['chat:1', 'chat:2', 'chat:3']) policy.sawFailure(failure(where));
    policy.decide(policy.list()[0].id, 'accepted');
    expect(policy.activeRules()).toEqual(['A relay step names its engine in the recipe; never fall back to the default one.']);
  });

  test('refuses a decision that is neither yes nor no', () => {
    const policy = openPolicy(dataDir, { now });
    for (const where of ['chat:1', 'chat:2', 'chat:3']) policy.sawFailure(failure(where));
    expect(() => policy.decide(policy.list()[0].id, 'maybe')).toThrow(/accepted or rejected/);
  });

  test('refuses to decide something it never proposed', () => {
    expect(() => openPolicy(dataDir, { now }).decide('nope', 'accepted')).toThrow(ProposalNotFoundError);
  });

  test('survives a reopen', () => {
    const first = openPolicy(dataDir, { now });
    for (const where of ['chat:1', 'chat:2', 'chat:3']) first.sawFailure(failure(where));
    first.decide(first.list()[0].id, 'accepted');

    expect(openPolicy(dataDir, { now }).activeRules()).toHaveLength(1);
  });
});

describe('buildRulesPrompt', () => {
  test('is empty when nothing was accepted', () => {
    expect(buildRulesPrompt([])).toBe('');
  });

  test('states them as rules, because a person agreed to them', () => {
    // Unlike the memory block, which is explicitly "what previous turns
    // wrote down, not instructions".
    const prompt = buildRulesPrompt(['Never push to main without asking.']);
    expect(prompt).toContain('Never push to main without asking.');
    expect(prompt).toMatch(/reviewed and accepted/);
  });
});
