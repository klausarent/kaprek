// Plan store — an append-only JSONL event log with an in-memory projection,
// structurally identical to src/missions/store.mjs.
//
// What it holds is deliberately thin: WHERE a plan lives (always an absolute
// path), what it belongs to, and its status. The plan's content and its
// steps are never copied in here — they are read from the file every time.
//
// The reason is Klaus' complaint, verbatim: "Hier muss man immer erst den
// Ordner öffnen und selber durchklicken, weil du niemals absolute Pfade mit
// schickst." An agent that writes a plan and then describes where it put it
// is the bug. kaprek decides the path up front, registers it here, and hands
// the user something to click — the path stops being something anyone has to
// reconstruct from a sentence.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { parseSteps, setStep as setStepInMarkdown, planTitle } from './markdown.mjs';
import { renderFindingsSection, appendFindingsSection } from './findings.mjs';
import { isInside } from '../lib/contain.mjs';

export const PLAN_STATUSES = ['draft', 'active', 'done', 'archived'];
/** A spec is what brainstorming produces; a plan is what writing-plans produces. */
export const PLAN_KINDS = ['spec', 'plan'];

/** Content above this is capped on read — a plan is a document, not a dataset. */
const MAX_READ_BYTES = 512 * 1024;

/** sha256 of a string, the fingerprint a plan carries of the file as kaprek last saw it. */
function hashOf(content) {
  return crypto.createHash('sha256').update(content, 'utf8').digest('hex');
}

/** The file's fingerprint now, or null when it cannot be read or is too large to be a plan. */
function hashFile(filePath) {
  try {
    const stat = fs.statSync(filePath);
    if (!stat.isFile() || stat.size > MAX_READ_BYTES * 4) return null;
    return hashOf(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

export class PlanNotFoundError extends Error {
  constructor(planId) {
    super(`plan not found: ${planId}`);
    this.name = 'PlanNotFoundError';
    this.planId = planId;
  }
}

export class PlanFileMissingError extends Error {
  constructor(filePath) {
    super(`plan file is gone: ${filePath}`);
    this.name = 'PlanFileMissingError';
    this.path = filePath;
  }
}

export class InvalidPlanPathError extends Error {
  constructor(filePath) {
    super(`plan path must be absolute, got: ${filePath}`);
    this.name = 'InvalidPlanPathError';
    this.path = filePath;
  }
}

export class InvalidStatusError extends Error {
  constructor(status) {
    super(`invalid status: ${status} (expected one of ${PLAN_STATUSES.join(', ')})`);
    this.name = 'InvalidStatusError';
    this.status = status;
  }
}

/**
 * The gate: a plan is done when a converge turn found nothing, not when
 * someone says so. Overriding is allowed — and recorded, on the plan and in
 * every receipt that points at it — because a gate nobody can pass by hand
 * gets worked around in silence, which is worse than an override on record.
 */
export class PlanNotConvergedError extends Error {
  constructor(planId, converge) {
    const state = converge === null ? 'no convergence check has run yet' : `the last check (round ${converge.round}) found ${converge.findings} gap(s)`;
    super(`plan ${planId} cannot be marked done: ${state}`);
    this.name = 'PlanNotConvergedError';
    this.planId = planId;
    this.converge = converge;
  }
}

export class PlanOutsideRootError extends Error {
  constructor(filePath) {
    super(`plan path is outside every allowed root: ${filePath}`);
    this.name = 'PlanOutsideRootError';
    this.path = filePath;
  }
}

// realish() and isInside() moved to src/lib/contain.mjs — the council's file
// snapshots need the same containment answer this store does.

/**
 * The key two registrations of the same file agree on. Windows paths are
 * case-insensitive, so `C:\p\Plan.md` and `c:\p\plan.md` are one plan there
 * and two everywhere else — matching the filesystem's own answer rather than
 * picking one rule for both.
 */
function dedupeKey(absolutePath) {
  return process.platform === 'win32' ? absolutePath.toLowerCase() : absolutePath;
}

function applyEvent(plans, event) {
  const { type, planId, data, ts } = event;
  switch (type) {
    case 'plan.created': {
      // One file, one plan. Two kaprek processes sharing a dataDir each
      // append their own plan.created for the same path (Grok's review) —
      // replaying both would leave two entries whose step-writers race on
      // one file. First writer wins; later ones only fill in blanks.
      const resolved = typeof data?.path === 'string' ? path.resolve(data.path) : null;
      const key = resolved === null ? null : dedupeKey(resolved);
      if (key !== null) {
        for (const existing of plans.values()) {
          if (dedupeKey(existing.path) !== key) continue;
          existing.chatId = existing.chatId ?? data.chatId ?? null;
          existing.missionId = existing.missionId ?? data.missionId ?? null;
          if (data.contentHash) {
            existing.seenHash = data.contentHash;
            existing.seenAt = ts;
          }
          existing.updatedAt = ts;
          return;
        }
      }
      plans.set(planId, {
        id: planId,
        path: data.path,
        title: data.title,
        kind: data.kind,
        status: 'draft',
        chatId: data.chatId ?? null,
        missionId: data.missionId ?? null,
        // The last convergence check, and whether 'done' was set past the
        // gate. Both null until something happens; both survive in the
        // event log, so a plan's history of checks is replayable.
        converge: null,
        override: null,
        // The file as kaprek last saw it (a registration, a tick, a converge
        // round): the fingerprint, and when. Against it a read can say
        // "edited outside kaprek since" — the Graft idea of a source hash,
        // applied to the one file a plan IS.
        seenHash: data.contentHash ?? null,
        seenAt: data.contentHash ? ts : null,
        createdAt: ts,
        updatedAt: ts,
      });
      break;
    }
    case 'plan.status': {
      const plan = plans.get(planId);
      if (!plan) break;
      plan.status = data.status;
      // An override is a fact about THIS status. The next status change,
      // whichever way it goes, starts clean.
      plan.override = data.override ? { by: data.override.by, at: ts } : null;
      plan.updatedAt = ts;
      break;
    }
    case 'plan.converged': {
      const plan = plans.get(planId);
      if (!plan) break;
      if (data.contentHash) {
        plan.seenHash = data.contentHash;
        plan.seenAt = ts;
      }
      plan.converge = {
        round: data.round,
        chatId: data.chatId ?? null,
        findings: data.findings,
        converged: data.converged === true,
        at: ts,
      };
      plan.updatedAt = ts;
      break;
    }
    case 'plan.touched': {
      const plan = plans.get(planId);
      if (!plan) break;
      if (data?.contentHash) {
        plan.seenHash = data.contentHash;
        plan.seenAt = ts;
      }
      plan.updatedAt = ts;
      break;
    }
    default:
      // Unknown type — skip, so an older reader survives a newer writer.
      break;
  }
}

function loadEvents(eventsPath) {
  if (!fs.existsSync(eventsPath)) return [];
  const lines = fs.readFileSync(eventsPath, 'utf8').split('\n').filter((line) => line.trim().length > 0);
  const events = [];
  let skipped = 0;
  for (const line of lines) {
    try {
      events.push(JSON.parse(line));
    } catch {
      skipped += 1;
    }
  }
  if (skipped > 0) console.warn(`plans: skipped ${skipped} corrupt event line(s) while loading ${eventsPath}`);
  return events;
}

function clone(value) {
  return value === undefined ? value : JSON.parse(JSON.stringify(value));
}

/**
 * Opens the plan store for `dataDir`, replaying `<dataDir>/plans/events.jsonl`.
 *
 * @param {() => string[]} [options.allowedRoots] - the directories a plan may
 *   live in, evaluated on every access rather than captured once: kaprek's
 *   own data dir plus whatever mission working directories exist right now.
 *   Anything else is refused — at registration AND at every later read or
 *   write, because the event log is a file on disk and a hand-edited line
 *   naming someone else's document must not become a write permit.
 */
export function openPlans(dataDir, { allowedRoots } = {}) {
  const plansDir = path.join(dataDir, 'plans');
  const eventsFile = path.join(plansDir, 'events.jsonl');
  const roots = typeof allowedRoots === 'function' ? allowedRoots : () => [dataDir];

  /** @throws {PlanOutsideRootError} when `filePath` is in none of the current roots. */
  function assertInsideRoot(filePath) {
    const current = roots().filter((root) => typeof root === 'string' && root.trim() !== '');
    if (!current.some((root) => isInside(root, filePath))) throw new PlanOutsideRootError(filePath);
  }

  const plans = new Map();
  for (const event of loadEvents(eventsFile)) applyEvent(plans, event);

  function commit(type, planId, data) {
    const event = { id: crypto.randomUUID(), ts: new Date().toISOString(), type, planId, data };
    fs.mkdirSync(plansDir, { recursive: true });
    fs.appendFileSync(eventsFile, `${JSON.stringify(event)}\n`, 'utf8');
    applyEvent(plans, event);
    return event;
  }

  function requirePlan(planId) {
    const plan = plans.get(planId);
    if (!plan) throw new PlanNotFoundError(planId);
    return plan;
  }

  /**
   * The plan plus whether its file is still there — a deleted file is worth
   * showing, not hiding — and whether it changed outside kaprek since kaprek
   * last saw it (null when nothing has been seen yet or the file is gone).
   */
  function withExistence(plan) {
    const exists = fs.existsSync(plan.path);
    const changedOutside = exists && plan.seenHash ? hashFile(plan.path) !== plan.seenHash : null;
    return { ...clone(plan), exists, changedOutside };
  }

  /** Reads a registered plan's file, re-checking containment first. */
  function readFileOf(plan) {
    assertInsideRoot(plan.path);
    let raw;
    try {
      if (!fs.statSync(plan.path).isFile()) throw new PlanFileMissingError(plan.path);
      raw = fs.readFileSync(plan.path, 'utf8');
    } catch (err) {
      if (err instanceof PlanFileMissingError) throw err;
      throw new PlanFileMissingError(plan.path);
    }
    return raw;
  }

  return {
    eventsPath: eventsFile,

    list({ missionId, chatId, status } = {}) {
      return [...plans.values()]
        .filter((p) => (missionId === undefined || p.missionId === missionId) && (chatId === undefined || p.chatId === chatId) && (status === undefined || p.status === status))
        .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
        .map(withExistence);
    },

    get(planId) {
      return withExistence(requirePlan(planId));
    },

    /**
     * Records a plan file. Idempotent per path: registering the same file
     * again returns the plan that is already there rather than a second
     * entry — a turn that reruns, or two routes that both notice the same
     * new file, must not litter the list.
     *
     * @param {string} options.path - absolute; the file must already exist
     * @param {string} [options.title] - defaults to the file's first heading, then its name
     */
    register({ path: filePath, title, kind = 'plan', chatId = null, missionId = null } = {}) {
      if (typeof filePath !== 'string' || !path.isAbsolute(filePath)) throw new InvalidPlanPathError(filePath);
      const resolved = path.resolve(filePath);
      assertInsideRoot(resolved);
      // A directory exists too. Registering one produced a plan that then
      // failed every read with "plan file is gone" while the path was right
      // there (Grok's review) — refuse it at the door instead.
      let stat;
      try {
        stat = fs.statSync(resolved);
      } catch {
        throw new PlanFileMissingError(resolved);
      }
      if (!stat.isFile()) throw new PlanFileMissingError(resolved);

      const key = dedupeKey(resolved);
      for (const plan of plans.values()) {
        if (dedupeKey(plan.path) === key) {
          // Fill in what the first registration did not know. Without this,
          // a plan first seen from one chat stays pinned to it forever even
          // once it belongs to a mission.
          const fill = {
            ...(plan.chatId === null && chatId !== null ? { chatId } : {}),
            ...(plan.missionId === null && missionId !== null ? { missionId } : {}),
          };
          commit('plan.created', plan.id, { path: plan.path, title: plan.title, kind: plan.kind, ...fill, contentHash: hashFile(resolved) });
          return withExistence(plans.get(plan.id));
        }
      }

      const resolvedTitle =
        (typeof title === 'string' && title.trim() !== '' ? title.trim() : null) ??
        planTitle(fs.readFileSync(resolved, 'utf8').slice(0, 4096)) ??
        path.basename(resolved);

      const planId = crypto.randomUUID();
      commit('plan.created', planId, {
        path: resolved,
        title: resolvedTitle,
        kind: PLAN_KINDS.includes(kind) ? kind : 'plan',
        chatId,
        missionId,
        contentHash: hashFile(resolved),
      });
      return withExistence(requirePlan(planId));
    },

    /**
     * Changes the status. 'done' is gated: it needs a convergence check that
     * found nothing (see recordConverge), or an explicit override naming who
     * decided — which is then part of the plan's record, not a detail lost
     * in a click.
     *
     * @param {{override?: {by: string}}} [options]
     * @throws {PlanNotConvergedError} for 'done' without a clean check and without an override
     */
    setStatus(planId, status, { override } = {}) {
      if (!PLAN_STATUSES.includes(status)) throw new InvalidStatusError(status);
      const plan = requirePlan(planId);
      if (status === 'done' && !(plan.converge?.converged === true)) {
        const by = typeof override?.by === 'string' ? override.by.trim() : '';
        if (by === '') throw new PlanNotConvergedError(planId, plan.converge ? { round: plan.converge.round, findings: plan.converge.findings } : null);
        commit('plan.status', planId, { status, override: { by: by.slice(0, 80) } });
        return withExistence(requirePlan(planId));
      }
      commit('plan.status', planId, { status });
      return withExistence(requirePlan(planId));
    },

    /**
     * Records what a convergence check found. Zero findings with the
     * agent's claim of convergence marks the plan done — that IS the gate
     * being passed; findings put it (back) to active, because there is work
     * again. The findings themselves are appended to the file by
     * appendFindings(); this only records the verdict.
     *
     * @param {{chatId?: string|null, findings: number, converged: boolean}} result
     */
    recordConverge(planId, { chatId = null, findings, converged }) {
      const plan = requirePlan(planId);
      const count = Number.isInteger(findings) && findings >= 0 ? findings : 0;
      const clean = converged === true && count === 0;
      const round = (plan.converge?.round ?? 0) + 1;
      commit('plan.converged', planId, { round, chatId, findings: count, converged: clean, contentHash: hashFile(plan.path) });
      if (clean && plan.status !== 'done') commit('plan.status', planId, { status: 'done' });
      if (!clean && plan.status !== 'active') commit('plan.status', planId, { status: 'active' });
      return withExistence(requirePlan(planId));
    },

    /**
     * Appends one round of findings to the plan file as unchecked steps —
     * append-only, under its own heading, so nothing a person wrote above
     * is touched. Returns the plan as read() would, from the new content.
     */
    appendFindings(planId, findings, { round, ts = new Date().toISOString() } = {}) {
      const plan = requirePlan(planId);
      const raw = readFileOf(plan);
      const nextRound = Number.isInteger(round) && round > 0 ? round : (plan.converge?.round ?? 0) + 1;
      const next = appendFindingsSection(raw, renderFindingsSection({ round: nextRound, findings, ts }));
      const tmp = `${plan.path}.kaprek-tmp-${process.pid}-${crypto.randomUUID()}`;
      fs.writeFileSync(tmp, next, 'utf8');
      fs.renameSync(tmp, plan.path);
      commit('plan.touched', planId, { contentHash: hashOf(next) });
      return { ...withExistence(plan), content: next, steps: parseSteps(next), truncated: false };
    },

    /**
     * The plan's current content and steps, straight from disk.
     *
     * Steps are parsed from the WHOLE document even when the content is
     * capped: setStep addresses the full file, so steps derived from a
     * truncated prefix would silently disagree with what a click writes
     * (Grok's review).
     */
    read(planId) {
      const plan = requirePlan(planId);
      const raw = readFileOf(plan);
      const truncated = Buffer.byteLength(raw, 'utf8') > MAX_READ_BYTES;
      const content = truncated ? raw.slice(0, MAX_READ_BYTES) : raw;
      return { ...withExistence(plan), content, steps: parseSteps(raw), truncated };
    },

    /**
     * Ticks or unticks one step by rewriting that line in the file. Throws
     * RangeError (from markdown.mjs) when the step is gone, which is the
     * honest answer when the file changed underneath the open page.
     */
    setStep(planId, index, done) {
      const plan = requirePlan(planId);
      const raw = readFileOf(plan);
      const next = setStepInMarkdown(raw, index, done === true);
      const tmp = `${plan.path}.kaprek-tmp-${process.pid}-${crypto.randomUUID()}`;
      fs.writeFileSync(tmp, next, 'utf8');
      fs.renameSync(tmp, plan.path);
      commit('plan.touched', planId, { contentHash: hashOf(next) });
      return { ...withExistence(plan), content: next, steps: parseSteps(next), truncated: false };
    },
  };
}
