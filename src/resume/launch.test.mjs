import { describe, it, expect } from 'vitest';
import { buildResumeArgs, buildClaudeCommand, buildCodexCommand, buildGrokCommand, buildKimiCommand } from './launch.mjs';

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
