import { test, expect } from 'vitest';
import { looksLikePlanning } from './intent.mjs';

test('naming the activity is enough, in either language', () => {
  expect(looksLikePlanning('Lass uns das mal brainstormen')).toBe(true);
  expect(looksLikePlanning('I want to brainstorm the onboarding flow')).toBe(true);
  expect(looksLikePlanning('Kannst du ein Konzept für den Newsletter machen?')).toBe(true);
  expect(looksLikePlanning("Let's plan the migration")).toBe(true);
});

test('an opener plus a building verb counts, the verb alone does not', () => {
  expect(looksLikePlanning('Lass uns einen Newsletter-Generator bauen')).toBe(true);
  expect(looksLikePlanning('Ich möchte eine Auswertung für die Kurse entwickeln')).toBe(true);
  expect(looksLikePlanning("Let's build a small dashboard for the numbers")).toBe(true);
  // Plain instructions are work, not planning — the popup must stay away.
  expect(looksLikePlanning('Bau das Login-Formular nach dem Muster von oben')).toBe(false);
  expect(looksLikePlanning('Build the login form like the one above')).toBe(false);
});

test('asking about an existing plan is not asking for a new one', () => {
  expect(looksLikePlanning('Zeig mir den Plan von gestern')).toBe(false);
  expect(looksLikePlanning('Was steht im Plan?')).toBe(false);
  expect(looksLikePlanning('Show me the plan')).toBe(false);
  expect(looksLikePlanning('Dann eben Plan B')).toBe(false);
});

test('a word that merely contains a signal never triggers it', () => {
  expect(looksLikePlanning('Die Flugzeugplanung interessiert mich nicht, fix den Test')).toBe(false);
  expect(looksLikePlanning('Der Bauplan liegt im Ordner, lies ihn')).toBe(false);
});

test('steering turns and junk are never planning', () => {
  for (const text of ['ja', 'weiter', 'ok mach', '', null, undefined, 42]) {
    expect(looksLikePlanning(text)).toBe(false);
  }
});

test('a follow-up inside an ongoing build is still planning when it asks for a design', () => {
  expect(looksLikePlanning('Wie sollten wir die Speicherung angehen?')).toBe(true);
  expect(looksLikePlanning('How should we structure the store?')).toBe(true);
});
