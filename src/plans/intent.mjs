// "Is this person about to plan something?" — the trigger for kaprek's
// offer of a guided quiz instead of a wall of questions.
//
// A false positive costs a popup nobody wanted; a false negative costs
// nothing but the old behaviour. So this leans conservative: it fires on
// someone NAMING the activity ("brainstorm", "Konzept", "let's plan") or on
// an intent opener followed by a building verb ("lass uns … bauen"). A bare
// instruction — "build the login form" — is work, not planning, and stays
// out of the way.
//
// Word-level matching throughout, never substring: "Flugzeugplanung" is not
// "Planung", and "Bauplan" is not "Plan". \b would not help here — it is
// ASCII-based and breaks on exactly the umlauts this has to handle.

const MIN_WORDS = 3;

/** Naming the activity is enough on its own. */
const DIRECT_WORDS = [
  'brainstorm',
  'brainstormen',
  'brainstorming',
  'konzept',
  'konzepts',
  'konzeptes',
  'konzipieren',
  'konzipier',
  'planen',
  'planung',
  'spec',
  'entwurf',
  'entwerfen',
];

/** Multi-word signals, matched against the normalized word stream. */
const DIRECT_PHRASES = ['lets plan', 'plan out', 'wie sollten wir', 'how should we', 'wie gehen wir vor', 'was waere der beste weg'];

/** "I intend to…" — worthless alone, decisive in front of a building verb. */
const OPENERS = ['lass uns', 'lasst uns', 'lets', 'wir sollten', 'we should', 'ich will', 'ich moechte', 'ich brauche', 'i want to', 'i need to'];

/** The other half of the pair. */
const BUILD_VERBS = ['bauen', 'aufbauen', 'machen', 'entwickeln', 'erstellen', 'build', 'make', 'create', 'design', 'develop'];

/**
 * Asking ABOUT a plan is not asking FOR one. These only block when no
 * opener is present — "lass uns den Plan für X machen" is still planning,
 * while "zeig mir den Plan" is a lookup.
 */
const LOOKUP_PHRASES = ['den plan', 'der plan', 'dem plan', 'im plan', 'the plan', 'plan b'];

/**
 * Lowercased word stream with umlauts folded and apostrophes closed up, so
 * "let's" is one word and "möchte" matches "moechte".
 */
function normalize(text) {
  return ` ${text
    .toLowerCase()
    .replace(/[’']/g, '')
    .replace(/ä/g, 'ae')
    .replace(/ö/g, 'oe')
    .replace(/ü/g, 'ue')
    .replace(/ß/g, 'ss')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()} `;
}

const hasPhrase = (stream, phrase) => stream.includes(` ${phrase} `);

/**
 * Whether `text` reads like someone starting to plan or brainstorm.
 *
 * @param {unknown} text - a user's prompt; anything non-string is false
 * @returns {boolean}
 */
export function looksLikePlanning(text) {
  if (typeof text !== 'string') return false;
  const stream = normalize(text);
  const wordCount = stream.trim() === '' ? 0 : stream.trim().split(' ').length;
  if (wordCount < MIN_WORDS) return false;

  const hasOpener = OPENERS.some((opener) => hasPhrase(stream, opener));
  if (!hasOpener && LOOKUP_PHRASES.some((phrase) => hasPhrase(stream, phrase))) return false;

  if (DIRECT_WORDS.some((word) => hasPhrase(stream, word))) return true;
  if (DIRECT_PHRASES.some((phrase) => hasPhrase(stream, phrase))) return true;
  return hasOpener && BUILD_VERBS.some((verb) => hasPhrase(stream, verb));
}
