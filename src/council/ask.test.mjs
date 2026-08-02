import { test, expect } from 'vitest';
import { availablePeerIds } from './ask.mjs';

test('the engines kaprek knows about are always offerable as peers', () => {
  const ids = availablePeerIds({ engineIds: ['claude-code', 'codex'] });
  expect(ids).toContain('claude-code');
  expect(ids).toContain('codex');
});

test('a peer driver only shows up when it says it is installed', () => {
  // grok resolves a bare command name when nothing is on PATH, which its own
  // available() reports as "probably there"; with a bogus absolute override
  // it must say no.
  const missing = availablePeerIds({ engineIds: [], env: { KAPREK_GROK_PATH: 'C:\\definitely\\not\\here\\grok.exe', PATH: '' } });
  expect(missing).not.toContain('grok');
});

test('nothing is listed twice', () => {
  const ids = availablePeerIds({ engineIds: ['codex', 'codex'] });
  expect(ids.filter((id) => id === 'codex')).toHaveLength(1);
});
