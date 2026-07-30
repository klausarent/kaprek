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
import { checkLimits } from './limits.mjs';

const CLAIM_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const HEARTBEAT_OK_MARKER = 'heartbeat_ok';

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
 * @param {(request: import('../harness/adapter.mjs').ApprovalRequest) => Promise<import('../harness/adapter.mjs').ApprovalDecision>} [options.onApprovalRequest] -
 *   forwarded to runTurn() for a trigger whose `approvalRequired` is true.
 *   Omitted entirely means such a trigger never fires (fail-closed) — see
 *   fireTrigger()'s step 4. The server wires this up to the same
 *   makeApprovalHandler() a normal chat turn uses once a live UI exists for
 *   it (task 8); until then this stays undefined in production, which is
 *   itself the correct, safe default for 'question'/'review' triggers.
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
  onApprovalRequest,
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
   * fireTrigger(id, {cause}) -> {fired, reason?, chatId?, result?, silent?}.
   * See the module doc comment for the fail-closed posture; the checks
   * below run in the exact order the task brief specifies.
   */
  async function fireTrigger(id, { cause } = {}) {
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

    // Escalation gate: 'question'/'review' REQUIRE a live approval handler.
    // Without one the trigger does not fire at all — never "fires but
    // auto-denies every tool call", which would just be a confusing silent
    // failure deep inside the turn instead of a clear, logged rejection here.
    if (trigger.approvalRequired && typeof onApprovalRequest !== 'function') {
      const reason = 'approval required but no approval handler configured';
      log(`trigger ${id}: rejected (${reason})`);
      return { fired: false, reason };
    }

    // Everything past this point is synchronous up to the `await runTurn`
    // call below, so runningIds.add() here is what makes the "already
    // running" check above race-free against a second fireTrigger() call
    // issued before this one's first await (see the module doc comment).
    runningIds.add(id);
    try {
      const prompt = buildPrompt(trigger, { reason: reasonText, checklist });
      const result = await runTurn({
        dataDir,
        text: prompt,
        harness,
        harnessName,
        cwd,
        permissionMode,
        allowedTools: allowedToolsFor(trigger),
        onApprovalRequest: trigger.approvalRequired ? onApprovalRequest : undefined,
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

  /** If the chat's last assistant reply is exactly HEARTBEAT_OK (trimmed, case-insensitive), hides it from the visible chat list. Returns whether it was silenced. */
  function maybeSilenceHeartbeatChat(chatId) {
    const chats = openChats(dataDir);
    let events;
    try {
      events = chats.events(chatId);
    } catch {
      return false; // best-effort — a lookup failure here must not fail an already-completed turn
    }
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

  return { fireTrigger, tick, start, stop };
}
