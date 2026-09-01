// `kaprek doctor` — CLI front end. Owns argv parsing, printing and the exit
// code (always 0: doctor is a report, not a gate); src/doctor/doctor.mjs
// owns the checks and the two --fix effects.
import os from 'node:os';
import path from 'node:path';
import { runDoctor } from '../doctor/doctor.mjs';
import { getAppDir } from '../lib/appdir.mjs';

export const DOCTOR_USAGE = `Usage: kaprek doctor [--fix] [--json]

A read-only health report over kaprek's own data directory — plus exactly
two safe fixes behind --fix. Exit code is always 0: this is a report, not a
gate.

Checks (one line each):
  transcript-drift   samples the 10 newest session transcripts through the
                     real parser; warn from 1% unusable lines, fail from 10%
  hooks              the four managed hook entries: script exists,
                     --managed-by marker intact, settings entry well-formed
  search-index       schema version both ways (newer index: warn — kaprek
                     only opens it read-only; older: fine, dropped on open)
  policy             policy.json load result; warn on the P0.5 fail-closed
                     fallback, with the reason
  presets            every <dataDir>/presets/*.json parsed; broken ones named
  ledger             last ledger event per recent session; orphaned or
                     circular 'end' entries warn
  context-state      stale/malformed per-session cwd state files (sweep age:
                     7 days)
  grants             active grant count; grants unused for over 30 days are
                     named as cleanup candidates — grants never expire, and
                     doctor never revokes
  triggers-degraded  condition-error streaks per trigger (skipped when the
                     feature is not present)

--fix does EXACTLY TWO things, listed before they happen, and nothing else:
  1. deletes orphaned context state files (same 7-day condition as the
     automatic sweep)
  2. triggers a search index rebuild — only at an equal or lower schema
     version, never a newer one
Hooks are NOT fixed by --fix in this version (kaprek hooks uninstall/install
does that).`;

function defaultScanRoot() {
  return path.join(os.homedir(), '.claude', 'projects');
}

/** Parses `kaprek doctor [...]` argv. Throws on unknown flags. */
export function parseDoctorArgs(argv) {
  const result = { fix: false, json: false, help: false, dir: defaultScanRoot(), dataDir: null };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    switch (arg) {
      case '--fix':
        result.fix = true;
        break;
      case '--json':
        result.json = true;
        break;
      case '--help':
      case '-h':
        result.help = true;
        break;
      case '--dir': {
        const raw = argv[i + 1];
        if (raw === undefined) throw new Error('--dir requires a path argument');
        result.dir = raw;
        i += 1;
        break;
      }
      case '--data-dir': {
        const raw = argv[i + 1];
        if (raw === undefined) throw new Error('--data-dir requires a path argument');
        result.dataDir = raw;
        i += 1;
        break;
      }
      default:
        throw new Error(`Unknown argument for doctor: ${arg}`);
    }
  }
  return result;
}

const STATUS_ORDER = { fail: 0, warn: 1, ok: 2 };

/**
 * Prints the report: one section header per check isn't needed — repo style
 * is one line per check (status + message), detail lines indented below,
 * then a summary line. With --json, prints one machine-readable document
 * instead: { checks: [...], fix, summary }. Returns the process exit code —
 * always 0.
 */
export function printDoctorReport(report, { json } = {}) {
  if (json) {
    console.log(JSON.stringify({ checks: report.checks, fix: report.fix, summary: report.summary }, null, 2));
    return 0;
  }
  const sorted = [...report.checks].sort((a, b) => STATUS_ORDER[a.status] - STATUS_ORDER[b.status]);
  for (const c of sorted) {
    console.log(`${c.id} [${c.status}] ${c.message}`);
    for (const line of c.detail ?? []) console.log(`    ${line}`);
  }
  if (report.fix.applied.length > 0 || report.fix.skipped.length > 0) {
    console.log('');
    console.log('--fix:');
    for (const line of report.fix.applied) console.log(`  done: ${line}`);
    for (const line of report.fix.skipped) console.log(`  skipped: ${line}`);
  }
  console.log('');
  console.log(`summary: ${report.summary.total} checks — ${report.summary.ok} ok, ${report.summary.warn} warn, ${report.summary.fail} fail (exit code 0: doctor reports, it does not gate)`);
  return 0;
}

/**
 * `kaprek doctor [--fix] [--json]`. Never throws — a crashing check becomes
 * a warn line, a crashing doctor becomes an error line plus the summary it
 * managed to collect. Exit code is always 0.
 */
export async function runDoctorCommand(argv, { dataDir = getAppDir(), rootDir = defaultScanRoot() } = {}) {
  let opts;
  try {
    opts = parseDoctorArgs(argv);
  } catch (err) {
    console.error(err.message);
    console.error('Usage: kaprek doctor [--fix] [--json] [--dir <scan-root>] [--data-dir <dir>]');
    return 0; // usage errors of a report command still do not gate anything
  }
  if (opts.help) {
    console.log(DOCTOR_USAGE);
    return 0;
  }
  const effectiveDataDir = opts.dataDir ?? dataDir;
  const effectiveRoot = opts.dir ?? rootDir;
  if (!opts.json) {
    console.log(`kaprek doctor — data dir: ${effectiveDataDir}`);
    console.log(`scan root: ${effectiveRoot}${opts.fix ? '  (--fix)' : ''}`);
    console.log('');
  }
  let report;
  try {
    report = await runDoctor({ dataDir: effectiveDataDir, rootDir: effectiveRoot, fix: opts.fix });
  } catch (err) {
    console.error(`kaprek doctor failed: ${err.message}`);
    return 0;
  }
  return printDoctorReport(report, { json: opts.json });
}
