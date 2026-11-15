import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runHandoverCommand, firstStartCwd } from './handover.mjs';
import { readHandovers, currentSwitch, acquireStartLock, openSwitch, recordHandover } from '../handover/store.mjs';

const T0 = Date.parse('2026-11-15T12:00:00.000Z');

let dataDir;
let work;
let file;
beforeEach(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kaprek-handover-cli-'));
  work = fs.mkdtempSync(path.join(os.tmpdir(), 'kaprek-work-'));
  file = path.join(work, 'UEBERGABE.md');
  fs.writeFileSync(file, '# Übergabe\n', 'utf8');
});
afterEach(() => {
  fs.rmSync(dataDir, { recursive: true, force: true });
  fs.rmSync(work, { recursive: true, force: true });
});

async function run(argv, overrides = {}) {
  const out = [];
  const err = [];
  const code = await runHandoverCommand(argv, {
    dataDir,
    env: { CLAUDE_CODE_SESSION_ID: 's1' },
    cwd: work,
    scanAll: async () => ({ sessions: [] }),
    now: () => T0,
    stdout: (l) => out.push(l),
    stderr: (l) => err.push(l),
    ...overrides,
  });
  return { code, out: out.join('\n'), err: err.join('\n') };
}

const current = () => currentSwitch(readHandovers(dataDir));
const run2 = (argv) => run(argv, { lockWaitMs: 0 });

describe('kaprek handover add', () => {
  it('records the calling session, in the folder it was started in', async () => {
    const ledgerEvents = () => [
      { type: 'start', sessionId: 'other', cwd: 'C:\\x' },
      { type: 'stop', sessionId: 's1', cwd: 'C:\\wandered' },
      { type: 'start', sessionId: 's1', cwd: work },
      { type: 'start', sessionId: 's1', cwd: 'C:\\later' },
    ];
    const r = await run(['add', '--file', file, '--section', 'Übergabe 15.11.'], { ledgerEvents, cwd: 'C:\\wandered' });
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/^recorded h-[0-9a-f]{8} in switch w-.* \(opened now\)/);
    expect(current().handovers[0]).toMatchObject({ sessionId: 's1', cwd: work, file, section: 'Übergabe 15.11.', status: 'pending' });
  });

  it('prefers --cwd, --session and --switch when given', async () => {
    const opened = await run(['open']);
    const switchId = opened.out.trim();
    const r = await run(['add', '--file', file, '--cwd', work, '--session', 's7', '--switch', switchId, '--title', 'Shop'], { env: {} });
    expect(r.code).toBe(0);
    expect(current().handovers[0]).toMatchObject({ sessionId: 's7', cwd: work, title: 'Shop' });
    expect(current().switchId).toBe(switchId);
  });

  it('reads long text from files instead of arguments', async () => {
    const promptFile = path.join(work, 'prompt.txt');
    fs.writeFileSync(promptFile, '\ufeffZuerst "K7" einsammeln.\nDann /codex:result.', 'utf8');
    const r = await run(['add', '--file', file, '--prompt-file', promptFile]);
    expect(r.code).toBe(0);
    expect(current().handovers[0].prompt).toBe('Zuerst "K7" einsammeln.\nDann /codex:result.');
  });

  it('exits 3 instead of writing past a start run that holds the protocol', async () => {
    const run = acquireStartLock(dataDir);
    const add = await run2(['add', '--file', file]);
    const open = await run2(['open']);
    run.release();
    expect(add.code).toBe(3);
    expect(add.err).toMatch(/busy/);
    expect(open.code).toBe(3);
    expect(readHandovers(dataDir).switches).toHaveLength(0);
  });

  it('reports "nothing open"', async () => {
    const r = await run(['add', '--nothing', '--note', 'alles committet']);
    expect(r.code).toBe(0);
    expect(current().handovers[0]).toMatchObject({ status: 'nothing', note: 'alles committet' });
  });

  it('refuses without a session, without a real absolute file, or with mixed flags — and records nothing', async () => {
    expect((await run(['add', '--file', file], { env: {} })).code).toBe(2);
    expect((await run(['add'])).code).toBe(2);
    expect((await run(['add', '--file', 'UEBERGABE.md'])).code).toBe(2);
    expect((await run(['add', '--file', path.join(work, 'weg.md')])).err).toMatch(/does not exist/);
    expect((await run(['add', '--nothing', '--file', file])).code).toBe(2);
    expect((await run(['add', '--file', file, '--cwd', path.join(work, 'weg')])).err).toMatch(/working directory does not exist/);
    expect((await run(['add', '--file', file, '--bogus'])).code).toBe(2);
    expect(readHandovers(dataDir).switches).toHaveLength(0);
  });
});

describe('kaprek handover open', () => {
  it('opens a switch with the sessions that are open right now, and prints only its id on stdout', async () => {
    const iso = new Date(T0 - 3600_000).toISOString();
    const scanAll = async () => ({ sessions: [
      { engine: 'claude', id: 'a', cwd: work, title: 'A', hidden: false, lastTs: iso, ledger: { open: true } },
      { engine: 'claude', id: 'b', cwd: work, title: 'B', hidden: false, lastTs: iso, ledger: { open: false } },
    ] });
    const r = await run(['open', '--note', 'Limit 97 %'], { scanAll, loginOrg: () => 'org-old' });
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/^w-\d{8}-\d{4}-[0-9a-f]{4}$/);
    expect(current()).toMatchObject({ note: 'Limit 97 %', loginOrg: 'org-old', by: 's1' });
    expect(current().expected.map((x) => x.sessionId)).toEqual(['a']);
  });

  it('returns the same switch when run again within the hour, a new one with --new or after a start', async () => {
    const first = (await run(['open'])).out.trim();
    expect((await run(['open'], { now: () => T0 + 59 * 60_000 })).out.trim()).toBe(first);
    expect((await run(['open', '--new'])).out.trim()).not.toBe(first);
    expect(readHandovers(dataDir).switches).toHaveLength(2);
  });

  it('does not remember the login with --after-login', async () => {
    await run(['open', '--after-login'], { loginOrg: () => 'org-new' });
    expect(current().loginOrg).toBeNull();
  });
});

describe('kaprek handover start', () => {
  const startOk = (calls) => async (opts) => {
    calls.push(opts);
    return { ok: true, switchId: 'w-1', results: [{ handoverId: 'h-aaaa0001', title: 'Shop', ok: true, method: 'wt-tab' }] };
  };

  it('refuses inside a Claude Code session unless it is a dry run or --from-agent', async () => {
    const calls = [];
    const refused = await run(['start', '--all'], { start: startOk(calls) });
    expect(refused.code).toBe(2);
    expect(refused.err).toMatch(/person's step/);
    expect(calls).toHaveLength(0);
    expect((await run(['start', '--all', '--dry-run'], { start: startOk(calls) })).code).toBe(0);
    expect((await run(['start', '--all', '--from-agent'], { start: startOk(calls) })).code).toBe(0);
    expect(calls.map((c) => c.dryRun)).toEqual([true, false]);
  });

  it('starts everything pending from a plain terminal and passes the options on', async () => {
    const calls = [];
    const r = await run(['start', '--all', '--account', 'auto', '--no-skip', '--again'], { env: {}, start: startOk(calls), loginOrg: () => 'org-new' });
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/started h-aaaa0001 Shop \(wt-tab\)/);
    expect(r.out).toMatch(/1\/1 started in switch w-1/);
    expect(calls[0]).toMatchObject({ ids: null, account: 'auto', skip: false, again: true, dryRun: false, loginOrg: 'org-new' });
  });

  it('names what it wants: --all or ids, not neither and not both', async () => {
    expect((await run(['start'], { env: {} })).code).toBe(2);
    expect((await run(['start', '--all', 'h-aaaa0001'], { env: {} })).code).toBe(2);
    expect((await run(['start', '--all', '--account', 'root'], { env: {} })).code).toBe(2);
  });

  it('exits 3 while another start runs, 1 when a start failed, 2 when there is no switch', async () => {
    expect((await run(['start', '--all'], { env: {}, start: async () => ({ ok: false, busy: true, results: [] }) })).code).toBe(3);
    const failed = await run(['start', 'h-aaaa0001'], { env: {}, start: async () => ({ ok: false, switchId: 'w-1', warning: 'same login', results: [{ handoverId: 'h-aaaa0001', title: 'Shop', ok: false, error: 'working directory does not exist' }] }) });
    expect(failed.code).toBe(1);
    expect(failed.err).toMatch(/warning: same login/);
    expect(failed.err).toMatch(/failed h-aaaa0001 Shop: working directory does not exist/);
    expect((await run(['start', '--all'], { env: {}, start: async () => ({ ok: false, notFound: true, error: 'no handover recorded yet', results: [] }) })).code).toBe(2);
  });

  it('prints what a dry run would do', async () => {
    const r = await run(['start', '--all', '--dry-run'], { start: async () => ({ ok: true, switchId: 'w-1', results: [{ handoverId: 'h-aaaa0001', title: 'Shop', ok: true, dryRun: true, cwd: 'C:\\p', command: 'claude.exe "…"', startFile: 'C:\\d\\start\\h.md' }] }) });
    expect(r.out).toContain('would start h-aaaa0001 Shop');
    expect(r.out).toContain('in   C:\\p');
    expect(r.out).toContain('1/1 would start');
  });
});

describe('kaprek handover list', () => {
  it('says so when nothing was recorded', async () => {
    expect((await run([])).out).toMatch(/no account switch recorded yet/);
  });

  it('lists the current switch with statuses and who has not reported', async () => {
    const iso = new Date(T0 - 3600_000).toISOString();
    const scanAll = async () => ({ sessions: [{ engine: 'claude', id: 'zzzzzzzz-1', cwd: work, title: 'Stumm', hidden: false, lastTs: iso, ledger: { open: true } }] });
    await run(['open'], { scanAll });
    await run(['add', '--file', file, '--title', 'Shop']);
    await run(['add', '--nothing'], { env: { CLAUDE_CODE_SESSION_ID: 's2' } });
    const r = await run(['list']);
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/switch w-.* · 1 pending · 1 nothing open · 1 not reported/);
    expect(r.out).toMatch(/h-[0-9a-f]{8} {2}pending {2}Shop/);
    expect(r.out).toMatch(/missing {2}zzzzzzzz/);
    const json = JSON.parse((await run(['--json'])).out);
    expect(json.current.handovers).toHaveLength(2);
  });

  it('points at handovers an earlier switch still holds', async () => {
    const old = openSwitch(dataDir, { now: T0 - 5000 });
    recordHandover(dataDir, { sessionId: 'old-1', cwd: work, file, switchId: old.switchId, now: T0 - 4000 });
    openSwitch(dataDir, { now: T0 });
    const r = await run(['list']);
    expect(r.out).toMatch(/1 earlier switch, 1 handover there not started — start them with --switch <id>: --all/);
    expect((await run(['list', '--all'])).out).toContain(old.switchId);
  });

  it('rejects an unknown subcommand', async () => {
    expect((await run(['frobnicate'])).code).toBe(2);
  });
});

describe('firstStartCwd', () => {
  it('is the folder of the first start event, or null', () => {
    const events = [{ type: 'stop', sessionId: 'a', cwd: 'C:\\1' }, { type: 'start', sessionId: 'a', cwd: 'C:\\2' }, { type: 'start', sessionId: 'a', cwd: 'C:\\3' }];
    expect(firstStartCwd(events, 'a')).toBe('C:\\2');
    expect(firstStartCwd(events, 'b')).toBeNull();
  });
});
