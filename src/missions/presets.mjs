// Mission presets — a preset is data, not code: a template that pre-fills a
// new mission's goal and first prompt so a recurring kind of work starts
// guided instead of from a blank prompt. Two generic built-ins ship with
// kaprek; anything personal or project-specific belongs in
// <dataDir>/presets/*.json on the user's machine, never in this repo.
import fs from 'node:fs';
import path from 'node:path';

export const BUILTIN_PRESETS = [
  {
    id: 'blank',
    title: 'Blank mission',
    description: 'Start from scratch: name the goal, pick a directory, go.',
    goalTemplate: '',
    firstPrompt: '',
    builtin: true,
  },
  {
    id: 'guided-feature',
    title: 'Build a feature',
    description: 'A guided software change: plan first, ask before anything destructive, verify before done.',
    goalTemplate: 'Build and verify: <what you want built>',
    firstPrompt: [
      'You are working inside this mission\'s project directory.',
      'First, read enough of the codebase to propose a short plan (files to touch, tests to add).',
      'Then implement step by step, running the project\'s tests as you go.',
      'Ask before anything destructive or irreversible, and before any action that leaves this machine.',
      'Finish by stating what you built, how you verified it, and what remains open.',
    ].join(' '),
    builtin: true,
  },
];

const REQUIRED_FIELDS = ['id', 'title', 'firstPrompt'];
const OPTIONAL_STRING_FIELDS = ['description', 'goalTemplate'];

/**
 * Validates one parsed user-preset object. Returns a normalized preset or
 * null when a required field is missing or mistyped — the caller counts and
 * reports skips, this function never throws.
 */
function normalizeUserPreset(parsed) {
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
  for (const field of REQUIRED_FIELDS) {
    if (typeof parsed[field] !== 'string' || parsed[field].trim().length === 0) {
      // firstPrompt may legitimately be empty only for the builtin blank
      // preset; a user file that omits its prompt has nothing to guide with.
      if (field === 'firstPrompt' && typeof parsed[field] === 'string') continue;
      return null;
    }
  }
  const preset = {
    id: parsed.id,
    title: parsed.title,
    firstPrompt: parsed.firstPrompt,
    description: '',
    goalTemplate: '',
    builtin: false,
  };
  for (const field of OPTIONAL_STRING_FIELDS) {
    if (typeof parsed[field] === 'string') preset[field] = parsed[field];
  }
  return preset;
}

/**
 * Loads the preset catalog for `dataDir`: the built-ins plus every valid
 * `<dataDir>/presets/*.json`. A user preset with a builtin's id replaces
 * that builtin. Invalid or unparseable files are skipped and summarized in
 * a single console.warn call — bad user input must never take the catalog
 * down.
 */
export function loadPresets(dataDir) {
  const byId = new Map(BUILTIN_PRESETS.map((p) => [p.id, p]));

  const presetsDir = path.join(dataDir, 'presets');
  let fileNames = [];
  try {
    fileNames = fs.readdirSync(presetsDir).filter((name) => name.endsWith('.json'));
  } catch {
    fileNames = [];
  }

  let skipped = 0;
  for (const name of fileNames.sort()) {
    try {
      const parsed = JSON.parse(fs.readFileSync(path.join(presetsDir, name), 'utf8'));
      const preset = normalizeUserPreset(parsed);
      if (preset === null) {
        skipped += 1;
        continue;
      }
      byId.set(preset.id, preset);
    } catch {
      skipped += 1;
    }
  }
  if (skipped > 0) {
    console.warn(`presets: skipped ${skipped} invalid preset file(s) in ${presetsDir}`);
  }
  return [...byId.values()];
}
