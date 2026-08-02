// The relay walking a recipe graph: edges, edge gates, retries, budgets.
//
// Separate from dispatcher.test.mjs, which pins down v1 behaviour and stays
// as the compatibility contract. Every peer here is a stub, for the same
// reason it is there: a test that needed a real CLI could never run in CI.
import { test, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openChats } from '../chats/store.mjs';
import { createApprovalStore } from '../server/approval-store.mjs';
import { budgetSnapshotHashOf, createRelayDispatcher, participantsHashOf } from './dispatcher.mjs';

let dataDir;

beforeEach(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kaprek-graph-test-'));
});

afterEach(() => {
  fs.rmSync(dataDir, { recursive: true, force: true });
});

/** A peer that always answers in shape. */
function stubPeer(id) {
  let call = 0;
  return {
    id,
    available: () => true,
    async runTurn() {
      call += 1;
      return { status: 'handoff', message: `${id} #${call}`, usage: null, costUsd: null, durationMs: 1 };
    },
  };
}

/** A peer that throws every time. */
function deadPeer(id, message = 'not answering') {
  return {
    id,
    available: () => true,
    async runTurn() {
      throw new Error(message);
    },
  };
}

/**
 * A dispatcher driving recipes. Harness steps ('claude', 'codex') go through
 * runHarnessTurn — the seam the server fills with real engines.
 */
function setup({ peers = {}, harness } = {}) {
  const chats = openChats(dataDir);
  const chat = chats.createChat({ title: 'recipe test' });
  const approvalStore = createApprovalStore({ dataDir, log: () => {} });
  const drivers = new Map(Object.entries(peers));
  const harnessCalls = [];
  const waits = [];

  const dispatcher = createRelayDispatcher({
    dataDir,
    getChats: () => openChats(dataDir),
    approvalStore,
    getPeerDriver: (id) => drivers.get(id) ?? null,
    runClaudeTurn: () => ({ status: 'handoff', message: 'claude (legacy path)' }),
    runHarnessTurn: async ({ engine, prompt }) => {
      harnessCalls.push({ engine, prompt });
      if (harness) return harness({ engine, prompt, call: harnessCalls.length });
      return { status: 'handoff', message: `${engine} #${harnessCalls.length}` };
    },
    // No real backoff: the delay is asserted from the event, and 45 seconds
    // of sleeping proves nothing the number does not.
    wait: (ms) => {
      waits.push(ms);
      return Promise.resolve();
    },
    log: (m) => {
      if (process.env.RELAY_DEBUG) console.log('LOG:', m);
    },
  });
  return { chatId: chat.id, dispatcher, approvalStore, harnessCalls, waits };
}

function eventsOfType(chatId, eventType) {
  return openChats(dataDir)
    .events(chatId)
    .filter((event) => event.kind === 'relay' && event.eventType === eventType);
}

function relayOf(chatId) {
  return openChats(dataDir).get(chatId).relay;
}

async function passGate(dispatcher, chatId) {
  const parked = relayOf(chatId);
  return dispatcher.resumeAfterGate({
    chatId,
    voucher: {
      participantsHash: participantsHashOf(parked),
      budgetSnapshotHash: budgetSnapshotHashOf(parked),
      approvalKey: parked.gateKey,
    },
  });
}

const THREE_STEPS = {
  id: 'three',
  title: 'write, review, apply',
  steps: [
    { id: 'write', agent: 'grok' },
    { id: 'review', agent: 'claude' },
    { id: 'apply', agent: 'codex' },
  ],
  edges: [
    { from: 'write', to: 'review' },
    { from: 'review', to: 'apply' },
    { from: 'apply', to: 'write' },
  ],
  budgets: { maxRounds: 1 },
};

test('recipe: the run follows the edges, in order', async () => {
  const { chatId, dispatcher } = setup({ peers: { grok: stubPeer('grok') } });
  const run = await dispatcher.startRun({ chatId, goal: 'ship it', recipe: THREE_STEPS });
  await dispatcher.waitFor(run.runId);

  expect(eventsOfType(chatId, 'message').map((event) => event.from)).toEqual(['grok', 'claude', 'codex']);
  // One lap of the graph is one round, and the budget was one.
  expect(relayOf(chatId).rounds).toBe(1);
});

test('recipe: an edge marked requiresHuman gates BEFORE the step on the far side runs', async () => {
  const gated = {
    ...THREE_STEPS,
    edges: [
      { from: 'write', to: 'review' },
      { from: 'review', to: 'apply', requiresHuman: true },
      { from: 'apply', to: 'write' },
    ],
    budgets: { maxRounds: 5 },
  };
  const { chatId, dispatcher, harnessCalls } = setup({ peers: { grok: stubPeer('grok') } });
  const run = await dispatcher.startRun({ chatId, goal: 'ship it', recipe: gated });
  await dispatcher.waitFor(run.runId);

  const relay = relayOf(chatId);
  expect(relay.status).toBe('waiting_gate');
  expect(relay.gateReason).toBe('edge');
  // The step behind the gate has NOT run: only claude, on this side of it.
  expect(harnessCalls.map((call) => call.engine)).toEqual(['claude-code']);
  expect(relay.stepId).toBe('apply');
  expect(eventsOfType(chatId, 'gate.requested').at(-1).textPreview).toContain('apply');
});

test('recipe: an edge voucher buys one passage and no extra round', async () => {
  const gated = {
    ...THREE_STEPS,
    edges: [
      { from: 'write', to: 'review' },
      { from: 'review', to: 'apply', requiresHuman: true },
      { from: 'apply', to: 'write' },
    ],
    budgets: { maxRounds: 1 },
  };
  const { chatId, dispatcher } = setup({ peers: { grok: stubPeer('grok') } });
  const run = await dispatcher.startRun({ chatId, goal: 'ship it', recipe: gated });
  await dispatcher.waitFor(run.runId);

  const budgetBefore = relayOf(chatId).maxRounds;
  await passGate(dispatcher, chatId);
  await dispatcher.waitFor(run.runId);

  // Approving one handoff must not also buy a round nobody agreed to.
  expect(relayOf(chatId).maxRounds).toBe(budgetBefore);
  expect(eventsOfType(chatId, 'message').map((event) => event.from)).toEqual(['grok', 'claude', 'codex']);
});

test('recipe: the same edge asks again the next time round', async () => {
  const gated = {
    id: 'pair',
    title: 'pair',
    steps: [
      { id: 'write', agent: 'grok' },
      { id: 'apply', agent: 'codex' },
    ],
    edges: [
      { from: 'write', to: 'apply', requiresHuman: true },
      { from: 'apply', to: 'write' },
    ],
    budgets: { maxRounds: 4 },
  };
  const { chatId, dispatcher } = setup({ peers: { grok: stubPeer('grok') } });
  const run = await dispatcher.startRun({ chatId, goal: 'ship it', recipe: gated });
  await dispatcher.waitFor(run.runId);

  for (let pass = 0; pass < 2; pass += 1) {
    expect(relayOf(chatId).status).toBe('waiting_gate');
    await passGate(dispatcher, chatId);
    await dispatcher.waitFor(run.runId);
  }
  // A voucher is spent, never held: two passages meant two questions.
  expect(eventsOfType(chatId, 'gate.requested').filter((event) => event.reason === 'edge').length).toBeGreaterThanOrEqual(2);
});

test('recipe: a failed dispatch is retried with backoff, and the log shows both attempts', async () => {
  let calls = 0;
  const flaky = {
    id: 'grok',
    available: () => true,
    async runTurn() {
      calls += 1;
      if (calls === 1) throw new Error('grok was briefly unavailable');
      return { status: 'done', message: 'second time lucky' };
    },
  };
  const { chatId, dispatcher, waits } = setup({ peers: { grok: flaky } });
  const run = await dispatcher.startRun({
    chatId,
    goal: 'ship it',
    recipe: {
      id: 'solo',
      title: 'solo',
      steps: [{ id: 'write', agent: 'grok' }],
      edges: [{ from: 'write', to: 'write' }],
      budgets: { retriesPerDispatch: 1 },
    },
  });
  await dispatcher.waitFor(run.runId);

  const retried = eventsOfType(chatId, 'dispatch.retry');
  expect(retried).toHaveLength(1);
  expect(retried[0].attempt).toBe(1);
  expect(retried[0].delayMs).toBe(15_000);
  expect(waits).toEqual([15_000]);
  // Both attempts are in the log, under different dispatch ids.
  expect(eventsOfType(chatId, 'dispatch.failed')).toHaveLength(1);
  expect(relayOf(chatId).status).toBe('completed');
});

test('recipe: when the retries are spent, onPeerFailure question asks instead of stopping', async () => {
  const { chatId, dispatcher } = setup({ peers: { grok: deadPeer('grok') } });
  const run = await dispatcher.startRun({
    chatId,
    goal: 'ship it',
    recipe: {
      id: 'solo',
      title: 'solo',
      steps: [{ id: 'write', agent: 'grok' }],
      edges: [{ from: 'write', to: 'write' }],
      budgets: { retriesPerDispatch: 1 },
      escalation: { onPeerFailure: 'question' },
    },
  });
  await dispatcher.waitFor(run.runId);

  const relay = relayOf(chatId);
  expect(relay.status).toBe('waiting_gate');
  expect(relay.gateReason).toBe('peer');
  // Two attempts, both recorded.
  expect(eventsOfType(chatId, 'dispatch.failed')).toHaveLength(2);
});

test('recipe: onPeerFailure notify carries on past the broken step and says so', async () => {
  const { chatId, dispatcher, harnessCalls } = setup({ peers: { grok: deadPeer('grok', 'grok is out') } });
  const run = await dispatcher.startRun({
    chatId,
    goal: 'ship it',
    recipe: {
      id: 'pair',
      title: 'pair',
      steps: [
        { id: 'write', agent: 'grok' },
        { id: 'review', agent: 'claude' },
      ],
      edges: [
        { from: 'write', to: 'review' },
        { from: 'review', to: 'write' },
      ],
      budgets: { maxRounds: 1 },
      escalation: { onPeerFailure: 'notify' },
    },
  });
  await dispatcher.waitFor(run.runId);

  const notices = eventsOfType(chatId, 'notice');
  expect(notices.length).toBeGreaterThan(0);
  expect(notices[0].textPreview).toContain('carrying on');
  // The next step ran despite the failure — which is what 'notify' asks for.
  expect(harnessCalls.length).toBeGreaterThan(0);
});

test('recipe: onBudget stop ends the run instead of asking', async () => {
  const { chatId, dispatcher } = setup({ peers: { grok: stubPeer('grok') } });
  const run = await dispatcher.startRun({
    chatId,
    goal: 'ship it',
    recipe: { ...THREE_STEPS, budgets: { maxRounds: 1 }, escalation: { onBudget: 'stop' } },
  });
  await dispatcher.waitFor(run.runId);

  expect(relayOf(chatId).status).toBe('stopped');
  expect(eventsOfType(chatId, 'gate.requested')).toHaveLength(0);
});

test('recipe: hardMaxTurns is the backstop when onBudget says carry on', async () => {
  const { chatId, dispatcher } = setup({ peers: { grok: stubPeer('grok') } });
  const run = await dispatcher.startRun({
    chatId,
    goal: 'ship it',
    recipe: { ...THREE_STEPS, budgets: { maxRounds: 1, hardMaxTurns: 4 }, escalation: { onBudget: 'notify' } },
  });
  await dispatcher.waitFor(run.runId);

  const relay = relayOf(chatId);
  expect(relay.status).toBe('stopped');
  expect(relay.turns).toBe(4);
  expect(eventsOfType(chatId, 'notice').length).toBeGreaterThan(0);
});

test('recipe: a run refuses to start when a step names a peer that is not installed', async () => {
  const { chatId, dispatcher } = setup({ peers: {} });
  await expect(
    dispatcher.startRun({
      chatId,
      goal: 'ship it',
      recipe: { id: 'solo', title: 'solo', steps: [{ id: 'write', agent: 'grok' }], edges: [] },
    }),
  ).rejects.toThrow(/unknown peer/);
});

test('recipe: a line rather than a ring completes at its last step', async () => {
  const { chatId, dispatcher } = setup({ peers: { grok: stubPeer('grok') } });
  const run = await dispatcher.startRun({
    chatId,
    goal: 'ship it',
    recipe: {
      id: 'line',
      title: 'a line, not a ring',
      steps: [
        { id: 'write', agent: 'grok' },
        { id: 'review', agent: 'claude' },
      ],
      edges: [{ from: 'write', to: 'review' }],
    },
  });
  await dispatcher.waitFor(run.runId);

  expect(relayOf(chatId).status).toBe('completed');
  expect(eventsOfType(chatId, 'message').map((event) => event.from)).toEqual(['grok', 'claude']);
});

test('recipe: a legacy start is a recipe too, and still books its route', async () => {
  const { chatId, dispatcher } = setup({ peers: { grok: stubPeer('grok') } });
  const run = await dispatcher.startRun({ chatId, goal: 'ship it', route: ['grok', 'claude'], maxRounds: 1 });
  await dispatcher.waitFor(run.runId);

  const relay = relayOf(chatId);
  expect(relay.route).toEqual(['grok', 'claude']);
  expect(relay.recipeId).toBe('legacy-route');
  expect(eventsOfType(chatId, 'message').map((event) => event.from)).toEqual(['grok', 'claude']);
});

test('recipe: a step with tools is told it has them; a step without is told it has not', async () => {
  const prompts = [];
  const { chatId, dispatcher } = setup({
    peers: { grok: stubPeer('grok') },
    harness: ({ prompt }) => {
      prompts.push(prompt);
      return { status: 'handoff', message: 'done' };
    },
  });
  const run = await dispatcher.startRun({
    chatId,
    goal: 'ship it',
    recipe: {
      id: 'mixed',
      title: 'review then apply',
      steps: [
        { id: 'review', agent: 'claude' },
        { id: 'apply', agent: 'codex', tools: 'full' },
      ],
      edges: [
        { from: 'review', to: 'apply' },
        { from: 'apply', to: 'review' },
      ],
      budgets: { maxRounds: 1 },
    },
  });
  await dispatcher.waitFor(run.runId);

  // The live M2 run failed here: codex had tools and file access, and the
  // prompt told it "you have no tools, no file access", so it described the
  // change instead of making it.
  expect(prompts[0]).toContain('no tools');
  expect(prompts[1]).toContain('your usual tools');
  expect(prompts[1]).not.toContain('no tools');
});

test('recipe: a peer asking for a human is not presented as a question about rounds', async () => {
  const asking = {
    id: 'grok',
    available: () => true,
    async runTurn() {
      return { status: 'needs_human', message: 'I need to know which database this targets' };
    },
  };
  const { chatId, dispatcher } = setup({ peers: { grok: asking } });
  const run = await dispatcher.startRun({
    chatId,
    goal: 'ship it',
    recipe: { id: 'solo', title: 'solo', steps: [{ id: 'write', agent: 'grok' }], edges: [{ from: 'write', to: 'write' }], budgets: { maxRounds: 5 } },
  });
  await dispatcher.waitFor(run.runId);

  const relay = relayOf(chatId);
  expect(relay.status).toBe('waiting_gate');
  expect(relay.gateReason).toBe('ask');
  expect(eventsOfType(chatId, 'gate.requested').at(-1).textPreview).toMatch(/decision only you can make/);
});
