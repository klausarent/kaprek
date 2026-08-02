import { describe, test, expect } from 'vitest';
import { HOME_MISSIONS, buildHomePrompt, homeMission, homeSummary, plainLanguage } from './home.mjs';

describe('HOME_MISSIONS', () => {
  test('the four Klaus named, and no more', () => {
    expect(HOME_MISSIONS.map((mission) => mission.id)).toEqual(['game', 'trip', 'tool', 'reel']);
  });

  test('at most three questions each — a fourth means the first three were vague', () => {
    for (const mission of HOME_MISSIONS) {
      expect(mission.questions.length).toBeLessThanOrEqual(3);
      expect(mission.questions.length).toBeGreaterThan(0);
    }
  });

  test('every question is answerable by someone who has not thought about it yet', () => {
    for (const mission of HOME_MISSIONS) {
      for (const question of mission.questions) {
        // Either a short list to pick from, or an invitation to type one
        // thing. Never both empty, which would be a blank prompt with a
        // question mark on it.
        expect(question.options.length > 0 || question.freeText === true).toBe(true);
        expect(question.question.endsWith('?')).toBe(true);
      }
    }
  });

  test('every mission says what finished looks like, in something you can point at', () => {
    for (const mission of HOME_MISSIONS) {
      expect(mission.done.length).toBeGreaterThan(10);
      // Not "a successful outcome" — a file, a plan, a thing that runs.
      expect(mission.done).toMatch(/file|plan|run|read|play/i);
    }
  });

  test('no jargon in anything a person reads', () => {
    const surface = HOME_MISSIONS.flatMap((mission) => [mission.title, mission.blurb, mission.done, ...mission.questions.map((question) => question.question)]).join(' ');
    for (const term of ['prompt', 'token', 'model', 'agent', 'llm', 'repository', 'commit']) {
      // Whole words only: "teleprompter" is what the thing is called, and a
      // substring check would ban the one screen it belongs on.
      // String.raw, because `\b` inside a template literal is a backspace
      // character — the test would have passed against anything.
      expect(surface.toLowerCase()).not.toMatch(new RegExp(String.raw`\b${term}s?\b`));
    }
  });
});

describe('homeMission', () => {
  test('finds one by id, and null for anything else', () => {
    expect(homeMission('game').title).toBe('Build a small game');
    expect(homeMission('nope')).toBeNull();
  });
});

describe('buildHomePrompt', () => {
  test('carries every answer through', () => {
    const prompt = buildHomePrompt(homeMission('game'), { about: 'Catching things that fall', who: 'A young child', look: 'Bright and simple shapes' });
    expect(prompt).toContain('Catching things that fall');
    expect(prompt).toContain('A young child');
  });

  test('an unanswered question is marked, not dropped', () => {
    // Dropping it would leave the agent guessing without knowing it is
    // guessing.
    expect(buildHomePrompt(homeMission('game'), { about: 'A maze' })).toContain('(not answered)');
  });

  test('tells the agent not to keep asking', () => {
    const prompt = buildHomePrompt(homeMission('tool'), {});
    expect(prompt).toMatch(/Do not ask more/);
    expect(prompt).toMatch(/not a programmer/);
  });

  test('ends with what finished looks like', () => {
    expect(buildHomePrompt(homeMission('trip'), {})).toContain('A plan per day');
  });
});

describe('plainLanguage', () => {
  test('replaces the words that only mean something to insiders', () => {
    expect(plainLanguage('The model used 4000 tokens for that prompt.')).toBe('The kaprek used 4000 lengths for that what you asked for.');
  });

  test('keeps the first letter as it was', () => {
    expect(plainLanguage('Agent finished.')).toBe('Kaprek finished.');
  });

  test('leaves ordinary words alone', () => {
    expect(plainLanguage('The plan is ready and the file is saved.')).toBe('The plan is ready and the file is saved.');
  });

  test('is for display only', () => {
    // Stated as a test because it is the rule that matters: the transcript
    // is not rewritten, so switching to the full view shows the real thing.
    const original = 'The agent wrote a commit.';
    plainLanguage(original);
    expect(original).toBe('The agent wrote a commit.');
  });
});

describe('homeSummary', () => {
  test('says what it is, where it is, and what was remembered', () => {
    const lines = homeSummary({ mission: homeMission('game'), files: ['game.html'], remembered: ['Luca is six'] });
    expect(lines[0]).toContain('double-click');
    expect(lines.join(' ')).toContain('game.html');
    // The one piece of machinery worth showing even here: a person told
    // "I remembered X" understands why the next one goes better.
    expect(lines.join(' ')).toContain('Remembered for next time');
  });

  test('with nothing to point at, it says only what was meant to happen', () => {
    expect(homeSummary({ mission: homeMission('reel') })).toHaveLength(1);
  });
});
