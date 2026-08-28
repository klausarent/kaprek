// `kaprek resume` — the session list of all four agent CLIs, and the way
// back after a crash, from the terminal. Dependencies are injected so the
// command is testable; bin/cli.mjs passes the real scanner and launcher.
import path from 'node:path';
import { redactSecrets } from '../parser/parse.mjs';

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const ALL_GAP_MS = 700; // wt needs a breath between tabs, or they land in new windows

export const RESUME_USAGE = `Usage: kaprek resume [<engine>:<id>] [--all] [--hours N] [--days N] [--no-skip]

  kaprek resume              list sessions of the last 7 days (claude, codex, grok, kimi)
  kaprek resume claude:<id>  open that session as a new Windows Terminal tab
                             (a unique prefix of <engine>:<id> also works)
  kaprek resume --all        open every session active in the last 24 hours
  --hours N                  window for --all (default 24)
  --days N                   window for the list (default 7)
  --no-skip                  do not pass the permission-skipping flags to the CLIs
`;

function parse(argv) {
  const opts = { key: null, all: false, hours: 24, days: 7, skip: true };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--all') opts.all = true;
    else if (a === '--no-skip') opts.skip = false;
    else if (a === '--hours') opts.hours = Math.max(1, Number(argv[++i]) || 24);
    else if (a === '--days') opts.days = Math.max(1, Number(argv[++i]) || 7);
    else if (/^[a-z]+:.+$/.test(a)) opts.key = a;
    else throw new Error(`unknown argument: ${a}`);
  }
  return opts;
}

function ago(iso, nowMs) {
  const min = Math.round((nowMs - Date.parse(iso)) / 60000);
  if (min < 60) return `${min} min`;
  if (min < 48 * 60) return `${Math.round(min / 60)} h`;
  return `${Math.round(min / (24 * 60))} d`;
}

/**
 * Finds the session `key` names — an exact `engine:id` match first, then (so
 * a long UUID never has to be typed in full) a unique prefix of the key. More
 * than one prefix match is reported as ambiguous rather than guessed at.
 */
function resolveSession(sessions, key) {
  const exact = sessions.find((s) => s.key === key);
  if (exact) return { session: exact };
  const candidates = sessions.filter((s) => s.key.startsWith(key));
  if (candidates.length === 1) return { session: candidates[0] };
  if (candidates.length > 1) return { ambiguous: candidates };
  return {};
}

export async function runResumeCommand(argv, { scanAll, resumeSession, now = Date.now, stdout = (l) => console.log(l), stderr = (l) => console.error(l), sleep = (ms) => new Promise((r) => setTimeout(r, ms)) }) {
  let opts;
  try {
    opts = parse(argv);
  } catch (err) {
    stderr(err.message);
    stderr(RESUME_USAGE);
    return 1;
  }
  const { sessions } = await scanAll();
  const nowMs = now();

  if (opts.key) {
    const { session, ambiguous } = resolveSession(sessions, opts.key);
    if (ambiguous) {
      stderr(`ambiguous key: ${opts.key} matches ${ambiguous.length} sessions:`);
      for (const s of ambiguous) stderr(`  ${s.key}  ${redactSecrets(s.title)}`);
      return 2;
    }
    if (!session) {
      stderr(`no such session: ${opts.key} (run \`kaprek resume\` for the list)`);
      return 2;
    }
    const r = await resumeSession(session, { skip: opts.skip });
    if (!r.ok) {
      stderr(`could not open ${session.key}: ${r.error}`);
      return 1;
    }
    stdout(`opened ${session.key} (${r.method})`);
    return 0;
  }

  if (opts.all) {
    const picked = sessions
      .filter((s) => !s.hidden && nowMs - Date.parse(s.lastTs) <= opts.hours * HOUR_MS)
      .sort((a, b) => Date.parse(b.lastTs) - Date.parse(a.lastTs));
    let failed = 0;
    for (const s of picked) {
      const r = await resumeSession(s, { skip: opts.skip });
      if (r.ok) stdout(`opened ${s.key} — ${redactSecrets(s.title)}`);
      else {
        failed++;
        stderr(`failed ${s.key}: ${r.error}`);
      }
      await sleep(ALL_GAP_MS);
    }
    stdout(`${picked.length - failed}/${picked.length} sessions of the last ${opts.hours} h reopened`);
    return failed === 0 ? 0 : 1;
  }

  const listed = sessions
    .filter((s) => !s.hidden && nowMs - Date.parse(s.lastTs) <= opts.days * DAY_MS)
    .sort((a, b) => Date.parse(b.lastTs) - Date.parse(a.lastTs));
  if (listed.length === 0) {
    stdout(`no sessions in the last ${opts.days} days`);
    return 0;
  }
  for (const s of listed) {
    const flag = s.crash ? ' [crash]' : '';
    stdout(`${s.key.padEnd(48)} ${ago(s.lastTs, nowMs).padStart(6)}  ${path.basename(s.cwd || '') || '-'}  ${redactSecrets(s.title)}${flag}`);
  }
  stdout(`\n${listed.length} sessions. Resume one: kaprek resume <engine>:<id>   All of last 24 h: kaprek resume --all`);
  return 0;
}
