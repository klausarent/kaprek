// Trigger runner — the motor that turns a declarative trigger definition
// (see registry.mjs) into an actual chat turn, WITHOUT any user input. This
// is the mechanism behind kaprek's differentiator: every other local-agent
// product only reacts to something the user typed.
//
// Every path through fireTrigger() is fail-closed: a check that can't be
// satisfied (unknown trigger, limit reached, missing checklist, no
// approval handler for an escalation that requires one, ...) returns
// `{fired:false, reason}` and logs why — it never falls back to "just run
// it anyway".
import fs from 'node:fs';
import path from 'node:path';
import { openChats } from '../chats/store.mjs';
import { readFile as readWorkspaceFile } from '../workspace/fs.mjs';
import { readRuns } from '../orchestrator/runs.mjs';
import { SERVER_NAME as MCP_SERVER_NAME } from '../apps/mcp-server.mjs';
import { checkLimits } from './limits.mjs';

const CLAIM_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const HEARTBEAT_OK_MARKER = 'heartbeat_ok';

// Claude Code's documented convention for an MCP-provided tool's qualified
// name is `mcp__<server-name>__<tool-name>` (see mcp-config.mjs's
// `mcpServers` key, the same 'kaprek-apps' as MCP_SERVER_NAME here). A
// kaprek app's own tool id is itself "<app-id>.<action>" (see
// manifest.mjs's TOOL_ID_RE), so the app id a qualified tool name belongs
// to is the FIRST dot-segment after stripping this prefix.
const MCP_TOOL_PREFIX = `mcp__${MCP_SERVER_NAME}__`;

/**
 * Extracts the app id a qualified kaprek-apps MCP tool name belongs to, or
 * null if `toolName` isn't one of ours at all (e.g. a built-in CLI tool
 * like Bash/Write/WebFetch, or an MCP tool from some other server).
 *
 * NOT verified against a live CLI run — see task-7a-review.md's "cannot
 * verify from diff" note on the exact qualified-name format a real `claude`
 * process reports. That is a deliberate, safe direction to be wrong in: if
 * this assumption is off, notifyPolicyHandler() below denies MORE than it
 * should (every tool call fails to match and gets denied), never less —
 * fail-closed either way, just possibly over-strict until verified live.
 */
function appIdForMcpTool(toolName) {
  if (typeof toolName !== 'string' || !toolName.startsWith(MCP_TOOL_PREFIX)) return null;
  const toolId = toolName.slice(MCP_TOOL_PREFIX.length);
  const dotIndex = toolId.indexOf('.');
  return dotIndex > 0 ? toolId.slice(0, dotIndex) : null;
}

/**
 * The `escalation:'notify'` approval handler — a pure policy decision, no
 * human, no SSE, no timeout: allows ONLY a kaprek-apps MCP tool call whose
 * app id is in `trigger.appScope`; denies literally everything else (Bash,
 * Write, Edit, WebFetch, a Read outside the scoped apps, an MCP tool from an
 * app NOT in scope, ...). This is what makes "kein Trigger erzeugt
 * Außenwirkung ohne Freigabe" true for the DEFAULT escalation level by
 * kaprek's own code, instead of depending on whatever the underlying CLI
 * happens to do when no `--permission-prompt-tool` is wired at all (see
 * task-7a-review.md Critical #2) — this handler is ALWAYS passed to
 * runTurn() for a 'notify' trigger, so `--permission-prompt-tool stdio` is
 * always active for one (see claude-code.mjs::buildArgs()).
 */
function notifyPolicyHandler(trigger) {
  return async (request) => {
    const appId = appIdForMcpTool(request.toolName);
    if (appId !== null && trigger.appScope.includes(appId)) {
      return { behavior: 'allow' };
    }
    return { behavior: 'deny', message: 'not permitted for notify trigger' };
  };
}

function pad2(n) {
  return String(n).padStart(2, '0');
}

/** Local "YYYY-MM-DD" for `date`, matching the calendar day a user sees on their own clock. */
function localDateIso(date) {
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
}

/** Local "HH:MM" for `date`, minute precision (seconds/ms dropped — a tick only needs to hit the right minute once). */
function localHHMM(date) {
  return `${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
}

/**
 * The currently-due schedule slot for `trigger` at `nowMs`, or null if none
 * is due right now. For `everyMinutes`, every window has exactly one slot
 * (its start, floored to the interval) that stays "due" for the whole
 * window — idempotency across repeated ticks within it comes entirely from
 * the claim file (see tryClaim()), not from this function returning null a
 * second time. For `dailyAt`, a slot is due only in the exact minute it
 * names; a tick outside that minute sees no slot at all.
 */
function dueScheduleSlot(trigger, nowMs) {
  const date = new Date(nowMs);
  if (trigger.config.everyMinutes !== undefined) {
    const windowMs = trigger.config.everyMinutes * 60_000;
    const windowStart = Math.floor(nowMs / windowMs) * windowMs;
    return new Date(windowStart).toISOString();
  }
  if (localHHMM(date) !== trigger.config.dailyAt) return null;
  return `${localDateIso(date)}T${trigger.config.dailyAt}`;
}

/** Builds the final prompt: promptTemplate with {{reason}}/{{checklist}} substituted, plus a short generated context block (no template engine beyond that one substitution pass). */
function buildPrompt(trigger, { reason, checklist }) {
  const substituted = trigger.promptTemplate
    .split('{{reason}}')
    .join(reason ?? '')
    .split('{{checklist}}')
    .join(checklist ?? '');

  const contextLines = [
    `[trigger] id: ${trigger.id}`,
    `[trigger] cause: ${reason ?? 'n/a'}`,
    `[trigger] escalation: ${trigger.escalation}`,
  ];
  if (checklist !== undefined) contextLines.push(`[trigger] checklist:\n${checklist}`);

  return `${substituted}\n\n${contextLines.join('\n')}`;
}

/**
 * Creates a trigger runner bound to one dataDir/trigger registry.
 *
 * @param {object} options
 * @param {string} options.dataDir
 * @param {{list: Function, get: Function}} options.triggers - a registry.mjs::openTriggers() instance
 * @param {Function} options.runTurn - src/orchestrator/run.mjs::runTurn, injected so tests can pass a stub around a fake harness
 * @param {{startTurn: Function}} options.harness - e.g. src/harness/fake.mjs for tests
 * @param {string} [options.harnessName]
 * @param {string} options.cwd - the harness's working directory AND the
 *   workspace root a heartbeat trigger's checklistPath is read from (see
 *   src/workspace/fs.mjs) — same directory runTurn() passes to the CLI
 * @param {string} [options.permissionMode]
 * @param {() => number} [options.now] - injectable clock (default Date.now); tests never sleep
 * @param {(message: string) => void} [options.log] - every accept/reject decision is logged through this (default console.log)
 * @param {number} [options.tickMs] - setInterval period for start() (default 60_000)
 * @param {(chatId: string) => (request: import('../harness/adapter.mjs').ApprovalRequest) => Promise<import('../harness/adapter.mjs').ApprovalDecision>} [options.makeUiApprovalHandler] -
 *   a FACTORY, not a handler — called with the trigger turn's own chatId
 *   (known only once runTurn() resolves it, see run.mjs's onChatResolved)
 *   to build the actual per-turn handler. Used ONLY for `escalation:
 *   'question'|'review'` — a 'notify' trigger never needs this at all, it
 *   always gets its own self-contained notifyPolicyHandler() instead (see
 *   above). The server wires this to the SAME makeApprovalHandler() a
 *   normal chat turn uses (src/server/server.mjs), so a question/review
 *   trigger's approval surfaces over SSE if a client happens to be
 *   streaming that chatId, and auto-denies after the same timeout
 *   otherwise — see fireTrigger()'s escalation gate below for what happens
 *   when this option is omitted entirely (a runner built without it, e.g.
 *   in an isolated test).
 */
export function createTriggerRunner({
  dataDir,
  triggers,
  runTurn,
  harness,
  harnessName,
  cwd,
  permissionMode,
  now = Date.now,
  log = (message) => console.log(message),
  tickMs = 60_000,
  makeUiApprovalHandler,
}) {
  // Loop guard (part 2 of 2 — part 1 is the cause.origin==='trigger' check
  // in fireTrigger() itself): a trigger already running must not be started
  // again by an overlapping tick or a manual fire while it's still in
  // flight. Cleared in the `finally` below, so it can never leak a stuck id.
  const runningIds = new Set();
  let timer = null;

  function currentNow() {
    return now();
  }

  function claimsDir() {
    return path.join(dataDir, 'triggers', 'claims');
  }

  /** Filename-safe encoding of a slot for use in a claim's path — ':' is reserved on Windows (NTFS alternate-data-stream syntax), so it is not usable verbatim in a filename component. */
  function claimFilePath(triggerId, slot) {
    return path.join(claimsDir(), `${triggerId}-${slot.replace(/:/g, '-')}.claim`);
  }

  /** Exclusive-create a claim file for (triggerId, slot). Returns true if this call won the claim, false if the slot was already claimed. */
  function tryClaim(triggerId, slot) {
    fs.mkdirSync(claimsDir(), { recursive: true });
    try {
      fs.writeFileSync(claimFilePath(triggerId, slot), '', { flag: 'wx' });
      return true;
    } catch (err) {
      if (err.code === 'EEXIST') return false;
      throw err;
    }
  }

  /** Deletes claim files older than 7 days. Best-effort — a cleanup failure must never block firing. */
  function cleanupOldClaims() {
    const dir = claimsDir();
    if (!fs.existsSync(dir)) return;
    const cutoff = currentNow() - CLAIM_MAX_AGE_MS;
    for (const entry of fs.readdirSync(dir)) {
      const full = path.join(dir, entry);
      try {
        if (fs.statSync(full).mtimeMs < cutoff) fs.unlinkSync(full);
      } catch {
        // best-effort — a single unreadable/already-gone claim must not stop the sweep
      }
    }
  }

  /** allowedTools is derived from appScope, never left unset — an empty appScope MUST mean "no tools", not "the harness's own default set" (see run.mjs's allowedTools passthrough contract). */
  function allowedToolsFor(trigger) {
    return [...trigger.appScope];
  }

  /**
   * Whether a heartbeat trigger is due to fire again, based on its OWN last
   * run in runs.jsonl (not in-memory state — see limits.mjs's identical
   * reasoning) rather than "checklist exists" alone; the checklist check in
   * fireTrigger() below is a firing PRECONDITION, this is the tick's own
   * scheduling decision.
   */
  function heartbeatDue(trigger, nowMs) {
    const runs = readRuns(dataDir).filter((run) => run.triggerId === trigger.id);
    if (runs.length === 0) return true;
    const last = runs[runs.length - 1];
    const lastTs = Date.parse(last.ts);
    if (!Number.isFinite(lastTs)) return true;
    return nowMs - lastTs >= trigger.config.intervalMinutes * 60_000;
  }

  /**
   * A trigger's approval-wiring status — used both by fireTrigger()'s own
   * gate below and exposed to callers (GET /api/triggers, see
   * server.mjs::handleTriggersList) so a 'question'/'review' trigger that
   * structurally can never fire is visible via the API, not just a
   * console.log line (task-7a-review.md Important #2).
   */
  function approvalCapability(trigger) {
    if (trigger.escalation === 'notify') {
      return { approvalPath: 'policy', blocked: null };
    }
    if (typeof makeUiApprovalHandler !== 'function') {
      return { approvalPath: 'ui', blocked: 'no UI approval handler configured for this escalation level' };
    }
    return { approvalPath: 'ui', blocked: null };
  }

  /**
   * fireTrigger(id, {cause, onEvent, onChatId}) -> {fired, reason?, chatId?, result?, silent?}.
   * See the module doc comment for the fail-closed posture; the checks
   * below run in the exact order the task brief specifies.
   *
   * `onEvent`/`onChatId` (both optional) are forwarded straight through to
   * runTurn() — a caller that wants to stream a manually-fired trigger's
   * turn live (see server.mjs's SSE fire route) gets the exact same live
   * hooks a normal chat turn gets; a tick-driven background fire simply
   * omits them.
   */
  async function fireTrigger(id, { cause, onEvent, onChatId } = {}) {
    // 1/2. Loop guard, part 1: a run CAUSED by a trigger must never itself
    // fire another trigger — checked before even looking the trigger up, so
    // no trigger-shape detail can influence this decision.
    if (cause?.origin === 'trigger') {
      const reason = 'loop guard: a trigger-originated cause never fires another trigger';
      log(`trigger ${id}: rejected (${reason})`);
      return { fired: false, reason };
    }

    const trigger = triggers.get(id);
    if (!trigger) {
      const reason = 'unknown trigger';
      log(`trigger ${id}: rejected (${reason})`);
      return { fired: false, reason };
    }
    if (trigger.enabled !== true) {
      const reason = 'trigger disabled';
      log(`trigger ${id}: rejected (${reason})`);
      return { fired: false, reason };
    }

    // Loop guard, part 2: the same trigger must not run twice concurrently.
    if (runningIds.has(id)) {
      const reason = 'already running';
      log(`trigger ${id}: rejected (${reason})`);
      return { fired: false, reason };
    }

    const limitCheck = checkLimits({ dataDir, trigger, now: currentNow() });
    if (!limitCheck.allowed) {
      log(`trigger ${id}: rejected (${limitCheck.reason})`);
      return { fired: false, reason: limitCheck.reason };
    }

    // Type-specific firing precondition.
    let checklist;
    let slot;
    let reasonText;
    if (trigger.type === 'heartbeat') {
      try {
        checklist = readWorkspaceFile({ workspaceDir: cwd, relPath: trigger.config.checklistPath });
      } catch {
        const reason = `heartbeat checklist not found: ${trigger.config.checklistPath}`;
        log(`trigger ${id}: rejected (${reason})`);
        return { fired: false, reason };
      }
      reasonText = `heartbeat interval reached (every ${trigger.config.intervalMinutes}m)`;
    } else {
      slot = dueScheduleSlot(trigger, currentNow());
      if (slot === null) {
        const reason = 'no schedule slot due right now';
        log(`trigger ${id}: rejected (${reason})`);
        return { fired: false, reason };
      }
      if (!tryClaim(id, slot)) {
        const reason = `schedule slot already claimed: ${slot}`;
        log(`trigger ${id}: rejected (${reason})`);
        return { fired: false, reason };
      }
      reasonText = `schedule slot due: ${slot}`;
    }

    // Escalation gate: EVERY trigger turn gets a real approval handler, no
    // exceptions — a 'notify' trigger always has one (its own self-contained
    // notifyPolicyHandler(), built below, needs nothing external). Only
    // 'question'/'review' can actually be unfireable here: they need
    // makeUiApprovalHandler wired (see approvalCapability() above); without
    // it the trigger does not fire at all — never "fires but auto-denies
    // every tool call", which would just be a confusing silent failure deep
    // inside the turn instead of a clear, logged rejection here.
    const capability = approvalCapability(trigger);
    if (capability.blocked) {
      log(`trigger ${id}: rejected (${capability.blocked})`);
      return { fired: false, reason: capability.blocked };
    }

    // Everything past this point is synchronous up to the `await runTurn`
    // call below, so runningIds.add() here is what makes the "already
    // running" check above race-free against a second fireTrigger() call
    // issued before this one's first await (see the module doc comment).
    // It also backs isAnyTriggerRunning() (server-level loop-guard layer 2,
    // see server.mjs's fire route) — runningIds.size > 0 means SOME
    // trigger-origin turn is currently in flight, not just this one.
    runningIds.add(id);
    try {
      const prompt = buildPrompt(trigger, { reason: reasonText, checklist });

      // A question/review handler needs the turn's chatId in its closure
      // (makeUiApprovalHandler(chatId) -> handler), but chatId is only
      // known once runTurn() resolves/creates it — resolvedChatId is filled
      // in by onChatResolved below, called synchronously BEFORE
      // harness.startTurn() ever runs, so strictly before any approval
      // request could possibly arrive (see run.mjs's own doc comment on
      // onChatResolved). notifyPolicyHandler() needs none of this.
      let resolvedChatId = null;
      const approvalHandlerForTurn =
        trigger.escalation === 'notify' ? notifyPolicyHandler(trigger) : (request) => makeUiApprovalHandler(resolvedChatId)(request);

      const result = await runTurn({
        dataDir,
        text: prompt,
        harness,
        harnessName,
        cwd,
        permissionMode,
        allowedTools: allowedToolsFor(trigger),
        onApprovalRequest: approvalHandlerForTurn,
        onEvent,
        onChatResolved: (chatId) => {
          resolvedChatId = chatId;
          onChatId?.(chatId);
        },
        origin: 'trigger',
        triggerId: id,
        silent: false,
      });

      let silent = false;
      if (trigger.type === 'heartbeat' && result.chatId) {
        silent = maybeSilenceHeartbeatChat(result.chatId);
      }

      log(`trigger ${id}: fired (chatId=${result.chatId ?? 'n/a'}, silent=${silent})`);
      return { fired: true, chatId: result.chatId, result, silent };
    } finally {
      runningIds.delete(id);
    }
  }

  /**
   * A heartbeat run is only "silent" (hidden from the visible chat list by
   * default) if BOTH hold: the final reply is exactly HEARTBEAT_OK (trimmed,
   * case-insensitive) AND no tool ran during the turn at all. The text alone
   * is not trustworthy — a turn that ran e.g. a WebFetch/Read and still
   * happened to answer "HEARTBEAT_OK" did something real and must stay
   * visible regardless of what its final reply claims (task-7a-review.md
   * Important #1).
   */
  function maybeSilenceHeartbeatChat(chatId) {
    const chats = openChats(dataDir);
    let events;
    try {
      events = chats.events(chatId);
    } catch {
      return false; // best-effort — a lookup failure here must not fail an already-completed turn
    }
    if (events.some((e) => e.kind === 'tool')) return false;
    const lastAssistant = [...events].reverse().find((e) => e.kind === 'assistant');
    const text = typeof lastAssistant?.text === 'string' ? lastAssistant.text.trim().toLowerCase() : null;
    if (text !== HEARTBEAT_OK_MARKER) return false;
    chats.setSilent(chatId, true);
    return true;
  }

  /** One scan over every enabled trigger, firing whichever is due right now. Fire-and-forget per trigger — a rejected/errored one must not block the others in the same tick. */
  function tick() {
    const nowMs = currentNow();
    for (const trigger of triggers.list()) {
      if (!trigger.enabled) continue;
      const due = trigger.type === 'heartbeat' ? heartbeatDue(trigger, nowMs) : dueScheduleSlot(trigger, nowMs) !== null;
      if (!due) continue;
      const cause = { origin: trigger.type === 'heartbeat' ? 'heartbeat' : 'schedule' };
      fireTrigger(trigger.id, { cause }).catch((err) => {
        log(`trigger ${trigger.id}: tick error: ${err?.message ?? String(err)}`);
      });
    }
  }

  /** Starts the tick timer (idempotent) and sweeps stale claim files once. `unref()`'d so a process exiting with the runner still "running" is never blocked by it. */
  function start() {
    cleanupOldClaims();
    if (timer) return;
    timer = setInterval(tick, tickMs);
    if (typeof timer.unref === 'function') timer.unref();
  }

  /** Stops the tick timer (idempotent). */
  function stop() {
    if (!timer) return;
    clearInterval(timer);
    timer = null;
  }

  /**
   * Loop-guard layer 2 (see server.mjs's fire route doc comment for layer
   * 1/3): true while ANY trigger-origin turn is in flight, not just a
   * specific id. Deliberately coarse — a manual user fire briefly blocked by
   * an unrelated already-running heartbeat is an acceptable false positive;
   * an unnoticed trigger-A-fires-trigger-B-fires-trigger-A chain over HTTP
   * is not.
   */
  function isAnyTriggerRunning() {
    return runningIds.size > 0;
  }

  return { fireTrigger, tick, start, stop, isAnyTriggerRunning, approvalCapability };
}
