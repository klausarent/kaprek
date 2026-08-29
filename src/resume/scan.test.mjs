import { describe, it, expect, beforeAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseClaudeFile, projectSlugToPath, markCrashGroups, publicSession, setCacheDir, setStoreRoots, scanAll, STORES, attachLedgerInfo, filterToLedgerSessions } from './scan.mjs';
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
