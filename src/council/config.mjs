// The council's saved setup: who holds which role, and how eagerly kaprek
// asks a peer without being asked.
//
// Lives in `<dataDir>/council.json`, written whole (it is one small object,
// not an event log — there is no history worth keeping of "the lead was
// Codex for an hour last Tuesday").
//
// Reading fails towards OFF, never towards asking: a corrupt or half-written
// file must not silently start spending someone's tokens on peers they did
// not configure. A missing file is not an error — it means "not set up yet",
// and the caller offers a suggestion instead.
import fs from 'node:fs';
import path from 'node:path';
import { COUNCIL_LEVELS, COUNCIL_ROLES, validateAssignment } from './roles.mjs';

const FILE_NAME = 'council.json';
export const DEFAULT_LEVEL = 'plans';

export class InvalidCouncilError extends Error {
  constructor(errors) {
    super(`invalid council setup: ${errors.join('; ')}`);
    this.name = 'InvalidCouncilError';
    this.errors = errors;
  }
}

function configPath(dataDir) {
  return path.join(dataDir, FILE_NAME);
}

/**
 * The saved setup, or null when there is none yet.
 *
 * @returns {{level: string, assignment: {lead: string|null, thinker: string|null, worker: string|null, peer: string[]}, configured: boolean}}
 *   `configured` is false for both "no file" and "unreadable file" — the two
 *   are the same answer to the only question a caller has (may I consult a
 *   peer right now?), and the difference is reported through `problem`.
 */
export function readCouncil(dataDir) {
  const empty = { level: 'off', assignment: { lead: null, thinker: null, worker: null, peer: [] }, configured: false, problem: null };

  let raw;
  try {
    raw = fs.readFileSync(configPath(dataDir), 'utf8');
  } catch {
    return empty; // not set up yet — the normal state on a fresh install
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    return { ...empty, problem: `council.json could not be read (${err.message}); no peer will be consulted until it is fixed` };
  }

  const level = COUNCIL_LEVELS.includes(parsed?.level) ? parsed.level : 'off';
  const assignment = {
    lead: typeof parsed?.assignment?.lead === 'string' ? parsed.assignment.lead : null,
    thinker: typeof parsed?.assignment?.thinker === 'string' ? parsed.assignment.thinker : null,
    worker: typeof parsed?.assignment?.worker === 'string' ? parsed.assignment.worker : null,
    peer: Array.isArray(parsed?.assignment?.peer) ? [...new Set(parsed.assignment.peer.filter((id) => typeof id === 'string'))] : [],
  };

  // A file that parsed but names nobody is not a setup.
  const configured = COUNCIL_ROLES.every((role) => (role === 'peer' ? true : assignment[role] !== null));
  return {
    level: configured ? level : 'off',
    assignment,
    configured,
    problem: configured ? null : raw.trim() === '' ? null : 'council.json names no lead, thinker, or worker; no peer will be consulted until it does',
  };
}

/**
 * Saves a setup after checking it against what is installed.
 *
 * @throws {InvalidCouncilError} for a level or an assignment that does not
 *   hold up — a saved setup that cannot run is worse than none, because the
 *   UI would show it as active.
 */
export function writeCouncil(dataDir, { level, assignment }, availableIds = []) {
  if (!COUNCIL_LEVELS.includes(level)) throw new InvalidCouncilError([`level must be one of ${COUNCIL_LEVELS.join(', ')}`]);
  const checked = validateAssignment(assignment, availableIds);
  if (!checked.ok) throw new InvalidCouncilError(checked.errors);

  const content = `${JSON.stringify({ level, assignment: checked.assignment }, null, 2)}\n`;
  fs.mkdirSync(dataDir, { recursive: true });
  const tmp = path.join(dataDir, `.${FILE_NAME}.tmp-${process.pid}`);
  fs.writeFileSync(tmp, content, 'utf8');
  fs.renameSync(tmp, configPath(dataDir));
  return { level, assignment: checked.assignment, configured: true, problem: null };
}
