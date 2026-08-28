import { describe, it, expect } from 'vitest';
import { runResumeCommand } from './resume.mjs';

const sessions = [
  { key: 'claude:a', engine: 'claude', id: 'a', cwd: 'C:\\p', title: 'Aufgabe A', lastTs: '2026-08-28T06:30:00.000Z', userMsgs: 2, hidden: false, crash: true },
  { key: 'codex:b', engine: 'codex', id: 'b', cwd: 'C:\\q', title: 'Aufgabe B', lastTs: '2026-08-27T06:30:00.000Z', userMsgs: 1, hidden: false, crash: false },
  { key: 'grok:abc111', engine: 'grok', id: 'abc111', cwd: 'C:\\r', title: 'Aufgabe C', lastTs: '2026-08-28T05:00:00.000Z', userMsgs: 1, hidden: false, crash: false },
  { key: 'grok:abc222', engine: 'grok', id: 'abc222', cwd: 'C:\\r', title: 'Aufgabe D', lastTs: '2026-08-28T04:00:00.000Z', userMsgs: 1, hidden: false, crash: false },
];

const NOW_MS = Date.parse('2026-08-28T07:00:00.000Z');

function deps() {
  const launched = [];
  const lines = [];
  return {
    launched,
    lines,
    deps: {
      scanAll: async () => ({ sessions, scannedAt: 'x' }),
      resumeSession: async (s, opts) => { launched.push([s.key, opts.skip]); return { ok: true, method: 'wt-tab' }; },
      now: () => NOW_MS,
      stdout: (line) => lines.push(line),
      stderr: (line) => lines.push(`ERR ${line}`),
      sleep: async () => {},
    },
  };
}

/** `n` sessions one minute apart, newest first (s0 is `nowMs`, s(n-1) is `n-1` minutes old) — for exercising --limit. */
function depsWithManySessions(n) {
  const many = Array.from({ length: n }, (_, i) => ({
    key: `claude:s${i}`,
    engine: 'claude',
    id: `s${i}`,
    cwd: 'C:\\p',
    title: `Aufgabe ${i}`,
    lastTs: new Date(NOW_MS - i * 60_000).toISOString(),
    userMsgs: 1,
    hidden: false,
    crash: false,
  }));
  const lines = [];
  return {
    lines,
    deps: {
      scanAll: async () => ({ sessions: many, scannedAt: 'x' }),
      resumeSession: async () => ({ ok: true, method: 'wt-tab' }),
      now: () => NOW_MS,
      stdout: (line) => lines.push(line),
      stderr: (line) => lines.push(`ERR ${line}`),
      sleep: async () => {},
    },
  };
}

describe('kaprek resume', () => {
  it('lists sessions newest first with engine:id keys', async () => {
    const d = deps();
    const code = await runResumeCommand([], d.deps);
    expect(code).toBe(0);
    expect(d.lines.join('\n')).toMatch(/claude:a[\s\S]*grok:abc111[\s\S]*grok:abc222/);
    expect(d.lines.join('\n')).toMatch(/Aufgabe A/);
    expect(d.launched).toEqual([]);
  });

  it('resumes one session by exact key', async () => {
    const d = deps();
    expect(await runResumeCommand(['codex:b'], d.deps)).toBe(0);
    expect(d.launched).toEqual([['codex:b', true]]);
  });

  it('resumes one session by a unique prefix of its key', async () => {
    const d = deps();
    expect(await runResumeCommand(['grok:abc1'], d.deps)).toBe(0);
    expect(d.launched).toEqual([['grok:abc111', true]]);
  });

  it('--all resumes only the last 24 hours, newest first, with a pause between calls but not after the last one, --no-skip drops the permission flags', async () => {
    const d = deps();
    const sleeps = [];
    d.deps.sleep = async (ms) => { sleeps.push(ms); };
    const code = await runResumeCommand(['--all', '--no-skip'], d.deps);
    expect(code).toBe(0);
    // codex:b is ~24.5h old at `now` and falls outside the default 24h window.
    expect(d.launched).toEqual([
      ['claude:a', false],
      ['grok:abc111', false],
      ['grok:abc222', false],
    ]);
    // 3 launches, a pause between each pair, none trailing the last one.
    expect(sleeps.length).toBe(2);
  });

  it('--all reports a partial failure as exit 1 and names the failed session', async () => {
    const d = deps();
    d.deps.resumeSession = async (s) => (s.key === 'grok:abc222' ? { ok: false, error: 'boom' } : { ok: true, method: 'wt-tab' });
    const code = await runResumeCommand(['--all'], d.deps);
    expect(code).toBe(1);
    expect(d.lines.join('\n')).toMatch(/ERR .*grok:abc222.*boom/);
  });

  it('--hours abc (non-numeric) falls back to the 24h default instead of throwing or picking 1h', async () => {
    const d = deps();
    const code = await runResumeCommand(['--all', '--hours', 'abc'], d.deps);
    expect(code).toBe(0);
    expect(d.launched.map(([k]) => k)).toEqual(['claude:a', 'grok:abc111', 'grok:abc222']);
  });

  it('--days 0 clamps to a 1-day window instead of falling back to the 7-day default', async () => {
    const d = deps();
    // grok:abc222 is 3h old (inside 1 day), codex:b is ~24.5h old (outside).
    const code = await runResumeCommand(['--days', '0'], d.deps);
    expect(code).toBe(0);
    const text = d.lines.join('\n');
    expect(text).toMatch(/grok:abc222/);
    expect(text).not.toMatch(/codex:b/);
  });

  it('unknown key exits 2 with a message and launches nothing', async () => {
    const d = deps();
    expect(await runResumeCommand(['grok:nope'], d.deps)).toBe(2);
    expect(d.lines.join('\n')).toMatch(/ERR .*grok:nope/);
    expect(d.launched).toEqual([]);
  });

  it('an ambiguous prefix exits 2 and lists the candidates', async () => {
    const d = deps();
    const code = await runResumeCommand(['grok:abc'], d.deps);
    expect(code).toBe(2);
    expect(d.lines.join('\n')).toMatch(/ERR .*ambiguous.*grok:abc/);
    expect(d.lines.join('\n')).toMatch(/grok:abc111/);
    expect(d.lines.join('\n')).toMatch(/grok:abc222/);
    expect(d.launched).toEqual([]);
  });

  it('a second positional key argument is rejected with exit 2, not silently overwritten', async () => {
    const d = deps();
    const code = await runResumeCommand(['claude:a', 'codex:b'], d.deps);
    expect(code).toBe(2);
    expect(d.lines.join('\n')).toMatch(/ERR only one session key is allowed/);
    expect(d.launched).toEqual([]);
  });

  it('a launch failure for a single key exits 1', async () => {
    const d = deps();
    d.deps.resumeSession = async () => ({ ok: false, error: 'no such CLI' });
    const code = await runResumeCommand(['codex:b'], d.deps);
    expect(code).toBe(1);
    expect(d.lines.join('\n')).toMatch(/ERR .*codex:b.*no such CLI/);
  });

  it('an unknown flag is rejected with exit 1 and the usage text', async () => {
    const d = deps();
    const code = await runResumeCommand(['--nope'], d.deps);
    expect(code).toBe(1);
    expect(d.lines.join('\n')).toMatch(/ERR unknown argument: --nope/);
  });

  it('caps the list at 40 by default and hints at --limit 0', async () => {
    const d = depsWithManySessions(60);
    const code = await runResumeCommand([], d.deps);
    expect(code).toBe(0);
    const rows = d.lines.filter((l) => /^claude:s\d+/.test(l));
    expect(rows.length).toBe(40);
    expect(rows[0]).toMatch(/^claude:s0\b/);
    expect(rows[39]).toMatch(/^claude:s39\b/);
    expect(d.lines.join('\n')).toMatch(/and 20 more/);
  });

  it('--limit 0 shows every matching session', async () => {
    const d = depsWithManySessions(60);
    const code = await runResumeCommand(['--limit', '0'], d.deps);
    expect(code).toBe(0);
    const rows = d.lines.filter((l) => /^claude:s\d+/.test(l));
    expect(rows.length).toBe(60);
    expect(d.lines.join('\n')).not.toMatch(/more \(--limit/);
  });

  it('--limit N below the total still names the count left out', async () => {
    const d = depsWithManySessions(10);
    const code = await runResumeCommand(['--limit', '3'], d.deps);
    expect(code).toBe(0);
    const rows = d.lines.filter((l) => /^claude:s\d+/.test(l));
    expect(rows.length).toBe(3);
    expect(d.lines.join('\n')).toMatch(/and 7 more/);
  });
});
