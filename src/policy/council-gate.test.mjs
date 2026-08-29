import { describe, test, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { evaluateCouncilGate, MIN_FILES, MIN_LINES } from './council-gate.mjs';
import { appendSessionEvent } from '../ledger/sessions.mjs';

function tmpDataDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'kaprek-council-gate-'));
}

function fakeExec({ stat = ' 6 files changed, 200 insertions(+), 10 deletions(-)\n', untracked = '', diffFails = false } = {}) {
  return (args) => {
    if (diffFails && args[0] === 'diff') throw new Error('fatal: not a git repository');
    if (args[0] === 'diff' && args.includes('--stat')) return stat;
    if (args[0] === 'ls-files') return untracked;
    throw new Error(`unexpected git args: ${args.join(' ')}`);
  };
}

function seedSessionStart(dataDir, sessionId, isoTs) {
  appendSessionEvent(dataDir, { type: 'start', sessionId, cwd: 'C:/repo', transcriptPath: null, ts: isoTs });
}

function baseOpts() {
  return {
    dataDir: tmpDataDir(),
    cwd: 'C:/repo',
    sessionId: 'sess-1',
    stopHookActive: false,
    now: () => 1000,
    exec: fakeExec(),
  };
}

describe('evaluateCouncilGate', () => {
  afterEach(() => {
    delete process.env.KAPREK_COUNCIL_GATE;
  });

  test('blocks a large enough change with no council review yet this session', () => {
    const opts = baseOpts();
    seedSessionStart(opts.dataDir, opts.sessionId, new Date(0).toISOString());
    const result = evaluateCouncilGate(opts);
    expect(result.block).toBe(true);
    expect(result.reason).toMatch(/kaprek council gate/);
    expect(result.reason).toMatch(/--diff/);
    expect(result.reason).toMatch(/KAPREK_COUNCIL_GATE=0/);
  });

  test('(a) does not fire when KAPREK_COUNCIL_GATE=0', () => {
    process.env.KAPREK_COUNCIL_GATE = '0';
    const opts = baseOpts();
    seedSessionStart(opts.dataDir, opts.sessionId, new Date(0).toISOString());
    expect(evaluateCouncilGate(opts).block).toBe(false);
  });

  test('(b) does not fire when stop_hook_active is true', () => {
    const opts = baseOpts();
    seedSessionStart(opts.dataDir, opts.sessionId, new Date(0).toISOString());
    expect(evaluateCouncilGate({ ...opts, stopHookActive: true }).block).toBe(false);
  });

  test('(c) does not fire twice for the same session — the once-marker holds', () => {
    const opts = baseOpts();
    seedSessionStart(opts.dataDir, opts.sessionId, new Date(0).toISOString());
    expect(evaluateCouncilGate(opts).block).toBe(true);
    expect(evaluateCouncilGate(opts).block).toBe(false);
  });

  test('(d) does not fire outside a git repo (git diff throws)', () => {
    const opts = baseOpts();
    opts.exec = fakeExec({ diffFails: true });
    expect(evaluateCouncilGate(opts).block).toBe(false);
  });

  test('(e) does not fire below both the file and the line threshold', () => {
    const opts = baseOpts();
    opts.exec = fakeExec({ stat: ' 2 files changed, 10 insertions(+), 2 deletions(-)\n' });
    expect(evaluateCouncilGate(opts).block).toBe(false);
  });

  test('(e) fires on the file-count threshold alone (untracked files count as files)', () => {
    const opts = baseOpts();
    opts.exec = fakeExec({ stat: ' 1 file changed, 1 insertion(+)\n', untracked: 'a\nb\nc\nd\ne\n' });
    seedSessionStart(opts.dataDir, opts.sessionId, new Date(0).toISOString());
    const result = evaluateCouncilGate(opts);
    expect(result.block).toBe(true);
    expect(result.reason).toMatch(/6 files/);
  });

  test('(e) fires on the line-count threshold alone', () => {
    const opts = baseOpts();
    opts.exec = fakeExec({ stat: ' 1 file changed, 100 insertions(+), 60 deletions(-)\n' });
    seedSessionStart(opts.dataDir, opts.sessionId, new Date(0).toISOString());
    const result = evaluateCouncilGate(opts);
    expect(result.block).toBe(true);
    expect(result.reason).toMatch(/160 lines/);
  });

  test('exactly at the thresholds fires (>=, not >)', () => {
    const opts = baseOpts();
    opts.exec = fakeExec({ stat: ` ${MIN_FILES} files changed, ${MIN_LINES} insertions(+)\n` });
    seedSessionStart(opts.dataDir, opts.sessionId, new Date(0).toISOString());
    expect(evaluateCouncilGate(opts).block).toBe(true);
  });

  test('(f) does not fire when a council result already exists from this session', () => {
    const opts = baseOpts();
    seedSessionStart(opts.dataDir, opts.sessionId, new Date(0).toISOString());
    const cliDir = path.join(opts.dataDir, 'council', 'cli');
    fs.mkdirSync(cliDir, { recursive: true });
    fs.writeFileSync(path.join(cliDir, 'result.json'), '{}', 'utf8'); // mtime is "now", well after the epoch session start above
    expect(evaluateCouncilGate(opts).block).toBe(false);
  });

  test('fails open when exec is missing', () => {
    const opts = baseOpts();
    delete opts.exec;
    expect(evaluateCouncilGate(opts).block).toBe(false);
  });

  test('fails open when the deadline has already run out', () => {
    const opts = baseOpts();
    let calls = 0;
    opts.now = () => {
      calls += 1;
      return calls === 1 ? 0 : 10000;
    };
    seedSessionStart(opts.dataDir, opts.sessionId, new Date(0).toISOString());
    expect(evaluateCouncilGate(opts).block).toBe(false);
  });

  test('fails open on missing dataDir/cwd/sessionId rather than throwing', () => {
    expect(evaluateCouncilGate({ ...baseOpts(), dataDir: '' }).block).toBe(false);
    expect(evaluateCouncilGate({ ...baseOpts(), cwd: '' }).block).toBe(false);
    expect(evaluateCouncilGate({ ...baseOpts(), sessionId: '' }).block).toBe(false);
  });
});
