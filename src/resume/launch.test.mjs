import { describe, it, expect, vi } from 'vitest';
import { spawn } from 'node:child_process';
import { buildResumeArgs, buildClaudeCommand, buildCodexCommand, buildGrokCommand, buildKimiCommand, resumeSession, PATHS } from './launch.mjs';

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, spawn: vi.fn() };
});

describe('buildResumeArgs', () => {
  it('matches the launcher command strings for every engine', () => {
    const id = 'abc-123';
    const join = (r) => r.args.join(' ');
    expect(join(buildResumeArgs({ engine: 'claude', id }))).toBe(buildClaudeCommand(id).replace(/^claude /, ''));
    expect(join(buildResumeArgs({ engine: 'codex', id }))).toBe(buildCodexCommand(id).replace(/^codex /, ''));
    expect(join(buildResumeArgs({ engine: 'grok', id }))).toBe(buildGrokCommand(id).replace(/^grok /, ''));
    expect(join(buildResumeArgs({ engine: 'kimi', id }))).toBe(buildKimiCommand(id).replace(/^kimi /, ''));
  });

  it('drops the skip flags when asked', () => {
    expect(buildResumeArgs({ engine: 'claude', id: 'x' }, { skip: false }).args).toEqual(['--resume', 'x']);
    expect(buildResumeArgs({ engine: 'codex', id: 'x' }, { skip: false }).args).toEqual(['resume', 'x']);
  });

  it('rejects unknown engines', () => {
    expect(() => buildResumeArgs({ engine: 'nope', id: 'x' })).toThrow(/unknown engine/);
  });
});

describe('resumeSession', () => {
  it('reports a missing CLI instead of opening an empty tab', async () => {
    const original = PATHS.claude;
    PATHS.claude = '';
    try {
      const r = await resumeSession({ engine: 'claude', id: 'x', cwd: 'C:\\p', title: 't' });
      expect(r).toEqual({ ok: false, error: expect.stringMatching(/claude CLI not found/) });
      expect(spawn).not.toHaveBeenCalled();
    } finally {
      PATHS.claude = original;
    }
  });

  it('rejects unknown engines without opening a tab', async () => {
    const r = await resumeSession({ engine: 'nope', id: 'x' });
    expect(r).toEqual({ ok: false, error: expect.stringMatching(/unknown engine/) });
    expect(spawn).not.toHaveBeenCalled();
  });
});
