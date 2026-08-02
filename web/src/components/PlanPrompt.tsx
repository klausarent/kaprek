// "This sounds like planning. Want to do it with cards instead?"
//
// Appears while you type, not after you send: offering a different way to
// work AFTER the work started is an interruption, not an offer. Saying no is
// remembered for the session, because a suggestion that keeps coming back
// after a no is not a suggestion.
//
// The detection itself lives in the same module the server uses
// (src/plans/intent.mjs) — mirrored here so the offer appears without a
// round trip on every keystroke.
import type { PlanMode } from "../lib/api";

/** Naming the activity is enough on its own. */
const DIRECT_WORDS = [
  "brainstorm",
  "brainstormen",
  "brainstorming",
  "konzept",
  "konzepts",
  "konzeptes",
  "konzipieren",
  "konzipier",
  "planen",
  "planung",
  "planning",
  "entwurf",
  "entwerfen",
];
const DIRECT_PHRASES = ["lets plan", "plan out", "wie sollten wir", "how should we", "wie gehen wir vor"];
const OPENERS = ["lass uns", "lasst uns", "lets", "wir sollten", "we should", "ich will", "ich moechte", "ich brauche", "i want to", "i need to"];
const BUILD_VERBS = ["bauen", "aufbauen", "machen", "entwickeln", "erstellen", "build", "make", "create", "design", "develop"];
const LOOKUP_PHRASES = ["den plan", "der plan", "dem plan", "im plan", "the plan", "plan b"];
const NEGATORS = ["kein", "keine", "keinen", "nicht", "ohne", "no", "not", "dont", "without"];
const NEGATION_WINDOW = 2;
const MIN_WORDS = 3;

function normalize(text: string): string {
  return ` ${text
    .toLowerCase()
    .replace(/[’']/g, "")
    .replace(/ä/g, "ae")
    .replace(/ö/g, "oe")
    .replace(/ü/g, "ue")
    .replace(/ß/g, "ss")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()} `;
}

const hasPhrase = (stream: string, phrase: string) => stream.includes(` ${phrase} `);

function hasUnnegatedPhrase(stream: string, phrase: string): boolean {
  const words = stream.trim().split(" ");
  const parts = phrase.split(" ");
  for (let i = 0; i + parts.length <= words.length; i += 1) {
    if (parts.some((part, offset) => words[i + offset] !== part)) continue;
    if (!words.slice(Math.max(0, i - NEGATION_WINDOW), i).some((word) => NEGATORS.includes(word))) return true;
  }
  return false;
}

/** Whether `text` reads like someone starting to plan. Mirrors src/plans/intent.mjs. */
export function looksLikePlanning(text: unknown): boolean {
  if (typeof text !== "string") return false;
  const stream = normalize(text);
  const wordCount = stream.trim() === "" ? 0 : stream.trim().split(" ").length;
  if (wordCount < MIN_WORDS) return false;

  const hasOpener = OPENERS.some((opener) => hasPhrase(stream, opener));
  if (!hasOpener && LOOKUP_PHRASES.some((phrase) => hasPhrase(stream, phrase))) return false;

  if (DIRECT_WORDS.some((word) => hasUnnegatedPhrase(stream, word))) return true;
  if (DIRECT_PHRASES.some((phrase) => hasUnnegatedPhrase(stream, phrase))) return true;
  return hasOpener && BUILD_VERBS.some((verb) => hasUnnegatedPhrase(stream, verb));
}

export default function PlanPrompt({ onPick, onDismiss }: { onPick: (mode: PlanMode) => void; onDismiss: () => void }) {
  return (
    <div className="plan-prompt" role="dialog" aria-label="Work through this as a quiz?">
      <span className="plan-prompt-text">This sounds like planning. Work through it as a quiz instead of a wall of questions?</span>
      <span className="plan-prompt-actions">
        <button type="button" className="btn btn-small" onClick={() => onPick("brainstorm")}>
          Start the quiz
        </button>
        <button type="button" className="btn btn-small" onClick={() => onPick("plan")}>
          Straight to a plan
        </button>
        <button type="button" className="link-button" onClick={onDismiss}>
          Just chat
        </button>
      </span>
    </div>
  );
}
