// The handover log: what every session wrote down before an account switch,
// and what became of it. Append-only, like every kaprek store — one JSON
// line per event in <dataDir>/handover/log.jsonl.
//
// A "switch" is one account change: the running sessions hand over, the
// person logs in to another account, and kaprek starts one fresh session per
// handover (never --resume: the new account would re-read the whole
// transcript, uncached). Events:
//
//   switch.opened            { switchId, ts, by, note, expected: [{sessionId, cwd, title}] }
//   handover.recorded        { switchId, handoverId, ts, sessionId, cwd, file,
//                              section, prompt, title, note, nothingOpen }
//   handover.start-requested { switchId, handoverId, attemptId, ts, account, skip, startFile }
//   handover.started         { switchId, handoverId, attemptId, ts, ok, method, error }
//   handover.confirmed       { switchId, handoverId, attemptId, ts, newSessionId }
//
// The intent is written BEFORE a tab is opened and the outcome after it, so
// a crash in between leaves a visible "unknown" instead of a handover that
// looks untouched and gets a second session on the next click. "started"
// only means the tab opened; "confirmed" means the new session's transcript
// was seen (src/resume/scan.mjs finds the attempt key in its first prompt).
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export const HANDOVER_EVENT_TYPES = ['switch.opened', 'handover.recorded', 'handover.start-requested', 'handover.started', 'handover.confirmed'];
export const HANDOVER_STATUSES = ['nothing', 'pending', 'failed', 'unknown', 'spawned', 'running'];

// `add` without --switch joins the latest switch if it is younger than this;
// older than that, the handover belongs to a new account change.
export const AUTO_OPEN_WINDOW_MS = 12 * 60 * 60 * 1000;

// A start run holds <dataDir>/handover/start.lock; one left behind by a
// killed process is taken over after this long.
export const START_LOCK_STALE_MS = 2 * 60 * 1000;
// ...unless the process that holds it is still running: then it is only
// taken over after this long without a refresh. A run refreshes after every
// tab, so a live owner this quiet is hung, not slow.
export const START_LOCK_LIVE_STALE_MS = 15 * 60 * 1000;

// "h-1a2b3c4d.9f8e": handover id, dot, attempt id. It names the start file
// and travels in the first prompt of the fresh session, which is how that
// session is recognised afterwards.
export const ATTEMPT_KEY_RE = /\bh-[0-9a-f]{8}\.[0-9a-f]{4}\b/;

const LIMITS = { title: 80, section: 200, prompt: 4000, note: 2000, by: 200, path: 1000, id: 200 };
const MAX_EXPECTED = 200;

function logPath(dataDir) {
  return path.join(dataDir, 'handover', 'log.jsonl');
}

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

// A dozen sessions report within the same minute. One line is one write, but
// Windows answers a concurrent open with EBUSY/EPERM now and then — and a
// report that is silently lost is exactly the failure this log exists to
// prevent, so the append is retried before it gives up loudly.
function append(dataDir, event) {
  const file = logPath(dataDir);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  // A write torn by a crash leaves a last line without its newline. The
  // reader skips that fragment — but the next event glued onto it would be
  // skipped with it, and a lost "start-requested" is a tab nobody knows of.
  const line = `${endsWithNewline(file) ? '' : '\n'}${JSON.stringify(event)}\n`;
  for (let attempt = 0; ; attempt++) {
    try {
      fs.appendFileSync(file, line, 'utf8');
      return;
    } catch (err) {
      if (attempt >= 5 || !['EBUSY', 'EPERM', 'EAGAIN', 'EACCES'].includes(err?.code)) throw err;
      sleepSync(40 * (attempt + 1));
    }
  }
}

/** True for a missing or empty file too: there is nothing to separate from. */
function endsWithNewline(file) {
  let fd;
  try {
    const { size } = fs.statSync(file);
    if (size === 0) return true;
    fd = fs.openSync(file, 'r');
    const last = Buffer.alloc(1);
    fs.readSync(fd, last, 0, 1, size - 1);
    return last[0] === 0x0a;
  } catch {
    return true;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

function iso(now) {
  return new Date(typeof now === 'function' ? now() : now).toISOString();
}

/** Trimmed, control characters removed (line breaks kept only when `multiline`), cut at `max`; null for anything empty or not a string. */
function text(value, max, { multiline = false } = {}) {
  if (typeof value !== 'string') return null;
  // eslint-disable-next-line no-control-regex
  const cleaned = (multiline ? value.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '') : value.replace(/[\u0000-\u001F\u007F]+/g, ' ')).trim();
  if (cleaned === '') return null;
  return cleaned.length > max ? cleaned.slice(0, max) : cleaned;
}

function newSwitchId(tsIso) {
  // w-20261115-1255-3fa9: readable in a listing, unique enough for one machine.
  const stamp = tsIso.replace(/[-:]/g, '').slice(0, 13).replace('T', '-');
  return `w-${stamp}-${crypto.randomBytes(2).toString('hex')}`;
}

function newHandoverId() {
  return `h-${crypto.randomBytes(4).toString('hex')}`;
}

export function newAttemptId() {
  return crypto.randomBytes(2).toString('hex');
}

export function attemptKey(handoverId, attemptId) {
  return `${handoverId}.${attemptId}`;
}

export function readEvents(dataDir) {
  const file = logPath(dataDir);
  if (!fs.existsSync(file)) return [];
  const events = [];
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (line.trim() === '') continue;
    try {
      events.push(JSON.parse(line));
    } catch {
      // a torn line from a crash mid-write is not the log's problem
    }
  }
  return events;
}

/**
 * nothing  nothing to hand over — listed, never started
 * pending  reported, no start attempted
 * failed   no attempt opened a tab, and every one of them says so
 * unknown  an attempt was requested and its outcome never written (crash)
 * spawned  a tab opened; the new session has not been seen yet
 * running  the new session was seen
 */
/**
 * Did a start attempt open a tab — or may it have? An attempt without an
 * outcome counts: nobody knows. Attempts that all say "no tab" (folder gone,
 * CLI missing) leave the handover as untouched as one never started: it may
 * still be corrected, its switch is not spent, its old session not replaced.
 */
function mayHaveOpened(attempts) {
  return attempts.some((a) => !a.result || a.result.ok);
}

function statusOf(h) {
  if (h.nothingOpen) return 'nothing';
  if (h.attempts.length === 0) return 'pending';
  if (h.attempts.some((a) => a.confirmed)) return 'running';
  if (h.attempts.some((a) => a.result?.ok)) return 'spawned';
  // One attempt without an outcome may be a tab that did open. A later
  // attempt that failed does not settle that: "failed" would send the
  // handover into the next ordinary run and open a second session.
  return h.attempts.some((a) => !a.result) ? 'unknown' : 'failed';
}

/**
 * Folds the event log into switches, oldest first. Within a switch the last
 * `handover.recorded` of a handover id wins (a session may correct its
 * report until a start was attempted — recordHandover() gives a correction
 * after that its own id, so a started handover never changes under the
 * session that was started from it). A record that names a switch nobody
 * opened still shows up, under a switch made up on the spot: a protocol
 * must not lose a line because another one is missing.
 */
export function fold(events) {
  const switches = new Map();
  const ensureSwitch = (switchId, ts) => {
    let sw = switches.get(switchId);
    if (!sw) {
      sw = { switchId, openedAt: ts ?? null, by: null, note: null, loginOrg: null, expected: [], handovers: new Map() };
      switches.set(switchId, sw);
    }
    return sw;
  };
  const attemptOf = (e) => switches.get(e.switchId)?.handovers.get(e.handoverId)?.attempts.find((a) => a.attemptId === e.attemptId) ?? null;

  for (const e of events) {
    if (typeof e?.switchId !== 'string' || e.switchId === '') continue;
    if (e.type === 'switch.opened') {
      const sw = ensureSwitch(e.switchId, e.ts);
      sw.openedAt = e.ts ?? sw.openedAt;
      sw.by = e.by ?? null;
      sw.note = e.note ?? null;
      sw.loginOrg = e.loginOrg ?? null;
      sw.expected = Array.isArray(e.expected) ? e.expected.filter((x) => typeof x?.sessionId === 'string') : [];
    } else if (e.type === 'handover.recorded') {
      if (typeof e.handoverId !== 'string' || e.handoverId === '') continue;
      const sw = ensureSwitch(e.switchId, e.ts);
      const existing = sw.handovers.get(e.handoverId);
      // recordHandover() never writes this (it decides under the lock every
      // start holds), but a log is read as it is: once a tab opened or may
      // have, what that session was started from does not change any more.
      if (existing && mayHaveOpened(existing.attempts)) continue;
      sw.handovers.set(e.handoverId, {
        handoverId: e.handoverId,
        sessionId: e.sessionId ?? null,
        cwd: e.cwd ?? null,
        file: e.file ?? null,
        section: e.section ?? null,
        prompt: e.prompt ?? null,
        title: e.title ?? null,
        note: e.note ?? null,
        nothingOpen: e.nothingOpen === true,
        recordedAt: e.ts ?? null,
        attempts: existing?.attempts ?? [],
      });
    } else if (e.type === 'handover.start-requested') {
      const h = switches.get(e.switchId)?.handovers.get(e.handoverId);
      if (!h || typeof e.attemptId !== 'string') continue;
      h.attempts.push({ attemptId: e.attemptId, requestedAt: e.ts ?? null, account: e.account ?? null, skip: e.skip !== false, startFile: e.startFile ?? null, result: null, confirmed: null });
    } else if (e.type === 'handover.started') {
      const a = attemptOf(e);
      if (a) a.result = { ts: e.ts ?? null, ok: e.ok === true, method: e.method ?? null, error: e.error ?? null };
    } else if (e.type === 'handover.confirmed') {
      const a = attemptOf(e);
      if (a && !a.confirmed) a.confirmed = { ts: e.ts ?? null, sessionId: e.newSessionId ?? null };
    }
  }

  return {
    switches: [...switches.values()].map((sw) => ({
      switchId: sw.switchId,
      openedAt: sw.openedAt,
      by: sw.by,
      note: sw.note,
      loginOrg: sw.loginOrg,
      expected: sw.expected,
      handovers: [...sw.handovers.values()].map((h) => {
        const opened = h.attempts.filter((a) => a.result?.ok);
        const confirmed = h.attempts.filter((a) => a.confirmed);
        const last = h.attempts[h.attempts.length - 1] ?? null;
        return {
          ...h,
          status: statusOf(h),
          startedAt: opened.length > 0 ? opened[opened.length - 1].result.ts : null,
          lastError: last?.result && !last.result.ok ? last.result.error : null,
          newSessionId: confirmed.length > 0 ? confirmed[confirmed.length - 1].confirmed.sessionId : null,
        };
      }),
    })),
  };
}

export function readHandovers(dataDir) {
  return fold(readEvents(dataDir));
}

/** The switch new handovers join and the button acts on: the one opened last. */
export function currentSwitch(state) {
  return state.switches.length > 0 ? state.switches[state.switches.length - 1] : null;
}

export function countByStatus(handovers) {
  const counts = Object.fromEntries(HANDOVER_STATUSES.map((s) => [s, 0]));
  for (const h of handovers) counts[h.status] += 1;
  return counts;
}

/**
 * Opens a switch. `expected` is the list of sessions that were open at this
 * moment — frozen here, so "who has not reported yet" is answered against
 * what was running when the switch began, not against whatever happens to
 * be open when somebody looks.
 */
export function openSwitch(dataDir, { by = null, note = null, expected = [], loginOrg = null, now = Date.now } = {}) {
  const ts = iso(now);
  const switchId = newSwitchId(ts);
  const list = (Array.isArray(expected) ? expected : [])
    .map((x) => ({ sessionId: text(x?.sessionId, LIMITS.id), cwd: text(x?.cwd, LIMITS.path), title: text(x?.title, 160) }))
    .filter((x) => x.sessionId)
    .slice(0, MAX_EXPECTED);
  // loginOrg: the organization logged in when the switch began. A start on
  // "the logged-in account" while it is still the same one would put every
  // fresh session back on the account that just ran out.
  append(dataDir, { type: 'switch.opened', switchId, ts, by: text(by, LIMITS.by), note: text(note, LIMITS.note, { multiline: true }), expected: list, loginOrg: text(loginOrg, LIMITS.id) });
  return { switchId, openedAt: ts };
}

/**
 * Writes one session's handover into a switch: the one named by `switchId`,
 * otherwise the latest (opening one when there is none younger than
 * AUTO_OPEN_WINDOW_MS that nothing was started from yet). `nothingOpen` records a session that has nothing to
 * hand over. Throws on a handover without an absolute file path — a start
 * that points a fresh session at nothing is worse than no start.
 */
export function recordHandover(dataDir, { sessionId = null, cwd = null, file = null, section = null, prompt = null, title = null, note = null, nothingOpen = false, switchId = null, now = Date.now, lockWaitMs } = {}) {
  const session = text(sessionId, LIMITS.id);
  const handoverFile = text(file, LIMITS.path);
  if (!nothingOpen) {
    if (!handoverFile) throw new Error('a handover needs a file (or nothingOpen when there is nothing to hand over)');
    // isAbsolute() alone accepts "\foo", which means a different file on every drive.
    if (!path.isAbsolute(handoverFile) || path.resolve(handoverFile) !== path.normalize(handoverFile)) {
      throw new Error(`the handover file must be a full absolute path: ${handoverFile}`);
    }
  }
  const ts = iso(now);
  // Read, decide, write — under the lock every start run holds. Without it
  // a dozen sessions reporting at once would each open a switch of their
  // own, and a correction could land on a handover a start just took.
  return withStoreLock(dataDir, () => {
    const state = readHandovers(dataDir);
    let sw = switchId ? (state.switches.find((s) => s.switchId === switchId) ?? null) : currentSwitch(state);
    if (switchId && !sw) throw new Error(`no such switch: ${switchId}`);
    let opened = false;
    // Without --switch a report joins the latest switch only while that one
    // is young and untouched. One that was started from is over: a report
    // hours later is the next account change, not a straggler of this one
    // (a straggler names its switch, the lead's message carries the id).
    const spent = sw && !switchId && (Date.parse(ts) - (Date.parse(sw.openedAt) || 0) > AUTO_OPEN_WINDOW_MS || sw.handovers.some((h) => mayHaveOpened(h.attempts)));
    if (!sw || spent) {
      sw = { ...openSwitch(dataDir, { by: session, now: () => Date.parse(ts) }), handovers: [] };
      opened = true;
    }
    // The same session reporting again corrects its report — unless a tab
    // was opened from it (or may have been); then the correction is a new
    // handover. A report whose starts were all refused is corrected in
    // place: a second handover next to it would get a second session.
    const earlier = session ? sw.handovers.filter((h) => h.sessionId === session).pop() : null;
    const replaces = earlier && !mayHaveOpened(earlier.attempts);
    const handoverId = replaces ? earlier.handoverId : newHandoverId();
    append(dataDir, {
      type: 'handover.recorded',
      switchId: sw.switchId,
      handoverId,
      ts,
      sessionId: session,
      cwd: text(cwd, LIMITS.path),
      file: nothingOpen ? null : handoverFile,
      section: nothingOpen ? null : text(section, LIMITS.section),
      prompt: nothingOpen ? null : text(prompt, LIMITS.prompt, { multiline: true }),
      title: text(title, LIMITS.title),
      note: text(note, LIMITS.note, { multiline: true }),
      nothingOpen: nothingOpen === true,
    });
    return { switchId: sw.switchId, handoverId, opened, replaced: Boolean(replaces) };
  }, lockWaitMs === undefined ? {} : { waitMs: lockWaitMs });
}

/**
 * `kaprek handover open`: the switch of this account change. Asked twice
 * within `reuseWithinMs` — the lead invoked again, or a participant that ran
 * `open` by mistake — it answers with the switch that is already there, as
 * long as nothing was started from it; `forceNew` opens a separate one.
 */
export function openOrReuseSwitch(dataDir, { reuseWithinMs = 60 * 60 * 1000, forceNew = false, now = Date.now, lockWaitMs, ...open } = {}) {
  return withStoreLock(dataDir, () => {
    const cur = currentSwitch(readHandovers(dataDir));
    const nowMs = typeof now === 'function' ? now() : now;
    if (cur && !forceNew && nowMs - (Date.parse(cur.openedAt) || 0) <= reuseWithinMs && cur.handovers.every((h) => !mayHaveOpened(h.attempts))) {
      return { switchId: cur.switchId, openedAt: cur.openedAt, reused: true };
    }
    return { ...openSwitch(dataDir, { ...open, now }), reused: false };
  }, lockWaitMs === undefined ? {} : { waitMs: lockWaitMs });
}

export function recordStartRequested(dataDir, { switchId, handoverId, attemptId, account = null, skip = true, startFile = null, now = Date.now } = {}) {
  append(dataDir, { type: 'handover.start-requested', switchId, handoverId, attemptId, ts: iso(now), account, skip: skip !== false, startFile });
}

export function recordStarted(dataDir, { switchId, handoverId, attemptId, ok, method = null, error = null, now = Date.now } = {}) {
  append(dataDir, { type: 'handover.started', switchId, handoverId, attemptId, ts: iso(now), ok: ok === true, method, error: text(error, 500) });
}

export function recordConfirmed(dataDir, { switchId, handoverId, attemptId, newSessionId, now = Date.now } = {}) {
  append(dataDir, { type: 'handover.confirmed', switchId, handoverId, attemptId, ts: iso(now), newSessionId });
}

function readLock(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err?.code === 'EPERM'; // it exists, it is just not ours to signal
  }
}

/**
 * One writer that decides at a time, across processes: a start run (the
 * server's button, or `kaprek handover start` in a terminal) and every
 * read-then-write of the protocol take <dataDir>/handover/start.lock.
 * Returns { release, refresh }, or null while somebody else holds it.
 *
 * The lock names its owner. `release` and `refresh` only touch a lock that
 * still carries this owner's token, so a run that was taken over cannot
 * delete its successor's lock. A lock counts as abandoned when its process
 * is gone; when that process still runs but did not refresh it for
 * `liveStaleMs` (a run refreshes after every tab); or, without a readable
 * owner, when it is older than `staleMs`. Taking over and releasing both
 * happen under a second lock, so two processes that saw it abandoned cannot
 * both delete and re-create, and a release cannot hit a lock that was just
 * taken over.
 */
export function acquireStartLock(dataDir, { now = Date.now, staleMs = START_LOCK_STALE_MS, liveStaleMs = START_LOCK_LIVE_STALE_MS, isAlive = pidAlive } = {}) {
  const file = path.join(dataDir, 'handover', 'start.lock');
  const reclaim = `${file}.reclaim`;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const token = crypto.randomBytes(8).toString('hex');
  const create = () => {
    const fd = fs.openSync(file, 'wx');
    try {
      fs.writeSync(fd, JSON.stringify({ pid: process.pid, token, ts: iso(now) }));
    } finally {
      fs.closeSync(fd);
    }
    return {
      // Under the same second lock a takeover uses: "is it still mine?" and
      // "delete it" must not have a takeover in between, or this would
      // delete the lock of the run that took over.
      release() {
        for (let attempt = 0; attempt < 60; attempt++) {
          let rfd;
          try {
            rfd = fs.openSync(reclaim, 'wx');
          } catch (err) {
            if (err?.code !== 'EEXIST') return;
            // A takeover is deciding right now — or one died doing it and
            // left its file behind, which must not keep this lock forever.
            try {
              if (Date.now() - fs.statSync(reclaim).mtimeMs > 30_000) fs.unlinkSync(reclaim);
            } catch { /* gone already */ }
            sleepSync(20);
            continue;
          }
          try {
            if (readLock(file)?.token === token) {
              try { fs.unlinkSync(file); } catch { /* already gone */ }
            }
          } finally {
            fs.closeSync(rfd);
            try { fs.unlinkSync(reclaim); } catch { /* already gone */ }
          }
          return;
        }
      },
      refresh() {
        if (readLock(file)?.token !== token) return;
        const t = new Date();
        try { fs.utimesSync(file, t, t); } catch { /* gone: nothing to keep alive */ }
      },
    };
  };
  const tryCreate = () => {
    try {
      return create();
    } catch (err) {
      if (err?.code === 'EEXIST') return null;
      throw err;
    }
  };

  const mine = tryCreate();
  if (mine) return mine;

  const seen = readLock(file);
  let mtimeMs = null;
  try {
    mtimeMs = fs.statSync(file).mtimeMs;
  } catch { /* vanished between the two calls */ }
  if (mtimeMs === null) return tryCreate();
  const nowMs = typeof now === 'function' ? now() : now;
  const age = nowMs - mtimeMs;
  // No readable owner (a write torn mid-way): only its age speaks. A dead
  // owner: abandoned at once. A live one: only after a long silence.
  const abandoned = !seen ? age >= staleMs : !isAlive(seen.pid) || age >= liveStaleMs;
  if (!abandoned) return null;

  let rfd;
  try {
    rfd = fs.openSync(reclaim, 'wx');
  } catch (err) {
    if (err?.code !== 'EEXIST') throw err;
    // Somebody is taking over right now — or died doing it.
    try {
      if (Date.now() - fs.statSync(reclaim).mtimeMs > 30_000) fs.unlinkSync(reclaim);
    } catch { /* gone already */ }
    return null;
  }
  try {
    // Still the lock that was judged abandoned? Another process may have
    // taken over and released, and a third one acquired, in between.
    const current = readLock(file);
    if (current && seen && current.token !== seen.token) return null;
    try { fs.unlinkSync(file); } catch { /* released meanwhile */ }
    return tryCreate();
  } finally {
    fs.closeSync(rfd);
    try { fs.unlinkSync(reclaim); } catch { /* already gone */ }
  }
}

/**
 * Runs `fn` while holding the lock, waiting up to `waitMs` for a start run
 * to finish. Throws an error with code HANDOVER_BUSY when it does not get in.
 */
export function withStoreLock(dataDir, fn, { waitMs = 90_000, acquire = acquireStartLock } = {}) {
  const deadline = Date.now() + waitMs;
  for (;;) {
    const lock = acquire(dataDir);
    if (lock) {
      try {
        return fn();
      } finally {
        lock.release();
      }
    }
    if (Date.now() >= deadline) {
      const err = new Error('the handover protocol is busy (a start is running) — try again in a moment');
      err.code = 'HANDOVER_BUSY';
      throw err;
    }
    sleepSync(150);
  }
}

/**
 * Index for src/resume/scan.mjs, never throwing (a broken handover log must
 * not take the session list down with it):
 *   bySession  old session id → { handoverId, recordedAt, started } of its latest report
 *   byAttempt  attempt key    → { switchId, handoverId, attemptId, confirmed }
 */
export function handoverIndex(dataDir) {
  const bySession = new Map();
  const byAttempt = new Map();
  let state;
  try {
    state = readHandovers(dataDir);
  } catch {
    return { bySession, byAttempt };
  }
  for (const sw of state.switches) {
    for (const h of sw.handovers) {
      if (h.sessionId) bySession.set(h.sessionId, { handoverId: h.handoverId, recordedAt: h.recordedAt, started: mayHaveOpened(h.attempts) });
      for (const a of h.attempts) {
        byAttempt.set(attemptKey(h.handoverId, a.attemptId), { switchId: sw.switchId, handoverId: h.handoverId, attemptId: a.attemptId, confirmed: Boolean(a.confirmed) });
      }
    }
  }
  return { bySession, byAttempt };
}
