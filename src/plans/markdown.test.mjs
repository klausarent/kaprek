import { test, expect } from 'vitest';
import { parseSteps, setStep, planTitle } from './markdown.mjs';

const PLAN = [
  '# Newsletter generator',
  '',
  '## Task 1: Store',
  '',
  '- [ ] **Step 1: Write the failing test**',
  '- [x] Already done',
  '  - [ ] An indented step still counts',
  '',
  'Prose with a - [ ] lookalike inside a sentence.',
  '* [ ] A star bullet is a checkbox too',
  '',
].join('\n');

test('checkboxes are steps, prose is not', () => {
  const steps = parseSteps(PLAN);
  expect(steps.map((s) => s.text)).toEqual([
    '**Step 1: Write the failing test**',
    'Already done',
    'An indented step still counts',
    'A star bullet is a checkbox too',
  ]);
  expect(steps.map((s) => s.done)).toEqual([false, true, false, false]);
});

test('a document with no checkboxes has no steps', () => {
  expect(parseSteps('# Just a design doc\n\nSome prose.')).toEqual([]);
  expect(parseSteps(null)).toEqual([]);
});

test('a checkbox inside a code fence is an example, not a step', () => {
  // Found by Codex' adversarial review: kaprek's own guided-plan prompt shows
  // the format inside a fence, so any plan quoting it would grow phantom
  // steps — and ticking one would rewrite the example.
  const doc = ['# Plan', '', 'Format steps like this:', '', '```markdown', '- [ ] Not a real step', '```', '', '- [ ] A real step', ''].join('\n');
  const steps = parseSteps(doc);
  expect(steps.map((s) => s.text)).toEqual(['A real step']);
  // And the index the UI ticks must address the real one.
  expect(setStep(doc, 0, true)).toContain('- [x] A real step');
  expect(setStep(doc, 0, true)).toContain('- [ ] Not a real step');
});

test('fences of any length and tildes both close correctly', () => {
  const doc = ['~~~', '- [ ] tilde example', '~~~', '````', '- [ ] four backticks', '```', '- [ ] still inside', '````', '- [ ] real'].join('\n');
  expect(parseSteps(doc).map((s) => s.text)).toEqual(['real']);
});

test('an unclosed fence swallows the rest, rather than guessing', () => {
  const doc = ['- [ ] before', '```', '- [ ] after an unclosed fence'].join('\n');
  expect(parseSteps(doc).map((s) => s.text)).toEqual(['before']);
});

test('ticking a step changes that line and nothing else', () => {
  const next = setStep(PLAN, 0, true);
  expect(next.split('\n')[4]).toBe('- [ ] **Step 1: Write the failing test**'.replace('[ ]', '[x]'));
  // Every other line survives byte-for-byte: the plan is the user's file,
  // not a rendering of our state.
  const before = PLAN.split('\n');
  const after = next.split('\n');
  expect(after.filter((_, i) => i !== 4)).toEqual(before.filter((_, i) => i !== 4));
});

test('unticking works and indentation is preserved', () => {
  const next = setStep(PLAN, 1, false);
  expect(next.split('\n')[5]).toBe('- [ ] Already done');
  const indented = setStep(PLAN, 2, true);
  expect(indented.split('\n')[6]).toBe('  - [x] An indented step still counts');
});

test('setting a step that does not exist is an error, not a silent no-op', () => {
  expect(() => setStep(PLAN, 99, true)).toThrow(RangeError);
  expect(() => setStep(PLAN, -1, true)).toThrow(RangeError);
});

test('the first heading names the plan, otherwise the filename has to', () => {
  expect(planTitle(PLAN)).toBe('Newsletter generator');
  expect(planTitle('no heading here')).toBeNull();
  expect(planTitle('## Deeper heading first')).toBe('Deeper heading first');
});
