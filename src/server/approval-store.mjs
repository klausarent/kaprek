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
import crypto from 'node:crypto';

/**
 * How long ONE approval question raised by an interactive chat turn may wait
 * before it is auto-denied. Ten minutes because a human is demonstrably at the
 * other end of a chat turn — they typed it. Was server.mjs's
 * DEFAULT_APPROVAL_TIMEOUT_MS.
 */
export const APPROVAL_DEADLINE_INTERACTIVE_MS = 10 * 60_000;

/**
 * How long a DEFERRED question stays answerable in the inbox before it lapses.
 *
 * This used to be the length of a wait: the CLI sat blocked on the question
 * for up to eight hours. It is not a wait any more. An unattended question is
 * filed and the turn is told to carry on (see server.mjs's DEFERRAL_MESSAGE),
 * so nothing is held open while the entry sits here, and the only cost of a
 * longer window is a slightly longer list. Hence 24 hours rather than eight:
 * a question raised on Friday evening is still answerable on Saturday, and
 * "the run I approve now happens now" stays true because approving starts a
 * fresh follow-up turn rather than un-blocking an old one.
 *
 * After it, the entry becomes 'lapsed' - silently, since nobody is waiting on
 * an answer that never came.
 */
export const APPROVAL_INBOX_TTL_MS = 24 * 60 * 60_000;

/** @deprecated The old name for APPROVAL_INBOX_TTL_MS, from when this was how long a turn PARKED on a question. Kept so an external reference does not break silently. */
export const APPROVAL_DEADLINE_UNATTENDED_MS = APPROVAL_INBOX_TTL_MS;

/**
 * How long an entry that is FINISHED (decided, timed out, or expired with its
 * process) is kept for the record before it is pruned. Pending entries are
 * never pruned by age — an entry still waiting is the one thing this file
 * exists for.
 */
export const APPROVAL_HISTORY_RETENTION_MS = 7 * 24 * 60 * 60_000;

/** Hard cap on entries in the file, newest first, applied after the age prune. Bounds a pathological trigger loop from growing the inbox without limit. */
export const MAX_STORED_APPROVALS = 500;

/**
 * Cap on how many questions may be waiting AT ONCE. MAX_STORED_APPROVALS
 * prunes finished entries only — a pending one is by definition still live and
 * cannot be dropped, so without this the inbox has no upper bound at all: a
 * looping agent that raises a question per tool call would grow the file (and
 * every rewrite of it) without limit. A put() over the cap THROWS rather than
 * being dropped quietly, so the CLI gets its fail-closed deny immediately
 * instead of blocking on a question nothing recorded (Härtung r3, Codex #5b).
 */
export const MAX_PENDING_APPROVALS = 50;

/**
 * Cap on the JSON size of one stored `input`. A can_use_tool request can carry
 * megabytes (a Write of a whole file), and this store rewrites its ENTIRE file
 * on every put and every decision, so an unbounded input turns each of those
 * into a multi-megabyte write.
 *
 * Why it is a megabyte and not something tighter: the stored input is not just
 * a record. It is what a deferred question is REPLAYED from - an approval
 * granted tomorrow morning re-runs exactly this call, and a truncated input
 * could not be re-run at all, only described. So the cap is set where it stops
 * pathological writes rather than where it would keep the file small, and the
 * short version the UI needs lives beside it in `inputPreview`.
 */
export const MAX_STORED_INPUT_BYTES = 1024 * 1024;

/** Length of `inputPreview`: enough to recognise the call in a list, small enough that a UI never has to load the full input to render one. */
export const STORED_INPUT_PREVIEW_CHARS = 2048;

/**
 * Backoff before retrying a write that failed with a TRANSIENT error. On
 * Windows an antivirus scanner or the search indexer can hold approvals.json
 * open for a few hundred milliseconds, and rename() then fails with EPERM or
 * EBUSY. Without a retry that surfaces as put() throwing, which the approval
 * handler turns into a fail-closed deny — a legitimate overnight question
 * refused because a scanner blinked, in exactly the case this feature exists
 * for (Härtung r3, Grok #4). Three attempts, then the error stands.
 */
export const WRITE_RETRY_DELAYS_MS = [50, 150, 400];

/** Error codes worth retrying: someone else holds the file for a moment. A full disk (ENOSPC) or a missing directory is not transient and must fail at once. */
const TRANSIENT_WRITE_CODES = new Set(['EPERM', 'EBUSY', 'EACCES', 'EMFILE', 'ENFILE']);

const FILE_NAME = 'approvals.json';

/**
 * The schema version this binary writes and reads. The field has been
 * written since the first revision of this file but never READ — P0.5 makes
 * the gate real: a file with a HIGHER version was written by a newer kaprek,
 * whose fields this binary cannot know. Opening it read-only is the only
 * honest option: reads still work, but nothing is written back, nothing is
 * pruned, nothing is marked — a newer file must not be silently degraded to
 * what an older binary happens to understand.
 */
const SCHEMA_VERSION = 1;

/** The one reason a loaded entry can never be answered — see this module's own doc comment (2). Kept as a single string because there is only one truthful answer here: whoever owned that wait is unreachable from this process. */
const EXPIRED_PROCESS_GONE = 'process gone';

/**
 * An error that says WHICH state the entry is in and why the call therefore
 * did nothing. `err.already` is what the HTTP layer turns into a 409
 * `{already: '<state>'}` — the honest answer to "your click did nothing, and
 * here is what beat it" (introduced for P1's decide/cancel refusals; the
 * grant-intent redemption below uses the same shape so POST /api/grants can
 * name exactly what refused it).
 */
function alreadyError(status, message) {
  return Object.assign(new Error(message), { already: status });
}

/** The honest refusal every mutating call gives on a newer-schema file. */
function newerSchemaMessage(version) {
  return `approvals.json was written by a newer kaprek version (schema version ${version} > ${SCHEMA_VERSION}); this process opens the store READ-ONLY and refuses to modify it`;
}

function isFinished(entry) {
  return entry.status !== 'pending';
}

/**
 * The reasons a pending question can be withdrawn without anyone answering
 * it (P1). Each names the caller that did the cancelling, never the moral
 * of the story — the UI renders the wording.
 */
export const CANCELLED_REASONS = ['run-aborted', 'run-failed', 'trigger-deleted', 'mission-archived', 'shutdown'];

/**
 * When a finished entry stopped being live — the retention clock's zero
 * point. Deliberately NOT `requestedAt`: that is the caller's own timestamp
 * for when the QUESTION was raised, and an entry answered a second ago must
 * be kept for a week no matter how old the question was (a resumed CLI
 * session can carry a request whose own timestamp is hours old). Falls back to
 * requestedAt only for a record that somehow finished without either stamp.
 */
function finishedAt(entry) {
  // `cancelledAt` is the cancelled entry's own zero point (H4): a question
  // withdrawn with its run must be kept for a week from WHEN it was
  // withdrawn, not from when it was asked — without this field the sweep
  // would fall through to requestedAt and could prune a minutes-old
  // cancelled entry whose question was a day old.
  return entry.decidedAt ?? entry.expiredAt ?? entry.lapsedAt ?? entry.cancelledAt ?? entry.requestedAt ?? 0;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * A stable string for one tool input: JSON with object keys sorted at every
 * level, so two inputs that differ only in key order are the same input.
 *
 * Used for two things that must agree exactly: deciding whether a repeated
 * question is the SAME question (dedupe, see put()), and deciding whether the
 * call a follow-up turn is making is the one that was approved (the one-shot
 * pre-approval in runner.mjs). A mismatch in either direction is a bug with
 * teeth - the first would hide a different question behind an old entry, the
 * second would let an approval for `rm a.txt` authorise `rm b.txt`.
 */
export function canonicalInput(input) {
  const seen = new WeakSet();
  const walk = (value) => {
    if (value === null || typeof value !== 'object') return value;
    if (seen.has(value)) return '[circular]';
    seen.add(value);
    if (Array.isArray(value)) return value.map(walk);
    const out = {};
    for (const key of Object.keys(value).sort()) out[key] = walk(value[key]);
    return out;
  };
  try {
    return JSON.stringify(walk(input) ?? null);
  } catch {
    return null;
  }
}

/** Identity of a REPEATED question: same trigger, same tool, same input. Two fires of a nightly trigger asking the same thing are one inbox entry, not two (see put()). */
function questionFingerprint(entry) {
  return `${entry.triggerId ?? ''}\u0000${entry.toolName ?? ''}\u0000${canonicalInput(entry.input ?? null) ?? ''}`;
}

/**
 * The version of `input` that goes on disk: the original when it is small
 * enough, otherwise a marked stub carrying the first
 * STORED_INPUT_PREVIEW_CHARS characters of its JSON. The stub is deliberately
 * self-describing (`_truncated: true`) rather than silently shortened — an
 * inbox entry showing half a command with no sign that it is half would be
 * worse than one that says so.
 *
 * Only the STORED copy. The live SSE frame and the decision itself keep the
 * whole thing; see MAX_STORED_INPUT_BYTES.
 */
export function inputPreview(input) {
  if (input === null || input === undefined) return null;
  let json;
  try {
    json = JSON.stringify(input);
  } catch {
    return '(input could not be serialised)';
  }
  if (json === undefined) return null;
  return json.slice(0, STORED_INPUT_PREVIEW_CHARS);
}

export function storableInput(input) {
  if (input === null || input === undefined) return null;
  let json;
  try {
    json = JSON.stringify(input);
  } catch {
    // Cyclic or otherwise unserialisable: it could not have been written
    // either, so record that rather than throwing on the approval path.
    return { _truncated: true, preview: '(input could not be serialised)' };
  }
  if (json === undefined) return null;
  if (Buffer.byteLength(json, 'utf8') <= MAX_STORED_INPUT_BYTES) return input;
  return { _truncated: true, preview: json.slice(0, STORED_INPUT_PREVIEW_CHARS) };
}

/**
 * Creates the approval store for one data dir. Reads (and, if it found
 * anything left over from a previous process, rewrites) `<dataDir>/approvals.json`
 * synchronously here, so a caller holding the returned object can trust that
 * nothing pending is left claiming to be answerable.
 *
 * NOTHING here throws on the way in. A data dir whose approvals.json is
 * unreadable, unwritable or corrupt starts EMPTY and says so on stderr — same
 * posture as registry.mjs::readTriggersFile(), and for the same reason: this
 * file is a record, and a record that cannot be read must not be able to stop
 * kaprek from starting. It used to throw out of the constructor, which is
 * called from startServer()'s listen callback — outside any promise — so a
 * read-only approvals.json took the whole process down on every start
 * (panel Fix-Runde 1, C1).
 *
 * @param {object} options
 * @param {string} options.dataDir
 * @param {() => number} [options.now] - injectable clock (default Date.now); tests never sleep
 * @param {number} [options.pid] - recorded on every entry, for the record only — see the ownership note in loadFromDisk()
 * @param {(message: string) => void} [options.log] - where degraded-start and
 *   failed-write warnings go (default console.warn). Injectable so a test can
 *   assert that a failure was ANNOUNCED, not only survived.
 * @param {typeof import('node:fs')} [options.fsImpl] - the fs used for every
 *   read and write here. Injected ONLY by approval-store.test.mjs's atomicity
 *   test, which needs a write that fails halfway through to prove the
 *   temp-file+rename dance actually protects the file (a test that cannot fail
 *   a write can only assert that atomic code looks atomic).
 * @returns {{
 *   put: (entry: object) => Promise<object>,
 *   decide: (id: string, decision: {behavior: 'allow'|'deny', message?: string, via?: string}) => Promise<object>,
 *   cancel: (id: string, options?: {reason?: string}) => Promise<object>,
 *   cancelOpen: (options?: {reason?: string, match?: (entry: object) => boolean}) => Promise<object>,
 *   reopen: (id: string, options?: {reason?: string}) => Promise<object>,
 *   listPending: () => Promise<object[]>,
 *   listHistory: (options?: {limit?: number|null, since?: number|null}) => Promise<object[]>,
 *   get: (id: string) => Promise<object|null>,
 * }}
 */
export function createApprovalStore({
  dataDir,
  now = Date.now,
  pid = process.pid,
  log = (message) => console.warn(message),
  fsImpl = fs,
} = {}) {
  const filePath = path.join(dataDir, FILE_NAME);
  const TMP_PREFIX = `.${FILE_NAME}.tmp-`;

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

  /** Tail of the operation queue, see serialized(). */
  let queue = Promise.resolve();

  /**
   * Set when the file on disk carries a schema version NEWER than this
   * binary understands (P0.5). Every mutating path — put/decide/reopen, the
   * lapsed sweep, the constructor's write-back, even the stale-temp-file
   * cleanup — checks it: reads work, nothing is written, nothing is deleted.
   */
  let readOnly = false;
  let readOnlyVersion = null;

  /**
   * Moves a corrupt file out of the way so the next persist() cannot silently
   * overwrite the only evidence of what was pending. Three levels, each one a
   * fallback for the one before (panel Fix-Runde 1, M3): rename it, else copy
   * it aside and let the original be overwritten, else say loudly that the
   * evidence is about to be lost. Never throws — see this module's constructor
   * doc comment.
   */
  function setCorruptFileAside(raw) {
    const asidePath = path.join(dataDir, `approvals.corrupt-${now()}.json`);
    try {
      fsImpl.renameSync(filePath, asidePath);
      log(`approvals: ${filePath} was not readable JSON; moved to ${asidePath} and starting from an empty inbox`);
      return;
    } catch (renameErr) {
      try {
        fsImpl.writeFileSync(asidePath, raw, 'utf8');
        log(`approvals: ${filePath} was not readable JSON and could not be moved (${renameErr.message}); copied to ${asidePath} instead`);
        return;
      } catch (copyErr) {
        log(
          `approvals: ${filePath} was not readable JSON, and it could be neither moved (${renameErr.message}) nor copied aside (${copyErr.message}) — its contents will be LOST on the next write`,
        );
      }
    }
  }

  function loadFromDisk() {
    let raw;
    try {
      raw = fsImpl.readFileSync(filePath, 'utf8');
    } catch (err) {
      // ENOENT is the ordinary first start. Anything else (EACCES on a file
      // someone marked read-only, EBUSY, EIO) degrades to an empty inbox with
      // a warning rather than taking the process down on every start — the
      // ownership gate refuses foreign entries anyway, so an unread file
      // costs a post-mortem, not safety.
      if (err.code !== 'ENOENT') {
        log(`approvals: failed to read ${filePath} (${err.message}); starting from an empty inbox`);
      }
      return false;
    }

    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      setCorruptFileAside(raw);
      return false;
    }

    // P0.5, schema-version gate: a HIGHER version than this binary writes
    // means a newer kaprek wrote fields here this binary cannot know. The
    // store opens READ-ONLY — entries load as-is (no 'expired: process gone'
    // marking, that is an in-memory reinterpretation this binary must not
    // make durable), no write-back, no retention prune, no temp-file
    // cleanup. Backwards-compatible: a missing version field is version 1.
    const fileVersion = parsed?.version;
    if (fileVersion !== undefined && fileVersion !== null && fileVersion > SCHEMA_VERSION) {
      readOnly = true;
      readOnlyVersion = fileVersion;
      log(`approvals: ${filePath} was written by a newer kaprek version (schema version ${fileVersion} > ${SCHEMA_VERSION}); opening READ-ONLY — nothing is written back, pruned or deleted`);
    }

    const list = Array.isArray(parsed?.approvals) ? parsed.approvals : [];
    let changed = false;
    const expiredAt = now();
    for (const entry of list) {
      if (!entry || typeof entry.id !== 'string') continue;
      if (readOnly) {
        entries.set(entry.id, entry);
        continue;
      }
      if (entry.status === 'pending' && entry.mode === 'deferred') {
        // A DEFERRED entry hangs on no process at all. Nothing is blocked on
        // it: the turn that raised it was told to carry on and ended long ago,
        // and approving it starts a FRESH follow-up turn. So it survives a
        // restart intact and stays answerable, which is the whole point of
        // filing questions instead of parking on them.
        entries.set(entry.id, entry);
        continue;
      }
      if (entry.status === 'pending') {
        // An INTERACTIVE entry, though, was a live wait: some other process
        // was holding a CLI blocked on it. That is what cannot survive.
        //
        // Everything read from disk was put by another store instance, in
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

  async function persist() {
    const approvals = pruned();
    entries.clear();
    for (const entry of approvals) entries.set(entry.id, entry);
    // Keep ownedIds from outliving the entries it names — an id pruned from
    // the file must not leave a marker behind that a later, unrelated entry
    // with the same id would inherit.
    for (const id of [...ownedIds]) {
      if (!entries.has(id)) ownedIds.delete(id);
    }

    fsImpl.mkdirSync(dataDir, { recursive: true });
    const body = `${JSON.stringify({ version: 1, approvals }, null, 2)}
`;

    // ASYNC (Haertung r3, Codex #5c). This used to be writeFileSync +
    // renameSync, which blocks the ENTIRE event loop for the length of the
    // write. With a large inbox that stalls in-flight approval HTTP, the
    // harness's own clock polling, and the instance lock's greeting server,
    // whose silence makes a second start refuse fail-closed. Nothing here
    // needs to be synchronous: every caller is already async.
    //
    // Temp file in the SAME directory, then rename: rename is atomic within a
    // filesystem, so a reader (or a crash) either sees the whole previous file
    // or the whole new one, never a truncated inbox. The pid+timestamp in the
    // temp name keeps two writers from colliding on it even though there
    // should only ever be one.
    const tmpPath = path.join(dataDir, `${TMP_PREFIX}${pid}-${now()}`);
    for (let attempt = 0; ; attempt += 1) {
      try {
        await fsImpl.promises.writeFile(tmpPath, body, 'utf8');
        await fsImpl.promises.rename(tmpPath, filePath);
        return;
      } catch (err) {
        // A half-written temp file is exactly what the rename was there to
        // keep out of approvals.json; leaving it on disk would only
        // accumulate (panel Fix-Runde 1, M4). Best-effort: if even the unlink
        // fails there is nothing left to try, and the caller's own error is
        // the one worth reporting.
        try {
          await fsImpl.promises.unlink(tmpPath);
        } catch {
          // best-effort
        }
        if (!TRANSIENT_WRITE_CODES.has(err?.code) || attempt >= WRITE_RETRY_DELAYS_MS.length) throw err;
        // Someone else is holding the file for a moment (see
        // WRITE_RETRY_DELAYS_MS). Waiting is strictly better than turning a
        // scanner's half-second into a denied approval.
        await sleep(WRITE_RETRY_DELAYS_MS[attempt]);
      }
    }
  }

  /**
   * Every public method runs through this one queue, in call order.
   *
   * Two jobs. It keeps two persist() calls from interleaving their
   * write/rename pairs now that they are async: the later one must not
   * overtake the earlier and leave the file describing an older state. And it
   * preserves what the synchronous version got for free, a check-and-set
   * ("is this id already pending?", "has this been decided?") that no other
   * operation can slip inside. A previous failure does not poison the queue:
   * each entry runs regardless of how the one before it ended.
   */
  function serialized(work) {
    // The sweep runs inside the queue, ahead of the work, so no operation can
    // observe an entry that should already have lapsed. On a newer-schema
    // file the store is read-only: no sweep, and therefore no persist —
    // decide() refuses mutations before any of this could matter.
    const swept = async () => {
      if (!readOnly && sweepLapsed()) {
        try {
          await persist();
        } catch (err) {
          log(`approvals: could not record lapsed entries (${err.message}); they are refused in memory regardless`);
        }
      }
      return work();
    };
    const run = queue.then(swept, swept);
    queue = run.then(
      () => {},
      () => {},
    );
    return run;
  }

  /**
   * Marks every pending entry whose deadline has passed as 'lapsed'. Cheap
   * (one pass over an in-memory map, capped at MAX_STORED_APPROVALS) and run
   * at the head of every operation, so nobody ever sees an entry that is
   * offering buttons its deadline already took away.
   *
   * Silent by design: a question nobody answered is the ordinary outcome of
   * asking someone who was not there, not an incident. It is the store's
   * equivalent of a letter going unanswered, and the trigger will ask again
   * on its next fire if it still wants to.
   *
   * @returns {boolean} whether anything changed and the file needs rewriting
   */
  function sweepLapsed() {
    const nowMs = now();
    let changed = false;
    for (const [id, entry] of entries) {
      if (entry.status !== 'pending') continue;
      const deadline = entry.deadlineAt;
      if (!Number.isFinite(deadline) || deadline > nowMs) continue;
      entries.set(id, { ...entry, status: 'lapsed', lapsedAt: nowMs });
      ownedIds.delete(id);
      changed = true;
    }
    return changed;
  }

  /** Sweeps temp files a previous run left behind (a crash between write and rename). Best-effort and silent: they are junk, not evidence. */
  function cleanupStaleTempFiles() {
    let names;
    try {
      names = fsImpl.readdirSync(dataDir);
    } catch {
      return;
    }
    for (const name of names) {
      if (!name.startsWith(TMP_PREFIX)) continue;
      try {
        fsImpl.unlinkSync(path.join(dataDir, name));
      } catch {
        // best-effort
      }
    }
  }

  if (loadFromDisk()) {
    // Queued rather than awaited: the constructor cannot await, and every
    // public method below goes through the same queue, so the first of them
    // already waits for this write-back. The write-back is bookkeeping (it
    // makes the 'process gone' marking durable); failing it costs an accurate
    // file, not correctness, since the ownership gate refuses those entries
    // either way. It must not cost the boot (panel Fix-Runde 1, C1).
    //
    // NEVER on a newer-schema file (P0.5): there loadFromDisk() marked
    // nothing — changed stays false, so this branch is not even taken, and
    // readOnly additionally guards the sweep-driven persists below.
    serialized(() => persist()).catch((err) => {
      log(`approvals: could not record expired entries in ${filePath} (${err.message}); they are refused in memory regardless`);
    });
  }
  // Only after load: on a newer-schema file nothing under this data dir is
  // touched, not even the temp files — deletion is a write, too.
  if (!readOnly) cleanupStaleTempFiles();

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
   *
   * A failed write is ROLLED BACK and rethrown, and that is the one place in
   * this file where a write failure is not survivable (panel Fix-Runde 1, I1).
   * Keeping the entry in memory after a failed persist() would leave an id
   * that is pending and owned but unreachable: the inbox would list a question
   * whose buttons can only 404, and — worse — the key stays occupied for the
   * rest of the process's life, so `chatId:1` (a CLI numbers from 1 every
   * turn) would make the FIRST approval of every later turn in that chat throw
   * 'already pending' and auto-deny. The caller (server.mjs's approval
   * handler) turns the rethrow into a fail-closed deny for this ONE question.
   */
  function put(entry) {
    return serialized(async () => {
    if (readOnly) throw new Error(newerSchemaMessage(readOnlyVersion));
    const id = entry?.id;
    if (typeof id !== 'string' || id.length === 0) throw new Error('approval entry needs a non-empty string id');
    const existing = entries.get(id);
    if (existing && !isFinished(existing)) throw new Error(`approval ${id} is already pending`);
    // Pending cap (Haertung r3, Codex #5b). Counted BEFORE the entry is
    // added, and only against entries this process is really waiting on:
    // finished ones are the retention window's problem, not a live limit.
    const pendingCount = [...entries.values()].filter((e) => e.status === 'pending' && (e.mode === 'deferred' || ownedIds.has(e.id))).length;
    if (pendingCount >= MAX_PENDING_APPROVALS) {
      throw new Error(`too many approvals already waiting (${pendingCount}/${MAX_PENDING_APPROVALS})`);
    }

    // DEDUPE (C3). A periodic trigger asks the same thing again on its next
    // fire, and that is deliberate: a question nobody answered is meant to
    // come back. What must not come back is a second inbox entry for it, or a
    // nightly trigger would leave twenty identical cards by morning. Same
    // trigger, same tool, same input (canonically compared) as something
    // already waiting means the SAME question - refresh its clock, count the
    // ask, keep its id so an answer already on its way still lands.
    //
    // Only against PENDING entries: asking again after a deny is a new
    // question, and the old decision stays on the record as what it was.
    if (entry.mode === 'deferred') {
      const fingerprint = questionFingerprint(entry);
      const twin = [...entries.values()].find(
        (candidate) => candidate.status === 'pending' && candidate.mode === 'deferred' && questionFingerprint(candidate) === fingerprint,
      );
      if (twin) {
        const refreshed = {
          ...twin,
          askedCount: (twin.askedCount ?? 1) + 1,
          requestedAt: entry.requestedAt ?? now(),
          deadlineAt: entry.deadlineAt ?? twin.deadlineAt,
          lastAskedAt: entry.requestedAt ?? now(),
        };
        entries.set(twin.id, refreshed);
        try {
          await persist();
        } catch (err) {
          entries.set(twin.id, twin);
          log(`approvals: could not record a repeat of ${twin.id} (${err.message})`);
          throw err;
        }
        return refreshed;
      }
    }

    const record = {
      chatId: null,
      requestId: id,
      triggerId: null,
      // 'interactive' (a human is at the other end of a live dialog, the turn
      // waits) or 'deferred' (nobody is there, the turn was told to carry on
      // and this entry can be redeemed later by a follow-up turn). The
      // difference decides whether the entry survives a restart - see
      // loadFromDisk().
      mode: 'interactive',
      askedCount: 1,
      toolName: null,
      displayName: null,
      input: null,
      inputPreview: null,
      description: null,
      reason: null,
      agentId: null,
      source: null,
      deadlineAt: null,
      ...entry,
      id,
      // Only the stored copy is capped; the caller keeps the full object for
      // the dialog and the decision (see MAX_STORED_INPUT_BYTES).
      input: storableInput(entry.input ?? null),
      // Always present, whether or not `input` was capped: a list view (and
      // the floating question box) renders from this and never has to pull a
      // megabyte of tool input to show one line.
      inputPreview: inputPreview(entry.input ?? null),
      requestedAt: entry.requestedAt ?? now(),
      pid,
      status: 'pending',
      decision: null,
      decidedAt: null,
      expired: null,
    };
    const hadOwnership = ownedIds.has(id);
    entries.set(id, record);
    ownedIds.add(id);
    try {
      await persist();
    } catch (err) {
      // Exactly back to the state before this call: the replaced entry
      // restored (or none), and the ownership marker as it was.
      if (existing) entries.set(id, existing);
      else entries.delete(id);
      if (!hadOwnership) ownedIds.delete(id);
      log(`approvals: could not record ${id} (${err.message}); refusing the question rather than holding it unanswerable`);
      throw err;
    }
    return record;
    });
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
  function decide(id, decision) {
    return serialized(async () => {
    if (readOnly) throw new Error(newerSchemaMessage(readOnlyVersion));
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
      throw alreadyError('decided', `approval ${id} was already decided (${entry.decision?.behavior ?? 'unknown'})`);
    }
    if (entry.status === 'lapsed') {
      throw alreadyError('lapsed', `approval ${id} lapsed: nobody answered it before its deadline, and the agent has moved on`);
    }
    if (entry.status === 'cancelled') {
      throw alreadyError('cancelled', `approval ${id} was cancelled (${entry.cancelledReason ?? 'unknown reason'}) before it was answered`);
    }
    // The ownership gate is for INTERACTIVE entries only. A deferred entry is
    // redeemed by starting a new turn, not by resolving a promise this process
    // happens to hold, so "which process filed it" is not a limit on who can
    // answer it (see loadFromDisk()).
    if (entry.status === 'expired') {
      throw new Error(`approval ${id} cannot be decided: ${EXPIRED_PROCESS_GONE} - the turn that asked it died with the process that started it`);
    }
    if (entry.mode !== 'deferred' && !ownedIds.has(id)) {
      throw new Error(`approval ${id} cannot be decided: ${EXPIRED_PROCESS_GONE} — the turn that asked it died with the process that started it`);
    }
    const behavior = decision?.behavior;
    if (behavior !== 'allow' && behavior !== 'deny') throw new Error('approval decision behavior must be "allow" or "deny"');

    // Check-and-set with no await in between, so two answers arriving in the
    // same tick cannot both pass the status check above.
    //
    // P6a, grant intent: an "allow" that came with the person's "always for
    // this form" carries the server-side hash of the RAW input (computed at
    // question time, before any redaction — the stored `input` here is
    // redacted/truncated and would either never match or match the wrong
    // secret, K1). The store stamps a ONE-CONSUMABLE nonce beside it; POST
    // /api/grants later redeems {approvalId, nonce} through
    // consumeGrantIntent() below — the only reader of this field.
    const grantIntent =
      behavior === 'allow' && typeof decision.grantIntent?.inputHash === 'string'
        ? {
            inputHash: decision.grantIntent.inputHash,
            nonce: crypto.randomBytes(24).toString('hex'),
            createdAt: now(),
            consumedAt: null,
          }
        : null;
    const decided = {
      ...entry,
      status: 'decided',
      decidedAt: now(),
      decision: behavior === 'allow' ? { behavior } : { behavior, message: decision.message ?? 'denied' },
      // WHO answered, as far as the server can know it: 'web' (the browser's
      // own token), 'phone-token' (the QR token's narrow routes), or
      // 'auto-deny' (a deadline or a turn end decided for you). Recorded
      // only when the caller says so — an older caller that does not name
      // its channel leaves the field null rather than a guessed value.
      decidedVia: decision.via ?? null,
      // Null for the ordinary answer — most questions mint nothing.
      grantIntent,
    };
    // ownedIds is NOT cleared here: it records who created the entry, and
    // that stays true after the answer. `status` is what makes a decision
    // single-shot. Clearing it would make the SECOND decide() report the
    // wrong reason (see the order note above); it is pruned in persist()
    // instead, along with the entry itself.
    entries.set(id, decided);
    try {
      await persist();
    } catch (err) {
      // Deliberately NOT rolled back and NOT rethrown, the opposite of put()
      // above (panel Fix-Runde 1, M1). By the time a decision reaches this
      // point it is real: the caller resolves the CLI's pending control
      // request with it, the tool either runs or does not, and no file can
      // undo that. Rolling back would only make the store disagree with what
      // happened. What is lost is the RECORD — on the next start this entry
      // reads as pending and is reported as 'process gone', which is a lie
      // about a question that was answered. That is worth a loud line.
      log(`approvals: ${id} was decided (${behavior}) but the record could not be written (${err.message}); the decision stands, the file is now out of date`);
    }
    return decided;
    });
  }

  /**
   * Redeems a grant intent (P6a): the one-time half of "always for this
   * form". POST /api/grants calls this with {approvalId, nonce}; on success
   * the nonce is burned (consumedAt set, persisted) and the caller gets the
   * mint material — toolName and the RAW-input hash, never the input itself.
   *
   * Every refusal is an `alreadyError`, so the HTTP layer answers 409 with
   * the honest reason (404 only for an id this store never heard of):
   *   - 'unknown'         id never recorded (or pruned)
   *   - 'not-owned'       a previous process filed it — the nonce died with
   *                       that process's heap, as everything did
   *   - '<status>'        not decided (pending / lapsed / cancelled / expired)
   *   - 'denied'          the answer was a deny — nothing to stand on
   *   - 'no-intent'       decided before this feature, or a plain allow
   *   - 'truncated'       the stored input is a stub — an over-cap form
   *                       mints nothing (there is no honest hash of it)
   *   - 'bad-nonce'       a nonce that was never issued for this entry
   *   - 'nonce-consumed'  REPLAY: correct nonce, already burned
   */
  function consumeGrantIntent(id, nonce) {
    return serialized(async () => {
      if (readOnly) throw new Error(newerSchemaMessage(readOnlyVersion));
      const entry = entries.get(id);
      if (!entry) throw alreadyError('unknown', `unknown approval: ${id}`);
      if (!ownedIds.has(id)) throw alreadyError('not-owned', `approval ${id} was not filed by this kaprek process`);
      if (entry.status !== 'decided') throw alreadyError(entry.status, `approval ${id} is ${entry.status}, not decided`);
      if (entry.decision?.behavior !== 'allow') throw alreadyError('denied', `approval ${id} was denied; a deny mints no grant`);
      if (typeof entry.grantIntent?.inputHash !== 'string') throw alreadyError('no-intent', `approval ${id} carries no grant intent`);
      if (entry.input?._truncated === true) throw alreadyError('truncated', `approval ${id}'s input was too large to keep in full; it mints no grant`);
      const given = typeof nonce === 'string' ? nonce : '';
      const expected = entry.grantIntent.nonce;
      const replay = entry.grantIntent.consumedAt !== null;
      const matches = given.length === expected.length && crypto.timingSafeEqual(Buffer.from(given), Buffer.from(expected));
      if (!matches) throw alreadyError(replay ? 'nonce-consumed' : 'bad-nonce', `grant intent nonce for ${id} is wrong or already used`);
      if (replay) throw alreadyError('nonce-consumed', `grant intent for ${id} was already consumed`);

      const consumed = { ...entry, grantIntent: { ...entry.grantIntent, consumedAt: now() } };
      entries.set(id, consumed);
      try {
        await persist();
      } catch (err) {
        // Same posture as decide(): the burn is real in memory and the mint
        // may proceed; the file will show an unconsumed nonce, which the
        // ownedIds/decided checks still refuse to double-redeem THIS process.
        log(`approvals: the grant intent for ${id} was consumed but the record could not be written (${err.message})`);
      }
      return {
        toolName: consumed.toolName ?? null,
        inputHash: consumed.grantIntent.inputHash,
        chatId: consumed.chatId ?? null,
        approvalId: id,
      };
    });
  }

  /**
   * Puts an ALLOWED question back on the queue because the run it authorised
   * never happened.
   *
   * A live run found the hole this closes. Approving a deferred question marks
   * it decided and starts a follow-up turn; if that turn dies before it gets
   * to the approved call - the real case was an ask-policy coverage gap, which
   * kills a turn before ANY tool runs - the approval was spent on nothing. The
   * command never ran, the entry read `decided/allow`, and nobody could
   * approve it again. The user believes they authorised something that did not
   * happen, which is the worst of the three possible outcomes.
   *
   * So the decision is only final once the action was actually consumed. This
   * reverses it, records WHY on the entry (`replayFailedAt`/`replayFailedReason`,
   * which the UI can show), and gives it a fresh deadline: the question is
   * genuinely open again, so its clock starts again.
   *
   * Deliberately narrow. Only a deferred, allowed entry can be reopened - a
   * deny stands (nothing ran, nothing to retry), and an interactive entry
   * belongs to a turn that is long gone.
   */
  function reopen(id, { reason } = {}) {
    return serialized(async () => {
      if (readOnly) throw new Error(newerSchemaMessage(readOnlyVersion));
      const entry = entries.get(id);
      if (!entry) throw new Error(`unknown approval: ${id}`);
      if (entry.mode !== 'deferred') throw new Error(`approval ${id} is not a deferred question and cannot be reopened`);
      if (entry.status !== 'decided' || entry.decision?.behavior !== 'allow') {
        throw new Error(`approval ${id} is ${entry.status}, only an allowed one can be reopened`);
      }

      const reopened = {
        ...entry,
        status: 'pending',
        decision: null,
        decidedAt: null,
        replayFailedAt: now(),
        replayFailedReason: reason ?? 'the follow-up turn ended without running it',
        deadlineAt: now() + APPROVAL_INBOX_TTL_MS,
      };
      entries.set(id, reopened);
      // Ownership is irrelevant for a deferred entry (see decide()), but keep
      // the marker consistent for the process that has it in hand.
      try {
        await persist();
      } catch (err) {
        entries.set(id, entry);
        log(`approvals: could not reopen ${id} (${err.message}); it stays recorded as allowed even though nothing ran`);
        throw err;
      }
      return reopened;
    });
  }

  /**
   * Withdraws one pending question without an answer (P1). Only a PENDING
   * entry can be cancelled — a decision, a lapse and a cancellation are all
   * final states, and the response says honestly which one beat the call:
   *   - pending        -> {ok: true, entry}   (status 'cancelled',
   *                                              cancelledAt, cancelledReason)
   *   - cancelled      -> {ok: true, already: 'cancelled', entry} — idempotent,
   *                      no second event is written
   *   - lapsed/decided -> {ok: false, already: '<status>'}
   *   - unknown id     -> {ok: false, error: 'unknown'}
   *
   * Runs on the same serialized queue as decide(), so a cancel and a decide
   * arriving in the same tick are ordered by ARRIVAL: the first one wins and
   * the second one reports what beat it (both orders are pinned by tests).
   * Like decide(), the transition is check-and-set with no await in between.
   *
   * `reason` must be one of CANCELLED_REASONS — a cancellation that cannot
   * say who cancelled it is exactly the kind of silent `ok: true` this
   * status exists to replace.
   */
  function cancel(id, { reason } = {}) {
    return serialized(async () => {
      if (readOnly) throw new Error(newerSchemaMessage(readOnlyVersion));
      if (!CANCELLED_REASONS.includes(reason)) {
        throw new Error(`approval cancel needs a reason from CANCELLED_REASONS, got: ${reason}`);
      }
      const entry = entries.get(id);
      if (!entry) return { ok: false, error: 'unknown' };
      if (entry.status === 'cancelled') return { ok: true, already: 'cancelled', entry };
      if (entry.status !== 'pending') return { ok: false, already: entry.status };
      const cancelled = {
        ...entry,
        status: 'cancelled',
        cancelledAt: now(),
        cancelledReason: reason,
      };
      ownedIds.delete(id);
      entries.set(id, cancelled);
      try {
        await persist();
      } catch (err) {
        entries.set(id, entry);
        // Undo the ownership withdrawal too, or a cancelled-in-memory-only
        // entry would be invisible to a retry of the same cancel.
        if (entry.mode !== 'deferred') ownedIds.add(id);
        log(`approvals: could not record the cancellation of ${id} (${err.message})`);
        throw err;
      }
      return { ok: true, entry: cancelled };
    });
  }

  /**
   * Cancels a SET of pending entries by the store's own id list — the
   * cascade path for trigger deletion, mission archiving and shutdown
   * (P1, "Kaskade ohne Breitensuche"). The callers never scan chats or
   * reconstruct ids; they name a reason and, where it applies, a predicate
   * over the entry (`match`), and the store cancels exactly the pending
   * entries it itself knows are open (deferred ones, and interactive ones
   * this process owns). The response lists the ids that were actually
   * cancelled, so a caller can say what it ended rather than assume.
   *
   * One queue entry, one persist: a shutdown cancelling twelve questions
   * writes the file once, not twelve times.
   */
  function cancelOpen({ reason, match = null } = {}) {
    return serialized(async () => {
      if (readOnly) throw new Error(newerSchemaMessage(readOnlyVersion));
      if (!CANCELLED_REASONS.includes(reason)) {
        throw new Error(`approval cancelOpen needs a reason from CANCELLED_REASONS, got: ${reason}`);
      }
      const open = [...entries.values()].filter(
        (entry) =>
          entry.status === 'pending' &&
          (entry.mode === 'deferred' || ownedIds.has(entry.id)) &&
          (typeof match === 'function' ? match(entry) : true),
      );
      const cancelledAt = now();
      const cancelled = [];
      for (const entry of open) {
        entries.set(entry.id, { ...entry, status: 'cancelled', cancelledAt, cancelledReason: reason });
        ownedIds.delete(entry.id);
        cancelled.push(entry.id);
      }
      if (cancelled.length > 0) {
        try {
          await persist();
        } catch (err) {
          log(`approvals: could not record the ${reason} cancellations (${err.message}); they are refused in memory regardless`);
        }
      }
      return { ok: true, cancelled };
    });
  }

  /**
   * The history (P1/D): finished entries — decided, lapsed, cancelled,
   * expired — newest first, for GET /api/approvals?status=all. Pending
   * entries are the inbox's job (listPending), never this list's. `since`
   * keeps only entries whose zero point (finishedAt) is at or after it;
   * `limit` caps the count after sorting. Records missing the newer fields
   * (runId, cancelledAt, decidedVia) come back as they are — the reader,
   * not the store, decides how a missing field renders.
   */
  function listHistory({ limit = null, since = null } = {}) {
    return serialized(async () => {
      let list = [...entries.values()]
        .filter((entry) => isFinished(entry))
        // A finished entry's grant intent is dead weight outside the mint
        // path: the history view has no business exposing a nonce, and a
        // stale intent must not look replayable. consumeGrantIntent() reads
        // the live record, never this projection.
        .map((entry) => {
          const { grantIntent, ...rest } = entry;
          return grantIntent ? rest : entry;
        });
      if (Number.isFinite(since)) list = list.filter((entry) => finishedAt(entry) >= since);
      list.sort((a, b) => finishedAt(b) - finishedAt(a));
      return Number.isFinite(limit) && limit > 0 ? list.slice(0, limit) : list;
    });
  }

  /** Every entry still waiting for an answer, oldest first — the inbox, in the order it should be worked. */
  function listPending() {
    return serialized(async () =>
      [...entries.values()]
        .filter((entry) => entry.status === 'pending' && (entry.mode === 'deferred' || ownedIds.has(entry.id)))
        .sort((a, b) => (a.requestedAt ?? 0) - (b.requestedAt ?? 0)),
    );
  }

  /** One entry by id, whatever its status — including expired ones, so a caller can say WHY an id is no longer answerable. Null when it was never recorded or has been pruned. */
  function get(id) {
    return serialized(async () => entries.get(id) ?? null);
  }

  return { put, decide, cancel, cancelOpen, reopen, consumeGrantIntent, listPending, listHistory, get };
}
