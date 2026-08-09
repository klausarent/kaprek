import { test, expect, vi } from 'vitest';
import fs from 'node:fs';
import { availablePeerIds, makeAskPeer } from './ask.mjs';
import { getEngine } from '../harness/registry.mjs';

vi.mock('../harness/registry.mjs', () => ({ getEngine: vi.fn() }));

test('a peer stands in an empty scratch directory, and it is gone afterwards', async () => {
  let seenCwd = null;
  getEngine.mockReturnValue({
    startTurn: async ({ cwd, onEvent }) => {
      seenCwd = cwd;
      // Empty at the moment the peer starts: nothing to read, by construction.
      expect(fs.readdirSync(cwd)).toEqual([]);
      onEvent({ type: 'text', text: '{"verdict":"agree","summary":"ok"}' });
      return { stopReason: 'result' };
    },
  });
  const answer = await makeAskPeer({})('claude-code', 'sound?', {});
  expect(answer).toContain('agree');
  expect(seenCwd).toContain('kaprek-council-');
  expect(fs.existsSync(seenCwd)).toBe(false);
});

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
