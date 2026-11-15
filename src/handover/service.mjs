// What `kaprek handover start` and the button behind POST /api/handover/start
// both do: start one fresh session per handover, in a new terminal tab, and
// write down what happened. One implementation, so the terminal and the
// browser cannot drift apart — and one lock (store.mjs), so they cannot both
// open a tab for the same handover.
//
// The fresh session is NOT a resume. It gets one short first prompt that
// points at a start file kaprek wrote; the start file carries what the old
// session reported. Only kaprek's own words, a cleaned title and a path ever
// reach the command line: Windows PowerShell 5.1 does not escape quotes in
// arguments to native programs, so free text from a session never goes there.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  readHandovers,
  currentSwitch,
  countByStatus,
  recordStartRequested,
  recordStarted,
  recordConfirmed,
  acquireStartLock,
  newAttemptId,
  attemptKey,
} from './store.mjs';
import { openTab, tabEnv, PATHS } from '../resume/launch.mjs';
import { redactSecrets } from '../parser/parse.mjs';
import { resolveCli } from '../harness/claude-code.mjs';

export const ACCOUNT_MODES = ['login', 'auto'];
const TAB_GAP_MS = 700; // wt needs a breath between tabs, or they land in new windows
const MAX_PER_RUN = 40;
const CLI_ENTRY = fileURLToPath(new URL('../../bin/cli.mjs', import.meta.url));

// A fresh session on "the account that is logged in" must not inherit the
// token of the account the server happened to be started under (`kaprek
// claude` exports it), nor that session's proxy route and account tag — and
// no API key or bearer token either: both outrank the login in Claude Code.
const LOGIN_CREDENTIALS = ['CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN'];
const LOGIN_PREAMBLE = [
  `Remove-Item -LiteralPath ${LOGIN_CREDENTIALS.map((n) => `'Env:${n}'`).join(',')} -ErrorAction SilentlyContinue`,
  "if ($env:KAPREK_ACCOUNT) { Remove-Item -LiteralPath 'Env:ANTHROPIC_BASE_URL','Env:ANTHROPIC_CUSTOM_HEADERS','Env:KAPREK_ACCOUNT' -ErrorAction SilentlyContinue }",
];

export function loginEnv(base = process.env) {
  const env = tabEnv(base);
  for (const name of LOGIN_CREDENTIALS) delete env[name];
  if (env.KAPREK_ACCOUNT) {
    delete env.ANTHROPIC_BASE_URL;
    delete env.ANTHROPIC_CUSTOM_HEADERS;
    delete env.KAPREK_ACCOUNT;
  }
  return env;
}

/** Letters, digits, space and ._- only — the one piece of session text that reaches a command line. */
export function cleanTitle(value) {
  const cleaned = String(value ?? '')
    .replace(/[^\p{L}\p{N} ._-]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 60)
    .trim();
  return cleaned || 'Session';
}

/**
 * A handover's display name: what the session called it, else the folder its
 * handover file lies in, else the working directory. A title a session chose
 * goes through the same redaction as every other text of it — it ends up in
 * a window title and on a command line.
 */
export function titleOf(h) {
  if (h.title) return cleanTitle(redactSecrets(h.title));
  if (h.file) return cleanTitle(path.basename(path.dirname(h.file)));
  if (h.cwd) return cleanTitle(path.basename(h.cwd));
  return 'Session';
}

export function defaultPrompt(h) {
  return `Lies ${h.file}${h.section ? `, Abschnitt „${h.section}“,` : ''} und mach dort weiter.`;
}

export function startFilePath(dataDir, key) {
  return path.join(dataDir, 'handover', 'start', `${key}.md`);
}

/** The first prompt of the fresh session. Carries the attempt key, by which the session is recognised later. */
export function buildPointer({ title, key, startFile }) {
  return `Übergabe ${title} (${key}): Lies ${startFile} und mach dort weiter. Das alte Transkript nicht lesen.`;
}

export function buildStartFile(h, { key, switchId }) {
  const lines = [
    `# Übergabe nach Kontowechsel: ${titleOf(h)}`,
    '',
    'Du setzt die Arbeit einer früheren Session auf einem anderen Claude-Konto fort.',
    'Das alte Transkript nicht lesen und die alte Session nicht fortsetzen (`--resume`): das neue Konto müsste den ganzen Verlauf neu einlesen.',
    'Alles Nötige steht in der Übergabedatei. Fehlt dort etwas, frag nach, statt im alten Verlauf zu suchen.',
    '',
    `- Übergabedatei: ${h.file}`,
    ...(h.section ? [`- Abschnitt: ${h.section}`] : []),
    `- Arbeitsordner: ${h.cwd}`,
    ...(h.sessionId ? [`- Alte Session: ${h.sessionId}`] : []),
    ...(h.recordedAt ? [`- Gemeldet: ${h.recordedAt}`] : []),
    `- Protokoll: Wechsel ${switchId}, Übergabe ${key}`,
    '',
    '## Auftrag',
    '',
    h.prompt || defaultPrompt(h),
  ];
  if (h.note) lines.push('', '## Hinweise der alten Session', '', h.note);
  return `${lines.join('\n')}\n`;
}

/**
 * What would be run for one handover — the testable half of a start.
 * `login` runs claude itself on whatever account is logged in; `auto` runs
 * `kaprek claude`, which picks the account with the most room and sets its
 * token inside its own process (never in an argument or a file).
 */
export function buildStartCommand({ pointer, account = 'login', skip = true, claudePath = PATHS.claude, nodePath = process.execPath, cliPath = CLI_ENTRY }) {
  const flags = skip ? ['--dangerously-skip-permissions'] : [];
  if (account === 'auto') return { exe: nodePath, args: [cliPath, 'claude', ...flags, pointer], preamble: [], env: tabEnv() };
  return { exe: claudePath, args: [...flags, pointer], preamble: LOGIN_PREAMBLE, env: loginEnv() };
}

function resolveIds(sw, ids) {
  const found = [];
  const errors = [];
  for (const id of ids) {
    const exact = sw.handovers.find((h) => h.handoverId === id);
    const matches = exact ? [exact] : sw.handovers.filter((h) => h.handoverId.startsWith(id));
    if (matches.length === 1) found.push(matches[0]);
    else errors.push({ handoverId: id, error: matches.length === 0 ? 'no such handover in this switch' : `ambiguous: matches ${matches.length} handovers` });
  }
  return { found: [...new Set(found)], errors };
}

/**
 * Which handovers a run starts. Without `ids`: everything not started yet
 * (`pending`, `failed`). `again` widens that to handovers whose outcome is
 * unclear or that already have a session — never by accident, only when the
 * person asks for a second session.
 */
export function pickForStart(sw, { ids = null, again = false } = {}) {
  const startable = (h) => h.status === 'pending' || h.status === 'failed' || (again && h.status !== 'nothing');
  if (!ids) return { picked: sw.handovers.filter(startable), skipped: [] };
  const { found, errors } = resolveIds(sw, ids);
  const picked = [];
  const skipped = [...errors];
  for (const h of found) {
    if (startable(h)) picked.push(h);
    else skipped.push({ handoverId: h.handoverId, title: titleOf(h), error: h.status === 'nothing' ? 'nothing to hand over' : `already ${h.status} (start again explicitly)` });
  }
  return { picked, skipped };
}

function isDirectory(p) {
  try { return fs.statSync(p).isDirectory(); } catch { return false; }
}

/**
 * Starts the picked handovers of one switch, one tab each.
 * Returns { ok, busy?, error?, switchId, results: [{ handoverId, title, ok,
 * method?, error?, cwd, command, startFile }] }; with `dryRun` nothing is
 * written and nothing is opened, and every result says what would run.
 */
export async function startHandovers(
  { dataDir, switchId = null, ids = null, again = false, account = 'login', skip = true, dryRun = false, loginOrg = null },
  { open = openTab, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), now = Date.now, lock = acquireStartLock, claudePath = PATHS.claude, autoCli = () => resolveCli(tabEnv()), launchDir = path.join(dataDir, 'resume-cache', 'launch') } = {},
) {
  if (!ACCOUNT_MODES.includes(account)) return { ok: false, error: `account must be one of ${ACCOUNT_MODES.join(', ')}`, results: [] };

  // The lock comes first, the protocol is read under it: a run that read
  // "pending" and then waited for the lock would start what the run before
  // it just started.
  const held = dryRun ? { release() {}, refresh() {} } : lock(dataDir);
  if (!held) return { ok: false, busy: true, error: 'another start is running', switchId, results: [] };
  try {
    const state = readHandovers(dataDir);
    const sw = switchId ? (state.switches.find((s) => s.switchId === switchId) ?? null) : currentSwitch(state);
    if (!sw) return { ok: false, notFound: true, error: switchId ? `no such switch: ${switchId}` : 'no handover recorded yet', results: [] };
    const { picked, skipped } = pickForStart(sw, { ids, again });
    const results = skipped.map((s) => ({ ...s, ok: false, skipped: true }));
    const batch = picked.slice(0, MAX_PER_RUN);
    for (let i = 0; i < batch.length; i++) {
      const h = batch[i];
      const title = titleOf(h);
      const attemptId = newAttemptId();
      const key = attemptKey(h.handoverId, attemptId);
      const startFile = startFilePath(dataDir, key);
      const pointer = buildPointer({ title, key, startFile });
      const { exe, args, preamble, env } = buildStartCommand({ pointer, account, skip, claudePath });
      const base = { handoverId: h.handoverId, title, cwd: h.cwd, startFile, command: [path.basename(exe || 'claude'), ...args.map((a) => (a === pointer ? `"${a}"` : a))].join(' ') };

      const refuse = !h.cwd || !isDirectory(h.cwd) ? `working directory does not exist: ${h.cwd ?? '(none recorded)'}`
        // Windows Terminal reads ";" as "next command", also inside -d <dir>.
        : h.cwd.includes(';') ? 'the working directory contains ";", which Windows Terminal reads as a command separator'
        : !h.file || !fs.existsSync(h.file) ? `handover file does not exist: ${h.file ?? '(none recorded)'}`
        // The login start runs claude.exe itself (PATHS.claude is never a shim).
        : account === 'login' && !claudePath ? 'claude CLI not found on this machine'
        // `kaprek claude` looks claude up on its own (KAPREK_CLAUDE_PATH, then
        // PATH) and starts a .cmd shim through a shell, which splits the
        // prompt at every space — so it is its lookup that is asked here.
        : account === 'auto' && autoCli().useShell ? 'account "auto" needs a native claude.exe: `kaprek claude` would start a .cmd shim here, which cannot carry the prompt'
        : null;
      if (dryRun) {
        results.push(refuse ? { ...base, ok: false, error: refuse } : { ...base, ok: true, dryRun: true });
        continue;
      }
      if (refuse) {
        // Written down as an attempt that failed: the handover shows why it
        // was not started, instead of sitting there looking untouched.
        let error = refuse;
        try {
          recordStartRequested(dataDir, { switchId: sw.switchId, handoverId: h.handoverId, attemptId, account, skip, startFile: null, now });
          recordStarted(dataDir, { switchId: sw.switchId, handoverId: h.handoverId, attemptId, ok: false, error: refuse, now });
        } catch (err) {
          error = `${refuse} (and the protocol could not be written: ${err?.message ?? err})`;
        }
        results.push({ ...base, ok: false, error });
        held.refresh();
        continue;
      }

      let outcome;
      try {
        fs.mkdirSync(path.dirname(startFile), { recursive: true });
        // 'wx': one start file per attempt, never rewritten under a session that is reading it.
        fs.writeFileSync(startFile, buildStartFile(h, { key, switchId: sw.switchId }), { encoding: 'utf8', flag: 'wx' });
        recordStartRequested(dataDir, { switchId: sw.switchId, handoverId: h.handoverId, attemptId, account, skip, startFile, now });
        const r = await open({ cwd: h.cwd, title: `Übergabe · ${title}`, exe, args, launchDir, env, preamble });
        outcome = { ok: true, method: r.method };
      } catch (err) {
        outcome = { ok: false, error: err?.message ?? String(err) };
      }
      try {
        recordStarted(dataDir, { switchId: sw.switchId, handoverId: h.handoverId, attemptId, ...outcome, now });
      } catch (err) {
        // The tab may be open and the log does not know: say so instead of pretending either way.
        outcome = { ok: false, error: `tab ${outcome.ok ? 'opened' : 'not opened'}, but the outcome could not be written: ${err?.message ?? err}` };
      }
      results.push({ ...base, ...outcome });
      held.refresh(); // still alive: nobody takes this run for abandoned
      if (i < batch.length - 1) await sleep(TAB_GAP_MS);
    }
    for (const h of picked.slice(MAX_PER_RUN)) results.push({ handoverId: h.handoverId, title: titleOf(h), ok: false, skipped: true, error: `more than ${MAX_PER_RUN} in one run — start again for the rest` });
    const sameLogin = account === 'login' && sw.loginOrg && loginOrg && sw.loginOrg === loginOrg;
    return {
      ok: results.every((r) => r.ok),
      switchId: sw.switchId,
      results,
      ...(sameLogin ? { warning: 'the logged-in account is still the one this switch was opened under — the fresh sessions run on it' } : {}),
    };
  } finally {
    held.release();
  }
}

/**
 * Writes `handover.confirmed` for every fresh session the scan found (a
 * claude session whose first prompt carries an attempt key, see
 * attachHandoverInfo in src/resume/scan.mjs) and that the log does not know
 * yet. Returns how many were new. The key counts whatever the session's
 * role is by now: a fresh session that has since handed over itself is
 * still the session its attempt started.
 */
export function confirmFromSessions(dataDir, sessions, { now = Date.now } = {}) {
  const fresh = sessions.filter((s) => s.engine === 'claude' && s.handover?.attemptKey);
  if (fresh.length === 0) return 0;
  const state = readHandovers(dataDir);
  let written = 0;
  for (const s of fresh) {
    const [handoverId, attemptId] = s.handover.attemptKey.split('.');
    for (const sw of state.switches) {
      const attempt = sw.handovers.find((h) => h.handoverId === handoverId)?.attempts.find((a) => a.attemptId === attemptId);
      if (!attempt || attempt.confirmed) continue;
      recordConfirmed(dataDir, { switchId: sw.switchId, handoverId, attemptId, newSessionId: s.id, now });
      attempt.confirmed = { sessionId: s.id };
      written += 1;
    }
  }
  return written;
}

function publicHandover(h) {
  return {
    handoverId: h.handoverId,
    sessionId: h.sessionId,
    cwd: h.cwd,
    file: h.file,
    section: h.section,
    prompt: h.prompt,
    title: titleOf(h),
    note: h.note,
    nothingOpen: h.nothingOpen,
    recordedAt: h.recordedAt,
    status: h.status,
    startedAt: h.startedAt,
    lastError: h.lastError,
    newSessionId: h.newSessionId,
    attempts: h.attempts.length,
    lastAttemptAt: h.attempts.length > 0 ? h.attempts[h.attempts.length - 1].requestedAt : null,
  };
}

function switchView(sw) {
  const reported = new Set(sw.handovers.map((h) => h.sessionId).filter(Boolean));
  return {
    switchId: sw.switchId,
    openedAt: sw.openedAt,
    note: sw.note,
    counts: countByStatus(sw.handovers),
    handovers: sw.handovers.map(publicHandover),
    // Sessions that were open when the switch began and have not reported.
    missing: sw.expected.filter((x) => !reported.has(x.sessionId)).map((x) => ({ sessionId: x.sessionId, cwd: x.cwd ?? '', title: x.title ?? '' })),
  };
}

/**
 * The shape GET /api/handover and `kaprek handover list` show: the current
 * switch, and the older ones newest first. `loginOrg` is the organization
 * logged in right now; with it, the current switch says whether that is
 * still the account it was opened under (`loginUnchanged`).
 */
export function overview(dataDir, { loginOrg = null } = {}) {
  const switches = readHandovers(dataDir).switches;
  const views = switches.map(switchView);
  const current = views.length > 0 ? views[views.length - 1] : null;
  if (current) {
    const opened = switches[switches.length - 1].loginOrg;
    current.loginUnchanged = Boolean(opened && loginOrg && opened === loginOrg);
  }
  return { current, history: views.slice(0, -1).reverse() };
}

/**
 * The sessions a new switch expects a report from: claude sessions a person
 * has open in a terminal (the ledger never saw them end) that were active in
 * the last `hours`.
 */
export function expectedSessions(sessions, { hours = 48, now = Date.now } = {}) {
  const since = (typeof now === 'function' ? now() : now) - hours * 60 * 60 * 1000;
  return sessions
    // not the ones that handed over at an earlier switch: their windows may
    // still be open, but nobody expects a second report from them
    .filter((s) => s.engine === 'claude' && !s.hidden && s.ledger?.open === true && s.handover?.role !== 'old' && Date.parse(s.lastTs) >= since)
    .map((s) => ({ sessionId: s.id, cwd: s.cwd, title: s.title }));
}
