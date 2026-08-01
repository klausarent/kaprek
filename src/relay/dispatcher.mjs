// The relay dispatcher: a controlled handoff loop between agents.
//
// THE PROBLEM IT SOLVES. Today the operator is the postman. Grok writes a
// batch, the operator copies it to Claude, Claude reviews it, the operator
// copies the review back. The work is real and the handoffs are invisible:
// nothing is recorded, nothing is budgeted, and the only thing stopping a
// loop is that a human gets tired. This turns each handoff into an event in
// the chat log, under a budget, with a human gate every couple of rounds.
//
// WHAT IT IS NOT. Not a chat between agents, not a workflow engine, not a
// network protocol. A run has a fixed route (grok, then claude), a fixed
// number of rounds before it must ask a human, and a hard turn ceiling. The
// peers cannot address each other, cannot change the route, and cannot extend
// their own budget - all three were considered and rejected, because a soft
// protocol read out of model output is exactly how these loops run away.
//
// THE HUMAN GATE is the deferred inbox this codebase already has: after
// RELAY_ROUNDS_PER_GATE full rounds the run files a question and stops. An
// approval is a voucher for exactly ONE more round, bound to the route and
// budget it was granted under, so an approval given for one shape of run
// cannot be spent on another.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

/** Full rounds (every peer on the route once) before the run must ask a human. Conservative on purpose: two rounds is enough to see whether the pair is converging, and short enough that a bad run costs little. */
export const RELAY_ROUNDS_PER_GATE = 2;

/** Absolute ceiling on turns in one run, gates included. The backstop for every case the other limits do not anticipate. */
export const RELAY_MAX_TURNS = 12;

/** Wall clock for a whole run. A run that has been going for an hour has stopped being a handoff and become a background process. */
export const RELAY_RUN_WALL_MS = 60 * 60_000;

/** How much of a message goes into the event line. The rest lives in the body artifact. */
export const RELAY_PREVIEW_CHARS = 4000;

/** How much of the previous peer's body is quoted into the next peer's prompt. Past this it gets the preview and the path. */
export const RELAY_CONTEXT_LIMIT_BYTES = 256 * 1024;

/** v1 route: one peer writes, Claude reviews. Fixed, not configurable per turn. */
export const RELAY_DEFAULT_ROUTE = Object.freeze(['grok', 'claude']);

/** The approval kind a relay gate files. Lets the inbox and the UI tell a gate from a tool-use question. */
export const RELAY_GATE_KIND = 'relay.gate';

/** Statuses a run can be in. `interrupted` is the one that matters most — see resumeAfterRestart(). */
export const RELAY_STATUSES = Object.freeze(['active', 'waiting_gate', 'interrupted', 'completed', 'stopped']);

function sha256(value) {
  return crypto.createHash('sha256').update(value, 'utf8').digest('hex');
}

/**
 * The identity of one handoff: this run, from this event, to this peer.
 *
 * Deterministic on purpose. If the process dies between deciding to dispatch
 * and recording the result, the id computed on the way back up is the same
 * one, so the log can be asked "did this already happen?" instead of guessing.
 * That is what makes replay-after-crash a decision rather than an accident.
 */
export function dispatchIdFor(runId, sourceEventId, targetPeer) {
  return sha256(`${runId}\u0000${sourceEventId}\u0000${targetPeer}`);
}

/**
 * What a gate voucher is bound to. An approval says "one more round of THIS
 * run, as it stands right now" - so if the route or the budget changed
 * between asking and answering, the voucher is for a run that no longer
 * exists and must not be spendable.
 */
export function participantsHashOf(relay) {
  return sha256(JSON.stringify(relay.route ?? []));
}

export function budgetSnapshotHashOf(relay) {
  return sha256(JSON.stringify([relay.maxRounds ?? null, relay.hardMaxTurns ?? null]));
}

/** A run's artifact directory, relative to dataDir. Deliberately NOT under workspace/: agents watch the workspace, and a relay writing there would be a loop with extra steps. */
export function artifactDirFor(runId) {
  return path.join('relay', runId);
}

/**
 * Writes one message body to the run's artifact directory and returns what the
 * event should carry. The event gets a preview and a reference; the file gets
 * everything. 85 drafts do not belong in a log line, and they do not belong in
 * the next prompt either without someone deciding so.
 */
export function writeBody({ dataDir, runId, turn, from, text }) {
  const relDir = artifactDirFor(runId);
  const absDir = path.join(dataDir, relDir);
  fs.mkdirSync(absDir, { recursive: true });
  const name = `${String(turn).padStart(3, '0')}-${from}.md`;
  fs.writeFileSync(path.join(absDir, name), text, 'utf8');
  return {
    bodyRef: path.join(relDir, name).split(path.sep).join('/'),
    bodySha256: sha256(text),
    textPreview: text.slice(0, RELAY_PREVIEW_CHARS),
  };
}

/** Reads a body back for the next prompt, capped: past the limit the peer gets the head plus a note, not a truncated draft pretending to be whole. */
export function readBodyForPrompt(dataDir, bodyRef) {
  const abs = path.join(dataDir, bodyRef);
  let text;
  try {
    text = fs.readFileSync(abs, 'utf8');
  } catch (err) {
    return `(the previous message could not be read back: ${err.message})`;
  }
  if (Buffer.byteLength(text, 'utf8') <= RELAY_CONTEXT_LIMIT_BYTES) return text;
  return `${text.slice(0, RELAY_CONTEXT_LIMIT_BYTES)}\n\n[truncated for context; the whole text is in ${bodyRef}]`;
}

/**
 * The prompt one peer gets. Everything it knows comes from here: the goal, its
 * role, what the last peer produced, and what it is allowed to answer. There
 * is no session and no memory, so this text IS the peer's world - which is
 * also why the whole thing is reconstructable from the log.
 */
export function buildPeerPrompt({ goal, role, round, maxRounds, previous, previousFrom }) {
  const lines = [
    `You are taking part in a controlled two-agent handoff. Your role: ${role}.`,
    `The operator's goal for this run: ${goal}`,
    `This is round ${round} of ${maxRounds} before a human is asked whether to continue.`,
    '',
    'Answer as JSON with exactly two fields:',
    '  status  - "handoff" to pass your work to the other agent, "done" when the goal is met,',
    '            "needs_human" when you cannot proceed without a decision only a person can make.',
    '  message - your actual work: the draft, the review, the revision. Not a summary of what you would do.',
    '',
    'You have no tools, no file access and no web search. Work from the text below alone.',
  ];
  if (previous) {
    lines.push('', `--- what ${previousFrom} produced ---`, previous, '--- end ---');
  } else {
    lines.push('', 'You are first: there is nothing from the other agent yet.');
  }
  return lines.join('\n');
}

/**
 * Creates the relay dispatcher.
 *
 * Everything it needs is injected, for the usual reason plus one specific to
 * this module: a relay test must be able to run a whole multi-round handoff
 * without a single real CLI, or the tests that matter here (rounds, gates,
 * vouchers, dedupe) could never run in CI.
 *
 * @param {object} options
 * @param {string} options.dataDir
 * @param {() => object} options.getChats - openChats() factory, re-opened per call like server.mjs does
 * @param {object} options.approvalStore - the deferred inbox; gates are entries in it
 * @param {(peerId: string) => object|null} options.getPeerDriver
 * @param {(options: object) => Promise<object>} options.runClaudeTurn - how a Claude review turn runs (server.mjs wires runTurn)
 * @param {() => {allowed: boolean, reason: string|null}} [options.canStartTurn] - the shared concurrency ceiling; a relay turn counts like a trigger turn
 * @param {(chatId: string) => void} [options.onTurnStart]
 * @param {(chatId: string) => void} [options.onTurnEnd]
 * @param {() => number} [options.now]
 * @param {(message: string) => void} [options.log]
 */
export function createRelayDispatcher({
  dataDir,
  getChats,
  approvalStore,
  getPeerDriver,
  runClaudeTurn,
  canStartTurn = () => ({ allowed: true, reason: null }),
  onTurnStart = () => {},
  onTurnEnd = () => {},
  now = Date.now,
  log = () => {},
} = {}) {
  /** runId -> {chatId, abort, promise}. Only ever holds runs this process is driving. */
  const active = new Map();

  function appendRelayEvent(chatId, event) {
    const chats = getChats();
    chats.appendEvent(chatId, { kind: 'relay', ...event });
  }

  function saveRelay(chatId, relay) {
    getChats().setRelay(chatId, relay);
  }

  function relayOf(chatId) {
    return getChats().get(chatId).relay ?? null;
  }

  /**
   * Has this exact handoff already produced a terminal event? The question a
   * deterministic dispatch id exists to make answerable (see dispatchIdFor).
   */
  function alreadyDispatched(chatId, dispatchId) {
    return getChats()
      .events(chatId)
      .some(
      (event) => event.kind === 'relay' && event.dispatchId === dispatchId && ['message', 'dispatch.failed'].includes(event.eventType),
    );
  }

  /** Runs one peer's turn and records it. Returns the peer's answer, or null when the turn failed (already recorded as dispatch.failed). */
  async function runPeerTurn({ chatId, relay, peerId, sourceEventId, previous, previousFrom, signal }) {
    const dispatchId = dispatchIdFor(relay.runId, sourceEventId, peerId);
    if (alreadyDispatched(chatId, dispatchId)) {
      log(`relay ${relay.runId}: dispatch ${dispatchId.slice(0, 8)} already has a result, skipping`);
      return null;
    }

    appendRelayEvent(chatId, {
      eventType: 'dispatch.started',
      runId: relay.runId,
      from: previousFrom ?? null,
      to: peerId,
      round: relay.rounds + 1,
      turn: relay.turns + 1,
      dispatchId,
    });

    const prompt = buildPeerPrompt({
      goal: relay.goal,
      role: peerId === 'claude' ? 'review the other agent\'s work and say plainly what is wrong with it' : 'produce the work the goal asks for',
      round: relay.rounds + 1,
      maxRounds: relay.maxRounds,
      previous,
      previousFrom,
    });

    try {
      const answer =
        peerId === 'claude'
          ? await runClaudeTurn({ chatId, prompt, signal, runId: relay.runId })
          : await (() => {
              const driver = getPeerDriver(peerId);
              if (!driver) throw new Error(`no driver for peer "${peerId}"`);
              return driver.runTurn({
                cwd: path.join(dataDir, 'workspace'),
                prompt,
                signal,
                logDir: path.join(dataDir, 'relay', 'logs'),
              });
            })();

      const body = writeBody({ dataDir, runId: relay.runId, turn: relay.turns + 1, from: peerId, text: answer.message });
      appendRelayEvent(chatId, {
        eventType: 'message',
        runId: relay.runId,
        from: peerId,
        to: null,
        round: relay.rounds + 1,
        turn: relay.turns + 1,
        status: answer.status,
        driver: peerId,
        driverVersion: answer.driverVersion ?? null,
        costUsd: answer.costUsd ?? null,
        // Always true, for every peer: a subscription CLI's per-turn figure is
        // derived from list prices nobody is actually paying (see
        // driver.mjs::PEER_COST_ESTIMATED).
        costEstimated: true,
        dispatchId,
        ...body,
      });
      return { ...answer, ...body, dispatchId };
    } catch (err) {
      appendRelayEvent(chatId, {
        eventType: 'dispatch.failed',
        runId: relay.runId,
        to: peerId,
        round: relay.rounds + 1,
        turn: relay.turns + 1,
        dispatchId,
        reason: err?.message ?? String(err),
      });
      return null;
    }
  }

  /** Files the gate question in the deferred inbox and parks the run. */
  async function requestGate(chatId, relay, lastPreview) {
    // The store keys entries by `chatId:requestId` (see
    // server.mjs::approvalKey) because a bare request id is not unique across
    // chats. A gate has to use the same shape or the answer route would look
    // it up under a key that does not exist.
    const requestId = `relay:${relay.runId}:round-${relay.rounds}`;
    const approvalKey = `${chatId}:${requestId}`;
    const question = [
      `Relay "${relay.goal}": ${relay.rounds} of ${relay.maxRounds} rounds done.`,
      'Approve one more round, or deny to stop the run.',
    ].join(' ');

    try {
      await approvalStore.put({
        id: approvalKey,
        requestId,
        chatId,
        mode: 'deferred',
        kind: RELAY_GATE_KIND,
        toolName: 'relay',
        displayName: `Relay: ${relay.goal}`.slice(0, 120),
        input: { runId: relay.runId, route: relay.route, rounds: relay.rounds, preview: (lastPreview ?? '').slice(0, 1000) },
        description: question,
        requestedAt: now(),
        deadlineAt: now() + 24 * 60 * 60_000,
        // The voucher's binding. An approval is for one more round of the run
        // AS IT STANDS: change the route or the budget in between and it is
        // an approval for a run that no longer exists.
        relayRunId: relay.runId,
        participantsHash: participantsHashOf(relay),
        budgetSnapshotHash: budgetSnapshotHashOf(relay),
      });
    } catch (err) {
      log(`relay ${relay.runId}: could not file the gate question (${err.message})`);
    }

    const parked = { ...relay, status: 'waiting_gate', gateKey: approvalKey };
    saveRelay(chatId, parked);
    appendRelayEvent(chatId, { eventType: 'gate.requested', runId: relay.runId, round: relay.rounds, approvalKey, textPreview: question });
    return parked;
  }

  function finish(chatId, relay, status, reason) {
    const done = { ...relay, status };
    saveRelay(chatId, done);
    appendRelayEvent(chatId, {
      eventType: status === 'completed' ? 'run.completed' : 'run.stopped',
      runId: relay.runId,
      round: relay.rounds,
      turn: relay.turns,
      reason: reason ?? null,
    });
    return done;
  }

  /**
   * Drives the run until it must stop: goal met, gate due, budget spent, or
   * nothing changing. One turn at a time, always - a relay that fans out is a
   * relay nobody can follow.
   */
  async function drive(chatId, { signal } = {}) {
    let relay = relayOf(chatId);
    if (!relay || relay.status !== 'active') return relay;

    const startedAt = now();
    let lastHashByPeer = relay.lastHashByPeer ?? {};
    let previous = relay.lastBodyRef ? readBodyForPrompt(dataDir, relay.lastBodyRef) : null;
    let previousFrom = relay.lastFrom ?? null;
    let sourceEventId = relay.lastDispatchId ?? `${relay.runId}:start`;

    for (;;) {
      if (signal?.aborted) return finish(chatId, relay, 'stopped', 'stopped by the operator');
      if (relay.turns >= relay.hardMaxTurns) return finish(chatId, relay, 'stopped', `hard turn limit reached (${relay.hardMaxTurns})`);
      if (now() - startedAt > RELAY_RUN_WALL_MS) return finish(chatId, relay, 'stopped', 'the run hit its wall clock');

      const gate = canStartTurn();
      if (!gate.allowed) return finish(chatId, relay, 'stopped', gate.reason ?? 'no turn slot available');

      const peerId = relay.route[relay.roundPos ?? 0];
      onTurnStart(chatId);
      let answer;
      try {
        answer = await runPeerTurn({ chatId, relay, peerId, sourceEventId, previous, previousFrom, signal });
      } finally {
        onTurnEnd(chatId);
      }

      if (!answer) return finish(chatId, relay, 'stopped', `the handoff to ${peerId} failed`);

      // NO PROGRESS. The same peer producing byte-identical output twice is
      // not a handoff, it is a loop that happens to cost money. Compared by
      // hash rather than by eye because the texts are long.
      if (lastHashByPeer[peerId] === answer.bodySha256) {
        relay = { ...relay, turns: relay.turns + 1 };
        return finish(chatId, relay, 'stopped', `${peerId} produced the same output twice`);
      }
      lastHashByPeer = { ...lastHashByPeer, [peerId]: answer.bodySha256 };

      const nextPos = ((relay.roundPos ?? 0) + 1) % relay.route.length;
      const completedRound = nextPos === 0;
      relay = {
        ...relay,
        turns: relay.turns + 1,
        rounds: completedRound ? relay.rounds + 1 : relay.rounds,
        roundPos: nextPos,
        lastHashByPeer,
        lastBodyRef: answer.bodyRef,
        lastFrom: peerId,
        lastDispatchId: answer.dispatchId,
      };
      saveRelay(chatId, relay);

      previous = readBodyForPrompt(dataDir, answer.bodyRef);
      previousFrom = peerId;
      sourceEventId = answer.dispatchId;

      if (answer.status === 'done') return finish(chatId, relay, 'completed', `${peerId} reported the goal is met`);
      // A peer asking for a human is not a failure and does not wait for the
      // round to end: whatever it needs decided, it needs decided now.
      if (answer.status === 'needs_human') return requestGate(chatId, relay, answer.textPreview);
      if (completedRound && relay.rounds >= relay.maxRounds) return requestGate(chatId, relay, answer.textPreview);
    }
  }

  function launch(chatId, relay) {
    const controller = new AbortController();
    const promise = drive(chatId, { signal: controller.signal })
      .catch((err) => {
        log(`relay ${relay.runId}: driving failed (${err?.message ?? String(err)})`);
        try {
          finish(chatId, relayOf(chatId) ?? relay, 'stopped', `internal error: ${err?.message ?? String(err)}`);
        } catch {
          // the chat is gone; nothing left to record
        }
      })
      .finally(() => active.delete(relay.runId));
    active.set(relay.runId, { chatId, abort: () => controller.abort(), promise });
    return promise;
  }

  return {
    /**
     * Starts a run on an existing chat. Refuses if that chat already hosts one
     * that has not finished - a chat is one conversation, and two relays
     * writing into it would produce a transcript nobody can read.
     */
    async startRun({ chatId, goal, route = RELAY_DEFAULT_ROUTE, maxRounds = RELAY_ROUNDS_PER_GATE }) {
      if (typeof goal !== 'string' || goal.trim().length === 0) throw new Error('a relay run needs a goal');
      const existing = relayOf(chatId);
      if (existing && ['active', 'waiting_gate'].includes(existing.status)) {
        throw new Error('this chat already has a relay run in progress');
      }
      for (const peerId of route) {
        if (peerId !== 'claude' && !getPeerDriver(peerId)) throw new Error(`unknown peer "${peerId}"`);
      }

      const runId = crypto.randomUUID();
      const relay = {
        runId,
        status: 'active',
        route: [...route],
        goal: goal.trim(),
        maxRounds,
        hardMaxTurns: RELAY_MAX_TURNS,
        rounds: 0,
        turns: 0,
        roundPos: 0,
        artifactDir: artifactDirFor(runId).split(path.sep).join('/'),
        startedAt: now(),
      };
      saveRelay(chatId, relay);
      appendRelayEvent(chatId, { eventType: 'run.created', runId, goal: relay.goal, route: relay.route });
      launch(chatId, relay);
      return relay;
    },

    /** Stops a run mid-flight. The in-flight peer turn is aborted; what it already produced stays in the log. */
    async stopRun(runId, reason = 'stopped by the operator') {
      const running = active.get(runId);
      if (running) {
        running.abort();
        await running.promise.catch(() => {});
        return { stopped: true };
      }
      // Not driven by this process (a restart, or already finished): record
      // the stop against the chat that owns it, if it can be found.
      for (const chat of getChats().list()) {
        const relay = getChats().get(chat.id).relay;
        if (relay?.runId !== runId) continue;
        if (['completed', 'stopped'].includes(relay.status)) return { stopped: false, reason: 'the run had already finished' };
        finish(chat.id, relay, 'stopped', reason);
        return { stopped: true };
      }
      return { stopped: false, reason: 'unknown run' };
    },

    /**
     * Spends a gate voucher: one more round, and only if the run still looks
     * like the run the approval was given for.
     *
     * The hash check is the whole point. An approval is a statement about a
     * specific run at a specific moment; if the route or the budget changed in
     * between, the operator approved something else. Failing closed here costs
     * one click and prevents an approval from being laundered into a run
     * nobody agreed to.
     */
    async resumeAfterGate({ chatId, voucher }) {
      const relay = relayOf(chatId);
      if (!relay) throw new Error('this chat has no relay run');
      if (relay.status !== 'waiting_gate') throw new Error(`the run is ${relay.status}, not waiting at a gate`);
      if (voucher?.participantsHash !== participantsHashOf(relay) || voucher?.budgetSnapshotHash !== budgetSnapshotHashOf(relay)) {
        throw new Error('this approval was given for a different route or budget and can no longer be spent');
      }

      appendRelayEvent(chatId, { eventType: 'gate.resolved', runId: relay.runId, round: relay.rounds, approvalKey: voucher.approvalKey ?? null });
      // ONE voucher, ONE round. The ceiling moves by exactly one, so the next
      // gate is due the moment that round ends - not two rounds later, and
      // not "until the peers feel finished". Raising it by the original
      // maxRounds instead would quietly double the run on every approval.
      const resumed = { ...relay, status: 'active', maxRounds: relay.maxRounds + 1, gateKey: null };
      saveRelay(chatId, resumed);
      launch(chatId, resumed);
      return resumed;
    },

    /** Denies a gate: the run stops where it stands. */
    async denyGate({ chatId, reason = 'gate denied' }) {
      const relay = relayOf(chatId);
      if (!relay) throw new Error('this chat has no relay run');
      return finish(chatId, relay, 'stopped', reason);
    },

    /**
     * Marks runs that were mid-dispatch when the process died.
     *
     * NEVER auto-replays them, and that is a decision with scar tissue behind
     * it: this codebase has already shipped a bug where an approval was spent
     * on a turn that never ran. A dispatch whose result was never recorded may
     * or may not have reached the peer, and the only honest thing to say about
     * it is that nobody knows. The operator can start a new run from what the
     * log does show.
     */
    resumeAfterRestart() {
      const chats = getChats();
      const interrupted = [];
      for (const summary of chats.list()) {
        const relay = chats.get(summary.id).relay;
        if (!relay || !['active'].includes(relay.status)) continue;

        const events = chats.events(summary.id);
        const started = events.filter((event) => event.kind === 'relay' && event.eventType === 'dispatch.started');
        const terminal = new Set(
          events
            .filter((event) => event.kind === 'relay' && ['message', 'dispatch.failed'].includes(event.eventType))
            .map((event) => event.dispatchId),
        );
        const dangling = started.filter((event) => !terminal.has(event.dispatchId));
        const marked = { ...relay, status: 'interrupted' };
        chats.setRelay(summary.id, marked);
        chats.appendEvent(summary.id, {
          kind: 'relay',
          eventType: 'run.interrupted',
          runId: relay.runId,
          round: relay.rounds,
          turn: relay.turns,
          reason:
            dangling.length > 0
              ? `kaprek stopped while a handoff to ${dangling[dangling.length - 1].to} was in flight; its outcome is unknown and it will not be repeated automatically`
              : 'kaprek stopped while this run was active',
        });
        interrupted.push({ chatId: summary.id, runId: relay.runId });
      }
      return interrupted;
    },

    /** Whether this process is currently driving that run — the concurrency question the server asks. */
    isRunning(runId) {
      return active.has(runId);
    },

    /**
     * Resolves once this process has stopped driving the run — because it
     * finished, gated, or was stopped. Not needed by the server, which starts
     * a run and answers the request immediately; it exists so a test can say
     * "when the run has settled" instead of guessing at a number of ticks,
     * which is the difference between a deterministic test and a flaky one.
     */
    async waitFor(runId) {
      const running = active.get(runId);
      if (running) await running.promise.catch(() => {});
      return true;
    },

    activeRunCount() {
      return active.size;
    },
  };
}
