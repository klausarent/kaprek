import { describe, test, expect } from 'vitest';
import { MAX_PER_TURN, REMEMBER_FENCE, buildMemoryPrompt, parseRemember } from './protocol.mjs';

const block = (body) => ['```' + REMEMBER_FENCE, body, '```'].join('\n');

describe('parseRemember', () => {
  test('reads one statement out of an answer', () => {
    const answer = ['Fixed it.', '', block('{"text": "codex needs its own session id", "kind": "fact"}'), '', 'Anything else?'].join('\n');
    expect(parseRemember(answer)).toEqual([{ text: 'codex needs its own session id', kind: 'fact', confidence: 0.8 }]);
  });

  test('keeps every block, because remembering is additive', () => {
    // Unlike the quiz, where the last block wins: two blocks are two things
    // learned, not a correction.
    const answer = [block('{"text": "first"}'), block('{"text": "second"}')].join('\n\n');
    expect(parseRemember(answer).map((entry) => entry.text)).toEqual(['first', 'second']);
  });

  test('accepts an array in one block', () => {
    expect(parseRemember(block('[{"text": "a"}, {"text": "b"}]')).map((entry) => entry.text)).toEqual(['a', 'b']);
  });

  test('caps what one turn may add', () => {
    const many = JSON.stringify(Array.from({ length: 20 }, (_, index) => ({ text: `fact ${index}` })));
    expect(parseRemember(block(many))).toHaveLength(MAX_PER_TURN);
  });

  test('ignores a block that is not JSON rather than guessing', () => {
    expect(parseRemember(block('remember that the build is slow'))).toEqual([]);
  });

  test('ignores an entry with no text', () => {
    expect(parseRemember(block('{"kind": "fact"}'))).toEqual([]);
  });

  test('a kind it does not know becomes a plain fact', () => {
    // 'evidence' is kaprek's own bookkeeping; an agent asking for it gets a
    // fact instead of a rejected block.
    expect(parseRemember(block('{"text": "x", "kind": "evidence"}'))[0].kind).toBe('fact');
  });

  test('an unclosed block is not a memory', () => {
    expect(parseRemember('```' + REMEMBER_FENCE + '\n{"text": "half a thought"}')).toEqual([]);
  });

  test('a block shown INSIDE a longer fence is an example, not an instruction', () => {
    // The same trap the quiz parser had: kaprek's own prompt shows this
    // format in a code block, and a model quoting the prompt back would
    // otherwise write the example into the store.
    const answer = ['````markdown', block('{"text": "the example"}'), '````'].join('\n');
    expect(parseRemember(answer)).toEqual([]);
  });

  test('an answer with nothing to remember says nothing', () => {
    expect(parseRemember('Just a normal answer.')).toEqual([]);
    expect(parseRemember(null)).toEqual([]);
  });
});

describe('buildMemoryPrompt', () => {
  test('still explains how to write, even with nothing to show', () => {
    // The first live M3 run died here: an empty store meant an empty block,
    // so the agent never learned the format, so nothing was ever written,
    // so the store stayed empty.
    const prompt = buildMemoryPrompt([]);
    expect(prompt).toContain(REMEMBER_FENCE);
    expect(prompt).toMatch(/Nothing yet/);
  });

  test('puts the profile before the facts', () => {
    const prompt = buildMemoryPrompt([
      { text: 'a learned fact', kind: 'fact', stale: false },
      { text: 'kaprek is a local agent workspace', kind: 'profile', stale: false },
    ]);
    expect(prompt.indexOf('local agent workspace')).toBeLessThan(prompt.indexOf('a learned fact'));
  });

  test('marks a stale entry instead of hiding it', () => {
    const prompt = buildMemoryPrompt([{ text: 'the token lives in .env', kind: 'fact', stale: true }]);
    expect(prompt).toMatch(/possibly out of date/);
  });

  test('tells the agent that memory loses against what it can see', () => {
    const prompt = buildMemoryPrompt([{ text: 'x', kind: 'fact', stale: false }]);
    expect(prompt).toMatch(/trust what you find/);
  });

  test('never invites secrets', () => {
    expect(buildMemoryPrompt([{ text: 'x', kind: 'fact', stale: false }])).toMatch(/never a secret/);
  });
});

describe('the frozen block', () => {
  const profile = (createdAt) => ({ text: `profile from ${createdAt}`, kind: 'profile', stale: false, createdAt });
  const fact = (createdAt) => ({ text: `fact from ${createdAt}`, kind: 'fact', stale: false, createdAt });

  test('a profile written before this chat began is in', () => {
    const prompt = buildMemoryPrompt([profile('2026-08-01T09:00:00.000Z')], { frozenSince: '2026-08-02T09:00:00.000Z' });
    expect(prompt).toContain('profile from 2026-08-01');
  });

  test('a profile written after it began waits for the next chat', () => {
    // The prompt's head is what a prefix cache keys on. Changing it
    // mid-conversation throws away every cached token for the rest of it.
    const prompt = buildMemoryPrompt([profile('2026-08-02T10:00:00.000Z')], { frozenSince: '2026-08-02T09:00:00.000Z' });
    expect(prompt).not.toContain('profile from 2026-08-02');
  });

  test('facts are not frozen — they are meant to arrive as they are learned', () => {
    const prompt = buildMemoryPrompt([fact('2026-08-02T10:00:00.000Z')], { frozenSince: '2026-08-02T09:00:00.000Z' });
    expect(prompt).toContain('fact from 2026-08-02');
  });

  test('without a freeze line nothing is held back', () => {
    expect(buildMemoryPrompt([profile('2026-08-02T10:00:00.000Z')])).toContain('profile from 2026-08-02');
  });
});
