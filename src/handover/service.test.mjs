import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openSwitch, recordHandover, recordStartRequested, recordStarted, readHandovers, currentSwitch, acquireStartLock, ATTEMPT_KEY_RE } from './store.mjs';
import {
  cleanTitle,
  titleOf,
  buildPointer,
  buildStartFile,
  buildStartCommand,
  loginEnv,
  pickForStart,
  startHandovers,
  confirmFromSessions,
  overview,
  expectedSessions,
} from './service.mjs';

const T0 = Date.parse('2026-11-15T12:00:00.000Z');
const CLAUDE = 'C:\\bin\\claude.exe';

let dataDir;
let work;
let file;
beforeEach(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kaprek-handover-'));
  work = fs.mkdtempSync(path.join(os.tmpdir(), 'kaprek-work-'));
  file = path.join(work, 'UEBERGABE.md');
  fs.writeFileSync(file, '# Übergabe\n', 'utf8');
});
afterEach(() => {
  fs.rmSync(dataDir, { recursive: true, force: true });
  fs.rmSync(work, { recursive: true, force: true });
});

function seed(n = 2) {
  const sw = openSwitch(dataDir, { now: T0, loginOrg: 'org-old' });
  const ids = [];
  for (let i = 1; i <= n; i++) ids.push(recordHandover(dataDir, { sessionId: `s${i}`, cwd: work, file, title: `Projekt ${i}`, switchId: sw.switchId, now: T0 }).handoverId);
  return { switchId: sw.switchId, ids };
}

function fakes(overrides = {}) {
  const opened = [];
  const slept = [];
  return {
    opened,
    slept,
    deps: {
      open: async (tab) => { opened.push(tab); return { ok: true, method: 'wt-tab' }; },
      sleep: async (ms) => { slept.push(ms); },
      now: () => T0 + 5000,
      claudePath: CLAUDE,
      autoCli: () => ({ command: CLAUDE, useShell: false }),
      ...overrides,
    },
  };
}

describe('what reaches the command line', () => {
  it('keeps only letters, digits, space and ._- of a title', () => {
    expect(cleanTitle('shop.example "Black Week"; rm -rf\n`x` $y')).toBe('shop.example Black Week rm -rf x y');
    expect(cleanTitle('Übergabe Größe')).toBe('Übergabe Größe');
    expect(cleanTitle('  \'"; ')).toBe('Session');
    expect(cleanTitle('x'.repeat(200))).toHaveLength(60);
  });

  it('names a handover after its title, else the folder of its file, else the working directory', () => {
    expect(titleOf({ title: 'Shop', file: 'C:\\a\\b\\U.md' })).toBe('Shop');
    expect(titleOf({ file: 'C:\\a\\workbench\\U.md' })).toBe('workbench');
    expect(titleOf({ cwd: 'C:\\a\\alarm-tool' })).toBe('alarm-tool');
  });

  it('redacts a secret a session put into its title before it reaches a window title or a command', () => {
    const title = titleOf({ title: 'Deploy sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789 fertig' });
    expect(title).not.toContain('sk-ant-api03');
    expect(title).toContain('Deploy');
  });

  it('builds a pointer out of kaprek words, the cleaned title and a path — and carries the attempt key', () => {
    const pointer = buildPointer({ title: 'Shop', key: 'h-1a2b3c4d.9f8e', startFile: 'C:\\d\\handover\\start\\h-1a2b3c4d.9f8e.md' });
    expect(pointer).toBe('Übergabe Shop (h-1a2b3c4d.9f8e): Lies C:\\d\\handover\\start\\h-1a2b3c4d.9f8e.md und mach dort weiter. Das alte Transkript nicht lesen.');
    expect(pointer).toMatch(ATTEMPT_KEY_RE);
  });

  it('puts what the session wrote into the start file, not into the command', () => {
    const h = { file, section: 'Übergabe 15.11.', cwd: work, sessionId: 's1', recordedAt: '2026-11-15T12:00:00.000Z', prompt: 'Zuerst "K7" einsammeln; dann `F1`.', note: 'Codex läuft noch.', title: 'Shop' };
    const text = buildStartFile(h, { key: 'h-1a2b3c4d.9f8e', switchId: 'w-1' });
    expect(text).toContain(`- Übergabedatei: ${file}`);
    expect(text).toContain('- Abschnitt: Übergabe 15.11.');
    expect(text).toContain('Zuerst "K7" einsammeln; dann `F1`.');
    expect(text).toContain('## Hinweise der alten Session\n\nCodex läuft noch.');
    expect(text).toContain('Das alte Transkript nicht lesen');
    const { args } = buildStartCommand({ pointer: 'P', claudePath: CLAUDE });
    expect(args).toEqual(['--dangerously-skip-permissions', 'P']);
  });

  it('falls back to the standard instruction when the session gave no prompt', () => {
    const text = buildStartFile({ file, section: 'Übergabe', cwd: work }, { key: 'k', switchId: 'w' });
    expect(text).toContain(`Lies ${file}, Abschnitt „Übergabe“, und mach dort weiter.`);
  });

  it('runs claude itself for the login account and `kaprek claude` for auto', () => {
    const login = buildStartCommand({ pointer: 'P', account: 'login', skip: false, claudePath: CLAUDE });
    expect(login.exe).toBe(CLAUDE);
    expect(login.args).toEqual(['P']);
    expect(login.preamble.join('\n')).toContain('Env:CLAUDE_CODE_OAUTH_TOKEN');
    const auto = buildStartCommand({ pointer: 'P', account: 'auto', claudePath: CLAUDE, nodePath: 'node.exe', cliPath: 'C:\\k\\bin\\cli.mjs' });
    expect(auto.exe).toBe('node.exe');
    expect(auto.args).toEqual(['C:\\k\\bin\\cli.mjs', 'claude', '--dangerously-skip-permissions', 'P']);
    expect(auto.preamble).toEqual([]);
  });

  it('strips the old session and the old account from the login environment', () => {
    const env = loginEnv({ PATH: 'x', CLAUDE_CODE_CHILD_SESSION: '1', claude_code_session_id: 'abc', CLAUDE_CODE_OAUTH_TOKEN: 't', ANTHROPIC_API_KEY: 'k', KAPREK_ACCOUNT: 'konto1', ANTHROPIC_BASE_URL: 'http://127.0.0.1:1', ANTHROPIC_CUSTOM_HEADERS: 'x-kaprek-account: konto1' });
    expect(env).toEqual({ PATH: 'x' });
    // without kaprek's account tag, a base URL is the person's own setting
    expect(loginEnv({ ANTHROPIC_BASE_URL: 'https://proxy.example' })).toEqual({ ANTHROPIC_BASE_URL: 'https://proxy.example' });
  });
});

describe('pickForStart', () => {
  const sw = { handovers: [
    { handoverId: 'h-aaaa0001', status: 'pending' }, { handoverId: 'h-aaaa0002', status: 'failed' }, { handoverId: 'h-bbbb0003', status: 'spawned' },
    { handoverId: 'h-cccc0004', status: 'running' }, { handoverId: 'h-dddd0005', status: 'unknown' }, { handoverId: 'h-eeee0006', status: 'nothing' },
  ] };
  const idsOf = (list) => list.map((h) => h.handoverId);

  it('takes what was never started, and with again everything but "nothing open"', () => {
    expect(idsOf(pickForStart(sw).picked)).toEqual(['h-aaaa0001', 'h-aaaa0002']);
    expect(idsOf(pickForStart(sw, { again: true }).picked)).toEqual(['h-aaaa0001', 'h-aaaa0002', 'h-bbbb0003', 'h-cccc0004', 'h-dddd0005']);
  });

  it('resolves ids and unique prefixes, and says why it skips', () => {
    const r = pickForStart(sw, { ids: ['h-aaaa0001', 'h-bbbb', 'h-aaaa', 'h-zzzz', 'h-eeee0006'] });
    expect(idsOf(r.picked)).toEqual(['h-aaaa0001']);
    expect(r.skipped.map((s) => [s.handoverId, s.error])).toEqual([
      ['h-aaaa', 'ambiguous: matches 2 handovers'],
      ['h-zzzz', 'no such handover in this switch'],
      ['h-bbbb0003', 'already spawned (start again explicitly)'],
      ['h-eeee0006', 'nothing to hand over'],
    ]);
  });
});

describe('startHandovers', () => {
  it('opens one tab per handover, writes intent and outcome, and a start file per attempt', async () => {
    const { switchId } = seed(2);
    const { deps, opened, slept } = fakes();
    const r = await startHandovers({ dataDir, switchId }, deps);
    expect(r.ok).toBe(true);
    expect(r.results.map((x) => x.method)).toEqual(['wt-tab', 'wt-tab']);
    expect(opened).toHaveLength(2);
    expect(slept).toEqual([700]); // a breath between tabs, none after the last
    expect(opened[0]).toMatchObject({ cwd: work, exe: CLAUDE, title: 'Übergabe · Projekt 1' });
    const pointer = opened[0].args[opened[0].args.length - 1];
    const key = ATTEMPT_KEY_RE.exec(pointer)[0];
    const startFile = path.join(dataDir, 'handover', 'start', `${key}.md`);
    expect(pointer).toContain(startFile);
    expect(fs.readFileSync(startFile, 'utf8')).toContain(`- Übergabedatei: ${file}`);
    const sw = currentSwitch(readHandovers(dataDir));
    expect(sw.handovers.map((h) => h.status)).toEqual(['spawned', 'spawned']);
    expect(sw.handovers[0].attempts[0]).toMatchObject({ account: 'login', skip: true, startFile });
  });

  it('does not start the same handover twice unless asked to', async () => {
    const { switchId } = seed(1);
    const { deps, opened } = fakes();
    await startHandovers({ dataDir, switchId }, deps);
    const second = await startHandovers({ dataDir, switchId }, deps);
    expect(second.results).toEqual([]);
    expect(opened).toHaveLength(1);
    const third = await startHandovers({ dataDir, switchId, again: true }, deps);
    expect(third.results).toHaveLength(1);
    expect(opened).toHaveLength(2);
    expect(currentSwitch(readHandovers(dataDir)).handovers[0].attempts).toHaveLength(2);
  });

  it('turns a second run away while one holds the lock', async () => {
    const { switchId } = seed(1);
    const other = acquireStartLock(dataDir);
    const { deps, opened } = fakes();
    const r = await startHandovers({ dataDir, switchId }, deps);
    other.release();
    expect(r).toMatchObject({ ok: false, busy: true });
    expect(opened).toHaveLength(0);
  });

  it('reads the protocol only once it holds the lock — what the run before it started is not started again', async () => {
    const { switchId, ids } = seed(2);
    const { deps, opened } = fakes({
      // The run that held the lock while this one waited started the first handover.
      lock: (dir) => {
        recordStartRequested(dir, { switchId, handoverId: ids[0], attemptId: 'aaaa', now: T0 + 1 });
        recordStarted(dir, { switchId, handoverId: ids[0], attemptId: 'aaaa', ok: true, method: 'wt-tab', now: T0 + 2 });
        return acquireStartLock(dir);
      },
    });
    const r = await startHandovers({ dataDir, switchId }, deps);
    expect(r.results.map((x) => x.handoverId)).toEqual([ids[1]]);
    expect(opened).toHaveLength(1);
  });

  it('keeps its lock alive while it works and gives it back when it is done', async () => {
    const { switchId } = seed(2);
    const calls = [];
    const { deps } = fakes({
      lock: (dir) => {
        const real = acquireStartLock(dir);
        return { release: () => { calls.push('release'); real.release(); }, refresh: () => { calls.push('refresh'); real.refresh(); } };
      },
    });
    await startHandovers({ dataDir, switchId }, deps);
    expect(calls).toEqual(['refresh', 'refresh', 'release']);
    expect(fs.existsSync(path.join(dataDir, 'handover', 'start.lock'))).toBe(false);
  });

  it('leaves a handover with an unclear attempt out of the ordinary run, even after a retry failed', async () => {
    const { switchId, ids } = seed(1);
    recordStartRequested(dataDir, { switchId, handoverId: ids[0], attemptId: 'aaaa', now: T0 + 1 }); // crash: no outcome
    const failing = fakes({ open: async () => { throw new Error('wt.exe missing'); } });
    await startHandovers({ dataDir, switchId, ids, again: true }, failing.deps);
    expect(currentSwitch(readHandovers(dataDir)).handovers[0].status).toBe('unknown');
    const { deps, opened } = fakes();
    const r = await startHandovers({ dataDir, switchId }, deps);
    expect(r.results).toEqual([]);
    expect(opened).toHaveLength(0);
  });

  it('with dryRun says what would run and touches nothing', async () => {
    const { switchId } = seed(1);
    const { deps, opened } = fakes();
    const r = await startHandovers({ dataDir, switchId, dryRun: true }, deps);
    expect(r.results[0]).toMatchObject({ ok: true, dryRun: true, cwd: work });
    expect(r.results[0].command).toMatch(/^claude\.exe --dangerously-skip-permissions "Übergabe Projekt 1 \(h-/);
    expect(opened).toHaveLength(0);
    expect(fs.existsSync(path.join(dataDir, 'handover', 'start'))).toBe(false);
    expect(currentSwitch(readHandovers(dataDir)).handovers[0].status).toBe('pending');
  });

  it('refuses a handover whose folder or file is gone, without opening a tab or falling back to the home directory', async () => {
    const sw = openSwitch(dataDir, { now: T0 });
    recordHandover(dataDir, { sessionId: 's1', cwd: path.join(work, 'weg'), file, switchId: sw.switchId, now: T0 });
    recordHandover(dataDir, { sessionId: 's2', cwd: work, file: path.join(work, 'weg.md'), switchId: sw.switchId, now: T0 });
    const { deps, opened } = fakes();
    const r = await startHandovers({ dataDir, switchId: sw.switchId }, deps);
    expect(r.ok).toBe(false);
    expect(r.results.map((x) => x.error)).toEqual([expect.stringMatching(/working directory does not exist/), expect.stringMatching(/handover file does not exist/)]);
    expect(opened).toHaveLength(0);
    // Written down as failed attempts: the protocol says why they were not started.
    const after = currentSwitch(readHandovers(dataDir)).handovers;
    expect(after.map((h) => h.status)).toEqual(['failed', 'failed']);
    expect(after[0].lastError).toMatch(/working directory does not exist/);
    expect(fs.existsSync(path.join(dataDir, 'handover', 'start'))).toBe(false);
  });

  it('with dryRun names the refusal and still writes nothing', async () => {
    const sw = openSwitch(dataDir, { now: T0 });
    recordHandover(dataDir, { sessionId: 's1', cwd: path.join(work, 'weg'), file, switchId: sw.switchId, now: T0 });
    const r = await startHandovers({ dataDir, switchId: sw.switchId, dryRun: true }, fakes().deps);
    expect(r.results[0]).toMatchObject({ ok: false, error: expect.stringMatching(/working directory does not exist/) });
    expect(currentSwitch(readHandovers(dataDir)).handovers[0]).toMatchObject({ status: 'pending', attempts: [] });
  });

  it('records a tab that could not be opened as failed, and picks it up again on the next run', async () => {
    const { switchId } = seed(1);
    const failing = fakes({ open: async () => { throw new Error('wt.exe missing'); } });
    const r = await startHandovers({ dataDir, switchId }, failing.deps);
    expect(r.results[0]).toMatchObject({ ok: false, error: 'wt.exe missing' });
    expect(currentSwitch(readHandovers(dataDir)).handovers[0]).toMatchObject({ status: 'failed', lastError: 'wt.exe missing' });
    const { deps, opened } = fakes();
    await startHandovers({ dataDir, switchId }, deps);
    expect(opened).toHaveLength(1);
  });

  it('refuses auto where `kaprek claude` would start a .cmd shim — asking its lookup, not the launcher\'s', async () => {
    const { switchId } = seed(1);
    const shimFirst = fakes({ autoCli: () => ({ command: 'C:\\npm\\claude.cmd', useShell: true }) });
    const auto = await startHandovers({ dataDir, switchId, account: 'auto', dryRun: true }, shimFirst.deps);
    expect(auto.results[0].error).toMatch(/native claude\.exe/);
    // the login start runs claude.exe itself and does not care what PATH lists first
    const login = await startHandovers({ dataDir, switchId, account: 'login', dryRun: true }, shimFirst.deps);
    expect(login.results[0]).toMatchObject({ ok: true, dryRun: true });
  });

  it('refuses a login start without claude.exe', async () => {
    const { switchId } = seed(1);
    const none = await startHandovers({ dataDir, switchId, dryRun: true }, fakes({ claudePath: '' }).deps);
    expect(none.results[0].error).toMatch(/claude CLI not found/);
  });

  it('warns when the login is still the account the switch was opened under', async () => {
    const { switchId } = seed(1);
    const same = await startHandovers({ dataDir, switchId, dryRun: true, loginOrg: 'org-old' }, fakes().deps);
    expect(same.warning).toMatch(/still the one this switch was opened under/);
    const changed = await startHandovers({ dataDir, switchId, dryRun: true, loginOrg: 'org-new' }, fakes().deps);
    expect(changed.warning).toBeUndefined();
  });

  it('answers not-found for an unknown switch and rejects an unknown account mode', async () => {
    expect(await startHandovers({ dataDir, switchId: 'w-nope' }, fakes().deps)).toMatchObject({ ok: false, notFound: true });
    expect(await startHandovers({ dataDir, account: 'root' }, fakes().deps)).toMatchObject({ ok: false, error: expect.stringMatching(/account must be/) });
  });
});

describe('confirmFromSessions', () => {
  it('marks the handover running once, when a session carries its attempt key', async () => {
    const { switchId } = seed(1);
    const { deps, opened } = fakes();
    await startHandovers({ dataDir, switchId }, deps);
    const key = ATTEMPT_KEY_RE.exec(opened[0].args.at(-1))[0];
    const sessions = [
      { engine: 'claude', id: 'new-1', handover: { role: 'new', handoverId: key.split('.')[0], attemptKey: key } },
      { engine: 'claude', id: 'old-1', handover: { role: 'old', handoverId: key.split('.')[0] } },
      { engine: 'codex', id: 'c1', handover: null },
    ];
    expect(confirmFromSessions(dataDir, sessions)).toBe(1);
    expect(confirmFromSessions(dataDir, sessions)).toBe(0);
    expect(currentSwitch(readHandovers(dataDir)).handovers[0]).toMatchObject({ status: 'running', newSessionId: 'new-1' });
  });

  it('still recognises a fresh session that has handed over itself in the meantime', async () => {
    const { switchId } = seed(1);
    const { deps, opened } = fakes();
    await startHandovers({ dataDir, switchId }, deps);
    const key = ATTEMPT_KEY_RE.exec(opened[0].args.at(-1))[0];
    const sessions = [{ engine: 'claude', id: 'new-1', handover: { role: 'old', handoverId: 'h-ffff0000', attemptKey: key } }];
    expect(confirmFromSessions(dataDir, sessions)).toBe(1);
  });
});

describe('overview', () => {
  it('shows the current switch with who has not reported, and older switches newest first', () => {
    openSwitch(dataDir, { now: T0 - 2000, note: 'erster' });
    openSwitch(dataDir, { now: T0 - 1000, note: 'zweiter' });
    const sw = openSwitch(dataDir, { now: T0, loginOrg: 'org-old', expected: [{ sessionId: 's1', cwd: work, title: 'A' }, { sessionId: 's9', cwd: work, title: 'B' }] });
    recordHandover(dataDir, { sessionId: 's1', cwd: work, file, switchId: sw.switchId, now: T0 });
    const view = overview(dataDir, { loginOrg: 'org-old' });
    expect(view.current).toMatchObject({ switchId: sw.switchId, loginUnchanged: true });
    expect(view.current.missing).toEqual([{ sessionId: 's9', cwd: work, title: 'B' }]);
    expect(view.current.handovers[0]).toMatchObject({ title: path.basename(work), status: 'pending', attempts: 0 });
    expect(view.current.counts.pending).toBe(1);
    expect(view.history.map((s) => s.note)).toEqual(['zweiter', 'erster']);
    expect(overview(dataDir, { loginOrg: 'org-new' }).current.loginUnchanged).toBe(false);
  });

  it('is empty before the first switch', () => {
    expect(overview(dataDir)).toEqual({ current: null, history: [] });
  });
});

describe('expectedSessions', () => {
  it('takes the claude sessions a person has open and used lately', () => {
    const iso = (h) => new Date(T0 - h * 3600_000).toISOString();
    const s = (id, extra) => ({ engine: 'claude', id, cwd: 'C:\\p', title: id, hidden: false, lastTs: iso(1), ledger: { open: true }, ...extra });
    const sessions = [s('open'), s('ended', { ledger: { open: false } }), s('headless', { hidden: true }), s('old', { lastTs: iso(72) }), s('noledger', { ledger: null }), s('codex', { engine: 'codex' }), s('handed-over', { handover: { role: 'old', handoverId: 'h-aaaa0001' } })];
    expect(expectedSessions(sessions, { hours: 48, now: () => T0 }).map((x) => x.sessionId)).toEqual(['open']);
  });
});
