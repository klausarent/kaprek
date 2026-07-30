// approval-store.mjs — the persistent approval inbox.
//
// WHY IT EXISTS: a tool-use approval used to live in exactly two places, both
// of them fragile. In `pendingApprovals` (a process-local Map in server.mjs),
// and as a single SSE frame pushed at the moment the question was raised. A
// browser that was not connected AT THAT MOMENT never learned the question
// existed — opening kaprek a minute later showed nothing, and the request sat
// invisible until its own timer denied it. That is why an unattended
// 'question'/'review' trigger is refused outright today
// (runner.mjs::approvalCapability -> 'needs an open UI to ask for approval'):
// the honest thing to do when a question can only be delivered to a listener
// that isn't there. This store is the missing half — a question that can be
// LOOKED UP (GET /api/approvals) instead of only pushed, so a tab opened after
// the fact still finds it.
//
// WHAT IT DOES NOT DO — read this before writing a sentence about it anywhere:
//
//   1. It is NOT restart-proof. A pending approval means a `claude` CLI
//      subprocess is blocked on a `can_use_tool` control request, waiting for
//      a response on the stdin this server owns. Kill the server and that
//      child dies with it; the promise that would have carried the answer was
//      a JS closure in the dead process's heap. Nothing on disk can bring
//      either back. Entries from a previous process are therefore marked
//      `expired: 'process gone'` on load and REFUSED by decide() — the file
//      exists so the user can be told what died, not so kaprek can pretend to
//      redeem it.
//   2. It does not make anyone answer. `listPending()` is a queue, not a
//      promise of attention. The single wait is bounded by the caller's own
//      deadline (see the two constants below) and auto-denied when it runs
//      out — fail-closed, same as before.
//
// One data dir means one kaprek process (see src/lib/instance-lock.mjs), so
// this file has exactly one writer at a time. It is still written atomically
// (temp file in the same directory, then rename — same pattern as
// registry.mjs::writeTriggers) because a crash mid-write must not leave a
// half-written inbox behind: that file is the only record of what was pending.
import fs from 'node:fs';
import path from 'node:path';

/**
 * How long ONE approval question raised by an interactive chat turn may wait
 * before it is auto-denied. Ten minutes because a human is demonstrably at the
 * other end of a chat turn — they typed it. Was server.mjs's
 * DEFAULT_APPROVAL_TIMEOUT_MS.
 */
export const APPROVAL_DEADLINE_INTERACTIVE_MS = 10 * 60_000;

/**
 * How long ONE approval question raised by an UNATTENDED turn (a trigger that
 * fired on its own) may wait in the inbox before it is auto-denied.
 *
 * This is the PRIMARY bound on waiting, and the reason it is not simply
 * "forever": every second of it is a `claude` CLI subprocess held open with a
 * blocked tool call, plus this trigger's slot in the runner's loop guard (see
 * runner.mjs::isAnyTriggerRunning — while it waits, POST
 * /api/triggers/<id>/fire answers 429). Eight hours is the shortest span that
 * covers the case the inbox is built for: a trigger fires at night, the user
 * sees it the next morning. It is deliberately not 24h — a question nobody
 * answered by the next working morning is stale, and holding a CLI process for
 * a day to ask again is worse than denying and letting the trigger re-fire.
 *
 * The turn's own wall clock must be sized around this, not the other way
 * round: src/harness/timeout.mjs's `absolute` clock counts approval-wait time
 * in full and would otherwise kill the very overnight wait this constant
 * allows. See runner.mjs::UNATTENDED_ABSOLUTE_TIMEOUT_MS.
 */
export const APPROVAL_DEADLINE_UNATTENDED_MS = 8 * 60 * 60_000;

/**
 * How long an entry that is FINISHED (decided, timed out, or expired with its
 * process) is kept for the record before it is pruned. Pending entries are
 * never pruned by age — an entry still waiting is the one thing this file
 * exists for.
 */
export const APPROVAL_HISTORY_RETENTION_MS = 7 * 24 * 60 * 60_000;

/** Hard cap on entries in the file, newest first, applied after the age prune. Bounds a pathological trigger loop from growing the inbox without limit. */
export const MAX_STORED_APPROVALS = 500;

const FILE_NAME = 'approvals.json';

/** The one reason a loaded entry can never be answered — see this module's own doc comment (2). Kept as a single string because there is only one truthful answer here: whoever owned that wait is unreachable from this process. */
const EXPIRED_PROCESS_GONE = 'process gone';

function isFinished(entry) {
  return entry.status !== 'pending';
}

/**
 * When a finished entry stopped being live — the retention clock's zero
 * point. Deliberately NOT `requestedAt`: that is the caller's own timestamp
 * for when the QUESTION was raised, and an entry answered a second ago must
 * be kept for a week no matter how old the question was (a resumed CLI
 * session can carry a request whose own timestamp is hours old). Falls back to
 * requestedAt only for a record that somehow finished without either stamp.
 */
function finishedAt(entry) {
  return entry.decidedAt ?? entry.expiredAt ?? entry.requestedAt ?? 0;
}

/**
 * Creates the approval store for one data dir. Reads (and, if it found
 * anything left over from a previous process, rewrites) `<dataDir>/approvals.json`
 * synchronously here, so a caller holding the returned object can trust that
 * nothing pending is left claiming to be answerable.
 *
 * @param {object} options
 * @param {string} options.dataDir
 * @param {() => number} [options.now] - injectable clock (default Date.now); tests never sleep
 * @param {number} [options.pid] - recorded on every entry, for the record only — see the ownership note in loadFromDisk()
 * @returns {{
 *   put: (entry: object) => Promise<object>,
 *   decide: (id: string, decision: {behavior: 'allow'|'deny', message?: string}) => Promise<object>,
 *   listPending: () => Promise<object[]>,
 *   get: (id: string) => Promise<object|null>,
 * }}
 */
export function createApprovalStore({ dataDir, now = Date.now, pid = process.pid } = {}) {
  const filePath = path.join(dataDir, FILE_NAME);

  /** id -> entry. Insertion order is not meaningful; listPending() sorts by requestedAt. */
  const entries = new Map();

  /**
   * The ids THIS store instance put itself, i.e. the ones whose in-memory
   * promise is genuinely reachable from this process. This — not the recorded
   * pid — is what makes an entry decidable.
   *
   * The pid is a record of who asked, and it is deliberately NOT the test: a
   * pid can be recycled, so "that pid is alive" proves nothing about whether
   * the kaprek process that owned the wait still exists, and even a real,
   * still-running foreign process is unreachable from here anyway (its
   * `resolve` closure is in its own heap). Liveness is the wrong question;
   * ownership is the right one, and ownership cannot survive a process
   * boundary.
   */
  const ownedIds = new Set();

  function loadFromDisk() {
    let raw;
    try {
      raw = fs.readFileSync(filePath, 'utf8');
    } catch (err) {
      if (err.code === 'ENOENT') return false;
      throw err;
    }

    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      // Set the file aside rather than deleting it or writing straight over
      // it: it is the only record of what was pending, and a human may want
      // to look. Starting empty is the honest fallback — an unreadable inbox
      // holds nothing this process can answer either way.
      try {
        fs.renameSync(filePath, path.join(dataDir, `approvals.corrupt-${now()}.json`));
      } catch {
        // best-effort — a failed rename must not stop the server from starting
      }
      return false;
    }

    const list = Array.isArray(parsed?.approvals) ? parsed.approvals : [];
    let changed = false;
    const expiredAt = now();
    for (const entry of list) {
      if (!entry || typeof entry.id !== 'string') continue;
      if (entry.status === 'pending') {
        // Everything read from disk was put by another store instance — in
        // practice a previous process, since one data dir means one kaprek
        // (src/lib/instance-lock.mjs). The turn it belonged to is gone, the
        // CLI it blocked is gone, and the promise that carried the answer went
        // with them. Marking it here is the whole point: it is visibly dead
        // rather than a queue entry that looks answerable and silently isn't.
        entries.set(entry.id, { ...entry, status: 'expired', expired: EXPIRED_PROCESS_GONE, expiredAt });
        changed = true;
        continue;
      }
      entries.set(entry.id, entry);
    }
    return changed;
  }

  /** Drops finished entries past the retention window, then caps the total — newest kept. Pending entries survive both. */
  function pruned() {
    const cutoff = now() - APPROVAL_HISTORY_RETENTION_MS;
    const kept = [...entries.values()].filter((entry) => !isFinished(entry) || finishedAt(entry) >= cutoff);
    if (kept.length <= MAX_STORED_APPROVALS) return kept;
    const pending = kept.filter((entry) => !isFinished(entry));
    const finished = kept
      .filter(isFinished)
      .sort((a, b) => finishedAt(b) - finishedAt(a))
      .slice(0, Math.max(0, MAX_STORED_APPROVALS - pending.length));
    return [...pending, ...finished];
  }

  function persist() {
    const approvals = pruned();
    entries.clear();
    for (const entry of approvals) entries.set(entry.id, entry);
    // Keep ownedIds from outliving the entries it names — an id pruned from
    // the file must not leave a marker behind that a later, unrelated entry
    // with the same id would inherit.
    for (const id of [...ownedIds]) {
      if (!entries.has(id)) ownedIds.delete(id);
    }

    fs.mkdirSync(dataDir, { recursive: true });
    // Temp file in the SAME directory, then rename: rename is atomic within a
    // filesystem, so a reader (or a crash) either sees the whole previous file
    // or the whole new one, never a truncated inbox. The pid+timestamp in the
    // temp name keeps two writers from colliding on it even though there
    // should only ever be one.
    const tmpPath = path.join(dataDir, `.${FILE_NAME}.tmp-${pid}-${now()}`);
    fs.writeFileSync(tmpPath, `${JSON.stringify({ version: 1, approvals }, null, 2)}\n`, 'utf8');
    fs.renameSync(tmpPath, filePath);
  }

  if (loadFromDisk()) persist();

  /**
   * Records one newly raised approval question. `entry.id` is the caller's own
   * key — server.mjs passes `chatId:requestId` (see approvalKey()) because a
   * bare CLI request id is not unique across concurrent chats.
   *
   * Throws when an entry with that id is STILL PENDING: overwriting a live
   * wait would strand it (the record vanishes while the CLI still blocks).
   * A FINISHED entry with the same id is replaced instead — a CLI numbers its
   * requests from 1 again on every turn, so id reuse across turns of one chat
   * is normal, not a collision.
   */
  async function put(entry) {
    const id = entry?.id;
    if (typeof id !== 'string' || id.length === 0) throw new Error('approval entry needs a non-empty string id');
    const existing = entries.get(id);
    if (existing && !isFinished(existing)) throw new Error(`approval ${id} is already pending`);

    const record = {
      chatId: null,
      requestId: id,
      triggerId: null,
      toolName: null,
      displayName: null,
      input: null,
      description: null,
      reason: null,
      agentId: null,
      source: null,
      deadlineAt: null,
      ...entry,
      id,
      requestedAt: entry.requestedAt ?? now(),
      pid,
      status: 'pending',
      decision: null,
      decidedAt: null,
      expired: null,
    };
    entries.set(id, record);
    ownedIds.add(id);
    persist();
    return record;
  }

  /**
   * Answers one entry, exactly once. Throws — rather than resolving nothing —
   * for every case where the answer cannot land:
   *   - unknown id,
   *   - already decided (the second answer is refused, never applied on top),
   *   - expired: nothing in this process is waiting for it (see the module
   *     doc comment). This is the case a restart produces.
   * The caller is expected to turn these into a 404/409/410 rather than a
   * silent success.
   */
  async function decide(id, decision) {
    const entry = entries.get(id);
    if (!entry) throw new Error(`unknown approval: ${id}`);
    // ORDER MATTERS, and a mutant found it: 'already decided' is checked
    // BEFORE the ownership/expiry gate. Both refuse, but they say different
    // things to a user, and only one of them is true for a second click on an
    // entry this process answered a moment ago. Reporting 'process gone' there
    // — which an ownership check running first would do the moment the id
    // stopped being tracked as live — would tell someone their kaprek had
    // died when all that happened is that they clicked twice.
    if (entry.status === 'decided') {
      throw new Error(`approval ${id} was already decided (${entry.decision?.behavior ?? 'unknown'})`);
    }
    if (entry.status === 'expired' || !ownedIds.has(id)) {
      throw new Error(`approval ${id} cannot be decided: ${EXPIRED_PROCESS_GONE} — the turn that asked it died with the process that started it`);
    }
    const behavior = decision?.behavior;
    if (behavior !== 'allow' && behavior !== 'deny') throw new Error('approval decision behavior must be "allow" or "deny"');

    // Check-and-set with no await in between, so two answers arriving in the
    // same tick cannot both pass the status check above.
    const decided = {
      ...entry,
      status: 'decided',
      decidedAt: now(),
      decision: behavior === 'allow' ? { behavior } : { behavior, message: decision.message ?? 'denied' },
    };
    // ownedIds is NOT cleared here: it records who created the entry, and
    // that stays true after the answer. `status` is what makes a decision
    // single-shot. Clearing it would make the SECOND decide() report the
    // wrong reason (see the order note above); it is pruned in persist()
    // instead, along with the entry itself.
    entries.set(id, decided);
    persist();
    return decided;
  }

  /** Every entry still waiting for an answer, oldest first — the inbox, in the order it should be worked. */
  async function listPending() {
    return [...entries.values()]
      .filter((entry) => entry.status === 'pending' && ownedIds.has(entry.id))
      .sort((a, b) => (a.requestedAt ?? 0) - (b.requestedAt ?? 0));
  }

  /** One entry by id, whatever its status — including expired ones, so a caller can say WHY an id is no longer answerable. Null when it was never recorded or has been pruned. */
  async function get(id) {
    return entries.get(id) ?? null;
  }

  return { put, decide, listPending, get };
}
