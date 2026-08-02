import { test, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readCouncil, writeCouncil, InvalidCouncilError, DEFAULT_LEVEL } from './config.mjs';

const tmpDataDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'kaprek-council-'));
const AVAILABLE = ['claude-code', 'codex', 'grok'];
const SETUP = { level: 'plans', assignment: { lead: 'claude-code', thinker: 'codex', worker: 'claude-code', peer: ['codex', 'grok'] } };

test('a fresh install has no setup and consults nobody', () => {
  const council = readCouncil(tmpDataDir());
  expect(council.configured).toBe(false);
  expect(council.level).toBe('off');
  expect(council.problem).toBeNull();
});

test('a saved setup comes back exactly as it went in', () => {
  const dataDir = tmpDataDir();
  writeCouncil(dataDir, SETUP, AVAILABLE);
  const council = readCouncil(dataDir);
  expect(council.configured).toBe(true);
  expect(council.level).toBe('plans');
  expect(council.assignment.peer).toEqual(['codex', 'grok']);
});

test('a corrupt file consults nobody and says why', () => {
  const dataDir = tmpDataDir();
  fs.writeFileSync(path.join(dataDir, 'council.json'), '{ "level": "alwa', 'utf8');
  const council = readCouncil(dataDir);
  expect(council.level).toBe('off');
  expect(council.configured).toBe(false);
  expect(council.problem).toContain('could not be read');
});

test('a file that parses but names nobody is not a setup', () => {
  const dataDir = tmpDataDir();
  fs.writeFileSync(path.join(dataDir, 'council.json'), JSON.stringify({ level: 'always', assignment: { peer: ['codex'] } }), 'utf8');
  const council = readCouncil(dataDir);
  expect(council.level).toBe('off');
  expect(council.configured).toBe(false);
  expect(council.problem).toContain('names no lead');
});

test('an unknown level in a saved file degrades to off, never to always', () => {
  const dataDir = tmpDataDir();
  fs.writeFileSync(path.join(dataDir, 'council.json'), JSON.stringify({ ...SETUP, level: 'constantly' }), 'utf8');
  expect(readCouncil(dataDir).level).toBe('off');
});

test('a setup that cannot run is refused rather than saved', () => {
  const dataDir = tmpDataDir();
  expect(() => writeCouncil(dataDir, { ...SETUP, level: 'sometimes' }, AVAILABLE)).toThrow(InvalidCouncilError);
  expect(() => writeCouncil(dataDir, { level: 'plans', assignment: { ...SETUP.assignment, thinker: 'not-installed' } }, AVAILABLE)).toThrow(InvalidCouncilError);
  // The lead as its own peer is the one rule the whole feature rests on.
  expect(() => writeCouncil(dataDir, { level: 'plans', assignment: { lead: 'codex', thinker: 'codex', worker: 'codex', peer: ['codex'] } }, AVAILABLE)).toThrow(
    InvalidCouncilError,
  );
  expect(fs.existsSync(path.join(dataDir, 'council.json'))).toBe(false);
});

test('the default level asks around plans, not around everything', () => {
  expect(DEFAULT_LEVEL).toBe('plans');
});
