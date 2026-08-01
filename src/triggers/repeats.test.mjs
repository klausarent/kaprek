import { test, expect } from 'vitest';
import { findRepeats, repeatKey, REPEAT_THRESHOLD } from './repeats.mjs';

const NOW = Date.parse('2026-08-01T12:00:00.000Z');
const ago = (days) => new Date(NOW - days * 24 * 60 * 60 * 1000).toISOString();
const ask = (text, days = 0) => ({ kind: 'user', text, ts: ago(days) });

test('the same request phrased three ways still counts as the same request', () => {
  expect(repeatKey('Summarize the sales numbers for this week')).toBe(repeatKey('summarize the sales numbers for this week!'));
  expect(repeatKey('  Summarize   the sales numbers, for this week  ')).toBe(repeatKey('Summarize the sales numbers for this week'));
  expect(repeatKey('Deploy the marketing site')).not.toBe(repeatKey('Summarize the sales numbers'));
});

test('three repetitions cross the threshold; two do not', () => {
  const twice = findRepeats([ask('Summarize the sales numbers for this week', 4), ask('summarize the sales numbers for this week', 2)], { now: NOW });
  expect(twice).toHaveLength(0);

  const thrice = findRepeats(
    [ask('Summarize the sales numbers for this week', 6), ask('summarize the sales numbers for this week', 4), ask('Summarize the sales numbers for this week please', 1)],
    { now: NOW },
  );
  expect(thrice).toHaveLength(1);
  expect(thrice[0].count).toBe(REPEAT_THRESHOLD);
  // The suggestion quotes the LATEST phrasing — the user's own most recent words.
  expect(thrice[0].sample).toBe('Summarize the sales numbers for this week please');
});

test('steering turns and stale prompts never trigger a suggestion', () => {
  const steering = findRepeats([ask('yes'), ask('yes'), ask('yes'), ask('go on'), ask('go on'), ask('go on')], { now: NOW });
  expect(steering).toHaveLength(0);

  const stale = findRepeats(
    [ask('Check the deployment logs for errors', 90), ask('Check the deployment logs for errors', 80), ask('Check the deployment logs for errors', 70)],
    { now: NOW },
  );
  expect(stale).toHaveLength(0);
});

test('assistant turns are not requests, and the most repeated request comes first', () => {
  const events = [
    ask('Check the deployment logs for errors', 3),
    { kind: 'assistant', text: 'Check the deployment logs for errors', ts: ago(3) },
    ask('Check the deployment logs for errors', 2),
    ask('Check the deployment logs for errors', 1),
    ask('Write the weekly customer update draft', 5),
    ask('Write the weekly customer update draft', 4),
    ask('Write the weekly customer update draft', 3),
    ask('Write the weekly customer update draft', 2),
  ];
  const repeats = findRepeats(events, { now: NOW });
  expect(repeats.map((r) => r.count)).toEqual([4, 3]);
  expect(repeats[0].sample).toContain('weekly customer update');
});
