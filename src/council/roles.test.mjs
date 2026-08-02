import { test, expect } from 'vitest';
import { COUNCIL_ROLES, COUNCIL_LEVELS, suggestAssignment, validateAssignment, councilStatus, shouldConsult } from './roles.mjs';

const three = ['claude-code', 'codex', 'grok'];

test('every role is filled from what is actually installed', () => {
  const assignment = suggestAssignment(three);
  for (const role of COUNCIL_ROLES) expect(assignment).toHaveProperty(role);
  expect(three).toContain(assignment.lead);
  expect(assignment.peer.every((id) => three.includes(id))).toBe(true);
});

test('the lead never sits on the peer bench — a model asking itself is not a second opinion', () => {
  const assignment = suggestAssignment(three);
  expect(assignment.peer).not.toContain(assignment.lead);
  expect(assignment.peer.length).toBeGreaterThan(0);
});

test('the first engine offered becomes the lead, so nobody is hard-wired as the main one', () => {
  // Klaus: "Nicht jeder arbeitet mit Claude als Main so wie ich."
  expect(suggestAssignment(['codex', 'claude-code', 'grok']).lead).toBe('codex');
  expect(suggestAssignment(['grok', 'codex']).lead).toBe('grok');
});

test('one engine means no council, stated rather than faked', () => {
  const assignment = suggestAssignment(['claude-code']);
  expect(assignment.lead).toBe('claude-code');
  expect(assignment.peer).toEqual([]);
  // The other roles still get filled — one engine can do all the work, it
  // just cannot disagree with itself.
  expect(assignment.thinker).toBe('claude-code');
  expect(assignment.worker).toBe('claude-code');

  const status = councilStatus(assignment);
  expect(status.possible).toBe(false);
  expect(status.reason).toContain('second');
});

test('no engines at all is not a crash', () => {
  const assignment = suggestAssignment([]);
  expect(assignment.lead).toBeNull();
  expect(assignment.peer).toEqual([]);
  expect(councilStatus(assignment).possible).toBe(false);
});

test('an assignment naming an engine that is not there is refused, with the name in the error', () => {
  const bad = validateAssignment({ lead: 'claude-code', thinker: 'gone', worker: 'claude-code', peer: ['codex'] }, three);
  expect(bad.ok).toBe(false);
  expect(bad.errors.join(' ')).toContain('gone');

  const good = validateAssignment({ lead: 'claude-code', thinker: 'codex', worker: 'claude-code', peer: ['codex', 'grok'] }, three);
  expect(good.ok).toBe(true);
});

test('a peer that is also the lead is refused — that is the one rule the whole thing rests on', () => {
  const bad = validateAssignment({ lead: 'codex', thinker: 'codex', worker: 'codex', peer: ['codex'] }, three);
  expect(bad.ok).toBe(false);
  expect(bad.errors.join(' ').toLowerCase()).toContain('peer');
});

test('duplicate peers collapse instead of being asked twice', () => {
  const assignment = suggestAssignment(three);
  const validated = validateAssignment({ ...assignment, peer: ['codex', 'codex', 'grok'] }, three);
  expect(validated.ok).toBe(true);
  expect(validated.assignment.peer).toEqual(['codex', 'grok']);
});

test('the levels decide when a peer is asked without being asked for', () => {
  expect(COUNCIL_LEVELS).toEqual(['off', 'plans', 'decisions', 'always']);

  expect(shouldConsult('off', 'plan')).toBe(false);
  expect(shouldConsult('off', 'manual')).toBe(true); // the button always works

  expect(shouldConsult('plans', 'plan')).toBe(true);
  expect(shouldConsult('plans', 'decision')).toBe(false);
  expect(shouldConsult('plans', 'turn')).toBe(false);

  expect(shouldConsult('decisions', 'decision')).toBe(true);
  expect(shouldConsult('decisions', 'plan')).toBe(true);
  expect(shouldConsult('decisions', 'turn')).toBe(false);

  expect(shouldConsult('always', 'turn')).toBe(true);
});

test('an unknown level asks nothing rather than everything', () => {
  expect(shouldConsult('enthusiastic', 'plan')).toBe(false);
  expect(shouldConsult(undefined, 'plan')).toBe(false);
});
