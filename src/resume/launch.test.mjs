import { describe, it, expect, vi } from 'vitest';
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildResumeArgs, buildClaudeCommand, buildCodexCommand, buildGrokCommand, buildKimiCommand, resumeSession, PATHS, psQuote, buildScript, tabEnv, openTab, SESSION_ENV_MARKERS } from './launch.mjs';

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

describe('the start script', () => {
  it('quotes typographic single quotes too — PowerShell ends a literal at any of them', () => {
    expect(psQuote("C:\\Users\\O'Brien")).toBe("'C:\\Users\\O''Brien'");
    expect(psQuote('Kunde ’X‘ ‚a‛')).toBe("'Kunde ’’X‘‘ ‚‚a‛‛'");
  });

  it('drops the session markers before anything runs, then the preamble, then the command', () => {
    const script = buildScript({ cwd: 'C:\\Büro', header: 'Übergabe · Shop', exe: 'C:\\bin\\claude.exe', args: ['--flag', "it's"], preamble: ["Remove-Item -LiteralPath 'Env:X' -ErrorAction SilentlyContinue"] });
    const lines = script.split('\r\n');
    for (const name of SESSION_ENV_MARKERS) expect(script).toContain(`Remove-Item -LiteralPath 'Env:${name}' -ErrorAction SilentlyContinue`);
    const at = (needle) => lines.findIndex((l) => l.includes(needle));
    expect(at('Env:CLAUDE_CODE_CHILD_SESSION')).toBeLessThan(at("'Env:X'"));
    expect(at("'Env:X'")).toBeLessThan(at('Set-Location'));
    expect(lines).toContain("Set-Location -LiteralPath 'C:\\Büro'");
    expect(lines).toContain("& 'C:\\bin\\claude.exe' '--flag' 'it''s'");
  });

  it('takes the markers out of the environment a tab is spawned with, whatever their case', () => {
    expect(tabEnv({ PATH: 'x', CLAUDECODE: '1', Claude_Code_Child_Session: '1', CLAUDE_CODE_SESSION_ID: 'abc', CLAUDE_CODE_OAUTH_TOKEN: 'keep' })).toEqual({ PATH: 'x', CLAUDE_CODE_OAUTH_TOKEN: 'keep' });
  });
});

describe('openTab', () => {
  const fakeChild = () => {
    const child = new EventEmitter();
    child.unrefs = 0;
    child.unref = () => { child.unrefs += 1; };
    return child;
  };
  const tab = () => ({ cwd: os.tmpdir(), title: 'probe', exe: 'x.exe', args: [], launchDir: fs.mkdtempSync(path.join(os.tmpdir(), 'kaprek-launch-')) });

  it('answers once the terminal process exists, and survives a late error of it', async () => {
    const child = fakeChild();
    spawn.mockImplementationOnce(() => { queueMicrotask(() => child.emit('spawn')); return child; });
    const r = await openTab(tab());
    expect(r.ok).toBe(true);
    expect(child.unrefs).toBe(1);
    expect(fs.readFileSync(r.script, 'utf8').charCodeAt(0)).toBe(0xfeff); // BOM: PowerShell 5.1 reads the script as UTF-8
    expect(() => child.emit('error', new Error('late'))).not.toThrow();
  });

  it('rejects when the terminal could not be started, instead of claiming a tab or crashing on an unhandled error event', async () => {
    const child = fakeChild();
    spawn.mockImplementationOnce(() => { queueMicrotask(() => child.emit('error', new Error('spawn wt.exe ENOENT'))); return child; });
    await expect(openTab(tab())).rejects.toThrow(/ENOENT/);
    expect(child.unrefs).toBe(0);
  });
});
