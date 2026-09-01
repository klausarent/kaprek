// Tests for the P7 skip-if precondition: registry validation + path
// resolution (see condition.mjs / registry.mjs), the runner's condition gate
// (skip vs. condition-error vs. the onConditionError:'run' exception, the
// claim behaviour, the degraded streak), the run-line fields, the
// notification, and the guarantee that skipped runs do not consume the daily
// caps. Same harness discipline as runner.test.mjs: real orchestrator
// runTurn() over the fake, scriptable harness, injected clocks, no sleeps.
import { test, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runTurn } from '../orchestrator/run.mjs';
import { appendRun, readRuns } from '../orchestrator/runs.mjs';
import { openTriggers } from './registry.mjs';
import { createTriggerRunner } from './runner.mjs';
import { checkLimits } from './limits.mjs';
import { conditionErrorStreak, evaluateCondition, resolveConditionPath } from './condition.mjs';
import { createFakeHarness } from '../harness/fake.mjs';

let dataDir;
let cwd;

beforeEach(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kaprek-condition-test-'));
  cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'kaprek-condition-workspace-'));
  // A heartbeat trigger refuses to fire without its checklist file.
  fs.writeFileSync(path.join(cwd, 'CHECKLIST.md'), '- [ ] something\n');
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(dataDir, { recursive: true, force: true });
  fs.rmSync(cwd, { recursive: true, force: true });
});

function heartbeatTrigger(overrides = {}) {
  return {
    id: 'heartbeat-1',
    type: 'heartbeat',
    config: { intervalMinutes: 30 },
    promptTemplate: 'Check {{checklist}}.',
    appScope: [],
    enabled: true,
    ...overrides,
  };
}

function textResultScript(text, extra = {}) {
  return [
    { type: 'init', sessionId: 's1', tools: [], model: 'm', permissionMode: 'default' },
    { type: 'text', text },
    { type: 'result', sessionId: 's1', costUsd: 0.001, usage: {}, isError: false, ...extra },
  ];
}

function makeRunner({ trigger, notify, script, now = () => Date.now(), log = () => {} } = {}) {
  const triggers = openTriggers(dataDir, { knownAppIds: null, log: () => {}, conditionBaseDir: cwd });
  if (trigger) triggers.upsert(trigger);
  const harness = createFakeHarness({ script: script ?? textResultScript('ok') });
  const runner = createTriggerRunner({
    dataDir,
    triggers,
    runTurn,
    harness,
    harnessName: 'fake',
    cwd,
    now,
    log,
    ...(notify ? { notify } : {}),
  });
  return { runner, triggers, harness };
}

/** A heartbeat window whose slot is due RIGHT NOW, so only the condition decides. */
function dueHeartbeat() {
  const windowMs = 30 * 60_000;
  return Date.now() - (Date.now() % windowMs) + windowMs - 1000;
}

// ------------------------------------------------------------- registry

test('registry: a heartbeat may carry a file-exists condition; a relative path is resolved against the base dir and stored absolute', () => {
  const triggers = openTriggers(dataDir, { knownAppIds: null, log: () => {}, conditionBaseDir: cwd });
  const stored = triggers.upsert(heartbeatTrigger({ condition: { kind: 'file-exists', path: 'notes/today.md' } }));
  expect(stored.condition).toEqual({ kind: 'file-exists', path: path.join(cwd, 'notes', 'today.md') });
  expect(stored.onConditionError).toBe('skip');
});

test('registry: an absolute condition path is stored as given; file-newer-than-last-run validates too', () => {
  const abs = path.join(cwd, 'out.md');
  const triggers = openTriggers(dataDir, { knownAppIds: null, log: () => {}, conditionBaseDir: cwd });
  const stored = triggers.upsert(
    heartbeatTrigger({ condition: { kind: 'file-newer-than-last-run', path: abs }, onConditionError: 'run' }),
  );
  expect(stored.condition).toEqual({ kind: 'file-newer-than-last-run', path: abs });
  expect(stored.onConditionError).toBe('run');
});

test('registry: clipboard, file-watch and saved-prompt triggers reject a condition — their input IS their precondition', () => {
  const triggers = openTriggers(dataDir, { knownAppIds: null, log: () => {} });
  for (const [type, config] of [
    ['clipboard', { pollMs: 2000, matchPattern: 'x' }],
    ['file-watch', { path: 'inbox', debounceMs: 500 }],
    ['saved-prompt', {}],
  ]) {
    expect(() =>
      triggers.upsert({
        id: `cond-${type}`,
        type,
        config,
        promptTemplate: 'p',
        appScope: [],
        condition: { kind: 'file-exists', path: 'x' },
      }),
    ).toThrow(/condition/);
  }
});

test('registry: an unknown condition kind, an empty path and a stray onConditionError are validation errors', () => {
  const triggers = openTriggers(dataDir, { knownAppIds: null, log: () => {} });
  expect(() => triggers.upsert(heartbeatTrigger({ condition: { kind: 'command', path: 'x' } }))).toThrow(/condition\.kind/);
  expect(() => triggers.upsert(heartbeatTrigger({ condition: { kind: 'file-exists', path: '  ' } }))).toThrow(/condition\.path/);
  expect(() => triggers.upsert(heartbeatTrigger({ condition: { kind: 'file-exists', path: 'x' }, onConditionError: 'ignore' }))).toThrow(
    /onConditionError/,
  );
  expect(() => triggers.upsert(heartbeatTrigger({ onConditionError: 'run' }))).toThrow(/onConditionError/);
});

test('registry: a legacy trigger without condition validates unchanged and carries no condition field', () => {
  const triggers = openTriggers(dataDir, { knownAppIds: null, log: () => {} });
  const stored = triggers.upsert(heartbeatTrigger());
  expect('condition' in stored).toBe(false);
  expect(stored.limits).toEqual({ maxRunsPerDay: 24, maxCostPerDay: 1.0 });
});

// ------------------------------------------------------------- evaluateCondition

test('evaluateCondition: file-exists answers true for an existing path and false (not an error) for a missing one', () => {
  fs.writeFileSync(path.join(cwd, 'there.md'), 'x');
  expect(evaluateCondition({ kind: 'file-exists', path: 'there.md', cwd, dataDir }).met).toBe(true);
  expect(evaluateCondition({ kind: 'file-exists', path: 'missing.md', cwd, dataDir })).toMatchObject({ met: false, error: null });
});

test('evaluateCondition: file-newer-than-last-run compares against the given last-run time', () => {
  const now = Date.now();
  fs.writeFileSync(path.join(cwd, 'fresh.md'), 'x');
  expect(evaluateCondition({ kind: 'file-newer-than-last-run', path: 'fresh.md', cwd, dataDir, lastRunStartedAt: now - 60_000 }).met).toBe(true);
  // Older file, and no previous run at all (null -> the first run is never skipped).
  fs.utimesSync(path.join(cwd, 'fresh.md'), new Date(now - 600_000), new Date(now - 600_000));
  expect(evaluateCondition({ kind: 'file-newer-than-last-run', path: 'fresh.md', cwd, dataDir, lastRunStartedAt: now - 60_000 }).met).toBe(false);
  expect(evaluateCondition({ kind: 'file-newer-than-last-run', path: 'fresh.md', cwd, dataDir, lastRunStartedAt: null }).met).toBe(true);
});

test('evaluateCondition: a symlink out of the allowed roots is a containment ERROR, not a false condition', () => {
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'kaprek-condition-outside-'));
  try {
    fs.symlinkSync(outside, path.join(cwd, 'jail-break'), 'junction');
    const verdict = evaluateCondition({ kind: 'file-exists', path: 'jail-break', cwd, dataDir });
    expect(verdict.error).toMatch(/outside the allowed roots/);
  } finally {
    fs.rmSync(outside, { recursive: true, force: true });
  }
});

test('resolveConditionPath: relative resolves against cwd, absolute is kept', () => {
  expect(resolveConditionPath('a/b.md', { cwd, dataDir })).toBe(path.join(cwd, 'a', 'b.md'));
  const abs = path.join(os.tmpdir(), 'x.md');
  expect(resolveConditionPath(abs, { cwd, dataDir })).toBe(path.resolve(abs));
});

// ------------------------------------------------------------- runner gate

test('runner: a FALSE file-exists condition skips the run — run line with skipped/conditionKind/durationMs, no turn, no notify, claim stays set', async () => {
  const notify = vi.fn();
  const { runner, harness } = makeRunner({
    trigger: heartbeatTrigger({ condition: { kind: 'file-exists', path: 'never-there.md' } }),
    notify,
  });
  const fixedNow = dueHeartbeat();

  const result = await runner.fireTrigger('heartbeat-1', { cause: { origin: 'heartbeat' } });
  expect(result).toMatchObject({ fired: false, skipped: 'condition' });

  const runs = readRuns(dataDir);
  expect(runs).toHaveLength(1);
  expect(runs[0]).toMatchObject({
    origin: 'trigger',
    triggerId: 'heartbeat-1',
    skipped: 'condition',
    conditionKind: 'file-exists',
    conditionError: null,
    costUsd: null,
  });
  expect(typeof runs[0].durationMs).toBe('number');
  // No turn — the only runs.jsonl line is the condition-error skip.
  expect(notify).not.toHaveBeenCalled();

  // The window claim was taken DESPITE the skip: a second fire in the same
  // slot is rejected as claimed, not re-judged.
  const second = await runner.fireTrigger('heartbeat-1', { cause: { origin: 'heartbeat' } });
  expect(second.fired).toBe(false);
  expect(second.reason).toMatch(/already claimed/);
  expect(readRuns(dataDir)).toHaveLength(1);
});

test('runner: a TRUE file-exists condition fires the turn and writes no skipped line', async () => {
  fs.writeFileSync(path.join(cwd, 'today.md'), 'x');
  const { runner } = makeRunner({
    trigger: heartbeatTrigger({ condition: { kind: 'file-exists', path: 'today.md' } }),
  });
  const result = await runner.fireTrigger('heartbeat-1', { cause: { origin: 'heartbeat' } });
  expect(result.fired).toBe(true);
  expect(readRuns(dataDir).every((run) => run.skipped === null)).toBe(true);
});

test('runner: file-newer-than-last-run reads the trigger’s OWN last run from runs.jsonl', async () => {
  fs.writeFileSync(path.join(cwd, 'feed.md'), 'x');
  // Last run of THIS trigger, 10 minutes ago.
  const tenMinAgo = new Date(Date.now() - 600_000).toISOString();
  appendRun(dataDir, { origin: 'trigger', triggerId: 'heartbeat-1', ts: tenMinAgo });
  // Another trigger's newer run must be ignored.
  appendRun(dataDir, { origin: 'trigger', triggerId: 'other', ts: new Date().toISOString() });

  // File is older than the last run of this trigger -> skip (and the slot is
  // spent, so the next fire needs the NEXT window).
  fs.utimesSync(path.join(cwd, 'feed.md'), new Date(Date.now() - 900_000), new Date(Date.now() - 900_000));
  const windowMs = 30 * 60_000;
  let nowMs = dueHeartbeat();
  const { runner } = makeRunner({
    trigger: heartbeatTrigger({ condition: { kind: 'file-newer-than-last-run', path: 'feed.md' } }),
    now: () => nowMs,
  });
  const skipped = await runner.fireTrigger('heartbeat-1', { cause: { origin: 'heartbeat' } });
  expect(skipped).toMatchObject({ fired: false, skipped: 'condition' });

  // Touch the file -> newer than last run -> fires in the next window.
  nowMs += windowMs;
  const fresh = Date.now() + 1000;
  fs.utimesSync(path.join(cwd, 'feed.md'), new Date(fresh), new Date(fresh));
  const fired = await runner.fireTrigger('heartbeat-1', { cause: { origin: 'heartbeat' } });
  expect(fired.fired).toBe(true);
});

test('runner: an unjudgeable condition (symlink out of the roots) is loud — skipped: condition-error, notify names it, claim stays set', async () => {
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'kaprek-condition-outside-'));
  try {
    fs.symlinkSync(outside, path.join(cwd, 'jail-break'), 'junction');
    const notify = vi.fn();
    const { runner } = makeRunner({
      trigger: heartbeatTrigger({ condition: { kind: 'file-exists', path: 'jail-break' } }),
      notify,
    });

    const result = await runner.fireTrigger('heartbeat-1', { cause: { origin: 'heartbeat' } });
    expect(result).toMatchObject({ fired: false, skipped: 'condition-error' });

    const runs = readRuns(dataDir);
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({
      skipped: 'condition-error',
      conditionKind: 'file-exists',
      conditionError: expect.stringMatching(/outside the allowed roots/),
    });

    // The notification happened, and its text says what failed.
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify.mock.calls[0][0].text).toMatch(/Bedingung fehlgeschlagen: file-exists: .* — Lauf übersprungen/);

    // The claim is spent in the error case too.
    const second = await runner.fireTrigger('heartbeat-1', { cause: { origin: 'heartbeat' } });
    expect(second.reason).toMatch(/already claimed/);
  } finally {
    fs.rmSync(outside, { recursive: true, force: true });
  }
});

test('runner: five condition errors in a row mark the trigger degraded; a normal run resets the streak', async () => {
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'kaprek-condition-outside-'));
  try {
    fs.symlinkSync(outside, path.join(cwd, 'jail-break'), 'junction');
    const { runner } = makeRunner({
      trigger: heartbeatTrigger({
        id: 'degraded-1',
        condition: { kind: 'file-exists', path: 'jail-break' },
      }),
      notify: () => {},
      now: () => nowMs,
    });

    expect(runner.conditionStatus({ id: 'degraded-1', condition: { kind: 'file-exists', path: 'jail-break' } })).toEqual({
      degraded: false,
      conditionErrorStreak: 0,
    });

    // One error per heartbeat window: advance the injected clock by a full
    // window between fires so each fire claims a fresh slot.
    const windowMs = 30 * 60_000;
    let nowMs = dueHeartbeat();
    for (let i = 1; i <= 4; i += 1) {
      nowMs += windowMs;
      await runner.fireTrigger('degraded-1', { cause: { origin: 'heartbeat' } });
      const status = runner.conditionStatus({ id: 'degraded-1', condition: { kind: 'file-exists', path: 'jail-break' } });
      expect(status.conditionErrorStreak).toBe(i);
      expect(status.degraded).toBe(false);
    }
    nowMs += windowMs;
    await runner.fireTrigger('degraded-1', { cause: { origin: 'heartbeat' } });
    expect(runner.conditionStatus({ id: 'degraded-1', condition: { kind: 'file-exists', path: 'jail-break' } }).degraded).toBe(true);

    // A normal run (turned, no conditionError) resets the streak, and with
    // it the degraded flag.
    appendRun(dataDir, { origin: 'trigger', triggerId: 'degraded-1', costUsd: 0.01 });
    expect(runner.conditionStatus({ id: 'degraded-1', condition: { kind: 'file-exists', path: 'jail-break' } })).toEqual({
      degraded: false,
      conditionErrorStreak: 0,
    });
  } finally {
    fs.rmSync(outside, { recursive: true, force: true });
  }
});

test('conditionErrorStreak: counts skipped condition-error lines and runs carrying conditionError; a plain condition skip does NOT count', () => {
  appendRun(dataDir, { origin: 'trigger', triggerId: 't1', skipped: 'condition-error', conditionKind: 'file-exists', conditionError: 'x' });
  appendRun(dataDir, { origin: 'trigger', triggerId: 't1', skipped: 'condition-error', conditionKind: 'file-exists', conditionError: 'x' });
  // Another trigger's errors are ignored, not streak-breaking.
  appendRun(dataDir, { origin: 'trigger', triggerId: 'other', skipped: 'condition-error', conditionError: 'y' });
  appendRun(dataDir, { origin: 'trigger', triggerId: 't1', conditionError: 'file-exists: still broken' }); // onConditionError: 'run' — counts
  expect(conditionErrorStreak(readRuns(dataDir), 't1')).toBe(3);
  // A plain skip (the feature working) stops the streak.
  appendRun(dataDir, { origin: 'trigger', triggerId: 't1', skipped: 'condition', conditionKind: 'file-exists' });
  expect(conditionErrorStreak(readRuns(dataDir), 't1')).toBe(0);
});

test('runner: onConditionError "run" starts the turn anyway; the run line carries conditionError and the streak counts it', async () => {
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'kaprek-condition-outside-'));
  try {
    fs.symlinkSync(outside, path.join(cwd, 'jail-break'), 'junction');
    const notify = vi.fn();
    const { runner } = makeRunner({
      trigger: heartbeatTrigger({
        id: 'run-anyway-1',
        condition: { kind: 'file-exists', path: 'jail-break' },
        onConditionError: 'run',
      }),
      notify,
    });

    const result = await runner.fireTrigger('run-anyway-1', { cause: { origin: 'heartbeat' } });
    expect(result.fired).toBe(true);
    expect(typeof result.chatId).toBe('string'); // the turn actually ran
    // No notification on the 'run' path — the run itself is the outcome.
    expect(notify).not.toHaveBeenCalled();

    const runs = readRuns(dataDir).filter((run) => run.triggerId === 'run-anyway-1');
    expect(runs).toHaveLength(1);
    expect(runs[0].skipped).toBe(null);
    expect(runs[0].conditionError).toMatch(/file-exists: .*outside the allowed roots/);
    expect(runs[0].costUsd).toBe(0.001);

    // And the streak counts a real run carrying conditionError too.
    expect(
      runner.conditionStatus({ id: 'run-anyway-1', condition: { kind: 'file-exists', path: 'jail-break' } }).conditionErrorStreak,
    ).toBe(1);
  } finally {
    fs.rmSync(outside, { recursive: true, force: true });
  }
});

test('runner: a legacy trigger without a condition fires exactly as before', async () => {
  const { runner } = makeRunner({ trigger: heartbeatTrigger({ id: 'legacy-1' }) });
  const result = await runner.fireTrigger('legacy-1', { cause: { origin: 'heartbeat' } });
  expect(result.fired).toBe(true);
  expect(readRuns(dataDir).every((run) => run.skipped === null && run.conditionError === null)).toBe(true);
});

test('limits: a skipped condition run consumes neither the run count nor the cost cap', () => {
  const trigger = heartbeatTrigger({ id: 'capped-1', limits: { maxRunsPerDay: 2, maxCostPerDay: 0.5 } });
  // One real run plus one skipped condition run.
  appendRun(dataDir, { origin: 'trigger', triggerId: 'capped-1', costUsd: 0.1 });
  appendRun(dataDir, { origin: 'trigger', triggerId: 'capped-1', skipped: 'condition', conditionKind: 'file-exists' });
  const afterSkip = checkLimits({ dataDir, trigger });
  expect(afterSkip.allowed).toBe(true);
  expect(afterSkip.runsToday).toBe(1);
  expect(afterSkip.costToday).toBeCloseTo(0.1);

  // A second real run reaches the cap; the skips never contributed.
  appendRun(dataDir, { origin: 'trigger', triggerId: 'capped-1', costUsd: 0.1 });
  const afterTwo = checkLimits({ dataDir, trigger });
  expect(afterTwo.allowed).toBe(false);
  expect(afterTwo.reason).toMatch(/daily run limit reached \(2\/2\)/);
});

