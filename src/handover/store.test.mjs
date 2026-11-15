import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  openSwitch,
  openOrReuseSwitch,
  withStoreLock,
  recordHandover,
  recordStartRequested,
  recordStarted,
  recordConfirmed,
  readHandovers,
  currentSwitch,
  countByStatus,
  acquireStartLock,
  handoverIndex,
  attemptKey,
  ATTEMPT_KEY_RE,
  AUTO_OPEN_WINDOW_MS,
  START_LOCK_STALE_MS,
  START_LOCK_LIVE_STALE_MS,
} from './store.mjs';

const FILE = path.resolve(os.tmpdir(), 'UEBERGABE.md');
const T0 = Date.parse('2026-11-15T12:00:00.000Z');

let dataDir;
beforeEach(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kaprek-handover-'));
});
afterEach(() => {
  fs.rmSync(dataDir, { recursive: true, force: true });
});

function only(dir = dataDir) {
  const sw = currentSwitch(readHandovers(dir));
  return { sw, h: sw.handovers[0] };
}

describe('recording handovers', () => {
  it('opens a switch on the first report and lists the handover as pending', () => {
    const r = recordHandover(dataDir, { sessionId: 's1', cwd: 'C:\\p', file: FILE, section: 'Übergabe', now: T0 });
    expect(r.opened).toBe(true);
    const { sw, h } = only();
    expect(sw.switchId).toBe(r.switchId);
    expect(h).toMatchObject({ handoverId: r.handoverId, sessionId: 's1', file: FILE, section: 'Übergabe', status: 'pending', nothingOpen: false });
  });

  it('lets a session correct its report: same handover, last one wins', () => {
    const first = recordHandover(dataDir, { sessionId: 's1', file: FILE, note: 'alt', now: T0 });
    const second = recordHandover(dataDir, { sessionId: 's1', file: FILE, note: 'neu', now: T0 + 1000 });
    expect(second).toMatchObject({ handoverId: first.handoverId, replaced: true, opened: false });
    const { sw } = only();
    expect(sw.handovers).toHaveLength(1);
    expect(sw.handovers[0].note).toBe('neu');
  });

  it('gives a correction after a start attempt its own handover, leaving the started one alone', () => {
    const sw = openSwitch(dataDir, { now: T0 });
    const first = recordHandover(dataDir, { sessionId: 's1', file: FILE, note: 'alt', switchId: sw.switchId, now: T0 });
    recordStartRequested(dataDir, { switchId: sw.switchId, handoverId: first.handoverId, attemptId: 'aaaa', now: T0 + 1 });
    recordStarted(dataDir, { switchId: sw.switchId, handoverId: first.handoverId, attemptId: 'aaaa', ok: true, method: 'wt-tab', now: T0 + 2 });
    const second = recordHandover(dataDir, { sessionId: 's1', file: FILE, note: 'neu', switchId: sw.switchId, now: T0 + 3 });
    expect(second.handoverId).not.toBe(first.handoverId);
    const state = currentSwitch(readHandovers(dataDir));
    expect(state.handovers.map((h) => [h.note, h.status])).toEqual([['alt', 'spawned'], ['neu', 'pending']]);
  });

  it('corrects a report in place when every start from it was refused — no second handover, no second session', () => {
    const sw = openSwitch(dataDir, { now: T0 });
    const first = recordHandover(dataDir, { sessionId: 's1', file: FILE, note: 'falscher Pfad', switchId: sw.switchId, now: T0 });
    recordStartRequested(dataDir, { switchId: sw.switchId, handoverId: first.handoverId, attemptId: 'aaaa', now: T0 + 1 });
    recordStarted(dataDir, { switchId: sw.switchId, handoverId: first.handoverId, attemptId: 'aaaa', ok: false, error: 'handover file does not exist', now: T0 + 2 });
    const second = recordHandover(dataDir, { sessionId: 's1', file: FILE, note: 'richtig', switchId: sw.switchId, now: T0 + 3 });
    expect(second).toMatchObject({ handoverId: first.handoverId, replaced: true });
    const handovers = currentSwitch(readHandovers(dataDir)).handovers;
    expect(handovers).toHaveLength(1);
    expect(handovers[0]).toMatchObject({ note: 'richtig', status: 'failed' });
    // refused starts do not make the old session "replaced", nor the switch spent
    expect(handoverIndex(dataDir).bySession.get('s1').started).toBe(false);
    expect(recordHandover(dataDir, { sessionId: 's2', file: FILE, now: T0 + 4 }).switchId).toBe(sw.switchId);
    expect(openOrReuseSwitch(dataDir, { now: T0 + 5 })).toMatchObject({ switchId: sw.switchId, reused: true });
  });

  it('records a session with nothing open — listed, never pending', () => {
    recordHandover(dataDir, { sessionId: 's1', nothingOpen: true, note: 'alles committet', now: T0 });
    const { h } = only();
    expect(h).toMatchObject({ status: 'nothing', file: null, note: 'alles committet' });
  });

  it('joins the current switch within the window and opens a new one after it', () => {
    const a = recordHandover(dataDir, { sessionId: 's1', file: FILE, now: T0 });
    const b = recordHandover(dataDir, { sessionId: 's2', file: FILE, now: T0 + AUTO_OPEN_WINDOW_MS - 1 });
    const c = recordHandover(dataDir, { sessionId: 's3', file: FILE, now: T0 + AUTO_OPEN_WINDOW_MS + 1 });
    expect(b.switchId).toBe(a.switchId);
    expect(c.switchId).not.toBe(a.switchId);
    expect(c.opened).toBe(true);
  });

  it('does not join a switch something was already started from: that account change is over', () => {
    const first = recordHandover(dataDir, { sessionId: 's1', file: FILE, now: T0 });
    recordStartRequested(dataDir, { switchId: first.switchId, handoverId: first.handoverId, attemptId: 'aaaa', now: T0 + 1000 });
    const later = recordHandover(dataDir, { sessionId: 's2', file: FILE, now: T0 + 5 * 60 * 60 * 1000 });
    expect(later.switchId).not.toBe(first.switchId);
    expect(later.opened).toBe(true);
    // a straggler that names the switch still gets in
    expect(recordHandover(dataDir, { sessionId: 's3', file: FILE, switchId: first.switchId, now: T0 + 6 * 60 * 60 * 1000 }).switchId).toBe(first.switchId);
  });

  it('writes into the switch it is told to, however old, and refuses one that does not exist', () => {
    const old = openSwitch(dataDir, { now: T0 });
    openSwitch(dataDir, { now: T0 + 1000 });
    const r = recordHandover(dataDir, { sessionId: 's1', file: FILE, switchId: old.switchId, now: T0 + 10 * AUTO_OPEN_WINDOW_MS });
    expect(r.switchId).toBe(old.switchId);
    expect(() => recordHandover(dataDir, { sessionId: 's1', file: FILE, switchId: 'w-nope' })).toThrow(/no such switch/);
  });

  it('refuses a handover without a full absolute file path', () => {
    expect(() => recordHandover(dataDir, { sessionId: 's1' })).toThrow(/needs a file/);
    expect(() => recordHandover(dataDir, { sessionId: 's1', file: 'docs/UEBERGABE.md' })).toThrow(/absolute/);
    if (process.platform === 'win32') expect(() => recordHandover(dataDir, { sessionId: 's1', file: '\\UEBERGABE.md' })).toThrow(/absolute/);
    expect(readHandovers(dataDir).switches).toHaveLength(0);
  });

  it('strips control characters from single-line fields and keeps line breaks in the prompt', () => {
    recordHandover(dataDir, { sessionId: 's1', file: FILE, title: 'a\nb\u0007c', prompt: 'eins\nzwei\u0000', now: T0 });
    const { h } = only();
    expect(h.title).toBe('a b c');
    expect(h.prompt).toBe('eins\nzwei');
  });

  it('skips a torn line instead of losing the log', () => {
    recordHandover(dataDir, { sessionId: 's1', file: FILE, now: T0 });
    fs.appendFileSync(path.join(dataDir, 'handover', 'log.jsonl'), '{"type":"handover.rec', 'utf8');
    expect(currentSwitch(readHandovers(dataDir)).handovers).toHaveLength(1);
  });
});

describe('start attempts', () => {
  function started(steps) {
    const sw = openSwitch(dataDir, { now: T0 });
    const { handoverId } = recordHandover(dataDir, { sessionId: 's1', file: FILE, switchId: sw.switchId, now: T0 });
    steps({ switchId: sw.switchId, handoverId });
    return currentSwitch(readHandovers(dataDir)).handovers[0];
  }

  it('is unknown while an attempt was requested and its outcome never written', () => {
    const h = started((ids) => recordStartRequested(dataDir, { ...ids, attemptId: 'aaaa', now: T0 + 1 }));
    expect(h.status).toBe('unknown');
    expect(h.attempts).toHaveLength(1);
  });

  it('is spawned once a tab opened and running once the new session was seen', () => {
    const spawned = started((ids) => {
      recordStartRequested(dataDir, { ...ids, attemptId: 'aaaa', now: T0 + 1 });
      recordStarted(dataDir, { ...ids, attemptId: 'aaaa', ok: true, method: 'wt-tab', now: T0 + 2 });
    });
    expect(spawned).toMatchObject({ status: 'spawned', startedAt: new Date(T0 + 2).toISOString(), newSessionId: null });
    const sw = currentSwitch(readHandovers(dataDir));
    recordConfirmed(dataDir, { switchId: sw.switchId, handoverId: spawned.handoverId, attemptId: 'aaaa', newSessionId: 'new-1', now: T0 + 3 });
    expect(currentSwitch(readHandovers(dataDir)).handovers[0]).toMatchObject({ status: 'running', newSessionId: 'new-1' });
  });

  it('is failed when no tab could be opened, and spawned again after a later attempt worked', () => {
    const h = started((ids) => {
      recordStartRequested(dataDir, { ...ids, attemptId: 'aaaa', now: T0 + 1 });
      recordStarted(dataDir, { ...ids, attemptId: 'aaaa', ok: false, error: 'claude CLI not found', now: T0 + 2 });
    });
    expect(h).toMatchObject({ status: 'failed', lastError: 'claude CLI not found', startedAt: null });
    const sw = currentSwitch(readHandovers(dataDir));
    recordStartRequested(dataDir, { switchId: sw.switchId, handoverId: h.handoverId, attemptId: 'bbbb', now: T0 + 3 });
    recordStarted(dataDir, { switchId: sw.switchId, handoverId: h.handoverId, attemptId: 'bbbb', ok: true, method: 'wt-tab', now: T0 + 4 });
    expect(currentSwitch(readHandovers(dataDir)).handovers[0]).toMatchObject({ status: 'spawned', lastError: null });
  });

  it('counts every status, including the ones nobody has yet', () => {
    recordHandover(dataDir, { sessionId: 's1', file: FILE, now: T0 });
    recordHandover(dataDir, { sessionId: 's2', nothingOpen: true, now: T0 });
    expect(countByStatus(currentSwitch(readHandovers(dataDir)).handovers)).toEqual({ nothing: 1, pending: 1, failed: 0, unknown: 0, spawned: 0, running: 0 });
  });
});

describe('the switch', () => {
  it('freezes the sessions expected to report and the login it was opened under', () => {
    openSwitch(dataDir, { note: 'Limit', loginOrg: 'org-a', expected: [{ sessionId: 's1', cwd: 'C:\\p', title: 'Shop' }, { cwd: 'ohne id' }], now: T0 });
    const sw = currentSwitch(readHandovers(dataDir));
    expect(sw).toMatchObject({ note: 'Limit', loginOrg: 'org-a', openedAt: new Date(T0).toISOString() });
    expect(sw.expected).toEqual([{ sessionId: 's1', cwd: 'C:\\p', title: 'Shop' }]);
    expect(sw.switchId).toMatch(/^w-20261115-1200-[0-9a-f]{4}$/);
  });
});

describe('acquireStartLock', () => {
  const lockFile = () => path.join(dataDir, 'handover', 'start.lock');

  it('lets one run in and turns the second away until the first is done', () => {
    const first = acquireStartLock(dataDir);
    expect(first).not.toBeNull();
    expect(acquireStartLock(dataDir)).toBeNull();
    first.release();
    const again = acquireStartLock(dataDir);
    expect(again).not.toBeNull();
    again.release();
    expect(fs.existsSync(lockFile())).toBe(false);
  });

  it('takes over at once when the process that held the lock is gone', () => {
    acquireStartLock(dataDir);
    expect(acquireStartLock(dataDir, { isAlive: () => true })).toBeNull();
    const taken = acquireStartLock(dataDir, { isAlive: () => false });
    expect(taken).not.toBeNull();
    taken.release();
  });

  it('leaves a running owner alone for two minutes of silence, and takes over only after a long one', () => {
    const held = acquireStartLock(dataDir);
    const quiet = new Date(Date.now() - START_LOCK_STALE_MS - 5000);
    fs.utimesSync(lockFile(), quiet, quiet);
    expect(acquireStartLock(dataDir, { isAlive: () => true })).toBeNull();
    const hung = new Date(Date.now() - START_LOCK_LIVE_STALE_MS - 5000);
    fs.utimesSync(lockFile(), hung, hung);
    held.refresh(); // it was only slow: the refresh keeps it
    expect(acquireStartLock(dataDir, { isAlive: () => true })).toBeNull();
    fs.utimesSync(lockFile(), hung, hung);
    const taken = acquireStartLock(dataDir, { isAlive: () => true });
    expect(taken).not.toBeNull();
    taken.release();
  });

  it('judges a lock without a readable owner by its age alone', () => {
    fs.mkdirSync(path.dirname(lockFile()), { recursive: true });
    fs.writeFileSync(lockFile(), '{"pid":', 'utf8'); // torn mid-write
    expect(acquireStartLock(dataDir)).toBeNull();
    const old = new Date(Date.now() - START_LOCK_STALE_MS - 5000);
    fs.utimesSync(lockFile(), old, old);
    const taken = acquireStartLock(dataDir);
    expect(taken).not.toBeNull();
    taken.release();
  });

  it('does not release while a takeover is deciding, and leaves no second lock behind', () => {
    const held = acquireStartLock(dataDir);
    held.release();
    expect(fs.existsSync(lockFile())).toBe(false);
    expect(fs.existsSync(`${lockFile()}.reclaim`)).toBe(false);
  });

  it('does not let a run that was taken over delete or refresh its successor\'s lock', () => {
    const first = acquireStartLock(dataDir);
    const second = acquireStartLock(dataDir, { isAlive: () => false });
    const old = new Date(Date.now() - 60_000);
    fs.utimesSync(lockFile(), old, old);
    first.refresh();
    first.release();
    expect(fs.existsSync(lockFile())).toBe(true);
    expect(Date.now() - fs.statSync(lockFile()).mtimeMs).toBeGreaterThan(30_000);
    second.release();
    expect(fs.existsSync(lockFile())).toBe(false);
  });

  it('stands back while somebody else is taking the abandoned lock over', () => {
    acquireStartLock(dataDir);
    fs.writeFileSync(`${lockFile()}.reclaim`, '', 'utf8');
    expect(acquireStartLock(dataDir, { isAlive: () => false })).toBeNull();
  });
});

describe('handoverIndex', () => {
  it('maps old sessions to their report and attempt keys to their handover', () => {
    const sw = openSwitch(dataDir, { now: T0 });
    const { handoverId } = recordHandover(dataDir, { sessionId: 's1', file: FILE, switchId: sw.switchId, now: T0 });
    recordHandover(dataDir, { sessionId: 's2', nothingOpen: true, switchId: sw.switchId, now: T0 });
    recordStartRequested(dataDir, { switchId: sw.switchId, handoverId, attemptId: 'aaaa', now: T0 + 1 });
    const index = handoverIndex(dataDir);
    expect(index.bySession.get('s1')).toMatchObject({ handoverId, recordedAt: new Date(T0).toISOString(), started: true });
    expect(index.bySession.get('s2').started).toBe(false);
    expect(index.bySession.has('s2')).toBe(true); // nothing open is a report too
    const key = attemptKey(handoverId, 'aaaa');
    expect(key).toMatch(ATTEMPT_KEY_RE);
    expect(index.byAttempt.get(key)).toMatchObject({ handoverId, attemptId: 'aaaa', confirmed: false });
  });

  it('answers with empty maps when there is no log', () => {
    const index = handoverIndex(dataDir);
    expect(index.bySession.size).toBe(0);
    expect(index.byAttempt.size).toBe(0);
  });
});

describe('deciding under the lock', () => {
  it('makes a report wait for a start run, and gives up loudly instead of writing past it', () => {
    const run = acquireStartLock(dataDir);
    expect(() => recordHandover(dataDir, { sessionId: 's1', file: FILE, now: T0, lockWaitMs: 0 })).toThrow(/busy/);
    expect(readHandovers(dataDir).switches).toHaveLength(0);
    run.release();
    expect(recordHandover(dataDir, { sessionId: 's1', file: FILE, now: T0, lockWaitMs: 0 }).opened).toBe(true);
  });

  it('marks the error so callers can tell "busy" from "wrong"', () => {
    const run = acquireStartLock(dataDir);
    let code = null;
    try {
      withStoreLock(dataDir, () => {}, { waitMs: 0 });
    } catch (err) {
      code = err.code;
    }
    run.release();
    expect(code).toBe('HANDOVER_BUSY');
  });

  it('releases the lock when the work inside throws', () => {
    expect(() => withStoreLock(dataDir, () => { throw new Error('boom'); })).toThrow('boom');
    expect(fs.existsSync(path.join(dataDir, 'handover', 'start.lock'))).toBe(false);
  });

  it('opens one switch for an account change, however often it is asked', () => {
    const first = openOrReuseSwitch(dataDir, { note: 'Limit', now: T0 });
    const second = openOrReuseSwitch(dataDir, { now: T0 + 59 * 60_000 });
    expect(first.reused).toBe(false);
    expect(second).toMatchObject({ switchId: first.switchId, reused: true });
    expect(openOrReuseSwitch(dataDir, { forceNew: true, now: T0 + 1000 }).switchId).not.toBe(first.switchId);
  });

  it('opens a new switch after the hour, and after anything was started from the current one', () => {
    const first = openOrReuseSwitch(dataDir, { now: T0 });
    expect(openOrReuseSwitch(dataDir, { now: T0 + 61 * 60_000 }).reused).toBe(false);
    const third = openOrReuseSwitch(dataDir, { now: T0 + 62 * 60_000 });
    expect(third.reused).toBe(true);
    const { handoverId } = recordHandover(dataDir, { sessionId: 's1', file: FILE, switchId: third.switchId, now: T0 + 62 * 60_000 });
    recordStartRequested(dataDir, { switchId: third.switchId, handoverId, attemptId: 'aaaa', now: T0 + 63 * 60_000 });
    const fourth = openOrReuseSwitch(dataDir, { now: T0 + 64 * 60_000 });
    expect(fourth.reused).toBe(false);
    expect(fourth.switchId).not.toBe(first.switchId);
  });
});

describe('a log that was torn or tampered with', () => {
  const logFile = () => path.join(dataDir, 'handover', 'log.jsonl');

  it('starts the next event on a line of its own after a torn write', () => {
    const sw = openSwitch(dataDir, { now: T0 });
    const { handoverId } = recordHandover(dataDir, { sessionId: 's1', file: FILE, switchId: sw.switchId, now: T0 });
    fs.appendFileSync(logFile(), '{"type":"handover.rec', 'utf8'); // crash mid-write: no newline
    recordStartRequested(dataDir, { switchId: sw.switchId, handoverId, attemptId: 'aaaa', now: T0 + 1 });
    // The intent survived the fragment before it: the handover is not "pending" any more.
    expect(currentSwitch(readHandovers(dataDir)).handovers[0]).toMatchObject({ status: 'unknown' });
  });

  it('keeps a handover uncertain while one attempt has no outcome, even after a later attempt failed', () => {
    const sw = openSwitch(dataDir, { now: T0 });
    const { handoverId } = recordHandover(dataDir, { sessionId: 's1', file: FILE, switchId: sw.switchId, now: T0 });
    recordStartRequested(dataDir, { switchId: sw.switchId, handoverId, attemptId: 'aaaa', now: T0 + 1 });
    recordStartRequested(dataDir, { switchId: sw.switchId, handoverId, attemptId: 'bbbb', now: T0 + 2 });
    recordStarted(dataDir, { switchId: sw.switchId, handoverId, attemptId: 'bbbb', ok: false, error: 'wt.exe missing', now: T0 + 3 });
    expect(currentSwitch(readHandovers(dataDir)).handovers[0].status).toBe('unknown');
  });

  it('does not let a later record rewrite a handover a start was attempted from', () => {
    const sw = openSwitch(dataDir, { now: T0 });
    const { handoverId } = recordHandover(dataDir, { sessionId: 's1', file: FILE, note: 'alt', switchId: sw.switchId, now: T0 });
    recordStartRequested(dataDir, { switchId: sw.switchId, handoverId, attemptId: 'aaaa', now: T0 + 1 });
    fs.appendFileSync(logFile(), `${JSON.stringify({ type: 'handover.recorded', switchId: sw.switchId, handoverId, ts: new Date(T0 + 2).toISOString(), sessionId: 's1', file: 'C:\\other.md', note: 'neu' })}\n`, 'utf8');
    expect(currentSwitch(readHandovers(dataDir)).handovers[0]).toMatchObject({ file: FILE, note: 'alt' });
  });
});

describe('a takeover file somebody left behind', () => {
  it('does not keep a finished run from giving its lock back', () => {
    const held = acquireStartLock(dataDir);
    const reclaim = path.join(dataDir, 'handover', 'start.lock.reclaim');
    fs.writeFileSync(reclaim, '', 'utf8');
    const old = new Date(Date.now() - 60_000);
    fs.utimesSync(reclaim, old, old);
    held.release();
    expect(fs.existsSync(path.join(dataDir, 'handover', 'start.lock'))).toBe(false);
    expect(fs.existsSync(reclaim)).toBe(false);
  });
});
