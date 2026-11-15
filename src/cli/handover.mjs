// `kaprek handover` — the account switch from the terminal: sessions report
// what they hand over, kaprek keeps the protocol and starts one fresh session
// per handover. Dependencies are injected so the command is testable;
// bin/cli.mjs passes the real scanner, launcher and ledger.
import fs from 'node:fs';
import path from 'node:path';
import { openOrReuseSwitch, recordHandover, readHandovers } from '../handover/store.mjs';
import { startHandovers, overview, expectedSessions, confirmFromSessions, ACCOUNT_MODES } from '../handover/service.mjs';
import { redactSecrets } from '../parser/parse.mjs';

// `open` twice within this window means the same account change, not two.
const REOPEN_WINDOW_MS = 60 * 60 * 1000;

export const HANDOVER_USAGE = `Usage: kaprek handover [list] [--all] [--json]
       kaprek handover open [--note "<why>"] [--hours N] [--new] [--after-login]
       kaprek handover add --file <absolute path> [--section "<heading>"] [--cwd <dir>]
                           [--title "<name>"] [--prompt "<text>" | --prompt-file <path>]
                           [--note "<text>" | --note-file <path>] [--switch <id>] [--session <id>]
       kaprek handover add --nothing [--note "<text>"] [--switch <id>] [--session <id>]
       kaprek handover start [--all | <handover id>…] [--account login|auto] [--no-skip]
                             [--again] [--dry-run] [--switch <id>] [--from-agent]

An account switch in three steps. Sessions report what they hand over; you
log in to the other account; kaprek starts one fresh session per handover in
a new terminal tab — never a resume, the new account would re-read the
whole transcript.

  list     the current switch: every handover and its status, and the sessions
           that were open when it began and have not reported. --all adds the
           earlier switches.
  open     begin a switch and print its id. Remembers which sessions are open
           right now (active in the last --hours, default 48) as the ones
           expected to report. Run again within an hour, it returns the same
           switch unless --new. --after-login: the account was already
           switched, do not remember the current login as the old one.
  add      report this session's handover: the file a fresh session must read
           (--file, with --section if it is one heading of a longer file) and
           the folder to start it in (--cwd; default: where this session was
           started). --prompt replaces the standard instruction "read the file
           and continue there". --nothing reports that nothing is open. The
           session is taken from CLAUDE_CODE_SESSION_ID, or --session.
           Reporting again replaces the earlier report — until a start was
           attempted from it; after that a new report is a new handover.
           Without --switch the report joins the latest switch, unless
           that one is older than 12 hours or was already started from.
  start    open one tab per handover that has not been started (--all), or for
           the ones named. --account login (default) uses the account that is
           logged in; auto runs \`kaprek claude\`, which picks the account with
           the most room. --again also starts handovers that already have a
           tab or a session. --dry-run prints what would run. Inside a Claude
           Code session this refuses to start anything without --from-agent:
           the button is meant for the person.

Statuses: pending (reported) · nothing (nothing to hand over) · failed (no tab
could be opened) · unknown (start requested, outcome never written) · spawned
(tab opened, new session not seen yet) · running (new session seen).
Exit codes: 0 ok, 1 a start failed, 2 usage or validation, 3 busy (a start is running).`;

const VALUE_FLAGS = new Set(['--note', '--note-file', '--hours', '--file', '--section', '--cwd', '--title', '--prompt', '--prompt-file', '--switch', '--session', '--account']);
const BOOL_FLAGS = new Set(['--all', '--json', '--new', '--after-login', '--nothing', '--no-skip', '--again', '--dry-run', '--from-agent']);

function parse(argv) {
  const flags = {};
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (VALUE_FLAGS.has(a)) {
      if (i + 1 >= argv.length) throw new Error(`${a} needs a value`);
      flags[a.slice(2)] = argv[++i];
    } else if (BOOL_FLAGS.has(a)) flags[a.slice(2)] = true;
    else if (a.startsWith('--')) throw new Error(`unknown argument: ${a}`);
    else positional.push(a);
  }
  return { flags, positional };
}

function when(iso) {
  if (!iso) return '–';
  const d = new Date(iso);
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getDate())}.${p(d.getMonth() + 1)}. ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function summary(view) {
  const c = view.counts;
  const parts = [
    [c.pending, 'pending'], [c.failed, 'failed'], [c.unknown, 'unknown'], [c.spawned, 'spawned'], [c.running, 'running'], [c.nothing, 'nothing open'], [view.missing.length, 'not reported'],
  ].filter(([n]) => n > 0).map(([n, label]) => `${n} ${label}`);
  return parts.length > 0 ? parts.join(' · ') : 'no handovers yet';
}

function printSwitch(view, stdout) {
  stdout(`switch ${view.switchId} · opened ${when(view.openedAt)} · ${summary(view)}${view.note ? ` · ${redactSecrets(view.note)}` : ''}`);
  for (const h of view.handovers) {
    const where = h.nothingOpen ? '(nothing open)' : `${h.file}${h.section ? ` # ${redactSecrets(h.section)}` : ''}`;
    const extra = h.status === 'failed' && h.lastError ? `  [${h.lastError}]` : h.status === 'running' && h.newSessionId ? `  [session ${h.newSessionId.slice(0, 8)}]` : '';
    stdout(`  ${h.handoverId}  ${h.status.padEnd(8)} ${h.title.padEnd(28)} ${where}${extra}`);
  }
  for (const m of view.missing) stdout(`  ${'(no report)'.padEnd(10)}  ${'missing'.padEnd(8)} ${m.sessionId.slice(0, 8)}  ${m.cwd}  ${redactSecrets(m.title).slice(0, 80)}`);
}

/** The folder a session was started in: the cwd of its first `start` event in the ledger. Its memory and project instructions hang on that folder, wherever it wandered since. */
export function firstStartCwd(events, sessionId) {
  for (const e of events) {
    if (e?.sessionId === sessionId && e.type === 'start' && typeof e.cwd === 'string' && e.cwd) return e.cwd;
  }
  return null;
}

function readTextFile(file, readFile) {
  return readFile(path.resolve(file)).replace(/^\uFEFF/, '');
}

export async function runHandoverCommand(
  argv,
  {
    dataDir,
    env = process.env,
    cwd = process.cwd(),
    scanAll,
    ledgerEvents = () => [],
    loginOrg = () => null,
    start = startHandovers,
    exists = fs.existsSync,
    readFile = (f) => fs.readFileSync(f, 'utf8'),
    now = Date.now,
    lockWaitMs,
    stdout = (l) => console.log(l),
    stderr = (l) => console.error(l),
  },
) {
  const sub = argv[0] && !argv[0].startsWith('--') ? argv[0] : 'list';
  const rest = sub === argv[0] ? argv.slice(1) : argv;
  let flags;
  let positional;
  try {
    ({ flags, positional } = parse(rest));
  } catch (err) {
    stderr(err.message);
    stderr(HANDOVER_USAGE);
    return 2;
  }
  const fail = (message) => {
    stderr(message);
    return 2;
  };
  const busy = (err) => {
    stderr(err.message);
    return 3;
  };

  if (sub === 'list') {
    // Looking is also when a fresh session gets recognised: a tab that
    // opened shows as "running" once its transcript exists.
    if (scanAll && readHandovers(dataDir).switches.some((sw) => sw.handovers.some((h) => h.status === 'spawned' || h.status === 'unknown'))) {
      try {
        const { sessions } = await scanAll({ unfiltered: true });
        confirmFromSessions(dataDir, sessions, { now });
      } catch {
        // the list is still worth showing without the confirmation pass
      }
    }
    const view = overview(dataDir, { loginOrg: loginOrg() });
    if (flags.json) {
      stdout(JSON.stringify(view, null, 2));
      return 0;
    }
    if (!view.current) {
      stdout('no account switch recorded yet (a session reports one with `kaprek handover add`)');
      return 0;
    }
    printSwitch(view.current, stdout);
    if (view.current.loginUnchanged) stdout('  note: the logged-in account is still the one this switch was opened under');
    if (flags.all) for (const older of view.history) printSwitch(older, stdout);
    else if (view.history.length > 0) {
      // An earlier switch that still holds handovers nobody started must not
      // disappear behind a newer one: say so, with the way to reach them.
      const left = view.history.reduce((n, sw) => n + sw.counts.pending + sw.counts.failed + sw.counts.unknown, 0);
      stdout(`(${view.history.length} earlier switch${view.history.length === 1 ? '' : 'es'}${left > 0 ? `, ${left} handover${left === 1 ? '' : 's'} there not started — start them with --switch <id>` : ''}: --all)`);
    }
    return 0;
  }

  if (sub === 'open') {
    const hours = flags.hours === undefined ? 48 : Number(flags.hours);
    if (!Number.isFinite(hours) || hours <= 0) return fail('--hours must be a positive number');
    let expected = [];
    if (scanAll) {
      try {
        const { sessions } = await scanAll({});
        expected = expectedSessions(sessions, { hours, now }).map((s) => ({ ...s, title: redactSecrets(s.title) }));
      } catch (err) {
        stderr(`could not list the open sessions (${err?.message ?? err}); the switch is opened without an expected list`);
      }
    }
    let opened;
    try {
      opened = openOrReuseSwitch(dataDir, { reuseWithinMs: REOPEN_WINDOW_MS, forceNew: flags.new === true, by: env.CLAUDE_CODE_SESSION_ID ?? null, note: flags.note ?? null, expected, loginOrg: flags['after-login'] ? null : loginOrg(), now, lockWaitMs });
    } catch (err) {
      if (err?.code === 'HANDOVER_BUSY') return busy(err);
      throw err;
    }
    stdout(opened.switchId);
    stderr(opened.reused ? `reusing the switch opened ${when(opened.openedAt)} (pass --new for a separate one)` : `switch opened, ${expected.length} open session${expected.length === 1 ? '' : 's'} expected to report`);
    return 0;
  }

  if (sub === 'add') {
    const sessionId = flags.session ?? env.CLAUDE_CODE_SESSION_ID ?? null;
    if (!sessionId) return fail('no session id: run this inside a Claude Code session (CLAUDE_CODE_SESSION_ID) or pass --session <id>');
    if (flags.nothing && (flags.file || flags.prompt || flags['prompt-file'] || flags.section)) return fail('--nothing takes no --file, --section or --prompt');
    if (flags.prompt && flags['prompt-file']) return fail('pass --prompt or --prompt-file, not both');
    if (flags.note && flags['note-file']) return fail('pass --note or --note-file, not both');
    let prompt = flags.prompt ?? null;
    let note = flags.note ?? null;
    try {
      if (flags['prompt-file']) prompt = readTextFile(flags['prompt-file'], readFile);
      if (flags['note-file']) note = readTextFile(flags['note-file'], readFile);
    } catch (err) {
      return fail(`could not read ${err?.path ?? 'the text file'}: ${err?.message ?? err}`);
    }
    let file = null;
    if (!flags.nothing) {
      if (!flags.file) return fail('a handover needs --file <absolute path> (or --nothing when nothing is open)');
      if (!path.isAbsolute(flags.file) || path.resolve(flags.file) !== path.normalize(flags.file)) return fail(`--file must be a full absolute path: ${flags.file}`);
      file = path.normalize(flags.file);
      if (!exists(file)) return fail(`the handover file does not exist: ${file}`);
    }
    const startCwd = flags.cwd ? path.resolve(flags.cwd) : (firstStartCwd(ledgerEvents(), sessionId) ?? cwd);
    if (!flags.nothing && !exists(startCwd)) return fail(`the working directory does not exist: ${startCwd}`);
    let result;
    try {
      result = recordHandover(dataDir, { sessionId, cwd: startCwd, file, section: flags.section ?? null, prompt, title: flags.title ?? null, note, nothingOpen: flags.nothing === true, switchId: flags.switch ?? null, now, lockWaitMs });
    } catch (err) {
      if (err?.code === 'HANDOVER_BUSY') return busy(err);
      return fail(err.message);
    }
    const what = flags.nothing ? 'nothing open' : `${file}${flags.section ? ` # ${flags.section}` : ''}`;
    stdout(`${result.replaced ? 'updated' : 'recorded'} ${result.handoverId} in switch ${result.switchId}${result.opened ? ' (opened now)' : ''}: ${what}${flags.nothing ? '' : ` · starts in ${startCwd}`}`);
    return 0;
  }

  if (sub === 'start') {
    const account = flags.account ?? 'login';
    if (!ACCOUNT_MODES.includes(account)) return fail(`--account must be one of ${ACCOUNT_MODES.join(', ')}`);
    if (!flags.all && positional.length === 0) return fail('name the handovers to start, or pass --all');
    if (flags.all && positional.length > 0) return fail('pass --all or handover ids, not both');
    const inSession = Boolean(env.CLAUDE_CODE_SESSION_ID || env.CLAUDE_CODE_CHILD_SESSION || env.CLAUDECODE);
    if (inSession && !flags['dry-run'] && !flags['from-agent']) {
      return fail('this is running inside a Claude Code session. Starting the fresh sessions is the person\'s step: use the button (#/handover) or a terminal of your own. --dry-run shows what would run; --from-agent overrides.');
    }
    const r = await start({ dataDir, switchId: flags.switch ?? null, ids: flags.all ? null : positional, again: flags.again === true, account, skip: flags['no-skip'] !== true, dryRun: flags['dry-run'] === true, loginOrg: loginOrg() });
    if (r.busy) {
      stderr('another start is running (the button, or another terminal). Try again in a moment.');
      return 3;
    }
    if (r.notFound || (r.error && r.results.length === 0)) return fail(r.error);
    if (r.warning) stderr(`warning: ${r.warning}`);
    let failed = 0;
    for (const x of r.results) {
      if (x.dryRun) stdout(`would start ${x.handoverId} ${x.title}\n  in   ${x.cwd}\n  run  ${x.command}\n  file ${x.startFile}`);
      else if (x.ok) stdout(`started ${x.handoverId} ${x.title} (${x.method})`);
      else {
        failed += 1;
        stderr(`${x.skipped ? 'skipped' : 'failed'} ${x.handoverId}${x.title ? ` ${x.title}` : ''}: ${x.error}`);
      }
    }
    const done = r.results.filter((x) => x.ok).length;
    stdout(r.results.length === 0 ? 'nothing to start' : `${done}/${r.results.length} ${flags['dry-run'] ? 'would start' : 'started'} in switch ${r.switchId}`);
    return failed === 0 ? 0 : 1;
  }

  stderr(`unknown subcommand: ${sub}`);
  stderr(HANDOVER_USAGE);
  return 2;
}
