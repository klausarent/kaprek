import { describe, test, expect } from 'vitest';
import { FAILURES_BEFORE_REST, REST_MS, createPeerHealth } from './health.mjs';

function at(start) {
  let clock = start;
  return { now: () => clock, advance: (ms) => (clock += ms) };
}

describe('createPeerHealth', () => {
  test('asks everyone by default', () => {
    expect(createPeerHealth().check('grok')).toEqual({ ask: true });
  });

  test('one failure is a bad minute, not a verdict', () => {
    const health = createPeerHealth();
    health.failed('grok');
    expect(health.check('grok').ask).toBe(true);
    expect(FAILURES_BEFORE_REST).toBe(2);
  });

  test('two in a row and it is rested — with the reason', () => {
    const health = createPeerHealth();
    health.failed('grok');
    health.failed('grok');
    const state = health.check('grok');
    expect(state.ask).toBe(false);
    // Said, not hidden: a quietly dropped peer turns "two agreed" into a
    // sentence about one.
    expect(state.reason).toMatch(/did not answer 2 times/);
    expect(state.reason).toMatch(/minutes/);
  });

  test('the rest ends on its own', () => {
    const clock = at(1000);
    const health = createPeerHealth({ now: clock.now });
    health.failed('grok');
    health.failed('grok');
    expect(health.check('grok').ask).toBe(false);
    clock.advance(REST_MS + 1);
    expect(health.check('grok').ask).toBe(true);
  });

  test('an answer forgives everything', () => {
    const health = createPeerHealth();
    health.failed('grok');
    health.failed('grok');
    health.succeeded('grok');
    expect(health.check('grok').ask).toBe(true);
    expect(health.snapshot()).toEqual([]);
  });

  test('one broken peer does not rest the others', () => {
    const health = createPeerHealth();
    health.failed('grok');
    health.failed('grok');
    expect(health.check('codex').ask).toBe(true);
  });
});
