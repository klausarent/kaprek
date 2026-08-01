import { test, expect } from 'vitest';
import path from 'node:path';
import { buildModePrompt, planPathFor, PLAN_MODES, InvalidModeError } from './prompt.mjs';
import { QUIZ_FENCE } from './quiz.mjs';

const CWD = path.join('C:', 'work', 'newsletter');

test('the brainstorm prompt teaches the exact fence the parser reads', () => {
  const prompt = buildModePrompt({ mode: 'brainstorm', cwd: CWD, planPath: planPathFor({ cwd: CWD, topic: 'newsletter generator', ts: '2026-08-02T01:00:00.000Z' }) });
  expect(prompt).toContain(QUIZ_FENCE);
  expect(prompt).toContain('"questions"');
  // One packet per turn: the turn ending IS the question being asked.
  expect(prompt.toLowerCase()).toContain('end your turn');
});

test('both prompts name the destination as an absolute path', () => {
  const planPath = planPathFor({ cwd: CWD, topic: 'newsletter generator', ts: '2026-08-02T01:00:00.000Z' });
  expect(path.isAbsolute(planPath)).toBe(true);
  for (const mode of PLAN_MODES) {
    expect(buildModePrompt({ mode, cwd: CWD, planPath })).toContain(planPath);
  }
});

test('the plan prompt asks for checkbox steps, because that is what the UI ticks', () => {
  const prompt = buildModePrompt({ mode: 'plan', cwd: CWD, planPath: planPathFor({ cwd: CWD, topic: 'x', ts: '2026-08-02T01:00:00.000Z' }) });
  expect(prompt).toContain('- [ ]');
});

test('an unknown mode is refused rather than silently ignored', () => {
  expect(() => buildModePrompt({ mode: 'freestyle', cwd: CWD, planPath: 'C:\\x\\p.md' })).toThrow(InvalidModeError);
  expect(() => buildModePrompt({ mode: undefined, cwd: CWD, planPath: 'C:\\x\\p.md' })).toThrow(InvalidModeError);
});

test('the path is derived from date and topic, and stays inside the working directory', () => {
  const planPath = planPathFor({ cwd: CWD, topic: 'Newsletter Generator!! (v2)', ts: '2026-08-02T01:00:00.000Z' });
  expect(planPath.startsWith(path.resolve(CWD))).toBe(true);
  expect(planPath).toContain('2026-08-02');
  expect(path.basename(planPath)).toBe('2026-08-02-newsletter-generator-v2.md');
});

test('a topic that is empty or all punctuation still yields a usable filename', () => {
  const planPath = planPathFor({ cwd: CWD, topic: '???', ts: '2026-08-02T01:00:00.000Z' });
  expect(path.basename(planPath)).toBe('2026-08-02-plan.md');
});

test('a topic cannot escape the directory with slashes or dots', () => {
  const planPath = planPathFor({ cwd: CWD, topic: '../../etc/passwd', ts: '2026-08-02T01:00:00.000Z' });
  expect(planPath.startsWith(path.resolve(CWD))).toBe(true);
  expect(planPath).not.toContain('..');
});

test('no working directory means the plan lands in kaprek own workspace', () => {
  const planPath = planPathFor({ cwd: null, dataDir: path.join('C:', 'Users', 'k', '.kaprek'), topic: 'idea', ts: '2026-08-02T01:00:00.000Z' });
  expect(planPath.startsWith(path.join('C:', 'Users', 'k', '.kaprek', 'workspace'))).toBe(true);
});
