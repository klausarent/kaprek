import { test, expect } from 'vitest';
import { parseQuiz, formatAnswers, QUIZ_FENCE } from './quiz.mjs';

const fence = (json) => `${'```'}${QUIZ_FENCE}\n${json}\n${'```'}`;

const ONE_QUESTION = {
  questions: [
    {
      id: 'scope',
      header: 'Scope',
      question: 'What should the generator produce?',
      options: [
        { label: 'Plain text', description: 'Subject plus body, no HTML' },
        { label: 'Text and layout', description: 'A rendered template' },
      ],
    },
  ],
};

test('a fenced block anywhere in the answer becomes a quiz', () => {
  const quiz = parseQuiz(`Let me get one thing straight first.\n\n${fence(JSON.stringify(ONE_QUESTION))}\n\nPick whichever fits.`);
  expect(quiz).not.toBeNull();
  expect(quiz.done).toBe(false);
  expect(quiz.questions).toHaveLength(1);
  expect(quiz.questions[0].question).toBe('What should the generator produce?');
  expect(quiz.questions[0].options.map((o) => o.label)).toEqual(['Plain text', 'Text and layout']);
  // Free text is offered unless the agent explicitly turns it off: a quiz
  // that can only be answered with the options the agent thought of is a
  // worse conversation than the one it replaced.
  expect(quiz.questions[0].allowOther).toBe(true);
});

test('the last block wins, so an example block above the real one is harmless', () => {
  const example = { questions: [{ question: 'Example question', options: [{ label: 'A' }, { label: 'B' }] }] };
  const quiz = parseQuiz(`Here is the shape:\n${fence(JSON.stringify(example))}\nAnd here is the real one:\n${fence(JSON.stringify(ONE_QUESTION))}`);
  expect(quiz.questions[0].question).toBe('What should the generator produce?');
});

test('no block, broken JSON, or a block with nothing answerable in it yields null', () => {
  expect(parseQuiz('Just prose, no block at all.')).toBeNull();
  expect(parseQuiz(fence('{ "questions": [ '))).toBeNull();
  expect(parseQuiz(fence('{"questions": []}'))).toBeNull();
  // One option and no free text is not a question, it is an announcement.
  expect(parseQuiz(fence(JSON.stringify({ questions: [{ question: 'Sure?', options: [{ label: 'Yes' }], allowOther: false }] })))).toBeNull();
  expect(parseQuiz(null)).toBeNull();
});

test('an unanswerable question is dropped, the rest of the quiz survives', () => {
  const quiz = parseQuiz(
    fence(
      JSON.stringify({
        questions: [
          { question: '', options: [{ label: 'A' }, { label: 'B' }] },
          ONE_QUESTION.questions[0],
        ],
      }),
    ),
  );
  expect(quiz.questions).toHaveLength(1);
  expect(quiz.questions[0].id).toBe('scope');
});

test('a question with no options but free text allowed still counts', () => {
  const quiz = parseQuiz(fence(JSON.stringify({ questions: [{ question: 'What is this for?', allowOther: true }] })));
  expect(quiz.questions).toHaveLength(1);
  expect(quiz.questions[0].options).toEqual([]);
});

test('a broken last block never falls back to an older one', () => {
  // Codex' review: with "the last block wins" implemented as "keep the last
  // one that parsed", an example block followed by a real block that got cut
  // off mid-stream would re-ask the EXAMPLE question. Showing a stale
  // question as if it were live is worse than showing none.
  const example = { questions: [{ question: 'Example question', options: [{ label: 'A' }, { label: 'B' }] }] };
  const cutOff = `${'```'}${QUIZ_FENCE}\n{"questions": [{"question": "The real one"`;
  expect(parseQuiz(`${fence(JSON.stringify(example))}\n${cutOff}`)).toBeNull();
});

test('a quiz nested inside a longer outer fence is an example, not a question', () => {
  const inner = fence(JSON.stringify(ONE_QUESTION));
  expect(parseQuiz(`Here is how it looks:\n\n${'````'}markdown\n${inner}\n${'````'}\n`)).toBeNull();
});

test('duplicate ids are made distinct, so two cards never share one answer', () => {
  const quiz = parseQuiz(
    fence(JSON.stringify({ questions: [{ id: 'same', question: 'First?', allowOther: true }, { id: 'same', question: 'Second?', allowOther: true }] })),
  );
  expect(new Set(quiz.questions.map((q) => q.id)).size).toBe(2);
});

test('done ends the quiz and needs no questions', () => {
  const quiz = parseQuiz(fence('{"done": true}'));
  expect(quiz).not.toBeNull();
  expect(quiz.done).toBe(true);
  expect(quiz.questions).toEqual([]);
});

test('missing ids fall back to the position, so answers can always be addressed', () => {
  const quiz = parseQuiz(fence(JSON.stringify({ questions: [{ question: 'First?', allowOther: true }, { question: 'Second?', allowOther: true }] })));
  expect(quiz.questions.map((q) => q.id)).toEqual(['q1', 'q2']);
});

test('answers become a prompt that quotes the question, not just the choice', () => {
  const quiz = parseQuiz(fence(JSON.stringify(ONE_QUESTION)));
  const prompt = formatAnswers(quiz, { scope: { selected: ['Plain text'] } });
  expect(prompt).toContain('What should the generator produce?');
  expect(prompt).toContain('Plain text');
});

test('free text and multiple selections both survive the round trip', () => {
  const quiz = parseQuiz(
    fence(
      JSON.stringify({
        questions: [
          { id: 'channels', question: 'Which channels?', options: [{ label: 'Email' }, { label: 'Web' }], multiSelect: true },
          { id: 'who', question: 'Who reads it?', allowOther: true },
        ],
      }),
    ),
  );
  const prompt = formatAnswers(quiz, { channels: { selected: ['Email', 'Web'] }, who: { other: 'Existing customers' } });
  expect(prompt).toContain('Email, Web');
  expect(prompt).toContain('Existing customers');
});

test('a question left unanswered says so instead of quietly disappearing', () => {
  const quiz = parseQuiz(fence(JSON.stringify(ONE_QUESTION)));
  const prompt = formatAnswers(quiz, {});
  expect(prompt).toContain('What should the generator produce?');
  expect(prompt.toLowerCase()).toContain('skipped');
});
