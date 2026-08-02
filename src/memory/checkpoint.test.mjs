import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CHECKPOINT_AT, buildCheckpoint, buildRehydrationPrompt, readCheckpoint, shouldCheckpoint, wasCompacted, writeCheckpoint } from './checkpoint.mjs';

let dataDir;

beforeEach(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kaprek-checkpoint-'));
});

afterEach(() => {
  fs.rmSync(dataDir, { recursive: true, force: true });
});

const now = () => Date.parse('2026-08-02T10:00:00.000Z');

const transcript = [
  { kind: 'user', text: 'Make the relay walk a recipe graph.\nSecond line of the ask.' },
  { kind: 'assistant', text: 'I decided to translate the legacy route into a two-step recipe so there is one walker.\nA risk here is that the v1 vouchers stop matching.' },
  { kind: 'assistant', text: 'ok' },
];

describe('shouldCheckpoint', () => {
  test('fires exactly on the thresholds', () => {
    for (const threshold of CHECKPOINT_AT) expect(shouldCheckpoint(threshold)).toBe(true);
  });

  test('does not fire on every call after one', () => {
    // The bug this guards: a >= comparison would rewrite the checkpoint on
    // every tool call from 20 onwards.
    expect(shouldCheckpoint(21)).toBe(false);
    expect(shouldCheckpoint(19)).toBe(false);
    expect(shouldCheckpoint(100)).toBe(false);
  });
});

describe('buildCheckpoint', () => {
  test('takes the task from the ask, in its own words', () => {
    const checkpoint = buildCheckpoint({ chatId: 'c1', events: transcript, toolCalls: 20, now });
    expect(checkpoint.task).toBe('Make the relay walk a recipe graph.');
  });

  test('keeps decisions and risks as quoted sentences', () => {
    const checkpoint = buildCheckpoint({ chatId: 'c1', events: transcript, toolCalls: 20, now });
    expect(checkpoint.decisions[0]).toMatch(/translate the legacy route/);
    expect(checkpoint.risks[0]).toMatch(/v1 vouchers stop matching/);
  });

  test('skips lines too short or too long to mean anything', () => {
    const checkpoint = buildCheckpoint({
      chatId: 'c1',
      events: [
        { kind: 'user', text: 'go' },
        { kind: 'assistant', text: `decided\n${'decided '.repeat(60)}` },
      ],
      now,
    });
    expect(checkpoint.decisions).toEqual([]);
  });

  test('an empty chat produces an empty checkpoint rather than throwing', () => {
    expect(buildCheckpoint({ chatId: 'c1', events: [], now }).task).toBe('');
  });
});

describe('write and read', () => {
  test('lives next to its own chat, not in one shared file', () => {
    const checkpoint = buildCheckpoint({ chatId: 'c1', events: transcript, toolCalls: 40, now });
    expect(writeCheckpoint(dataDir, checkpoint)).toBe(true);
    // Two chats, two files: parallel agents must not overwrite each other's
    // idea of what they are doing.
    writeCheckpoint(dataDir, buildCheckpoint({ chatId: 'c2', events: [{ kind: 'user', text: 'a different job' }], now }));
    expect(readCheckpoint(dataDir, 'c1').task).toBe('Make the relay walk a recipe graph.');
    expect(readCheckpoint(dataDir, 'c2').task).toBe('a different job');
  });

  test('a missing checkpoint reads as null, not as a crash', () => {
    expect(readCheckpoint(dataDir, 'never-written')).toBeNull();
  });
});

describe('rehydration', () => {
  test('puts the task and the decisions back', () => {
    const prompt = buildRehydrationPrompt(buildCheckpoint({ chatId: 'c1', events: transcript, now }));
    expect(prompt).toContain('Make the relay walk a recipe graph.');
    expect(prompt).toContain('translate the legacy route');
    expect(prompt).toMatch(/do not re-open them/);
  });

  test('says a summary loses against what the agent can see', () => {
    const prompt = buildRehydrationPrompt(buildCheckpoint({ chatId: 'c1', events: transcript, now }));
    expect(prompt).toMatch(/what you can see wins/);
  });

  test('says nothing when there is nothing to say', () => {
    expect(buildRehydrationPrompt(null)).toBe('');
    expect(buildRehydrationPrompt(buildCheckpoint({ chatId: 'c1', events: [], now }))).toBe('');
  });
});

describe('wasCompacted', () => {
  test('recognizes the marker the parser already writes', () => {
    expect(wasCompacted([{ kind: 'user' }, { kind: 'compact', preTokens: 100, postTokens: 10 }])).toBe(true);
  });

  test('an ordinary chat has not been compacted', () => {
    expect(wasCompacted(transcript)).toBe(false);
    expect(wasCompacted()).toBe(false);
  });
});
