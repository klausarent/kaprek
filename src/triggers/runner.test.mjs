// Tests for the trigger runner. Run: npx vitest run src/triggers/runner.test.mjs
//
// Uses the REAL orchestrator runTurn() (see run.mjs) wired to the fake,
// scriptable harness — never a real CLI process, never a real sleep. Every
// clock is injected via `now`.
import { test, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runTurn } from '../orchestrator/run.mjs';
import { appendRun } from '../orchestrator/runs.mjs';
import { openChats } from '../chats/store.mjs';
import { openTriggers } from './registry.mjs';
import { createTriggerRunner } from './runner.mjs';
import { createFakeHarness } from '../harness/fake.mjs';

let dataDir;
let cwd;

beforeEach(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kaprek-triggers-runner-test-'));
  cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'kaprek-triggers-runner-workspace-'));
});

afterEach(() => {
  fs.rmSync(dataDir, { recursive: true, force: true });
  fs.rmSync(cwd, { recursive: true, force: true });
  vi.useRealTimers();
});

function heartbeatTrigger(overrides = {}) {
  return {
    id: 'heartbeat-1',
    type: 'heartbeat',
    config: { intervalMinutes: 30 },
    promptTemplate: 'Check {{checklist}} for anything overdue. Reason: {{reason}}',
    appScope: [],
    enabled: true,
    ...overrides,
  };
}

function scheduleTrigger(overrides = {}) {
  return {
    id: 'schedule-1',
    type: 'schedule',
    config: { dailyAt: '09:00' },
    promptTemplate: 'Run the nightly sync.',
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

function makeRunner({ trigger, script, makeUiApprovalHandler, now = () => Date.now(), log = () => {} } = {}) {
  const triggers = openTriggers(dataDir);
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
    makeUiApprovalHandler,
  });
  return { runner, triggers, harness };
}

// ------------------------------------------------------------- loop guard (Pflichttest)

test('fireTrigger never fires when cause.origin is "trigger"', async () => {
  const { runner } = makeRunner({ trigger: heartbeatTrigger() });
  fs.writeFileSync(path.join(cwd, 'CHECKLIST.md'), '- check the thing');

  const result = await runner.fireTrigger('heartbeat-1', { cause: { origin: 'trigger' } });
  expect(result).toEqual({ fired: false, reason: expect.stringMatching(/loop guard/) });
});

test('a second fireTrigger call for the same trigger while one is still in flight is rejected', async () => {
  fs.writeFileSync(path.join(cwd, 'CHECKLIST.md'), '- check the thing');
  const { runner } = makeRunner({ trigger: heartbeatTrigger(), script: textResultScript('still working') });

  const p1 = runner.fireTrigger('heartbeat-1', { cause: { origin: 'user' } });
  const p2 = runner.fireTrigger('heartbeat-1', { cause: { origin: 'user' } });
  const [r1, r2] = await Promise.all([p1, p2]);

  const results = [r1, r2];
  expect(results.filter((r) => r.fired)).toHaveLength(1);
  const rejected = results.find((r) => !r.fired);
  expect(rejected.reason).toMatch(/already running/);
});

test('once the in-flight run finishes, the trigger can fire again', async () => {
  fs.writeFileSync(path.join(cwd, 'CHECKLIST.md'), '- check the thing');
  const { runner } = makeRunner({ trigger: heartbeatTrigger() });

  const r1 = await runner.fireTrigger('heartbeat-1', { cause: { origin: 'user' } });
  expect(r1.fired).toBe(true);
  const r2 = await runner.fireTrigger('heartbeat-1', { cause: { origin: 'user' } });
  expect(r2.fired).toBe(true);
});

// ------------------------------------------------------------- heartbeat

test('heartbeat: a missing checklist file means no turn at all', async () => {
  const { runner } = makeRunner({ trigger: heartbeatTrigger({ config: { intervalMinutes: 30, checklistPath: 'CHECKLIST.md' } }) });
  // No CHECKLIST.md written in cwd.
  const result = await runner.fireTrigger('heartbeat-1', { cause: { origin: 'user' } });
  expect(result.fired).toBe(false);
  expect(result.reason).toMatch(/checklist not found/);
});

test('heartbeat: a HEARTBEAT_OK reply (any case, trimmed) marks the run silent and hides the chat from the store\'s silent flag', async () => {
  fs.writeFileSync(path.join(cwd, 'CHECKLIST.md'), '- nothing due');
  const { runner } = makeRunner({ trigger: heartbeatTrigger(), script: textResultScript('  Heartbeat_OK  ') });

  const result = await runner.fireTrigger('heartbeat-1', { cause: { origin: 'user' } });
  expect(result.fired).toBe(true);
  expect(result.silent).toBe(true);

  const chat = openChats(dataDir).get(result.chatId);
  expect(chat.silent).toBe(true);
  expect(chat.origin).toBe('trigger');
  expect(chat.triggerId).toBe('heartbeat-1');
});

test('heartbeat: a real answer produces a visible (non-silent) chat', async () => {
  fs.writeFileSync(path.join(cwd, 'CHECKLIST.md'), '- ship the report');
  const { runner } = makeRunner({ trigger: heartbeatTrigger(), script: textResultScript('The report is 2 days overdue.') });

  const result = await runner.fireTrigger('heartbeat-1', { cause: { origin: 'user' } });
  expect(result.fired).toBe(true);
  expect(result.silent).toBe(false);

  const chat = openChats(dataDir).get(result.chatId);
  expect(chat.silent).toBe(false);
});

test('heartbeat: a tool call during the turn keeps the chat visible even when the final reply is exactly HEARTBEAT_OK', async () => {
  fs.writeFileSync(path.join(cwd, 'CHECKLIST.md'), '- check backups');
  const script = [
    { type: 'init', sessionId: 's1', tools: [], model: 'm', permissionMode: 'default' },
    { type: 'tool-start', id: 't1', name: 'Read', input: { path: 'backups.log' } },
    { type: 'tool-end', id: 't1', result: 'backup ran fine', isError: false },
    { type: 'text', text: 'HEARTBEAT_OK' },
    { type: 'result', sessionId: 's1', costUsd: 0, usage: {}, isError: false },
  ];
  const { runner } = makeRunner({ trigger: heartbeatTrigger(), script });

  const result = await runner.fireTrigger('heartbeat-1', { cause: { origin: 'user' } });
  expect(result.fired).toBe(true);
  // The reply text alone would have said "silent", but a tool actually ran
  // during the turn — that must win (task-7a-review.md Important #1).
  expect(result.silent).toBe(false);

  const chat = openChats(dataDir).get(result.chatId);
  expect(chat.silent).toBe(false);
});

test('heartbeat: the checklist text and reason reach the prompt via {{checklist}}/{{reason}}', async () => {
  fs.writeFileSync(path.join(cwd, 'CHECKLIST.md'), '- water the plants');
  const harness = createFakeHarness({ script: textResultScript('ok') });
  const triggers = openTriggers(dataDir);
  triggers.upsert(heartbeatTrigger({ promptTemplate: 'CHECKLIST:\n{{checklist}}\nREASON: {{reason}}' }));
  const runner = createTriggerRunner({ dataDir, triggers, runTurn, harness, harnessName: 'fake', cwd, now: () => Date.now(), log: () => {} });

  const result = await runner.fireTrigger('heartbeat-1', { cause: { origin: 'user' } });
  const events = openChats(dataDir).events(result.chatId);
  const userEvent = events.find((e) => e.kind === 'user');
  expect(userEvent.text).toContain('water the plants');
  expect(userEvent.text).toContain('heartbeat interval reached');
});

// ------------------------------------------------------------- schedule

test('schedule (dailyAt): fires exactly once for its slot, a second call in the same minute is rejected', async () => {
  const fixedNow = new Date(2026, 6, 30, 9, 0, 0).getTime(); // local 09:00:00
  const { runner } = makeRunner({ trigger: scheduleTrigger({ config: { dailyAt: '09:00' } }), now: () => fixedNow });

  const first = await runner.fireTrigger('schedule-1', { cause: { origin: 'user' } });
  expect(first.fired).toBe(true);

  const second = await runner.fireTrigger('schedule-1', { cause: { origin: 'user' } });
  expect(second.fired).toBe(false);
  expect(second.reason).toMatch(/already claimed/);
});

test('schedule (dailyAt): outside the configured minute, no slot is due', async () => {
  const fixedNow = new Date(2026, 6, 30, 9, 1, 0).getTime(); // one minute past 09:00
  const { runner } = makeRunner({ trigger: scheduleTrigger({ config: { dailyAt: '09:00' } }), now: () => fixedNow });

  const result = await runner.fireTrigger('schedule-1', { cause: { origin: 'user' } });
  expect(result.fired).toBe(false);
  expect(result.reason).toMatch(/no schedule slot due/);
});

test('schedule (everyMinutes): fires once per window, a second call in the same window is rejected', async () => {
  const fixedNow = new Date(2026, 6, 30, 9, 3, 0).getTime(); // inside a 15-minute window
  const { runner } = makeRunner({ trigger: scheduleTrigger({ config: { everyMinutes: 15 } }), now: () => fixedNow });

  const first = await runner.fireTrigger('schedule-1', { cause: { origin: 'user' } });
  expect(first.fired).toBe(true);

  const second = await runner.fireTrigger('schedule-1', { cause: { origin: 'user' } });
  expect(second.fired).toBe(false);
  expect(second.reason).toMatch(/already claimed/);
});

test('schedule (everyMinutes): the NEXT window is a fresh slot and fires again', async () => {
  const windowMs = 15 * 60_000;
  const firstWindowNow = Math.floor(Date.now() / windowMs) * windowMs + 60_000;
  let currentNow = firstWindowNow;
  const { runner } = makeRunner({ trigger: scheduleTrigger({ config: { everyMinutes: 15 } }), now: () => currentNow });

  const first = await runner.fireTrigger('schedule-1', { cause: { origin: 'user' } });
  expect(first.fired).toBe(true);

  currentNow += windowMs; // advance one full window
  const second = await runner.fireTrigger('schedule-1', { cause: { origin: 'user' } });
  expect(second.fired).toBe(true);
});

// ------------------------------------------------------------- escalation / approval gate

test('escalation "review" without a configured UI approval handler factory never fires (fail-closed)', async () => {
  const { runner } = makeRunner({ trigger: scheduleTrigger({ config: { everyMinutes: 5 }, escalation: 'review' }) });
  const result = await runner.fireTrigger('schedule-1', { cause: { origin: 'user' } });
  expect(result.fired).toBe(false);
  expect(result.reason).toMatch(/approval/);
});

test('escalation "review" WITH a configured UI approval handler factory fires, and the factory is called with the turn\'s own chatId', async () => {
  const decisions = [];
  const chatIdsSeen = [];
  const makeUiApprovalHandler = (chatId) => {
    chatIdsSeen.push(chatId);
    return async (request) => {
      decisions.push(request);
      return { behavior: 'allow' };
    };
  };
  const script = [
    { type: 'init', sessionId: 's1', tools: [], model: 'm', permissionMode: 'default' },
    { approval: { toolName: 'Bash', input: { command: 'echo hi' } } },
    { type: 'text', text: 'done' },
    { type: 'result', sessionId: 's1', costUsd: 0, usage: {}, isError: false },
  ];
  const { runner } = makeRunner({ trigger: scheduleTrigger({ config: { everyMinutes: 5 }, escalation: 'review' }), script, makeUiApprovalHandler });

  const result = await runner.fireTrigger('schedule-1', { cause: { origin: 'user' } });
  expect(result.fired).toBe(true);
  expect(decisions).toHaveLength(1);
  // The factory must see the SAME chatId the turn actually resolved to —
  // not undefined/null (see run.mjs's onChatResolved and the timing
  // guarantee in runner.mjs's fireTrigger doc comment).
  expect(chatIdsSeen).toEqual([result.chatId]);
  expect(typeof result.chatId).toBe('string');
});

test('escalation "notify" never uses makeUiApprovalHandler even when one is configured — it always uses its own self-contained policy decider', async () => {
  const makeUiApprovalHandler = () => {
    throw new Error('should never be called for a notify trigger');
  };
  const script = [
    { type: 'init', sessionId: 's1', tools: [], model: 'm', permissionMode: 'default' },
    { approval: { toolName: 'Bash', input: { command: 'echo hi' } } },
    { type: 'text', text: 'done' },
    { type: 'result', sessionId: 's1', costUsd: 0, usage: {}, isError: false },
  ];
  const { runner, harness } = makeRunner({ trigger: scheduleTrigger({ config: { everyMinutes: 5 }, escalation: 'notify' }), script, makeUiApprovalHandler });

  const result = await runner.fireTrigger('schedule-1', { cause: { origin: 'user' } });
  expect(result.fired).toBe(true);
  // The Bash approval was auto-denied by notifyPolicyHandler (Bash isn't a
  // scoped MCP app tool), never even reaching makeUiApprovalHandler.
  expect(harness.approvalLog).toHaveLength(1);
  expect(harness.approvalLog[0].decision).toEqual({ behavior: 'deny', message: 'not permitted for notify trigger' });
});

test('escalation "notify" fires without any approval handler configured', async () => {
  const { runner } = makeRunner({ trigger: scheduleTrigger({ config: { everyMinutes: 5 }, escalation: 'notify' }) });
  const result = await runner.fireTrigger('schedule-1', { cause: { origin: 'user' } });
  expect(result.fired).toBe(true);
});

// ------------------------------------------------------------- appScope -> allowedTools

test('appScope: [] passes an empty allowedTools list to the harness, never "all tools"', async () => {
  const calls = [];
  const inner = createFakeHarness({ script: textResultScript('ok') });
  const harness = { startTurn: (opts) => { calls.push(opts); return inner.startTurn(opts); } };
  const triggers = openTriggers(dataDir);
  triggers.upsert(scheduleTrigger({ config: { everyMinutes: 5 }, appScope: [] }));
  const runner = createTriggerRunner({ dataDir, triggers, runTurn, harness, harnessName: 'fake', cwd, now: () => Date.now(), log: () => {} });

  await runner.fireTrigger('schedule-1', { cause: { origin: 'user' } });
  expect(calls).toHaveLength(1);
  expect(calls[0].allowedTools).toEqual([]);
});

test('appScope: [\'notes\'] passes exactly that list as allowedTools', async () => {
  const calls = [];
  const inner = createFakeHarness({ script: textResultScript('ok') });
  const harness = { startTurn: (opts) => { calls.push(opts); return inner.startTurn(opts); } };
  const triggers = openTriggers(dataDir);
  triggers.upsert(scheduleTrigger({ config: { everyMinutes: 5 }, appScope: ['notes'] }));
  const runner = createTriggerRunner({ dataDir, triggers, runTurn, harness, harnessName: 'fake', cwd, now: () => Date.now(), log: () => {} });

  await runner.fireTrigger('schedule-1', { cause: { origin: 'user' } });
  expect(calls[0].allowedTools).toEqual(['notes']);
});

// ------------------------------------------------------------- notify policy decider

test('notify: a Bash tool-use request is automatically denied, no human/SSE involved', async () => {
  const script = [
    { type: 'init', sessionId: 's1', tools: [], model: 'm', permissionMode: 'default' },
    { approval: { toolName: 'Bash', input: { command: 'echo hi' } } },
    { type: 'text', text: 'done' },
    { type: 'result', sessionId: 's1', costUsd: 0, usage: {}, isError: false },
  ];
  const { runner, harness } = makeRunner({ trigger: scheduleTrigger({ config: { everyMinutes: 5 }, escalation: 'notify' }), script });

  const result = await runner.fireTrigger('schedule-1', { cause: { origin: 'user' } });
  expect(result.fired).toBe(true);
  expect(harness.approvalLog).toHaveLength(1);
  expect(harness.approvalLog[0].decision).toEqual({ behavior: 'deny', message: 'not permitted for notify trigger' });
});

test('notify: a qualified MCP tool call for an app IN appScope is automatically allowed', async () => {
  const script = [
    { type: 'init', sessionId: 's1', tools: [], model: 'm', permissionMode: 'default' },
    { approval: { toolName: 'mcp__kaprek-apps__notes.write', input: { title: 'x' } } },
    { type: 'text', text: 'done' },
    { type: 'result', sessionId: 's1', costUsd: 0, usage: {}, isError: false },
  ];
  const { runner, harness } = makeRunner({
    trigger: scheduleTrigger({ config: { everyMinutes: 5 }, escalation: 'notify', appScope: ['notes'] }),
    script,
  });

  const result = await runner.fireTrigger('schedule-1', { cause: { origin: 'user' } });
  expect(result.fired).toBe(true);
  expect(harness.approvalLog).toHaveLength(1);
  expect(harness.approvalLog[0].decision).toEqual({ behavior: 'allow' });
});

test('notify: a qualified MCP tool call for an app NOT in appScope is automatically denied', async () => {
  const script = [
    { type: 'init', sessionId: 's1', tools: [], model: 'm', permissionMode: 'default' },
    { approval: { toolName: 'mcp__kaprek-apps__other-app.write', input: {} } },
    { type: 'text', text: 'done' },
    { type: 'result', sessionId: 's1', costUsd: 0, usage: {}, isError: false },
  ];
  const { runner, harness } = makeRunner({
    trigger: scheduleTrigger({ config: { everyMinutes: 5 }, escalation: 'notify', appScope: ['notes'] }),
    script,
  });

  const result = await runner.fireTrigger('schedule-1', { cause: { origin: 'user' } });
  expect(result.fired).toBe(true);
  expect(harness.approvalLog[0].decision.behavior).toBe('deny');
});

// ------------------------------------------------------------- disabled / unknown / limits

test('a disabled trigger never fires', async () => {
  const { runner } = makeRunner({ trigger: scheduleTrigger({ enabled: false }) });
  const result = await runner.fireTrigger('schedule-1', { cause: { origin: 'user' } });
  expect(result).toEqual({ fired: false, reason: 'trigger disabled' });
});

test('an unknown trigger id never fires', async () => {
  const { runner } = makeRunner({});
  const result = await runner.fireTrigger('does-not-exist', { cause: { origin: 'user' } });
  expect(result).toEqual({ fired: false, reason: 'unknown trigger' });
});

test('a trigger already at its daily run cap is rejected — a limits rejection, not a runTurn error', async () => {
  const fixedNow = new Date(2026, 6, 30, 9, 0, 0).getTime();
  const trigger = scheduleTrigger({ limits: { maxRunsPerDay: 1, maxCostPerDay: 50 } });
  const { runner } = makeRunner({ trigger, now: () => fixedNow });
  // Pre-fill today's one allowed run directly in runs.jsonl (see limits.mjs)
  // so the cap is already exhausted before fireTrigger() is even called.
  appendRun(dataDir, { ts: new Date(fixedNow).toISOString(), triggerId: 'schedule-1', origin: 'trigger', costUsd: 0 });

  const result = await runner.fireTrigger('schedule-1', { cause: { origin: 'user' } });
  expect(result.fired).toBe(false);
  expect(result.reason).toMatch(/daily run limit/);
});

// ------------------------------------------------------------- start()/stop()

test('start() ticks on the injected interval and stop() stops it — no timer keeps running after stop()', () => {
  vi.useFakeTimers();
  const logMessages = [];
  const triggers = openTriggers(dataDir);
  // A heartbeat trigger with no checklist file: every tick rejects
  // deterministically and synchronously, giving an observable, side-effect-
  // free signal that a tick happened.
  triggers.upsert(heartbeatTrigger({ config: { intervalMinutes: 5 } }));
  const harness = createFakeHarness({ script: textResultScript('ok') });
  const runner = createTriggerRunner({
    dataDir,
    triggers,
    runTurn,
    harness,
    harnessName: 'fake',
    cwd,
    now: () => Date.now(),
    log: (message) => logMessages.push(message),
    tickMs: 1000,
  });

  runner.start();
  vi.advanceTimersByTime(1000);
  const afterOneTick = logMessages.length;
  expect(afterOneTick).toBeGreaterThan(0);
  expect(logMessages.some((m) => m.includes('checklist not found'))).toBe(true);

  runner.stop();
  vi.advanceTimersByTime(10_000);
  expect(logMessages.length).toBe(afterOneTick);
});

test('start() is idempotent (no duplicate timers) and stop() is idempotent', () => {
  vi.useFakeTimers();
  const logMessages = [];
  const triggers = openTriggers(dataDir);
  triggers.upsert(heartbeatTrigger({ config: { intervalMinutes: 5 } }));
  const harness = createFakeHarness({ script: textResultScript('ok') });
  const runner = createTriggerRunner({
    dataDir,
    triggers,
    runTurn,
    harness,
    harnessName: 'fake',
    cwd,
    now: () => Date.now(),
    log: (message) => logMessages.push(message),
    tickMs: 1000,
  });

  runner.start();
  runner.start(); // second call must not add a second timer
  vi.advanceTimersByTime(1000);
  const afterOneTick = logMessages.length;
  expect(afterOneTick).toBe(1);

  runner.stop();
  runner.stop(); // must not throw
});
