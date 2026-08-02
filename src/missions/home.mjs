// kaprek Home — the same machine underneath, with everything named after
// what a person wants instead of after how it works.
//
// Klaus' four examples, unchanged: build a game, plan a city trip, build a
// small tool, make a reel with a teleprompter. The rule that shapes all of
// them is his: at most three questions, then a result you can point at, and
// nothing on screen that only means something to someone who knows what a
// model is.
//
// WHAT THIS IS NOT. Not a second product, not a second data store, not a
// simplified agent. Every mission here becomes an ordinary mission with an
// ordinary preset — the difference is entirely in what gets asked and what
// gets shown. If it needed its own engine it would be a lie: the honest
// version of "for everyone" is the same tool with the jargon taken out.
//
// THE THREE QUESTIONS ARE THE HARD PART. Each one has to be answerable by
// someone who has not thought about the task yet, which rules out "what
// should the architecture be" and rules in "who is it for". They also have
// to be enough: a fourth question is a sign the first three were vague.

/** A word that has no business on this screen, and what to say instead. */
export const JARGON = Object.freeze({
  prompt: 'what you asked for',
  token: 'length',
  model: 'kaprek',
  agent: 'kaprek',
  llm: 'kaprek',
  harness: 'kaprek',
  repository: 'folder',
  repo: 'folder',
  commit: 'save',
  deploy: 'publish',
});

/**
 * The four guided missions.
 *
 * `questions` are asked as quiz cards (the same protocol the guided planning
 * uses), `firstPrompt` is built from the answers, and `done` is what the
 * finished thing should be — written as something a person can check, not as
 * a definition of success.
 */
export const HOME_MISSIONS = Object.freeze([
  {
    id: 'game',
    title: 'Build a small game',
    blurb: 'A game that runs in a browser. Nothing to install, and you can send someone the file.',
    questions: [
      { id: 'about', header: 'The game', question: 'What is the game about?', options: ['Catching things that fall', 'A maze to get through', 'Guessing or quiz questions', 'Jumping across platforms'] },
      { id: 'who', header: 'Who plays', question: 'Who is going to play it?', options: ['A young child', 'A school-age child', 'Me', 'Friends, together'] },
      { id: 'look', header: 'Look', question: 'How should it look?', options: ['Bright and simple shapes', 'Pixel art', 'Hand-drawn', 'Whatever fits best'] },
    ],
    done: 'One file you can double-click, and it plays.',
  },
  {
    id: 'trip',
    title: 'Plan a city trip',
    blurb: 'A day-by-day plan you can actually follow, with the walking times worked out.',
    questions: [
      { id: 'where', header: 'Where', question: 'Which city?', options: [], freeText: true },
      { id: 'days', header: 'How long', question: 'How many days?', options: ['A weekend', 'Three days', 'A week', 'Longer'] },
      { id: 'pace', header: 'Pace', question: 'What kind of trip?', options: ['See a lot', 'Take it slowly', 'Mostly food', 'Good for children'] },
    ],
    done: 'A plan per day, in a file you can print or put on your phone.',
  },
  {
    id: 'tool',
    title: 'Build a small tool',
    blurb: 'Something that does one job on your own machine — renaming files, sorting photos, tidying a list.',
    questions: [
      { id: 'job', header: 'The job', question: 'What should it do, in one sentence?', options: [], freeText: true },
      { id: 'input', header: 'Starting from', question: 'What does it start with?', options: ['Files in a folder', 'A list I paste in', 'A spreadsheet', 'Nothing — it just runs'] },
      { id: 'result', header: 'Result', question: 'What should come out?', options: ['Changed files', 'A new file', 'Something on screen', 'A message somewhere'] },
    ],
    done: 'Something you can run again tomorrow without asking anyone.',
  },
  {
    id: 'reel',
    title: 'Make a reel with a teleprompter',
    blurb: 'A short vertical video: the text to say, in a size you can read while filming.',
    questions: [
      { id: 'topic', header: 'Topic', question: 'What is it about?', options: [], freeText: true },
      { id: 'length', header: 'Length', question: 'How long?', options: ['15 seconds', '30 seconds', 'A minute'] },
      { id: 'tone', header: 'Tone', question: 'How should it sound?', options: ['Straight and factual', 'Warm', 'Funny', 'Urgent'] },
    ],
    done: 'A script you can read off the screen while you film.',
  },
]);

export function homeMission(id) {
  return HOME_MISSIONS.find((mission) => mission.id === id) ?? null;
}

/**
 * Builds the first prompt from what was answered.
 *
 * The answers go in as a plain list rather than as a filled-in template,
 * because a template that has to survive four different missions ends up
 * saying nothing in all four.
 */
export function buildHomePrompt(mission, answers = {}) {
  const given = mission.questions.map((question) => `${question.question} ${answers[question.id] ?? '(not answered)'}`);
  return [
    `Someone asked for this: ${mission.title.toLowerCase()}.`,
    '',
    'What they said:',
    ...given.map((line) => `- ${line}`),
    '',
    `Finish with: ${mission.done}`,
    '',
    'They are not a programmer and have not asked to see how it works. Do not ask more',
    'questions unless you genuinely cannot continue — make a sensible choice and say what',
    'you chose. Work in this mission folder. When you are done, say in one sentence what to',
    'do with the result and where it is.',
  ].join('\n');
}

/**
 * Strips the words that only mean something to someone who already knows how
 * this works.
 *
 * Applied to what is SHOWN, never to what is stored or sent: the transcript
 * stays exactly as it was, and someone who switches to the full view sees
 * the real thing. Rewriting the record to match a simplified view would be
 * the wrong kind of kindness.
 */
export function plainLanguage(text) {
  if (typeof text !== 'string') return text;
  let out = text;
  for (const [term, replacement] of Object.entries(JARGON)) {
    out = out.replace(new RegExp(`\\b${term}(s?)\\b`, 'gi'), (match, plural) => {
      // Keep the plural and the capitalisation the sentence already had.
      // "4000 tokens" turning into "4000 length" reads like a bug, which is
      // the one thing a simplified view must never look like.
      const base = plural ? `${replacement}s` : replacement;
      return match[0] === match[0].toUpperCase() ? base[0].toUpperCase() + base.slice(1) : base;
    });
  }
  return out;
}

/**
 * What to show when a home mission finishes: the result, where it is, and
 * what was remembered.
 *
 * "Remembered" is in here because it is the one piece of machinery worth
 * exposing even at this level — a person who is told "I remembered that you
 * like it in German" understands immediately why the next one goes better.
 */
export function homeSummary({ mission, files = [], remembered = [] }) {
  const lines = [mission.done];
  if (files.length > 0) lines.push(`It is here: ${files.join(', ')}`);
  if (remembered.length > 0) lines.push(`Remembered for next time: ${remembered.join('; ')}`);
  return lines;
}
