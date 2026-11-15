import { describe, it, expect, beforeAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseClaudeFile, projectSlugToPath, markCrashGroups, publicSession, setCacheDir, setStoreRoots, scanAll, STORES, attachLedgerInfo, attachHandoverInfo, filterToLedgerSessions, classify, classifyKimi, classifyCodex, classifyGrok } from './scan.mjs';
import { appendSessionEvent } from '../ledger/sessions.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const fixture = path.join(here, 'fixtures', 'claude', '-C--Users-demo-proj', '11111111-1111-4111-8111-111111111111.jsonl');

beforeAll(() => {
  setCacheDir(fs.mkdtempSync(path.join(os.tmpdir(), 'kaprek-scan-')));
});

describe('resume scanner', () => {
  it('reads first prompt and cwd from a Claude transcript', async () => {
    const meta = await parseClaudeFile(fixture);
    expect(meta.first).toBe('Bitte README kürzen');
    expect(meta.cwd).toBe('C:\\Users\\demo\\proj');
    expect(meta.userMsgs).toBe(1);
  });

  it('turns a project slug back into a path', () => {
    expect(projectSlugToPath('-C--Users-demo-proj')).toMatch(/Users[\\/]demo[\\/]proj$/);
  });

  it('marks sessions that all ended within one crash window', () => {
    const t = (min) => new Date(Date.UTC(2026, 7, 28, 6, min)).toISOString();
    const sessions = [
      { engine: 'claude', id: 'a', lastTs: t(0) },
      { engine: 'claude', id: 'b', lastTs: t(1) },
      { engine: 'codex', id: 'c', lastTs: t(30) },
    ];
    markCrashGroups(sessions, { windowMs: 120_000, minMembers: 2, gapMs: 5 * 60_000 });
    const pub = sessions.map(publicSession);
    expect(pub.filter((s) => s.crash).map((s) => s.id).sort()).toEqual(['a', 'b']);
    expect(pub.find((s) => s.id === 'c').crash).toBe(false);
  });

  it('marks sessions whose file mtime lags well behind their last message and cluster together', () => {
    const t = (min) => new Date(Date.UTC(2026, 7, 28, 6, min)).toISOString();
    const ms = (min) => Date.UTC(2026, 7, 28, 6, min);
    const sessions = [
      // mtime 10 min after lastTs (> gapMs of 5 min) → crash candidate
      { engine: 'claude', id: 'a', lastTs: t(0), mtimeMs: ms(10) },
      // mtime also 10 min after lastTs, and within windowMs of a's mtime → same crash group
      { engine: 'claude', id: 'b', lastTs: t(1), mtimeMs: ms(11) },
      // mtime only 1 min after lastTs (< gapMs) → not a candidate, no crash
      { engine: 'codex', id: 'c', lastTs: t(2), mtimeMs: ms(3) },
    ];
    markCrashGroups(sessions, { windowMs: 120_000, minMembers: 2, gapMs: 5 * 60_000 });
    const pub = sessions.map(publicSession);
    expect(pub.filter((s) => s.crash).map((s) => s.id).sort()).toEqual(['a', 'b']);
    expect(pub.find((s) => s.id === 'c').crash).toBe(false);
  });

  it('publicSession exposes one shape and a stable key', () => {
    const s = publicSession({ engine: 'grok', id: 'x1', cwd: 'C:\\p', title: 'Hallo', lastTs: '2026-08-28T06:00:00.000Z' });
    expect(s).toMatchObject({ key: 'grok:x1', engine: 'grok', id: 'x1', cwd: 'C:\\p', title: 'Hallo', userMsgs: 0, hidden: false, crash: false });
    expect(s.firstTs).toBe(s.lastTs);
  });

  it('setStoreRoots({ home }) points all four store roots at that home', () => {
    const home = path.join('C:', 'fake-home');
    setStoreRoots({ home });
    expect(STORES).toEqual({
      claudeProjects: path.join(home, '.claude', 'projects'),
      kimiHome: path.join(home, '.kimi-code'),
      codexSessions: path.join(home, '.codex', 'sessions'),
      grokSessions: path.join(home, '.grok', 'sessions'),
    });
  });

  it('setStoreRoots({ home, claudeProjects }) lets a named override win over home — the --dir + resumeHome order in startServer()', () => {
    const home = path.join('C:', 'fake-home-2');
    const override = path.join('C:', 'explicit-claude-projects');
    setStoreRoots({ home, claudeProjects: override });
    expect(STORES.claudeProjects).toBe(override);
    expect(STORES.kimiHome).toBe(path.join(home, '.kimi-code'));
  });

  it('setStoreRoots points every engine at an empty home — scanAll finds nothing, fast', async () => {
    setStoreRoots({ home: fs.mkdtempSync(path.join(os.tmpdir(), 'kaprek-empty-home-')) });
    const start = Date.now();
    const { sessions } = await scanAll();
    const elapsed = Date.now() - start;
    expect(sessions).toEqual([]);
    expect(elapsed).toBeLessThan(1000);
  });
});

describe('ledger filtering', () => {
  const FIXTURE_ID = '11111111-1111-4111-8111-111111111111';

  it('attachLedgerInfo attaches open/lastType/endReason only where the ledger has a matching claude entry', () => {
    const ledgerIndex = new Map([
      ['a', { lastType: 'stop', endReason: null }],
      ['b', { lastType: 'end', endReason: 'clear' }],
    ]);
    const sessions = [
      { engine: 'claude', id: 'a' },
      { engine: 'claude', id: 'b' },
      { engine: 'claude', id: 'c' }, // not in the ledger
      { engine: 'codex', id: 'a' }, // same id, different engine — must not match
    ];
    const out = attachLedgerInfo(sessions, ledgerIndex);
    expect(out[0].ledger).toEqual({ open: true, lastType: 'stop', endReason: null });
    expect(out[1].ledger).toEqual({ open: false, lastType: 'end', endReason: 'clear' });
    expect(out[2].ledger).toBeUndefined();
    expect(out[3].ledger).toBeUndefined();
  });

  it('attachLedgerInfo is a no-op (same array reference) without a ledger index', () => {
    const sessions = [{ engine: 'claude', id: 'a' }];
    expect(attachLedgerInfo(sessions, null)).toBe(sessions);
  });

  it('filterToLedgerSessions drops claude sessions absent from the ledger, keeps other engines, and is a no-op when unfiltered or there is no index', () => {
    const sessions = [
      { engine: 'claude', id: 'a', ledger: { open: true, lastType: 'stop', endReason: null } },
      { engine: 'claude', id: 'b', ledger: null },
      { engine: 'kimi', id: 'z', ledger: null },
    ];
    const ledgerIndex = new Map([['a', {}]]);
    expect(filterToLedgerSessions(sessions, ledgerIndex).map((s) => s.id)).toEqual(['a', 'z']);
    expect(filterToLedgerSessions(sessions, ledgerIndex, { unfiltered: true })).toBe(sessions);
    expect(filterToLedgerSessions(sessions, null)).toBe(sessions);
  });

  it('filtering runs before crash-group tagging: a filtered-out sibling cannot make the remaining session look like a crash', () => {
    const t = (min) => new Date(Date.UTC(2026, 7, 28, 6, min)).toISOString();
    const raw = [
      { engine: 'claude', id: 'a', lastTs: t(0) }, // in the ledger
      { engine: 'claude', id: 'b', lastTs: t(1) }, // not in the ledger, would otherwise pair with `a`
    ];
    const ledgerIndex = new Map([['a', { lastType: 'stop', endReason: null }]]);
    const filtered = filterToLedgerSessions(attachLedgerInfo(raw, ledgerIndex), ledgerIndex);
    expect(filtered.map((s) => s.id)).toEqual(['a']);
    markCrashGroups(filtered, { windowMs: 120_000, minMembers: 2, gapMs: 5 * 60_000 });
    expect(filtered[0].crashGroup).toBeUndefined();
  });

  it('scanAll(dataDir) hides a claude session with no ledger entry by default, --unfiltered shows it, and open/ended follow the ledger', async () => {
    setStoreRoots({ claudeProjects: path.join(here, 'fixtures', 'claude') });
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kaprek-scan-ledger-'));

    const filteredOut = await scanAll({ dataDir });
    expect(filteredOut.sessions.find((s) => s.id === FIXTURE_ID)).toBeUndefined();

    const shownUnfiltered = await scanAll({ dataDir, unfiltered: true });
    expect(shownUnfiltered.sessions.find((s) => s.id === FIXTURE_ID)?.ledger).toBeNull();

    // A caller that never passes dataDir at all keeps seeing everything, ledger untouched.
    const noDataDir = await scanAll();
    expect(noDataDir.sessions.find((s) => s.id === FIXTURE_ID)?.ledger).toBeNull();

    appendSessionEvent(dataDir, { type: 'start', sessionId: FIXTURE_ID, ts: '2026-08-28T06:00:00.000Z' });
    const open = await scanAll({ dataDir });
    expect(open.sessions.find((s) => s.id === FIXTURE_ID)?.ledger).toEqual({ open: true, lastType: 'start', endReason: null });

    appendSessionEvent(dataDir, { type: 'end', sessionId: FIXTURE_ID, reason: 'clear', ts: '2026-08-28T06:05:00.000Z' });
    const ended = await scanAll({ dataDir });
    expect(ended.sessions.find((s) => s.id === FIXTURE_ID)?.ledger).toEqual({ open: false, lastType: 'end', endReason: 'clear' });

    fs.rmSync(dataDir, { recursive: true, force: true });
  });
});

describe('account-switch handovers', () => {
  const report = { handoverId: 'h-aaaa0001', recordedAt: '2026-11-15T12:00:00.000Z' };
  const index = { bySession: new Map([['old', report]]), byAttempt: new Map([['h-aaaa0001.bbbb', { handoverId: 'h-aaaa0001', attemptId: 'bbbb', confirmed: false }]]) };
  const s = (id, extra) => ({ engine: 'claude', id, lastTs: '2026-11-15T12:05:00.000Z', first: 'Hallo', ...extra });

  it('marks the session that reported as old and the one started from the handover as new', () => {
    const out = attachHandoverInfo([s('old'), s('fresh', { first: 'Übergabe Shop (h-aaaa0001.bbbb): Lies C:\\d\\h-aaaa0001.bbbb.md und mach dort weiter.' }), s('other')], index);
    expect(out[0].handover).toEqual({ role: 'old', handoverId: 'h-aaaa0001' });
    expect(out[1].handover).toEqual({ role: 'new', handoverId: 'h-aaaa0001', attemptKey: 'h-aaaa0001.bbbb' });
    expect(out[2].handover).toBeUndefined();
    expect(publicSession(out[0]).handover).toEqual({ role: 'old', handoverId: 'h-aaaa0001' });
    expect(publicSession(out[2]).handover).toBeNull();
  });

  it('lets go of an old session somebody kept working in after the report', () => {
    const out = attachHandoverInfo([s('old', { lastTs: '2026-11-15T12:29:00.000Z' }), s('old', { lastTs: '2026-11-15T13:00:00.000Z' })], index);
    expect(out[0].handover?.role).toBe('old');
    expect(out[1].handover).toBeUndefined();
  });

  it('keeps an old session handed over for good once a fresh session was started from its handover', () => {
    const started = { bySession: new Map([['old', { ...report, started: true }]]), byAttempt: new Map() };
    const out = attachHandoverInfo([s('old', { lastTs: '2026-11-16T09:00:00.000Z' })], started);
    expect(out[0].handover).toEqual({ role: 'old', handoverId: 'h-aaaa0001' });
  });

  it('lets an old session go again when its handover was never started and somebody works on in it', () => {
    const refused = { bySession: new Map([['old', { ...report, started: false }]]), byAttempt: new Map() };
    const out = attachHandoverInfo([s('old', { lastTs: '2026-11-15T13:00:00.000Z' })], refused);
    expect(out[0].handover).toBeUndefined();
  });

  it('treats the fresh session of one switch as the old session of the next: its own report comes first', () => {
    const twice = { bySession: new Map([['fresh', { handoverId: 'h-cccc0002', recordedAt: '2026-11-15T12:04:00.000Z' }]]), byAttempt: index.byAttempt };
    const out = attachHandoverInfo([s('fresh', { first: 'Übergabe Shop (h-aaaa0001.bbbb): Lies …' })], twice);
    expect(out[0].handover).toEqual({ role: 'old', handoverId: 'h-cccc0002', attemptKey: 'h-aaaa0001.bbbb' });
  });

  it('ignores a key no start attempt wrote, other engines, and a missing index', () => {
    const sessions = [s('x', { first: 'Übergabe (h-ffff0000.aaaa)' }), { engine: 'codex', id: 'old', lastTs: '2026-11-15T12:05:00.000Z' }];
    const out = attachHandoverInfo(sessions, index);
    expect(out[0].handover).toBeUndefined();
    expect(out[1].handover).toBeUndefined();
    expect(attachHandoverInfo(sessions, null)).toBe(sessions);
  });
});

describe('only sessions a person opened', () => {
  it('parseClaudeFile reads the entrypoint, and classify() marks claude -p (sdk-*) as automated', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kaprek-scan-entry-'));
    const file = path.join(dir, 'x.jsonl');
    const line = (entrypoint) => JSON.stringify({ type: 'user', entrypoint, cwd: 'C:\\p', timestamp: '2026-10-26T08:00:00.000Z', message: { role: 'user', content: 'Mach was' } });
    fs.writeFileSync(file, `${line('sdk-cli')}\n`);
    const headless = await parseClaudeFile(file);
    expect(headless.entrypoint).toBe('sdk-cli');
    expect(classify(headless)).toMatchObject({ kind: 'automated' });
    fs.writeFileSync(file, `${line('cli')}\n`);
    expect(classify(await parseClaudeFile(file))).toEqual({ kind: 'interactive', reason: '' });
    // A -p run later continued in a terminal (`claude -r`) counts as interactive.
    fs.writeFileSync(file, `${line('sdk-cli')}\n${line('cli')}\n`);
    expect(classify(await parseClaudeFile(file)).kind).toBe('interactive');
    // Fail closed: no entrypoint at all is no proof of a terminal.
    expect(classify({ userMsgs: 1, first: 'Hallo', cwd: 'C:\\p' })).toMatchObject({ kind: 'automated', reason: 'ohne entrypoint' });
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('classifyGrok hides session_kind "headless" (grok -p) in any directory, keeps a TUI session', () => {
    expect(classifyGrok({ sessionKind: 'headless', cwd: 'C:\\Users\\k\\Documents\\repo', userMsgs: 3 }).kind).toBe('automated');
    expect(classifyGrok({ sessionKind: '', cwd: 'C:\\Users\\k\\Documents\\repo', userMsgs: 1 }).kind).toBe('interactive');
  });

  it('classifyKimi treats Temp/.kaprek working dirs as headless', () => {
    expect(classifyKimi({ cwd: 'C:\\Users\\k\\AppData\\Local\\Temp\\claude\\x' }).kind).toBe('automated');
    expect(classifyKimi({ cwd: 'C:\\Users\\k\\.kaprek\\council' }).kind).toBe('automated');
    expect(classifyKimi({ cwd: 'C:\\Users\\k\\Documents\\Software\\repo' }).kind).toBe('interactive');
  });

  it('publicSession hides every non-interactive kind, keeps interactive and kind-less sessions visible', () => {
    const base = { engine: 'codex', id: 'x', lastTs: '2026-10-26T08:00:00.000Z' };
    expect(publicSession({ ...base, ...classifyCodex({ source: 'exec', userMsgs: 1 }) }).hidden).toBe(true);
    expect(publicSession({ ...base, kind: 'empty' }).hidden).toBe(true);
    expect(publicSession({ ...base, kind: 'interactive' }).hidden).toBe(false);
    expect(publicSession(base).hidden).toBe(false);
  });

  it('codex counts only the terminal TUI (source "cli"); imports, Desktop, kaprek and exec are hidden', () => {
    expect(classifyCodex({ originator: 'Codex Desktop', source: 'vscode', userMsgs: 1, imported: true })).toMatchObject({ kind: 'automated', reason: 'Import (Codex Desktop)' });
    expect(classifyCodex({ originator: 'Codex Desktop', source: 'vscode', userMsgs: 2 }).kind).toBe('automated');
    expect(classifyCodex({ originator: 'kaprek', source: 'vscode', userMsgs: 1 }).kind).toBe('automated');
    expect(classifyCodex({ originator: 'codex_cli_rs', source: 'cli', userMsgs: 1 }).kind).toBe('interactive');
    expect(classifyCodex({ originator: 'codex_cli_rs', source: 'cli', userMsgs: 1, imported: true }).kind).toBe('automated');
  });
});
