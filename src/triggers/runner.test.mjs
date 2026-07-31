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
import { MAX_TRIGGER_TURNS_PER_HOUR, MAX_CONCURRENT_TRIGGER_TURNS } from './limits.mjs';
import { createFakeHarness } from '../harness/fake.mjs';
import { buildArgs } from '../harness/claude-code.mjs';
import { createTurnClocks, IDLE_MS, TOOL_LEASE_MS, ACTIVE_TOTAL_MS, ABSOLUTE_MS } from '../harness/timeout.mjs';

let dataDir;
let cwd;

beforeEach(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kaprek-triggers-runner-test-'));
  cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'kaprek-triggers-runner-workspace-'));
});

afterEach(() => {
  vi.restoreAllMocks();
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

/**
 * The app registry the tests pretend is installed: `notes` owns
 * `notes.<action>`, `other-app` owns its own. Passed both to openTriggers
 * (an appScope may only name an installed app) and to the runner (the notify
 * policy asks which app REALLY provides a tool). A tool nobody owns resolves
 * to null, exactly like the server's resolver would answer for it.
 */
const TEST_APP_IDS = new Set(['notes', 'other-app']);
const TEST_TOOL_OWNERS = new Map([
  ['notes.write', 'notes'],
  ['notes.read', 'notes'],
  ['other-app.write', 'other-app'],
]);
const resolveTestToolApp = (toolId) => TEST_TOOL_OWNERS.get(toolId) ?? null;

function makeRunner({ trigger, script, makeUiApprovalHandler, now = () => Date.now(), log = () => {}, wrapHarness, ...rest } = {}) {
  const triggers = openTriggers(dataDir, { knownAppIds: TEST_APP_IDS, log: () => {} });
  if (trigger) triggers.upsert(trigger);
  const harness = createFakeHarness({ script: script ?? textResultScript('ok') });
  const runner = createTriggerRunner({
    dataDir,
    triggers,
    runTurn,
    // `wrapHarness` lets a test see the options the runner hands to
    // startTurn() (the timeout budgets, which no normalized event carries)
    // while still playing back the same fake script.
    harness: wrapHarness ? wrapHarness(harness) : harness,
    harnessName: 'fake',
    cwd,
    now,
    log,
    makeUiApprovalHandler,
    resolveToolApp: resolveTestToolApp,
    ...rest,
  });
  return { runner, triggers, harness };
}

function fileWatchTrigger(overrides = {}) {
  return {
    id: 'watch-1',
    type: 'file-watch',
    config: { path: 'inbox', debounceMs: 500 },
    promptTemplate: 'Handle these files:\n{{files}}',
    appScope: [],
    enabled: true,
    ...overrides,
  };
}

function clipboardTrigger(overrides = {}) {
  return {
    id: 'clip-1',
    type: 'clipboard',
    config: { pollMs: 1000, matchPattern: 'https?://' },
    promptTemplate: 'Look at this:\n{{clipboard}}',
    appScope: [],
    enabled: true,
    ...overrides,
  };
}

function savedPromptTrigger(overrides = {}) {
  return {
    id: 'saved-1',
    type: 'saved-prompt',
    config: {},
    promptTemplate: 'Write the weekly report.',
    appScope: [],
    enabled: true,
    ...overrides,
  };
}

/**
 * A stand-in for one fs.watch() watcher: captures the listener so a test can
 * emit exactly the events a real watcher would (including a `null` filename
 * and an 'error'), and records whether close() was called. No real file system
 * event, no waiting on the OS.
 */
function createFakeWatchFactory() {
  const watchers = [];
  const factory = (absPath, options, listener) => {
    const handlers = new Map();
    const watcher = {
      absPath,
      options,
      closed: false,
      emitChange: (eventType, filename) => listener(eventType, filename),
      emitError: (err) => handlers.get('error')?.(err),
      on: (event, handler) => {
        handlers.set(event, handler);
        return watcher;
      },
      close: () => {
        watcher.closed = true;
      },
    };
    watchers.push(watcher);
    return watcher;
  };
  factory.watchers = watchers;
  factory.last = () => watchers[watchers.length - 1];
  return factory;
}

/** A clipboard reader seam whose return value a test sets per poll. Records how often it was actually asked — a trigger that must not read the clipboard has to leave this at 0. */
function createFakeClipboardReader(initial = '') {
  const reader = async () => {
    reader.reads += 1;
    if (reader.failWith) throw reader.failWith;
    return reader.value;
  };
  reader.value = initial;
  reader.reads = 0;
  reader.failWith = null;
  return reader;
}

/** Lets pending promise callbacks run without advancing any clock — for the async poller, whose fire path awaits a real turn. */
async function flushMicrotasks(times = 20) {
  for (let i = 0; i < times; i += 1) await Promise.resolve();
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

// The unattended-escalation gate (codex-tag3.md F6): a question/review turn
// nobody can answer must not start. `hasApprovalClient` is the server's count
// of open SSE streams; these tests drive it directly.
const allowingApprovalHandler = () => async () => ({ behavior: 'allow' });

test('a scheduled question/review trigger does NOT fire while no client could be shown its approval', async () => {
  const { runner } = makeRunner({
    trigger: scheduleTrigger({ config: { everyMinutes: 5 }, escalation: 'review' }),
    makeUiApprovalHandler: allowingApprovalHandler,
    hasApprovalClient: () => false,
  });

  const result = await runner.fireTrigger('schedule-1', { cause: { origin: 'schedule' } });
  expect(result.fired).toBe(false);
  expect(result.reason).toBe('needs an open UI to ask for approval');
});

test('the same trigger fires from a tick once a client is streaming', async () => {
  let clientConnected = false;
  const { runner } = makeRunner({
    trigger: scheduleTrigger({ config: { everyMinutes: 5 }, escalation: 'review' }),
    makeUiApprovalHandler: allowingApprovalHandler,
    hasApprovalClient: () => clientConnected,
  });

  expect((await runner.fireTrigger('schedule-1', { cause: { origin: 'schedule' } })).fired).toBe(false);
  clientConnected = true;
  expect((await runner.fireTrigger('schedule-1', { cause: { origin: 'schedule' } })).fired).toBe(true);
});

test('a MANUAL fire of a question/review trigger is never gated — someone is demonstrably there', async () => {
  const { runner } = makeRunner({
    trigger: scheduleTrigger({ config: { everyMinutes: 5 }, escalation: 'review' }),
    makeUiApprovalHandler: allowingApprovalHandler,
    hasApprovalClient: () => false,
  });

  const result = await runner.fireTrigger('schedule-1', { cause: { origin: 'user' } });
  expect(result.fired).toBe(true);
});

test('a notify trigger fires unattended regardless — its policy decider needs no human at all', async () => {
  const { runner } = makeRunner({
    trigger: scheduleTrigger({ config: { everyMinutes: 5 }, escalation: 'notify' }),
    hasApprovalClient: () => false,
  });
  expect((await runner.fireTrigger('schedule-1', { cause: { origin: 'schedule' } })).fired).toBe(true);
});

test('approvalCapability reports the unattended gate as blocked, and clears it once a client connects', () => {
  let clientConnected = false;
  const trigger = scheduleTrigger({ config: { everyMinutes: 5 }, escalation: 'question' });
  const { runner, triggers } = makeRunner({
    trigger,
    makeUiApprovalHandler: allowingApprovalHandler,
    hasApprovalClient: () => clientConnected,
  });
  const stored = triggers.list()[0];

  expect(runner.approvalCapability(stored, { unattended: true })).toEqual({
    approvalPath: 'ui',
    blocked: 'needs an open UI to ask for approval',
  });
  // The same trigger IS fireable by hand right now, so the attended answer
  // must differ — GET /api/triggers deliberately reports the unattended one.
  expect(runner.approvalCapability(stored, { unattended: false })).toEqual({ approvalPath: 'ui', blocked: null });

  clientConnected = true;
  expect(runner.approvalCapability(stored, { unattended: true })).toEqual({ approvalPath: 'ui', blocked: null });
});

test('a runner built without hasApprovalClient refuses unattended question/review turns (fail-closed default)', async () => {
  const { runner } = makeRunner({
    trigger: scheduleTrigger({ config: { everyMinutes: 5 }, escalation: 'question' }),
    makeUiApprovalHandler: allowingApprovalHandler,
  });
  const result = await runner.fireTrigger('schedule-1', { cause: { origin: 'schedule' } });
  expect(result.fired).toBe(false);
  expect(result.reason).toBe('needs an open UI to ask for approval');
});

// ------------------------------------------------------------- persistent approval inbox (task 3)
//
// With a store wired in, the question outlives the connection that would have
// carried it: it is written down and can be LOOKED UP later (GET
// /api/approvals). That, and only that, is what makes an unattended
// question/review turn honest to start. Every test above this block runs
// WITHOUT a store and must keep describing the old behaviour exactly.

/** A store double with the four methods runner/server use. Records puts so a test can see what was written down. */
function fakeApprovalStore() {
  const puts = [];
  return {
    puts,
    put: async (entry) => {
      puts.push(entry);
      return entry;
    },
    decide: async () => ({}),
    listPending: async () => puts,
    get: async () => null,
  };
}

test('a scheduled question trigger DOES fire with an approval store, with no client streaming at all', async () => {
  const { runner } = makeRunner({
    trigger: scheduleTrigger({ config: { everyMinutes: 5 }, escalation: 'question' }),
    makeUiApprovalHandler: allowingApprovalHandler,
    hasApprovalClient: () => false,
    approvalStore: fakeApprovalStore(),
  });

  const result = await runner.fireTrigger('schedule-1', { cause: { origin: 'schedule' } });
  expect(result.fired).toBe(true);
});

test('approvalCapability reports the inbox path once a store is wired, attended or not', () => {
  const trigger = scheduleTrigger({ config: { everyMinutes: 5 }, escalation: 'question' });
  const { runner, triggers } = makeRunner({
    trigger,
    makeUiApprovalHandler: allowingApprovalHandler,
    hasApprovalClient: () => false,
    approvalStore: fakeApprovalStore(),
  });
  const stored = triggers.list()[0];

  expect(runner.approvalCapability(stored, { unattended: true })).toEqual({ approvalPath: 'inbox', blocked: null });
  expect(runner.approvalCapability(stored, { unattended: false })).toEqual({ approvalPath: 'inbox', blocked: null });
});

test('a runner WITHOUT a store still refuses an unattended question turn — and starts nothing at all', async () => {
  // The fail-closed default, restated as the inbox's own boundary: the store
  // is what lifts the gate, so a runner that has none must behave exactly as
  // it did before this feature existed. Stronger than the reason string
  // alone — it also pins that NOTHING ran: no startTurn, no chat, no bill.
  const started = [];
  const { runner } = makeRunner({
    trigger: scheduleTrigger({ config: { everyMinutes: 5 }, escalation: 'question' }),
    makeUiApprovalHandler: allowingApprovalHandler,
    hasApprovalClient: () => false,
    wrapHarness: (harness) => ({
      startTurn: (options) => {
        started.push(options);
        return harness.startTurn(options);
      },
    }),
  });

  const result = await runner.fireTrigger('schedule-1', { cause: { origin: 'schedule' } });
  expect(result).toEqual({ fired: false, reason: 'needs an open UI to ask for approval' });
  expect(started).toEqual([]);
  expect(openChats(dataDir).list()).toEqual([]);
});

test('an inbox store does NOT override the missing-handler refusal — with nothing to raise the question with, writing it down changes nothing', async () => {
  const { runner } = makeRunner({
    trigger: scheduleTrigger({ config: { everyMinutes: 5 }, escalation: 'review' }),
    approvalStore: fakeApprovalStore(),
  });
  const result = await runner.fireTrigger('schedule-1', { cause: { origin: 'schedule' } });
  expect(result.fired).toBe(false);
  expect(result.reason).toBe('no UI approval handler configured for this escalation level');
});

test('a runner WITHOUT a store still refuses an unattended question turn — and starts nothing at all', async () => {
  // The fail-closed default, restated as the inbox's own boundary: the store
  // is what lifts the gate, so a runner that has none must behave exactly as
  // it did before this feature existed. Stronger than the reason string
  // alone — it also pins that NOTHING ran: no startTurn, no chat, no bill.
  const started = [];
  const { runner } = makeRunner({
    trigger: scheduleTrigger({ config: { everyMinutes: 5 }, escalation: 'question' }),
    makeUiApprovalHandler: allowingApprovalHandler,
    hasApprovalClient: () => false,
    wrapHarness: (harness) => ({
      startTurn: (options) => {
        started.push(options);
        return harness.startTurn(options);
      },
    }),
  });

  const result = await runner.fireTrigger('schedule-1', { cause: { origin: 'schedule' } });
  expect(result).toEqual({ fired: false, reason: 'needs an open UI to ask for approval' });
  expect(started).toEqual([]);
  expect(openChats(dataDir).list()).toEqual([]);
});

test('an inbox store does NOT override the missing-handler refusal — with nothing to raise the question with, writing it down changes nothing', async () => {
  const { runner } = makeRunner({
    trigger: scheduleTrigger({ config: { everyMinutes: 5 }, escalation: 'review' }),
    approvalStore: fakeApprovalStore(),
  });
  const result = await runner.fireTrigger('schedule-1', { cause: { origin: 'schedule' } });
  expect(result.fired).toBe(false);
  expect(result.reason).toBe('no UI approval handler configured for this escalation level');
});

test('a runner WITHOUT a store still refuses an unattended question turn — and starts nothing at all', async () => {
  // The fail-closed default, restated as the inbox's own boundary: the store
  // is what lifts the gate, so a runner that has none must behave exactly as
  // it did before this feature existed. Stronger than the reason string
  // alone — it also pins that NOTHING ran: no startTurn, no chat, no bill.
  const started = [];
  const { runner } = makeRunner({
    trigger: scheduleTrigger({ config: { everyMinutes: 5 }, escalation: 'question' }),
    makeUiApprovalHandler: allowingApprovalHandler,
    hasApprovalClient: () => false,
    wrapHarness: (harness) => ({
      startTurn: (options) => {
        started.push(options);
        return harness.startTurn(options);
      },
    }),
  });

  const result = await runner.fireTrigger('schedule-1', { cause: { origin: 'schedule' } });
  expect(result).toEqual({ fired: false, reason: 'needs an open UI to ask for approval' });
  expect(started).toEqual([]);
  expect(openChats(dataDir).list()).toEqual([]);
});

test('an inbox store does NOT override the missing-handler refusal — with nothing to raise the question with, writing it down changes nothing', async () => {
  const { runner } = makeRunner({
    trigger: scheduleTrigger({ config: { everyMinutes: 5 }, escalation: 'review' }),
    approvalStore: fakeApprovalStore(),
  });
  const result = await runner.fireTrigger('schedule-1', { cause: { origin: 'schedule' } });
  expect(result.fired).toBe(false);
  expect(result.reason).toBe('no UI approval handler configured for this escalation level');
});

test('a runner WITHOUT a store still refuses an unattended question turn — and starts nothing at all', async () => {
  // The fail-closed default, restated as the inbox's own boundary: the store
  // is what lifts the gate, so a runner that has none must behave exactly as
  // it did before this feature existed. Stronger than the reason string
  // alone — it also pins that NOTHING ran: no startTurn, no chat, no bill.
  const started = [];
  const { runner } = makeRunner({
    trigger: scheduleTrigger({ config: { everyMinutes: 5 }, escalation: 'question' }),
    makeUiApprovalHandler: allowingApprovalHandler,
    hasApprovalClient: () => false,
    wrapHarness: (harness) => ({
      startTurn: (options) => {
        started.push(options);
        return harness.startTurn(options);
      },
    }),
  });

  const result = await runner.fireTrigger('schedule-1', { cause: { origin: 'schedule' } });
  expect(result).toEqual({ fired: false, reason: 'needs an open UI to ask for approval' });
  expect(started).toEqual([]);
  expect(openChats(dataDir).list()).toEqual([]);
});

test('an inbox store does NOT override the missing-handler refusal — with nothing to raise the question with, writing it down changes nothing', async () => {
  const { runner } = makeRunner({
    trigger: scheduleTrigger({ config: { everyMinutes: 5 }, escalation: 'review' }),
    approvalStore: fakeApprovalStore(),
  });
  const result = await runner.fireTrigger('schedule-1', { cause: { origin: 'schedule' } });
  expect(result.fired).toBe(false);
  expect(result.reason).toBe('no UI approval handler configured for this escalation level');
});

test('an unattended turn runs under the ordinary wall clock again - nothing is stretched around a wait', () => {
  // The park model needed absoluteTimeoutMs sized to outlast an eight-hour
  // approval wait. There is no wait any more, so the budget is the harness's
  // own: idle, tool-lease, active-total and a one-hour wall clock, exactly as
  // for a turn that never asks anything.
  const clock = fakeClock();
  const startedAt = clock.now();
  const clocks = createTurnClocks({
    idleMs: IDLE_MS,
    toolLeaseMs: TOOL_LEASE_MS,
    activeTotalMs: ACTIVE_TOTAL_MS,
    absoluteMs: ABSOLUTE_MS,
    nowFn: clock.now,
  });
  clocks.onProgress('init');

  // Twenty minutes of ordinary work: well inside every budget.
  for (let minute = 0; minute < 20; minute += 1) {
    clocks.onProgress('assistant-message');
    clock.advance(60_000);
    expect(clocks.check()).toBeNull();
  }
  // And the ordinary budgets still end a turn that overruns them. Kept busy
  // right up to the line, so it is the turn's own active budget that reports
  // it and not an idle gap - the point being that these are the SAME limits
  // any other turn runs under, with nothing stretched around a wait.
  while (clock.now() < startedAt + ACTIVE_TOTAL_MS) {
    clocks.onProgress('assistant-message');
    clock.advance(60_000);
  }
  expect(clocks.check()).toMatchObject({ clock: 'active-total' });
});

test('a trigger turn passes the ordinary wall clock explicitly, store or no store', async () => {
  // Explicit rather than implicit, because the interactive cap measures a
  // published deadline against this exact number.
  for (const approvalStore of [null, fakeApprovalStore()]) {
    const seen = [];
    const { runner } = makeRunner({
      trigger: scheduleTrigger({ config: { everyMinutes: 5 }, escalation: 'question' }),
      makeUiApprovalHandler: allowingApprovalHandler,
      hasApprovalClient: () => true,
      approvalStore,
      wrapHarness: (harness) => ({
        startTurn: (options) => {
          seen.push(options);
          return harness.startTurn(options);
        },
      }),
    });

    expect((await runner.fireTrigger('schedule-1', { cause: { origin: 'user' } })).fired).toBe(true);
    expect(seen[0].absoluteTimeoutMs).toBe(ABSOLUTE_MS);
    fs.rmSync(dataDir, { recursive: true, force: true });
    fs.mkdirSync(dataDir, { recursive: true });
  }
});

/** A hand-driven time source for the clock arithmetic below — no timers, no waiting. */
function fakeClock(start = 1_000_000) {
  let current = start;
  return { now: () => current, advance: (ms) => { current += ms; } };
}

function inboxTurnClocks(absoluteMs, nowFn) {
  return createTurnClocks({ idleMs: IDLE_MS, toolLeaseMs: TOOL_LEASE_MS, activeTotalMs: ACTIVE_TOTAL_MS, absoluteMs, nowFn });
}

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

// ------------------------------------------------------------- appScope is policy input, never a CLI flag

/** A harness that records the options runTurn() hands it, around a normal fake turn. */
function recordingHarness(calls) {
  const inner = createFakeHarness({ script: textResultScript('ok') });
  return {
    startTurn: (opts) => {
      calls.push(opts);
      return inner.startTurn(opts);
    },
  };
}

test('appScope: [] passes an empty allowedTools list to the harness, never "all tools"', async () => {
  const calls = [];
  const { runner } = makeRunner({ trigger: scheduleTrigger({ config: { everyMinutes: 5 }, appScope: [] }), harness: recordingHarness(calls) });

  await runner.fireTrigger('schedule-1', { cause: { origin: 'user' } });
  expect(calls).toHaveLength(1);
  expect(calls[0].allowedTools).toEqual([]);
});

test("appScope: ['notes'] is NOT passed as allowedTools — a scope authorizes our own policy, never the CLI", async () => {
  const calls = [];
  const { runner } = makeRunner({ trigger: scheduleTrigger({ config: { everyMinutes: 5 }, appScope: ['notes'] }), harness: recordingHarness(calls) });

  await runner.fireTrigger('schedule-1', { cause: { origin: 'user' } });
  // A name in --allowedTools is pre-allowed by the CLI and never reaches
  // can_use_tool, so it would skip the approval handler this whole layer is
  // built on (adversarial review Tag 3, Grok P0 / Codex F1).
  expect(calls[0].allowedTools).toEqual([]);
});

test('a trigger turn never passes --allowedTools to the real CLI argv, whatever its appScope says', async () => {
  const calls = [];
  const { runner } = makeRunner({ trigger: scheduleTrigger({ config: { everyMinutes: 5 }, appScope: ['notes'] }), harness: recordingHarness(calls) });
  await runner.fireTrigger('schedule-1', { cause: { origin: 'user' } });

  // The runner's contract is only half the guarantee — this is the other
  // half: claude-code.mjs turns exactly this options object into argv.
  const args = buildArgs({
    sessionId: null,
    mcpConfigPath: '/tmp/mcp.json',
    permissionMode: 'default',
    allowedTools: calls[0].allowedTools,
    settingsPath: '/tmp/settings.json',
    hasApprovalHandler: true,
  });
  expect(args).not.toContain('--allowedTools');
  expect(args).toContain('--permission-prompt-tool');
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

test('notify: the underscore-normalized tool name a real CLI reports is allowed too', async () => {
  // A live claude 2.1.220 run reports our advertised `notes.write` as
  // `mcp__kaprek-apps__notes_write` — the CLI swaps the dot for an
  // underscore. Caught by the day-3 live acceptance run: the dot-only
  // parser denied an in-scope app tool.
  const script = [
    { type: 'init', sessionId: 's1', tools: [], model: 'm', permissionMode: 'default' },
    { approval: { toolName: 'mcp__kaprek-apps__notes_write', input: { title: 'x' } } },
    { type: 'text', text: 'done' },
    { type: 'result', sessionId: 's1', costUsd: 0, usage: {}, isError: false },
  ];
  const { runner, harness } = makeRunner({
    trigger: scheduleTrigger({ config: { everyMinutes: 5 }, escalation: 'notify', appScope: ['notes'] }),
    script,
  });

  const result = await runner.fireTrigger('schedule-1', { cause: { origin: 'user' } });
  expect(result.fired).toBe(true);
  expect(harness.approvalLog[0].decision).toEqual({ behavior: 'allow' });
});

test('notify: a tool whose NAMESPACE looks in-scope but whose owning app is not is denied — ownership comes from the manifest', async () => {
  // App "evil" declaring `notes.exfiltrate` must not inherit what `notes` was
  // granted (adversarial review Tag 3, Codex F1). The resolver here answers
  // like the server's does: from the loaded manifests.
  const script = [
    { type: 'init', sessionId: 's1', tools: [], model: 'm', permissionMode: 'default' },
    { approval: { toolName: 'mcp__kaprek-apps__notes_exfiltrate', input: {} } },
    { type: 'text', text: 'done' },
    { type: 'result', sessionId: 's1', costUsd: 0, usage: {}, isError: false },
  ];
  const { runner, harness } = makeRunner({
    trigger: scheduleTrigger({ config: { everyMinutes: 5 }, escalation: 'notify', appScope: ['notes'] }),
    script,
    resolveToolApp: (toolId) => (toolId === 'notes.exfiltrate' ? 'evil' : resolveTestToolApp(toolId)),
  });

  const result = await runner.fireTrigger('schedule-1', { cause: { origin: 'user' } });
  expect(result.fired).toBe(true);
  expect(harness.approvalLog[0].decision).toEqual({ behavior: 'deny', message: 'not permitted for notify trigger' });
});

test('notify: a tool no app owns (unknown, or contested between two apps) is denied rather than guessed at', async () => {
  const script = [
    { type: 'init', sessionId: 's1', tools: [], model: 'm', permissionMode: 'default' },
    { approval: { toolName: 'mcp__kaprek-apps__notes_write', input: {} } },
    { type: 'text', text: 'done' },
    { type: 'result', sessionId: 's1', costUsd: 0, usage: {}, isError: false },
  ];
  const { runner, harness } = makeRunner({
    trigger: scheduleTrigger({ config: { everyMinutes: 5 }, escalation: 'notify', appScope: ['notes'] }),
    script,
    resolveToolApp: () => null, // exactly what resolveToolOwnership returns for a contested id
  });

  await runner.fireTrigger('schedule-1', { cause: { origin: 'user' } });
  expect(harness.approvalLog[0].decision.behavior).toBe('deny');
});

test('notify: an underscore-normalized tool for an app NOT in appScope stays denied', async () => {
  const script = [
    { type: 'init', sessionId: 's1', tools: [], model: 'm', permissionMode: 'default' },
    { approval: { toolName: 'mcp__kaprek-apps__otherapp_write', input: {} } },
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

test('notify: ToolSearch is allowed unconditionally — no path to check, and it has no appScope of its own', async () => {
  const script = [
    { type: 'init', sessionId: 's1', tools: [], model: 'm', permissionMode: 'default' },
    { approval: { toolName: 'ToolSearch', input: { query: 'notes' } } },
    { type: 'text', text: 'done' },
    { type: 'result', sessionId: 's1', costUsd: 0, usage: {}, isError: false },
  ];
  const { runner, harness } = makeRunner({ trigger: scheduleTrigger({ config: { everyMinutes: 5 }, escalation: 'notify' }), script });

  const result = await runner.fireTrigger('schedule-1', { cause: { origin: 'user' } });
  expect(result.fired).toBe(true);
  expect(harness.approvalLog[0].decision).toEqual({ behavior: 'allow' });
});

test('notify: Read inside the workspace is allowed', async () => {
  fs.writeFileSync(path.join(cwd, 'notes.md'), 'hi');
  const script = [
    { type: 'init', sessionId: 's1', tools: [], model: 'm', permissionMode: 'default' },
    { approval: { toolName: 'Read', input: { file_path: path.join(cwd, 'notes.md') } } },
    { type: 'text', text: 'done' },
    { type: 'result', sessionId: 's1', costUsd: 0, usage: {}, isError: false },
  ];
  const { runner, harness } = makeRunner({ trigger: scheduleTrigger({ config: { everyMinutes: 5 }, escalation: 'notify' }), script });

  const result = await runner.fireTrigger('schedule-1', { cause: { origin: 'user' } });
  expect(result.fired).toBe(true);
  expect(harness.approvalLog[0].decision).toEqual({ behavior: 'allow' });
});

test('notify: Read outside the workspace is denied with "outside the workspace"', async () => {
  const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kaprek-triggers-runner-outside-'));
  try {
    fs.writeFileSync(path.join(outsideDir, 'secret.txt'), 'top secret');
    const script = [
      { type: 'init', sessionId: 's1', tools: [], model: 'm', permissionMode: 'default' },
      { approval: { toolName: 'Read', input: { file_path: path.join(outsideDir, 'secret.txt') } } },
      { type: 'text', text: 'done' },
      { type: 'result', sessionId: 's1', costUsd: 0, usage: {}, isError: false },
    ];
    const { runner, harness } = makeRunner({ trigger: scheduleTrigger({ config: { everyMinutes: 5 }, escalation: 'notify' }), script });

    const result = await runner.fireTrigger('schedule-1', { cause: { origin: 'user' } });
    expect(result.fired).toBe(true);
    expect(harness.approvalLog[0].decision).toEqual({ behavior: 'deny', message: 'outside the workspace' });
  } finally {
    fs.rmSync(outsideDir, { recursive: true, force: true });
  }
});

test('notify: Read with no path in the input is denied — fail-closed, not a guess', async () => {
  const script = [
    { type: 'init', sessionId: 's1', tools: [], model: 'm', permissionMode: 'default' },
    { approval: { toolName: 'Read', input: {} } },
    { type: 'text', text: 'done' },
    { type: 'result', sessionId: 's1', costUsd: 0, usage: {}, isError: false },
  ];
  const { runner, harness } = makeRunner({ trigger: scheduleTrigger({ config: { everyMinutes: 5 }, escalation: 'notify' }), script });

  const result = await runner.fireTrigger('schedule-1', { cause: { origin: 'user' } });
  expect(result.fired).toBe(true);
  expect(harness.approvalLog[0].decision.behavior).toBe('deny');
});

test('notify: Glob is path-checked via its `path` field, same as Read', async () => {
  fs.mkdirSync(path.join(cwd, 'sub'), { recursive: true });
  const insideScript = [
    { type: 'init', sessionId: 's1', tools: [], model: 'm', permissionMode: 'default' },
    { approval: { toolName: 'Glob', input: { pattern: '*.md', path: path.join(cwd, 'sub') } } },
    { type: 'text', text: 'done' },
    { type: 'result', sessionId: 's1', costUsd: 0, usage: {}, isError: false },
  ];
  // Distinct ids: the everyMinutes claim file would otherwise make the
  // second fireTrigger() call in the same window a no-op rejection instead
  // of actually running a second turn (see the schedule-slot idempotency
  // tests above).
  const inside = makeRunner({ trigger: scheduleTrigger({ id: 'glob-inside', config: { everyMinutes: 5 }, escalation: 'notify' }), script: insideScript });
  await inside.runner.fireTrigger('glob-inside', { cause: { origin: 'user' } });
  expect(inside.harness.approvalLog[0].decision).toEqual({ behavior: 'allow' });

  const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kaprek-triggers-runner-outside-'));
  try {
    const outsideScript = [
      { type: 'init', sessionId: 's1', tools: [], model: 'm', permissionMode: 'default' },
      { approval: { toolName: 'Glob', input: { pattern: '*.md', path: outsideDir } } },
      { type: 'text', text: 'done' },
      { type: 'result', sessionId: 's1', costUsd: 0, usage: {}, isError: false },
    ];
    const outside = makeRunner({ trigger: scheduleTrigger({ id: 'glob-outside', config: { everyMinutes: 5 }, escalation: 'notify' }), script: outsideScript });
    await outside.runner.fireTrigger('glob-outside', { cause: { origin: 'user' } });
    expect(outside.harness.approvalLog[0].decision).toEqual({ behavior: 'deny', message: 'outside the workspace' });
  } finally {
    fs.rmSync(outsideDir, { recursive: true, force: true });
  }
});

test('notify: Grep is path-checked via its `path` field, same as Read/Glob', async () => {
  fs.writeFileSync(path.join(cwd, 'notes.md'), 'hi');
  const script = [
    { type: 'init', sessionId: 's1', tools: [], model: 'm', permissionMode: 'default' },
    { approval: { toolName: 'Grep', input: { pattern: 'hi', path: path.join(cwd, 'notes.md') } } },
    { type: 'text', text: 'done' },
    { type: 'result', sessionId: 's1', costUsd: 0, usage: {}, isError: false },
  ];
  const { runner, harness } = makeRunner({ trigger: scheduleTrigger({ config: { everyMinutes: 5 }, escalation: 'notify' }), script });

  const result = await runner.fireTrigger('schedule-1', { cause: { origin: 'user' } });
  expect(result.fired).toBe(true);
  expect(harness.approvalLog[0].decision).toEqual({ behavior: 'allow' });
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

// ------------------------------------------------------------- file-watch

/** The single user-prompt text of the one and only chat a test expects to exist. Fails loudly if there is not exactly one. */
function soleTurnPrompt() {
  const chats = openChats(dataDir).list();
  expect(chats).toHaveLength(1);
  const events = openChats(dataDir).events(chats[0].id);
  return events.find((e) => e.kind === 'user').text;
}

function makeInbox(...files) {
  fs.mkdirSync(path.join(cwd, 'inbox'), { recursive: true });
  for (const file of files) fs.writeFileSync(path.join(cwd, 'inbox', file), 'x', 'utf8');
}

test('file-watch: every event of one debounce window collapses into exactly ONE turn, with a deduped, sorted, workspace-relative {{files}} list', async () => {
  vi.useFakeTimers();
  makeInbox('b.md', 'a.md');
  const watchFactory = createFakeWatchFactory();
  const { runner } = makeRunner({ trigger: fileWatchTrigger(), createWatcher: watchFactory });
  runner.start();

  const watcher = watchFactory.last();
  expect(watcher.options).toMatchObject({ recursive: true, persistent: false });
  // Windows reports the same save several times — the debounce is what makes
  // that one turn instead of three.
  watcher.emitChange('change', 'b.md');
  watcher.emitChange('change', 'b.md');
  watcher.emitChange('change', 'a.md');
  expect(openChats(dataDir).list()).toHaveLength(0); // nothing yet: still inside the window

  await vi.advanceTimersByTimeAsync(500);

  const prompt = soleTurnPrompt();
  expect(prompt).toContain('inbox/a.md\ninbox/b.md');
  expect(prompt).toContain('2 watched path(s) changed');
  runner.stop();
});

test('file-watch: an event with filename null is discarded instead of guessing a path — no turn at all', async () => {
  vi.useFakeTimers();
  makeInbox('a.md');
  const logMessages = [];
  const watchFactory = createFakeWatchFactory();
  const { runner } = makeRunner({ trigger: fileWatchTrigger(), createWatcher: watchFactory, log: (m) => logMessages.push(m) });
  runner.start();

  watchFactory.last().emitChange('change', null);
  await vi.advanceTimersByTimeAsync(2000);

  expect(openChats(dataDir).list()).toEqual([]);
  expect(logMessages.some((m) => m.includes('watch event without a filename'))).toBe(true);
  runner.stop();
});

test('file-watch: only the subscribed events fire — a "change" is ignored for an events:["unlink"] trigger', async () => {
  vi.useFakeTimers();
  makeInbox('a.md');
  const watchFactory = createFakeWatchFactory();
  const { runner } = makeRunner({ trigger: fileWatchTrigger({ config: { path: 'inbox', events: ['unlink'], debounceMs: 100 } }), createWatcher: watchFactory });
  runner.start();

  watchFactory.last().emitChange('change', 'a.md');
  await vi.advanceTimersByTimeAsync(500);
  expect(openChats(dataDir).list()).toEqual([]);

  // A 'rename' for a path that no longer exists IS an unlink, and does fire.
  fs.rmSync(path.join(cwd, 'inbox', 'a.md'));
  watchFactory.last().emitChange('rename', 'a.md');
  await vi.advanceTimersByTimeAsync(500);
  expect(soleTurnPrompt()).toContain('inbox/a.md');
  runner.stop();
});

test('file-watch: the {{files}} list is capped at 50 paths, and the prompt says the list is incomplete', async () => {
  vi.useFakeTimers();
  fs.mkdirSync(path.join(cwd, 'inbox'), { recursive: true });
  const watchFactory = createFakeWatchFactory();
  const { runner } = makeRunner({ trigger: fileWatchTrigger(), createWatcher: watchFactory });
  runner.start();

  for (let i = 0; i < 60; i += 1) watchFactory.last().emitChange('change', `f${String(i).padStart(3, '0')}.md`);
  await vi.advanceTimersByTimeAsync(500);

  // The prompt carries the list twice (the template's own {{files}} and the
  // generated context block), so count DISTINCT paths.
  const prompt = soleTurnPrompt();
  const listed = new Set(prompt.split('\n').filter((line) => /^inbox\/f\d{3}\.md$/.test(line)));
  expect(listed.size).toBe(50);
  // Capped where the paths are collected, so the ones arriving after the cap
  // is reached are the ones missing.
  expect(listed.has('inbox/f049.md')).toBe(true);
  expect(listed.has('inbox/f050.md')).toBe(false);
  expect(prompt).toContain('this list is incomplete');
  runner.stop();
});

test('file-watch: maxDepth drops events below the configured depth', async () => {
  vi.useFakeTimers();
  fs.mkdirSync(path.join(cwd, 'inbox', 'deep'), { recursive: true });
  const watchFactory = createFakeWatchFactory();
  const { runner } = makeRunner({ trigger: fileWatchTrigger({ config: { path: 'inbox', debounceMs: 100, maxDepth: 1 } }), createWatcher: watchFactory });
  runner.start();

  watchFactory.last().emitChange('change', path.join('deep', 'nested.md'));
  await vi.advanceTimersByTimeAsync(500);
  expect(openChats(dataDir).list()).toEqual([]);

  watchFactory.last().emitChange('change', 'top.md');
  await vi.advanceTimersByTimeAsync(500);
  expect(soleTurnPrompt()).toContain('inbox/top.md');
  runner.stop();
});

/** A harness whose turn blocks until release() is called — keeps a trigger observably "in flight" without any clock. */
function gatedHarness() {
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  return {
    release: () => release(),
    async startTurn({ onEvent } = {}) {
      await gate;
      onEvent?.({ type: 'text', text: 'done' });
      onEvent?.({ type: 'result', sessionId: 's1', costUsd: 0, usage: {}, isError: false });
      return { sessionId: 's1', costUsd: 0, usage: {}, stopReason: 'result', error: null };
    },
  };
}

test('file-watch: a change arriving while this trigger\'s own turn runs is DISCARDED, not buffered for a second turn', async () => {
  vi.useFakeTimers();
  makeInbox('a.md', 'b.md');
  const logMessages = [];
  const watchFactory = createFakeWatchFactory();
  const harness = gatedHarness();
  const triggers = openTriggers(dataDir);
  triggers.upsert(fileWatchTrigger({ config: { path: 'inbox', debounceMs: 100 } }));
  const runner = createTriggerRunner({
    dataDir,
    triggers,
    runTurn,
    harness,
    harnessName: 'fake',
    cwd,
    now: () => Date.now(),
    log: (m) => logMessages.push(m),
    createWatcher: watchFactory,
  });
  runner.start();

  watchFactory.last().emitChange('change', 'a.md');
  await vi.advanceTimersByTimeAsync(100); // starts the turn; it now blocks on the gate
  expect(runner.isAnyTriggerRunning()).toBe(true);

  // This is the real loop: the turn itself writes into the watched folder.
  watchFactory.last().emitChange('change', 'b.md');
  await vi.advanceTimersByTimeAsync(1000);
  expect(logMessages.some((m) => m.includes('discarded (its own turn is still running)'))).toBe(true);

  harness.release();
  await flushMicrotasks(50);
  await vi.advanceTimersByTimeAsync(1000);

  // Exactly one turn, and b.md was never queued into a follow-up one.
  const prompt = soleTurnPrompt();
  expect(prompt).toContain('inbox/a.md');
  expect(prompt).not.toContain('inbox/b.md');
  runner.stop();
});

test('file-watch: a watcher error disables the trigger with a logged reason instead of going quiet', async () => {
  makeInbox('a.md');
  const logMessages = [];
  const watchFactory = createFakeWatchFactory();
  const { runner, triggers } = makeRunner({ trigger: fileWatchTrigger(), createWatcher: watchFactory, log: (m) => logMessages.push(m) });
  runner.start();

  const watcher = watchFactory.last();
  watcher.emitError(new Error('watch handle lost'));

  expect(triggers.get('watch-1').enabled).toBe(false);
  expect(watcher.closed).toBe(true);
  expect(logMessages.some((m) => m.includes('DISABLED itself') && m.includes('watch handle lost'))).toBe(true);
  runner.stop();
});

test('file-watch: a path that does not exist in the workspace disables the trigger at setup instead of pretending to watch', () => {
  const logMessages = [];
  const watchFactory = createFakeWatchFactory();
  const { runner, triggers } = makeRunner({ trigger: fileWatchTrigger({ config: { path: 'not-there' } }), createWatcher: watchFactory, log: (m) => logMessages.push(m) });
  runner.start();

  expect(watchFactory.watchers).toHaveLength(0);
  expect(triggers.get('watch-1').enabled).toBe(false);
  expect(logMessages.some((m) => m.includes('file-watch path unusable'))).toBe(true);
  runner.stop();
});

test('file-watch: a watched single file that is DELETED disables the trigger on the next tick (a silent watcher death is not silent)', async () => {
  vi.useFakeTimers();
  makeInbox('todo.md');
  const logMessages = [];
  const watchFactory = createFakeWatchFactory();
  const { runner, triggers } = makeRunner({
    trigger: fileWatchTrigger({ config: { path: 'inbox/todo.md', debounceMs: 100 } }),
    createWatcher: watchFactory,
    log: (m) => logMessages.push(m),
    tickMs: 1000,
  });
  runner.start();
  expect(watchFactory.watchers).toHaveLength(1);

  // fs.watch on a deleted single file stops delivering events on some
  // platforms WITHOUT an 'error' event — so nothing but the tick's own health
  // check can notice.
  fs.rmSync(path.join(cwd, 'inbox', 'todo.md'));
  await vi.advanceTimersByTimeAsync(1000);

  expect(triggers.get('watch-1').enabled).toBe(false);
  expect(logMessages.some((m) => m.includes('DISABLED itself') && m.includes('target no longer exists'))).toBe(true);
  runner.stop();
});

test('file-watch: a watched single file REPLACED by a rename (how editors save) gets a fresh watcher and keeps firing', async () => {
  vi.useFakeTimers();
  makeInbox('todo.md');
  const logMessages = [];
  const watchFactory = createFakeWatchFactory();
  const { runner, triggers } = makeRunner({
    trigger: fileWatchTrigger({ config: { path: 'inbox/todo.md', debounceMs: 100 } }),
    createWatcher: watchFactory,
    log: (m) => logMessages.push(m),
    tickMs: 1000,
  });
  runner.start();
  const firstWatcher = watchFactory.last();

  // The rename-over-a-temp-file dance: same path, different file object. The
  // old handle is dead, but the trigger's configuration is still perfectly
  // valid — so it must be re-watched, not disabled.
  fs.writeFileSync(path.join(cwd, 'inbox', '.todo.md.tmp'), 'new content', 'utf8');
  fs.renameSync(path.join(cwd, 'inbox', '.todo.md.tmp'), path.join(cwd, 'inbox', 'todo.md'));
  await vi.advanceTimersByTimeAsync(1000);

  expect(triggers.get('watch-1').enabled).toBe(true);
  expect(logMessages.some((m) => m.includes('watch target was replaced'))).toBe(true);
  expect(watchFactory.watchers).toHaveLength(2);
  expect(firstWatcher.closed).toBe(true);

  // And the NEW watcher actually drives turns.
  watchFactory.last().emitChange('change', 'todo.md');
  await vi.advanceTimersByTimeAsync(100);
  expect(soleTurnPrompt()).toContain('inbox/todo.md');
  runner.stop();
});

/**
 * A registry that hands out a trigger object the real one could never store.
 * openTriggers() normalizes every entry on load (see registry.mjs), so a
 * malformed config no longer reaches the runner through the FILE — this stub
 * is how the runner's own defensive checks stay tested anyway. They are the
 * second line of defense, for any registry instance that is not the
 * file-backed one.
 */
function stubTriggers(trigger) {
  const state = { ...trigger };
  return {
    list: () => [{ ...state }],
    get: (id) => (id === state.id ? { ...state } : null),
    setEnabled: (id, enabled) => {
      if (id !== state.id) return null;
      state.enabled = !!enabled;
      return { ...state };
    },
  };
}

/**
 * Makes fs.statSync fail for exactly one path, for the next `times` calls, with
 * `code` — everything else keeps the real implementation. That is how a
 * transient EBUSY (an editor's delete-then-rename caught mid-flight, an SMB
 * share blinking) is reproduced without waiting for one to happen.
 */
function failStatSync(absPath, { times, code }) {
  const realStatSync = fs.statSync;
  let remaining = times;
  vi.spyOn(fs, 'statSync').mockImplementation((target, ...rest) => {
    if (String(target) === absPath && remaining > 0) {
      remaining -= 1;
      const err = new Error('resource busy or locked');
      err.code = code;
      throw err;
    }
    return realStatSync(target, ...rest);
  });
}

test('file-watch: a single transient stat failure does NOT disable the trigger — it is retried on the next tick', async () => {
  vi.useFakeTimers();
  makeInbox('todo.md');
  const logMessages = [];
  const watchFactory = createFakeWatchFactory();
  const { runner, triggers } = makeRunner({
    trigger: fileWatchTrigger({ config: { path: 'inbox/todo.md', debounceMs: 100 } }),
    createWatcher: watchFactory,
    log: (m) => logMessages.push(m),
    tickMs: 1000,
  });
  runner.start();

  failStatSync(path.join(cwd, 'inbox', 'todo.md'), { times: 1, code: 'EBUSY' });
  await vi.advanceTimersByTimeAsync(1000); // the failing tick
  expect(triggers.get('watch-1').enabled).toBe(true);
  expect(logMessages.some((m) => m.includes('retrying on the next tick'))).toBe(true);

  await vi.advanceTimersByTimeAsync(1000); // succeeds again
  expect(triggers.get('watch-1').enabled).toBe(true);
  expect(logMessages.some((m) => m.includes('DISABLED itself'))).toBe(false);
  expect(watchFactory.watchers).toHaveLength(1); // same watcher, never reopened
  runner.stop();
});

test('file-watch: two consecutive stat failures disable the trigger, with the error in the reason', async () => {
  vi.useFakeTimers();
  makeInbox('todo.md');
  const logMessages = [];
  const watchFactory = createFakeWatchFactory();
  const { runner, triggers } = makeRunner({
    trigger: fileWatchTrigger({ config: { path: 'inbox/todo.md', debounceMs: 100 } }),
    createWatcher: watchFactory,
    log: (m) => logMessages.push(m),
    tickMs: 1000,
  });
  runner.start();

  failStatSync(path.join(cwd, 'inbox', 'todo.md'), { times: 2, code: 'EBUSY' });
  await vi.advanceTimersByTimeAsync(2000); // two ticks in a row

  expect(triggers.get('watch-1').enabled).toBe(false);
  expect(logMessages.some((m) => m.includes('DISABLED itself') && m.includes('resource busy') && m.includes('twice in a row'))).toBe(true);
  runner.stop();
});

test('file-watch: a disabled-by-health trigger is not re-armed in the same tick (no contradicting second log line)', async () => {
  vi.useFakeTimers();
  makeInbox('todo.md');
  const logMessages = [];
  const watchFactory = createFakeWatchFactory();
  const { runner } = makeRunner({
    trigger: fileWatchTrigger({ config: { path: 'inbox/todo.md', debounceMs: 100 } }),
    createWatcher: watchFactory,
    log: (m) => logMessages.push(m),
    tickMs: 1000,
  });
  runner.start();
  expect(watchFactory.watchers).toHaveLength(1);

  fs.rmSync(path.join(cwd, 'inbox', 'todo.md'));
  await vi.advanceTimersByTimeAsync(1000);

  // The disable is the LAST word for this trigger: no second watcher opened
  // from the stale snapshot, and no "watching …" line after the disable.
  expect(watchFactory.watchers).toHaveLength(1);
  const disabledAt = logMessages.findIndex((m) => m.includes('DISABLED itself'));
  expect(disabledAt).toBeGreaterThanOrEqual(0);
  expect(logMessages.slice(disabledAt + 1).some((m) => m.includes('watching '))).toBe(false);
  runner.stop();
});

test('file-watch: a healthy watcher survives many ticks — writing inside the watched directory is not mistaken for a replaced target', async () => {
  vi.useFakeTimers();
  makeInbox('a.md');
  const watchFactory = createFakeWatchFactory();
  const { runner, triggers } = makeRunner({ trigger: fileWatchTrigger({ config: { path: 'inbox', debounceMs: 100 } }), createWatcher: watchFactory, tickMs: 1000 });
  runner.start();

  for (let i = 0; i < 10; i += 1) {
    fs.writeFileSync(path.join(cwd, 'inbox', `new-${i}.md`), 'x', 'utf8');
    await vi.advanceTimersByTimeAsync(1000);
  }

  // Exactly one watcher for the whole run: a health check that reopened on
  // every tick would drop each debounce window's pending paths.
  expect(watchFactory.watchers).toHaveLength(1);
  expect(watchFactory.last().closed).toBe(false);
  expect(triggers.get('watch-1').enabled).toBe(true);
  runner.stop();
});

test('file-watch: a trigger whose config.events is missing disables itself instead of killing the process', async () => {
  vi.useFakeTimers();
  makeInbox('a.md');
  const logMessages = [];
  const watchFactory = createFakeWatchFactory();

  const broken = fileWatchTrigger({ escalation: 'notify', approvalRequired: false, limits: { maxRunsPerDay: 24, maxCostPerDay: 1 } });
  delete broken.config.events; // the field the listener needs and never gets

  const triggers = stubTriggers(broken);
  expect(triggers.get('watch-1').config.events).toBeUndefined();
  const runner = createTriggerRunner({
    dataDir,
    triggers,
    runTurn,
    harness: createFakeHarness({ script: textResultScript('ok') }),
    harnessName: 'fake',
    cwd,
    now: () => Date.now(),
    log: (m) => logMessages.push(m),
    createWatcher: watchFactory,
  });
  runner.start();

  // A throw here would be an uncaught exception inside fs.watch's callback,
  // i.e. a dead process.
  expect(() => watchFactory.last().emitChange('change', 'a.md')).not.toThrow();
  await vi.advanceTimersByTimeAsync(1000);

  expect(openChats(dataDir).list()).toEqual([]);
  expect(triggers.get('watch-1').enabled).toBe(false);
  expect(triggers.get('watch-1')).toBeTruthy(); // still there, just off
  expect(logMessages.some((m) => m.includes('DISABLED itself') && m.includes('config.events is not an array'))).toBe(true);
  runner.stop();
});

test('file-watch: a manual fire with no recorded changes still runs, with an empty {{files}} and a reason saying so', async () => {
  makeInbox('a.md');
  const { runner } = makeRunner({ trigger: fileWatchTrigger() });
  const result = await runner.fireTrigger('watch-1', { cause: { origin: 'user' } });
  expect(result.fired).toBe(true);
  expect(soleTurnPrompt()).toContain('manual fire (no file changes recorded)');
});

// ------------------------------------------------------------- clipboard

test('clipboard: without a matchPattern nothing fires AND the clipboard is never even read', async () => {
  vi.useFakeTimers();
  const logMessages = [];
  const reader = createFakeClipboardReader('https://example.test/a');
  const { runner } = makeRunner({
    trigger: clipboardTrigger({ config: { pollMs: 1000 } }),
    readClipboard: reader,
    platform: 'win32',
    log: (m) => logMessages.push(m),
  });
  runner.start();

  await vi.advanceTimersByTimeAsync(10_000);
  expect(reader.reads).toBe(0);
  expect(openChats(dataDir).list()).toEqual([]);
  expect(logMessages.some((m) => m.includes('no matchPattern configured'))).toBe(true);
  runner.stop();
});

test('clipboard: a poller that cannot start logs its reason ONCE, not on every tick', async () => {
  vi.useFakeTimers();
  const logMessages = [];
  const reader = createFakeClipboardReader('https://example.test/a');
  const { runner } = makeRunner({
    trigger: clipboardTrigger({ config: { pollMs: 1000 } }), // no matchPattern
    readClipboard: reader,
    platform: 'win32',
    log: (m) => logMessages.push(m),
    tickMs: 1000,
  });
  runner.start();

  await vi.advanceTimersByTimeAsync(60_000); // 60 ticks
  const notStarted = logMessages.filter((m) => m.includes('clipboard poller not started'));
  expect(notStarted).toHaveLength(1);
  expect(reader.reads).toBe(0);
  runner.stop();
});

test('clipboard: adding a matchPattern later starts the poller on the next tick (and logs the consent line then)', async () => {
  vi.useFakeTimers();
  const logMessages = [];
  const reader = createFakeClipboardReader('https://example.test/a');
  const { runner, triggers } = makeRunner({
    trigger: clipboardTrigger({ config: { pollMs: 1000 } }),
    readClipboard: reader,
    platform: 'win32',
    log: (m) => logMessages.push(m),
    tickMs: 1000,
  });
  runner.start();
  expect(logMessages.filter((m) => m.includes('clipboard trigger ACTIVE'))).toHaveLength(0);

  triggers.upsert(clipboardTrigger({ config: { pollMs: 1000, matchPattern: 'https?://' } }));
  await vi.advanceTimersByTimeAsync(1000); // this tick starts the poller
  await vi.advanceTimersByTimeAsync(1000); // its first poll

  expect(logMessages.filter((m) => m.includes('clipboard trigger ACTIVE'))).toHaveLength(1);
  expect(reader.reads).toBeGreaterThan(0);
  runner.stop();
});

test('clipboard: the pattern runs against a bounded PREFIX of the clipboard, not the whole 64 KB read', async () => {
  vi.useFakeTimers();
  const reader = createFakeClipboardReader('start');
  const { runner } = makeRunner({
    trigger: clipboardTrigger({ config: { pollMs: 1000, matchPattern: 'MARKER' } }),
    readClipboard: reader,
    platform: 'win32',
  });
  runner.start();

  await vi.advanceTimersByTimeAsync(1000); // prime
  // The marker sits past the 4096-character match window, so it is not seen —
  // that bound is what keeps a user-supplied pattern's cost proportional to a
  // few KB instead of to a full clipboard.
  reader.value = `${'a'.repeat(10_000)}MARKER`;
  await vi.advanceTimersByTimeAsync(1000);
  await flushMicrotasks(50);
  expect(openChats(dataDir).list()).toEqual([]);

  // Inside the window it fires normally.
  reader.value = `MARKER ${'a'.repeat(10_000)}`;
  await vi.advanceTimersByTimeAsync(1000);
  await flushMicrotasks(50);
  expect(soleTurnPrompt()).toContain('MARKER');
  runner.stop();
});

test('clipboard: an unusable pollMs disables the trigger instead of busy-looping', () => {
  vi.useFakeTimers();
  const logMessages = [];
  const reader = createFakeClipboardReader('https://example.test/a');
  const broken = clipboardTrigger({ escalation: 'notify', approvalRequired: false, limits: { maxRunsPerDay: 24, maxCostPerDay: 1 } });
  broken.config.pollMs = 'fast'; // setInterval() with this would fire every millisecond
  const triggers = stubTriggers(broken);
  const runner = createTriggerRunner({
    dataDir,
    triggers,
    runTurn,
    harness: createFakeHarness({ script: textResultScript('ok') }),
    harnessName: 'fake',
    cwd,
    now: () => Date.now(),
    log: (m) => logMessages.push(m),
    readClipboard: reader,
    platform: 'win32',
  });
  runner.start();

  expect(triggers.get('clip-1').enabled).toBe(false);
  expect(logMessages.some((m) => m.includes('DISABLED itself') && m.includes('config.pollMs'))).toBe(true);
  expect(reader.reads).toBe(0);
  runner.stop();
});

test('clipboard: the content already on the clipboard at start only primes the comparison, and unchanged content never fires', async () => {
  vi.useFakeTimers();
  const reader = createFakeClipboardReader('https://example.test/a');
  const { runner } = makeRunner({ trigger: clipboardTrigger(), readClipboard: reader, platform: 'win32' });
  runner.start();

  await vi.advanceTimersByTimeAsync(1000); // first read: primes only
  await vi.advanceTimersByTimeAsync(1000); // identical content
  expect(reader.reads).toBe(2);
  expect(openChats(dataDir).list()).toEqual([]);

  reader.value = 'https://example.test/b';
  await vi.advanceTimersByTimeAsync(1000);
  await flushMicrotasks(50);
  expect(soleTurnPrompt()).toContain('https://example.test/b');
  runner.stop();
});

test('clipboard: content that does not match the pattern never fires', async () => {
  vi.useFakeTimers();
  const reader = createFakeClipboardReader('nothing interesting');
  const { runner } = makeRunner({ trigger: clipboardTrigger(), readClipboard: reader, platform: 'win32' });
  runner.start();

  await vi.advanceTimersByTimeAsync(1000);
  reader.value = 'still no link here';
  await vi.advanceTimersByTimeAsync(1000);
  await flushMicrotasks(50);
  expect(openChats(dataDir).list()).toEqual([]);
  runner.stop();
});

test('clipboard: a secret in the copied text is redacted before it reaches the prompt, and never appears in the log at all', async () => {
  vi.useFakeTimers();
  const secret = `sk-${'a'.repeat(32)}`;
  const logMessages = [];
  const reader = createFakeClipboardReader('https://example.test/start');
  const { runner } = makeRunner({ trigger: clipboardTrigger(), readClipboard: reader, platform: 'win32', log: (m) => logMessages.push(m) });
  runner.start();

  await vi.advanceTimersByTimeAsync(1000); // prime
  reader.value = `https://example.test/api?token=${secret}`;
  await vi.advanceTimersByTimeAsync(1000);
  await flushMicrotasks(50);

  const prompt = soleTurnPrompt();
  expect(prompt).toContain('[REDACTED]');
  expect(prompt).not.toContain(secret);
  expect(logMessages.some((m) => m.includes(secret))).toBe(false);
  runner.stop();
});

test('clipboard: a failed read costs that poll only — the poller keeps going and still fires on the next changed value', async () => {
  vi.useFakeTimers();
  const logMessages = [];
  const reader = createFakeClipboardReader('https://example.test/a');
  const { runner } = makeRunner({ trigger: clipboardTrigger(), readClipboard: reader, platform: 'win32', log: (m) => logMessages.push(m) });
  runner.start();

  await vi.advanceTimersByTimeAsync(1000); // prime
  reader.failWith = new Error('clipboard busy');
  await vi.advanceTimersByTimeAsync(1000);
  expect(logMessages.some((m) => m.includes('clipboard read failed'))).toBe(true);

  reader.failWith = null;
  reader.value = 'https://example.test/b';
  await vi.advanceTimersByTimeAsync(1000);
  await flushMicrotasks(50);
  expect(soleTurnPrompt()).toContain('https://example.test/b');
  runner.stop();
});

test('clipboard: on a non-Windows platform the trigger reports supported:false, starts no poller, and a fire is refused in plain text', async () => {
  vi.useFakeTimers();
  const reader = createFakeClipboardReader('https://example.test/a');
  const { runner, triggers } = makeRunner({ trigger: clipboardTrigger(), readClipboard: reader, platform: 'linux' });

  const support = runner.supportStatus(triggers.get('clip-1'));
  expect(support.supported).toBe(false);
  expect(support.unsupportedReason).toMatch(/require Windows/);

  runner.start();
  await vi.advanceTimersByTimeAsync(10_000);
  expect(reader.reads).toBe(0);

  const result = await runner.fireTrigger('clip-1', { cause: { origin: 'user' } });
  expect(result.fired).toBe(false);
  expect(result.reason).toMatch(/require Windows/);
  runner.stop();
});

test('clipboard: a manual fire is refused — only the trigger\'s own poller may read the clipboard', async () => {
  const reader = createFakeClipboardReader('https://example.test/a');
  const { runner } = makeRunner({ trigger: clipboardTrigger(), readClipboard: reader, platform: 'win32' });

  const result = await runner.fireTrigger('clip-1', { cause: { origin: 'user' } });
  expect(result.fired).toBe(false);
  expect(result.reason).toMatch(/only from their own poller/);
  expect(reader.reads).toBe(0);
});

test('clipboard: activating the poller logs that clipboard contents are being read (visible consent)', () => {
  vi.useFakeTimers();
  const logMessages = [];
  const reader = createFakeClipboardReader('');
  const { runner } = makeRunner({ trigger: clipboardTrigger(), readClipboard: reader, platform: 'win32', log: (m) => logMessages.push(m) });
  runner.start();
  expect(logMessages.some((m) => m.includes('clipboard trigger ACTIVE') && m.includes('read every 1000ms'))).toBe(true);
  runner.stop();
});

// ------------------------------------------------------------- saved-prompt

test('saved-prompt: fires through a manual fire and runs the stored prompt', async () => {
  const { runner } = makeRunner({ trigger: savedPromptTrigger() });
  const result = await runner.fireTrigger('saved-1', { cause: { origin: 'user' } });
  expect(result.fired).toBe(true);
  expect(soleTurnPrompt()).toContain('Write the weekly report.');
});

test('saved-prompt: never fires from a tick, however often the tick runs', () => {
  vi.useFakeTimers();
  const { runner } = makeRunner({ trigger: savedPromptTrigger(), tickMs: 1000 });
  runner.start();
  vi.advanceTimersByTime(60_000);
  expect(openChats(dataDir).list()).toEqual([]);
  runner.stop();
});

test('saved-prompt: still respects the daily run cap', async () => {
  const fixedNow = new Date(2026, 6, 30, 9, 0, 0).getTime();
  const { runner } = makeRunner({ trigger: savedPromptTrigger({ limits: { maxRunsPerDay: 1, maxCostPerDay: 50 } }), now: () => fixedNow });
  appendRun(dataDir, { ts: new Date(fixedNow).toISOString(), triggerId: 'saved-1', origin: 'trigger', costUsd: 0 });

  const result = await runner.fireTrigger('saved-1', { cause: { origin: 'user' } });
  expect(result.fired).toBe(false);
  expect(result.reason).toMatch(/daily run limit/);
});

test('saved-prompt: escalation "review" without a UI approval handler still cannot fire (fail-closed, same gate as every other type)', async () => {
  const { runner } = makeRunner({ trigger: savedPromptTrigger({ escalation: 'review' }) });
  const result = await runner.fireTrigger('saved-1', { cause: { origin: 'user' } });
  expect(result.fired).toBe(false);
  expect(result.reason).toMatch(/approval/);
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

test('stop() closes every file watcher and stops every clipboard poller — nothing fires or reads afterwards', async () => {
  vi.useFakeTimers();
  makeInbox('a.md');
  const watchFactory = createFakeWatchFactory();
  const reader = createFakeClipboardReader('https://example.test/a');
  const triggers = openTriggers(dataDir);
  triggers.upsert(fileWatchTrigger({ config: { path: 'inbox', debounceMs: 100 } }));
  triggers.upsert(clipboardTrigger());
  const runner = createTriggerRunner({
    dataDir,
    triggers,
    runTurn,
    harness: createFakeHarness({ script: textResultScript('ok') }),
    harnessName: 'fake',
    cwd,
    now: () => Date.now(),
    log: () => {},
    tickMs: 1000,
    createWatcher: watchFactory,
    readClipboard: reader,
    platform: 'win32',
  });

  runner.start();
  expect(watchFactory.watchers).toHaveLength(1);
  await vi.advanceTimersByTimeAsync(1000);
  const readsWhileRunning = reader.reads;
  expect(readsWhileRunning).toBeGreaterThan(0);

  runner.stop();
  expect(watchFactory.last().closed).toBe(true);

  // A watch event after stop() has no state left to land in, and no poll
  // interval remains to read the clipboard again.
  watchFactory.last().emitChange('change', 'a.md');
  reader.value = 'https://example.test/changed';
  await vi.advanceTimersByTimeAsync(30_000);
  expect(reader.reads).toBe(readsWhileRunning);
  expect(openChats(dataDir).list()).toEqual([]);
});

test('a file-watch trigger enabled AFTER start() gets its watcher on the next tick, and loses it again when disabled', async () => {
  vi.useFakeTimers();
  makeInbox('a.md');
  const watchFactory = createFakeWatchFactory();
  const triggers = openTriggers(dataDir);
  triggers.upsert(fileWatchTrigger({ enabled: false }));
  const runner = createTriggerRunner({
    dataDir,
    triggers,
    runTurn,
    harness: createFakeHarness({ script: textResultScript('ok') }),
    harnessName: 'fake',
    cwd,
    now: () => Date.now(),
    log: () => {},
    tickMs: 1000,
    createWatcher: watchFactory,
  });

  runner.start();
  expect(watchFactory.watchers).toHaveLength(0); // disabled: nothing watches

  triggers.setEnabled('watch-1', true);
  await vi.advanceTimersByTimeAsync(1000);
  expect(watchFactory.watchers).toHaveLength(1);

  triggers.setEnabled('watch-1', false);
  await vi.advanceTimersByTimeAsync(1000);
  expect(watchFactory.last().closed).toBe(true);
  runner.stop();
});

// ------------------------------------------------------------- caps: post-check, global ceiling, cross-process claims

test('cost cap: crossing it during a turn is reported right after that turn, and the next fire is refused', async () => {
  // Pinned to the real clock, not a literal date: the runner's day window is
  // computed from this injected `now`, but runs.jsonl stamps entries with the
  // actual wall clock (runs.mjs `entry.ts ?? new Date().toISOString()`). A
  // literal date put an expiry into the test — it went red at the first
  // midnight after it was written (found 2026-07-31, the morning after).
  const fixedNow = Date.now();
  const logMessages = [];
  // One turn costing more than the whole cap: the preflight said yes at
  // $0.00, and the turn itself put the day over the line.
  const script = [
    { type: 'init', sessionId: 's1', tools: [], model: 'm', permissionMode: 'default' },
    { type: 'text', text: 'done' },
    { type: 'result', sessionId: 's1', costUsd: 1.2, usage: {}, isError: false },
  ];
  const { runner } = makeRunner({
    trigger: savedPromptTrigger({ limits: { maxRunsPerDay: 50, maxCostPerDay: 1.0 } }),
    script,
    now: () => fixedNow,
    log: (m) => logMessages.push(m),
  });

  const first = await runner.fireTrigger('saved-1', { cause: { origin: 'user' } });
  expect(first.fired).toBe(true);
  expect(logMessages.some((m) => m.includes('cap reached after this turn') && m.includes('daily cost limit'))).toBe(true);

  const second = await runner.fireTrigger('saved-1', { cause: { origin: 'user' } });
  expect(second.fired).toBe(false);
  expect(second.reason).toMatch(/daily cost limit/);
});

test('limitStatus reports the blocking reason a UI can show, and null while the trigger is free to run', async () => {
  const fixedNow = new Date(2026, 6, 30, 9, 0, 0).getTime();
  const { runner, triggers } = makeRunner({ trigger: savedPromptTrigger({ limits: { maxRunsPerDay: 1, maxCostPerDay: 5 } }), now: () => fixedNow });
  expect(runner.limitStatus(triggers.get('saved-1')).blockedReason).toBeNull();

  appendRun(dataDir, { ts: new Date(fixedNow).toISOString(), triggerId: 'saved-1', origin: 'trigger', costUsd: 0 });
  const status = runner.limitStatus(triggers.get('saved-1'));
  expect(status.blockedReason).toMatch(/daily run limit/);
  expect(status.runsToday).toBe(1);
});

test('limitStatus reports an unknown-cost day as estimated, so a UI never presents a guess as a measurement', async () => {
  const fixedNow = new Date(2026, 6, 30, 9, 0, 0).getTime();
  const { runner, triggers } = makeRunner({ trigger: savedPromptTrigger(), now: () => fixedNow });
  appendRun(dataDir, { ts: new Date(fixedNow).toISOString(), triggerId: 'saved-1', origin: 'trigger', costUsd: null });

  const status = runner.limitStatus(triggers.get('saved-1'));
  expect(status.costEstimated).toBe(true);
  expect(status.costToday).toBeGreaterThan(0);
});

test('global cap: the hourly ceiling stops EVERY trigger, not just the one that reached it', async () => {
  const fixedNow = new Date(2026, 6, 30, 9, 0, 0).getTime();
  const { runner, triggers } = makeRunner({ trigger: savedPromptTrigger({ limits: { maxRunsPerDay: 500, maxCostPerDay: 50 } }), now: () => fixedNow });
  // Turns of a DIFFERENT trigger fill the shared hourly ceiling.
  for (let i = 0; i < MAX_TRIGGER_TURNS_PER_HOUR; i += 1) {
    appendRun(dataDir, { ts: new Date(fixedNow - 60_000).toISOString(), triggerId: 'somebody-else', origin: 'trigger', costUsd: 0 });
  }

  const result = await runner.fireTrigger('saved-1', { cause: { origin: 'user' } });
  expect(result.fired).toBe(false);
  expect(result.reason).toMatch(/global trigger cap reached/);
  expect(runner.limitStatus(triggers.get('saved-1')).blockedReason).toMatch(/global trigger cap/);
});

test('global cap: a user own chat turns never push a trigger over it', async () => {
  const fixedNow = new Date(2026, 6, 30, 9, 0, 0).getTime();
  const { runner } = makeRunner({ trigger: savedPromptTrigger(), now: () => fixedNow });
  for (let i = 0; i < MAX_TRIGGER_TURNS_PER_HOUR + 5; i += 1) {
    appendRun(dataDir, { ts: new Date(fixedNow - 60_000).toISOString(), triggerId: null, origin: 'user', costUsd: 0 });
  }

  const result = await runner.fireTrigger('saved-1', { cause: { origin: 'user' } });
  expect(result.fired).toBe(true);
});

test('global cap: an A->B->A file-watch chain runs out at the hourly ceiling instead of all night', async () => {
  vi.useFakeTimers();
  fs.mkdirSync(path.join(cwd, 'dir-a'), { recursive: true });
  fs.mkdirSync(path.join(cwd, 'dir-b'), { recursive: true });
  const logMessages = [];
  const watchFactory = createFakeWatchFactory();
  const triggers = openTriggers(dataDir, { knownAppIds: TEST_APP_IDS, log: () => {} });
  triggers.upsert(fileWatchTrigger({ id: 'watch-a', config: { path: 'dir-a', debounceMs: 100 } }));
  triggers.upsert(fileWatchTrigger({ id: 'watch-b', config: { path: 'dir-b', debounceMs: 100 } }));
  const runner = createTriggerRunner({
    dataDir,
    triggers,
    runTurn,
    harness: createFakeHarness({ script: textResultScript('ok') }),
    harnessName: 'fake',
    cwd,
    now: () => Date.now(),
    log: (m) => logMessages.push(m),
    createWatcher: watchFactory,
    resolveToolApp: resolveTestToolApp,
  });
  runner.start();

  const [watcherA, watcherB] = watchFactory.watchers;
  // Each turn "writes" into the other trigger's directory — the loop nothing
  // else catches: neither trigger ever exceeds its OWN cap.
  for (let round = 0; round < MAX_TRIGGER_TURNS_PER_HOUR + 10; round += 1) {
    const watcher = round % 2 === 0 ? watcherA : watcherB;
    watcher.emitChange('change', `round-${round}.md`);
    await vi.advanceTimersByTimeAsync(200);
    await flushMicrotasks(30);
  }

  const chats = openChats(dataDir).list();
  expect(chats.length).toBe(MAX_TRIGGER_TURNS_PER_HOUR);
  expect(logMessages.some((m) => m.includes('global trigger cap reached'))).toBe(true);
  runner.stop();
});

/** A second runner on the SAME dataDir — the "two kaprek processes" case, minus the process. */
function secondRunnerOn(triggers, extra = {}) {
  return createTriggerRunner({
    dataDir,
    triggers,
    runTurn,
    harness: createFakeHarness({ script: textResultScript('ok') }),
    harnessName: 'fake',
    cwd,
    now: () => Date.now(),
    log: () => {},
    resolveToolApp: resolveTestToolApp,
    ...extra,
  });
}

test('two runners on one dataDir fire the same heartbeat window only ONCE (cross-process claim)', async () => {
  fs.writeFileSync(path.join(cwd, 'CHECKLIST.md'), '- check the thing', 'utf8');
  const fixedNow = new Date(2026, 6, 30, 9, 0, 0).getTime();
  const triggersA = openTriggers(dataDir, { knownAppIds: TEST_APP_IDS, log: () => {} });
  triggersA.upsert(heartbeatTrigger({ config: { intervalMinutes: 30 } }));
  const triggersB = openTriggers(dataDir, { knownAppIds: TEST_APP_IDS, log: () => {} });

  const runnerA = secondRunnerOn(triggersA, { now: () => fixedNow });
  const runnerB = secondRunnerOn(triggersB, { now: () => fixedNow });

  // Both processes' ticks conclude the same window is due — only one may run.
  const [a, b] = await Promise.all([
    runnerA.fireTrigger('heartbeat-1', { cause: { origin: 'heartbeat' } }),
    runnerB.fireTrigger('heartbeat-1', { cause: { origin: 'heartbeat' } }),
  ]);
  expect([a.fired, b.fired].filter(Boolean)).toHaveLength(1);
  expect([a, b].find((r) => !r.fired).reason).toMatch(/heartbeat window already claimed/);
  expect(openChats(dataDir).list()).toHaveLength(1);
});

test('a manual heartbeat fire takes no claim — "run now" still works in a window the tick already used', async () => {
  fs.writeFileSync(path.join(cwd, 'CHECKLIST.md'), '- check the thing', 'utf8');
  const fixedNow = new Date(2026, 6, 30, 9, 0, 0).getTime();
  const { runner } = makeRunner({ trigger: heartbeatTrigger({ config: { intervalMinutes: 30 } }), now: () => fixedNow });

  const fromTick = await runner.fireTrigger('heartbeat-1', { cause: { origin: 'heartbeat' } });
  expect(fromTick.fired).toBe(true);
  const manual = await runner.fireTrigger('heartbeat-1', { cause: { origin: 'user' } });
  expect(manual.fired).toBe(true);
});

test('two runners on one dataDir fire the same file-watch debounce window only ONCE', async () => {
  const fixedNow = new Date(2026, 6, 30, 9, 0, 0).getTime();
  makeInbox('a.md');
  const triggersA = openTriggers(dataDir, { knownAppIds: TEST_APP_IDS, log: () => {} });
  triggersA.upsert(fileWatchTrigger({ config: { path: 'inbox', debounceMs: 500 } }));
  const triggersB = openTriggers(dataDir, { knownAppIds: TEST_APP_IDS, log: () => {} });

  const runnerA = secondRunnerOn(triggersA, { now: () => fixedNow });
  const runnerB = secondRunnerOn(triggersB, { now: () => fixedNow });

  // Both watchers saw the same save inside the same debounce window.
  const cause = { origin: 'file-watch', files: ['inbox/a.md'], windowStartedAt: fixedNow };
  const [a, b] = await Promise.all([runnerA.fireTrigger('watch-1', { cause }), runnerB.fireTrigger('watch-1', { cause })]);

  expect([a.fired, b.fired].filter(Boolean)).toHaveLength(1);
  expect([a, b].find((r) => !r.fired).reason).toMatch(/file-watch window already claimed/);
});

// ------------------------------------------------- hardening r3: live turns count
//
// Both caps read runs.jsonl, which a turn only writes when it ENDS. That was a
// few minutes of blindness before the inbox and is hours of it now: a turn
// parked on an overnight question is, as far as every limit is concerned, a
// turn that never happened.

/** A harness that never returns until the test releases it, so a turn can be held in flight. */
function parkingHarness() {
  let release;
  let markStarted;
  const started = new Promise((resolve) => {
    markStarted = resolve;
  });
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  return {
    started,
    release: () => release(),
    async startTurn({ onEvent } = {}) {
      markStarted();
      await gate;
      onEvent?.({ type: 'result', sessionId: 's1', costUsd: 0, usage: {}, isError: false });
      return { sessionId: 's1', costUsd: 0, usage: {}, stopReason: 'result', error: null };
    },
  };
}

test('global cap: a turn that is still parked counts against the ceiling, not only finished ones', async () => {
  const fixedNow = new Date(2026, 6, 30, 9, 0, 0).getTime();
  const harness = parkingHarness();
  const triggers = openTriggers(dataDir, { knownAppIds: TEST_APP_IDS, log: () => {} });
  triggers.upsert(scheduleTrigger({ id: 'parker', config: { everyMinutes: 5 } }));
  triggers.upsert(savedPromptTrigger());
  const runner = createTriggerRunner({
    dataDir,
    triggers,
    runTurn,
    harness,
    harnessName: 'fake',
    cwd,
    now: () => fixedNow,
    log: () => {},
    resolveToolApp: resolveTestToolApp,
  });

  // One short of the ceiling on the log, so the ONLY thing that can push it
  // over is the live turn below.
  for (let i = 0; i < MAX_TRIGGER_TURNS_PER_HOUR - 1; i += 1) {
    appendRun(dataDir, { ts: new Date(fixedNow - 60_000).toISOString(), triggerId: 'somebody-else', origin: 'trigger', costUsd: 0 });
  }
  expect((await runner.limitStatus(triggers.get('saved-1'))).blockedReason).toBeNull();

  const parked = runner.fireTrigger('parker', { cause: { origin: 'schedule' } });
  await harness.started;

  const result = await runner.fireTrigger('saved-1', { cause: { origin: 'user' } });
  expect(result.fired).toBe(false);
  expect(result.reason).toMatch(/global trigger cap reached/);
  // And the trigger page says the same thing rather than looking armed.
  expect(runner.limitStatus(triggers.get('saved-1')).blockedReason).toMatch(/global trigger cap/);

  harness.release();
  await parked;
});

test('per-trigger cap: a parked turn occupies its own daily run slot too', async () => {
  const fixedNow = new Date(2026, 6, 30, 9, 0, 0).getTime();
  const harness = parkingHarness();
  const triggers = openTriggers(dataDir, { knownAppIds: TEST_APP_IDS, log: () => {} });
  triggers.upsert(scheduleTrigger({ id: 'parker', config: { everyMinutes: 5 }, limits: { maxRunsPerDay: 1, maxCostPerDay: 1 } }));
  const runner = createTriggerRunner({
    dataDir,
    triggers,
    runTurn,
    harness,
    harnessName: 'fake',
    cwd,
    now: () => fixedNow,
    log: () => {},
    resolveToolApp: resolveTestToolApp,
  });

  const parked = runner.fireTrigger('parker', { cause: { origin: 'schedule' } });
  await harness.started;

  // Nothing is in runs.jsonl yet, so only the in-flight count can produce this.
  expect(runner.limitStatus(triggers.get('parker'))).toMatchObject({ runsToday: 1, blockedReason: expect.stringMatching(/daily run limit/) });

  harness.release();
  await parked;
});

test('the tick starts at most MAX_CONCURRENT_TRIGGER_TURNS turns, and defers the rest instead of dropping them', async () => {
  const fixedNow = new Date(2026, 6, 30, 9, 0, 0).getTime();
  const harness = parkingHarness();
  const triggers = openTriggers(dataDir, { knownAppIds: TEST_APP_IDS, log: () => {} });
  const due = MAX_CONCURRENT_TRIGGER_TURNS + 2;
  for (let i = 0; i < due; i += 1) {
    triggers.upsert(scheduleTrigger({ id: `every-${i}`, config: { everyMinutes: 5 } }));
  }
  const lines = [];
  const runner = createTriggerRunner({
    dataDir,
    triggers,
    runTurn,
    harness,
    harnessName: 'fake',
    cwd,
    now: () => fixedNow,
    log: (message) => lines.push(message),
    resolveToolApp: resolveTestToolApp,
  });

  runner.tick();
  await harness.started;

  // Every one of them was due; only the cap decided how many actually started.
  const chats = openChats(dataDir).list();
  expect(chats).toHaveLength(MAX_CONCURRENT_TRIGGER_TURNS);
  const deferred = lines.filter((line) => line.includes('deferred'));
  expect(deferred).toHaveLength(due - MAX_CONCURRENT_TRIGGER_TURNS);
  // Deferred, not dropped: the line says why, and the trigger is still enabled
  // and still due for the next tick.
  expect(deferred[0]).toMatch(/trigger turns already running/);
  expect(triggers.list().every((t) => t.enabled)).toBe(true);

  harness.release();
});
