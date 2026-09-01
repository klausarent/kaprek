// doctor tests — one ok and one broken case per check, plus the fixture
// byte-equality guarantee (doctor without --fix mutates NOTHING), the
// limited --fix surface (exactly two effects), and the --json structure.
//
// The legacy fixtures (src/testdata/legacy-datadir/) are COPIED into a
// tmpdir per test, exactly like legacy-datadir.test.mjs does it — the
// committed fixtures are never opened by any store.
import { afterAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runDoctor } from './doctor.mjs';
import {
  checkTranscriptDrift,
  checkHooks,
  checkSearchIndex,
  checkPolicy,
  checkPresets,
  checkLedger,
  checkContextState,
  checkGrants,
  checkTriggersDegraded,
  DRIFT_SAMPLE_SIZE,
} from './checks.mjs';
import { parseDoctorArgs, printDoctorReport, runDoctorCommand } from '../cli/doctor.mjs';
import { install as installHook } from '../cli/hooks.mjs';
import { getPackageName } from '../lib/appdir.mjs';
import { appendSessionEvent } from '../ledger/sessions.mjs';
import { writeContextState, STATE_MAX_AGE_MS } from '../policy/prompt-context-state.mjs';
import { openSearchDb, SCHEMA_VERSION } from '../search/index.mjs';
import { openTriggers } from '../triggers/registry.mjs';
import { appendRun } from '../orchestrator/runs.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_DIR = path.join(__dirname, '..', 'testdata', 'legacy-datadir');

const tmpDirs = [];
afterAll(() => {
  for (const dir of tmpDirs) fs.rmSync(dir, { recursive: true, force: true });
});

/** A fresh tmpdir, registered for cleanup. */
function tmpdir(prefix = 'kaprek-doctor-') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
}

/** Copies the legacy fixture into a fresh tmpdir (never opens the original). */
function copyFixture() {
  const dir = tmpdir();
  fs.cpSync(FIXTURE_DIR, dir, { recursive: true });
  return dir;
}

/** Byte-for-byte comparison of a tmpdir copy against the committed fixture. `except` holds top-level names (or `name/` prefixes) to skip. */
function changedFiles(copyDir, except = []) {
  const skipped = (relPath) => except.some((e) => relPath === e || relPath.startsWith(`${e}/`) || (e.endsWith('.db') && relPath.startsWith(e)));
  const changed = [];
  const walk = (rel) => {
    for (const name of fs.readdirSync(path.join(FIXTURE_DIR, rel))) {
      const relPath = rel ? path.join(rel, name) : name;
      if (skipped(relPath)) continue;
      const fixturePath = path.join(FIXTURE_DIR, relPath);
      const copyPath = path.join(copyDir, relPath);
      if (fs.statSync(fixturePath).isDirectory()) {
        walk(relPath);
        continue;
      }
      let copyBuf = null;
      try {
        copyBuf = fs.readFileSync(copyPath);
      } catch {
        changed.push(`${relPath} (missing in copy)`);
        continue;
      }
      if (!copyBuf.equals(fs.readFileSync(fixturePath))) changed.push(relPath);
    }
  };
  walk('');
  // Files that exist ONLY in the copy (the --fix surface must not add any).
  const walkCopy = (rel) => {
    for (const name of fs.readdirSync(path.join(copyDir, rel))) {
      const relPath = rel ? path.join(rel, name) : name;
      if (skipped(relPath)) continue;
      const copyPath = path.join(copyDir, relPath);
      const fixturePath = path.join(FIXTURE_DIR, relPath);
      if (!fs.existsSync(fixturePath)) {
        changed.push(`${relPath} (extra in copy)`);
        continue;
      }
      if (fs.statSync(copyPath).isDirectory()) walkCopy(relPath);
    }
  };
  walkCopy('');
  return changed;
}

function byId(report, id) {
  return report.checks.find((c) => c.id === id);
}

const ALL_CHECK_IDS = ['transcript-drift', 'hooks', 'search-index', 'policy', 'presets', 'ledger', 'context-state', 'grants', 'triggers-degraded'];

/** Writes a session jsonl with `okLines` well-formed lines and `broken` junk lines. Returns the scan root. */
function writeScanRoot({ okLines = 10, broken = 0, unknownType = 0 } = {}) {
  const rootDir = tmpdir();
  const project = path.join(rootDir, 'proj');
  fs.mkdirSync(project, { recursive: true });
  const lines = [];
  for (let i = 0; i < okLines; i += 1) {
    lines.push(JSON.stringify({ type: 'user', uuid: `u${i}`, timestamp: '2026-08-24T08:00:00.000Z', message: { content: `hello ${i}` } }));
  }
  for (let i = 0; i < broken; i += 1) lines.push('{not json');
  for (let i = 0; i < unknownType; i += 1) lines.push(JSON.stringify({ type: 'brand-new-marker', uuid: `x${i}`, timestamp: '2026-08-24T08:00:00.000Z' }));
  fs.writeFileSync(path.join(project, 'session-1.jsonl'), `${lines.join('\n')}\n`, 'utf8');
  return rootDir;
}

describe('doctor checks', () => {
  it('transcript-drift: clean transcripts are ok', async () => {
    const result = await checkTranscriptDrift({ rootDir: writeScanRoot({ okLines: 20 }) });
    expect(result.status).toBe('ok');
  });

  it('transcript-drift: no transcripts at all is ok, not a fault', async () => {
    const result = await checkTranscriptDrift({ rootDir: tmpdir() });
    expect(result.status).toBe('ok');
  });

  it('transcript-drift: 1%+ unusable lines warn (threshold)', async () => {
    // exactly 1 of 100 = 1.0% -> warn, not fail
    const result = await checkTranscriptDrift({ rootDir: writeScanRoot({ okLines: 97, broken: 2, unknownType: 1 }) });
    expect(result.status).toBe('warn');
  });

  it('transcript-drift: 10%+ unusable lines fail (threshold)', async () => {
    const result = await checkTranscriptDrift({ rootDir: writeScanRoot({ okLines: 80, broken: 20 }) });
    expect(result.status).toBe('fail');
  });

  it('transcript-drift: samples only the newest transcripts', async () => {
    const rootDir = tmpdir();
    const project = path.join(rootDir, 'proj');
    fs.mkdirSync(project, { recursive: true });
    for (let i = 0; i < DRIFT_SAMPLE_SIZE + 3; i += 1) {
      const file = path.join(project, `s${i}.jsonl`);
      fs.writeFileSync(file, `${JSON.stringify({ type: 'user', uuid: 'u', timestamp: '2026-08-24T08:00:00.000Z', message: { content: 'x' } })}\n`, 'utf8');
      const t = Date.now() - (DRIFT_SAMPLE_SIZE + 3 - i) * 1000;
      fs.utimesSync(file, new Date(t), new Date(t));
    }
    const result = await checkTranscriptDrift({ rootDir });
    expect(result.message).toContain(`across ${DRIFT_SAMPLE_SIZE} transcript`);
  });

  it('hooks: all four entries intact is ok', () => {
    const dataDir = tmpdir();
    const settingsPath = path.join(tmpdir(), 'settings.json');
    const script = path.join(tmpdir(), 'hook-stop.mjs');
    fs.writeFileSync(script, '// fake hook\n', 'utf8');
    installHook({ settingsPath, hookScriptPath: script, sessionStartScriptPath: script, sessionEndScriptPath: script, userPromptScriptPath: script });
    const result = checkHooks({ dataDir, settingsPath });
    expect(result.status).toBe('ok');
  });

  it('hooks: a missing script file at the recorded path warns', () => {
    const dataDir = tmpdir();
    const settingsPath = path.join(tmpdir(), 'settings.json');
    const missing = path.join(tmpdir(), 'gone', 'hook-stop.mjs');
    const command = `node "${missing}" --managed-by=${getPackageName()}`;
    fs.writeFileSync(settingsPath, JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command }] }] } }), 'utf8');
    const result = checkHooks({ dataDir, settingsPath });
    expect(result.status).toBe('warn');
    expect(result.message).toMatch(/missing script file/);
  });

  it('hooks: not installed is ok, and a malformed command warns', () => {
    const dataDir = tmpdir();
    const settingsPath = path.join(tmpdir(), 'no-settings.json');
    expect(checkHooks({ dataDir, settingsPath }).status).toBe('ok');

    const malformedPath = path.join(tmpdir(), 'settings-malformed.json');
    fs.writeFileSync(malformedPath, JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command: `garbled --managed-by=${getPackageName()}` }] }] } }), 'utf8');
    const malformed = checkHooks({ dataDir, settingsPath: malformedPath });
    expect(malformed.status).toBe('warn');
    expect(malformed.message).toMatch(/not well-formed/);
  });

  it('search-index: missing index, current schema and older schema are ok; a newer schema warns', async () => {
    const probe = await openSearchDb({ dataDir: tmpdir() });
    if (probe.unavailable) return; // node:sqlite/FTS5 missing in this runtime — nothing to assert
    probe.db.close();

    expect((await checkSearchIndex({ dataDir: tmpdir() })).status).toBe('ok'); // no index yet

    const current = tmpdir();
    const opened = await openSearchDb({ dataDir: current });
    opened.db.close();
    const currentCheck = await checkSearchIndex({ dataDir: current });
    expect(currentCheck.status).toBe('ok');

    const older = tmpdir();
    const openedOlder = await openSearchDb({ dataDir: older });
    openedOlder.db.exec('PRAGMA user_version = 1');
    openedOlder.db.close();
    // openSearchDb dropped it back to current on open — rebuild the old version directly:
    const { DatabaseSync } = await import('node:sqlite');
    const db = new DatabaseSync(path.join(older, 'search.db'));
    db.exec('PRAGMA user_version = 1');
    db.close();
    const olderCheck = await checkSearchIndex({ dataDir: older });
    expect(olderCheck.status).toBe('ok');
    expect(olderCheck.message).toMatch(/older schema/);

    const newer = tmpdir();
    const dbNew = new DatabaseSync(path.join(newer, 'search.db'));
    dbNew.exec('PRAGMA user_version = 99');
    dbNew.close();
    const newerCheck = await checkSearchIndex({ dataDir: newer });
    expect(newerCheck.status).toBe('warn');
    expect(newerCheck.message).toMatch(/newer kaprek/);
    expect(SCHEMA_VERSION).toBe(2);
  });

  it('policy: default is ok; fail-closed fallback warns with the reason; the ask ceiling is said out loud; invalid JSON warns as fallback', () => {
    expect(checkPolicy({ dataDir: tmpdir() }).status).toBe('ok');

    const failClosed = tmpdir();
    fs.writeFileSync(path.join(failClosed, 'policy.json'), JSON.stringify({ mode: 'observe', brandNewField: true }), 'utf8');
    const failClosedCheck = checkPolicy({ dataDir: failClosed });
    expect(failClosedCheck.status).toBe('warn');
    expect(failClosedCheck.message).toMatch(/FAIL-CLOSED/);
    expect(failClosedCheck.message).toMatch(/brandNewField/);

    const ask = tmpdir();
    fs.writeFileSync(path.join(ask, 'policy.json'), JSON.stringify({ posture: 'ask' }), 'utf8');
    const askCheck = checkPolicy({ dataDir: ask });
    expect(askCheck.status).toBe('ok');
    expect(askCheck.message).toMatch(/'ask'/);

    const invalid = tmpdir();
    fs.writeFileSync(path.join(invalid, 'policy.json'), '{nope', 'utf8');
    const invalidCheck = checkPolicy({ dataDir: invalid });
    expect(invalidCheck.status).toBe('warn');
    expect(invalidCheck.message).toMatch(/fell back/);
  });

  it('presets: valid files count as ok, a broken one is named', () => {
    // The fixture copy carries presets/broken.json and presets/nightly-refactor.json.
    const withBroken = copyFixture();
    const brokenCheck = checkPresets({ dataDir: withBroken });
    expect(brokenCheck.status).toBe('warn');
    expect(brokenCheck.message).toContain('broken.json');

    const okDir = tmpdir();
    fs.mkdirSync(path.join(okDir, 'presets'), { recursive: true });
    fs.writeFileSync(path.join(okDir, 'presets', 'good.json'), JSON.stringify({ id: 'good', title: 'Good' }), 'utf8');
    const okCheck = checkPresets({ dataDir: okDir });
    expect(okCheck.status).toBe('ok');
  });

  it('ledger: consistent entries are ok; an orphaned end and a circular (double) end warn', () => {
    const okDir = tmpdir();
    appendSessionEvent(okDir, { type: 'start', sessionId: 's1' });
    appendSessionEvent(okDir, { type: 'stop', sessionId: 's1' });
    expect(checkLedger({ dataDir: okDir }).status).toBe('ok');

    const orphan = tmpdir();
    appendSessionEvent(orphan, { type: 'end', sessionId: 'ghost' });
    const orphanCheck = checkLedger({ dataDir: orphan });
    expect(orphanCheck.status).toBe('warn');
    expect(orphanCheck.message).toMatch(/inconsistent/);

    const circular = tmpdir();
    appendSessionEvent(circular, { type: 'start', sessionId: 's2' });
    appendSessionEvent(circular, { type: 'end', sessionId: 's2' });
    appendSessionEvent(circular, { type: 'end', sessionId: 's2' });
    const circularCheck = checkLedger({ dataDir: circular });
    expect(circularCheck.status).toBe('warn');
    expect(circularCheck.detail.join('\n')).toMatch(/2 end events/);
  });

  it('context-state: fresh files are ok; stale (past the 7-day sweep age) and malformed files warn', () => {
    const okDir = tmpdir();
    writeContextState(okDir, 'live-session', 'C:\\tmp');
    expect(checkContextState({ dataDir: okDir }).status).toBe('ok');

    const staleDir = tmpdir();
    writeContextState(staleDir, 'stale-session', 'C:\\tmp');
    fs.mkdirSync(path.join(staleDir, 'context'), { recursive: true });
    const staleFile = path.join(staleDir, 'context', 'old-session.json');
    fs.writeFileSync(staleFile, JSON.stringify({ cwd: 'C:\\old' }), 'utf8');
    const old = Date.now() - STATE_MAX_AGE_MS - 60_000;
    fs.utimesSync(staleFile, new Date(old), new Date(old));
    fs.writeFileSync(path.join(staleDir, 'context', 'garbled.json'), '{nope', 'utf8');
    const staleCheck = checkContextState({ dataDir: staleDir });
    expect(staleCheck.status).toBe('warn');
    expect(staleCheck.message).toMatch(/7 days/);
    expect(staleCheck.message).toMatch(/malformed/);
  });

  it('grants: no grants is ok; a grant idle for 30+ days warns as a cleanup candidate WITHOUT expiry', () => {
    const none = checkGrants({ dataDir: tmpdir() });
    expect(none.status).toBe('ok');

    const dir = tmpdir();
    const hash = 'a'.repeat(64);
    const old = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000).toISOString();
    const fresh = new Date().toISOString();
    const line = (id, ts, lastUsed) => `${JSON.stringify({ schemaVersion: 1, id, ts, type: 'grant.minted', data: { id, scope: 'mission:m1', toolName: 'Bash', inputHash: hash, postureAtGrant: 'auto', hardDenialsHash: 'h', createdAt: ts } })}\n${lastUsed ? JSON.stringify({ schemaVersion: 1, id: `${id}-use`, ts: lastUsed, type: 'grant.used', data: { id } }) : ''}\n`;
    fs.writeFileSync(path.join(dir, 'grants.jsonl'), `${line('grant-old', old, null)}${line('grant-fresh', fresh, fresh)}`, 'utf8');
    const result = checkGrants({ dataDir: dir });
    expect(result.status).toBe('warn');
    expect(result.message).toMatch(/2 active grant/);
    expect(result.message).toMatch(/never expire/);
    expect(result.detail.join('\n')).toMatch(/grant-old/);
    expect(result.detail.join('\n')).not.toMatch(/grant-fresh/);
  });

  it('triggers-degraded: no triggers is ok; condition-error streaks are listed; a streak past the threshold warns degraded', async () => {
    const empty = await checkTriggersDegraded({ dataDir: tmpdir() });
    expect(empty.status).toBe('ok');

    const dir = tmpdir();
    openTriggers(dir, { log: () => {} }).upsert({
      id: 'hb-deg',
      type: 'heartbeat',
      config: { intervalMinutes: 5 },
      promptTemplate: 'check',
      appScope: [],
      enabled: true,
      condition: { kind: 'file-exists', path: path.join(dir, 'checklist.md') },
    });
    const noStreak = await checkTriggersDegraded({ dataDir: dir });
    expect(noStreak.status).toBe('ok');

    for (let i = 0; i < 5; i += 1) appendRun(dir, { triggerId: 'hb-deg', skipped: 'condition-error', startedAt: new Date().toISOString(), endedAt: new Date().toISOString() });
    const degraded = await checkTriggersDegraded({ dataDir: dir });
    expect(degraded.status).toBe('warn');
    expect(degraded.message).toMatch(/DEGRADED/);
    expect(degraded.detail.join('\n')).toMatch(/hb-deg/);
  });
});

describe('doctor report, fix surface and json', () => {
  it('without --fix the doctor runs all checks and mutates NOTHING — the fixture copy stays byte-identical', async () => {
    const dataDir = copyFixture();
    const before = changedFiles(dataDir, ['search.db']); // baseline sanity: copy is identical
    expect(before).toEqual([]);
    const report = await runDoctor({ dataDir, rootDir: tmpdir(), settingsPath: path.join(tmpdir(), 'settings.json') });
    expect(report.checks.map((c) => c.id).sort()).toEqual([...ALL_CHECK_IDS].sort());
    expect(report.checks.every((c) => ['ok', 'warn', 'fail'].includes(c.status))).toBe(true);
    expect(report.summary.total).toBe(ALL_CHECK_IDS.length);
    expect(report.fix.applied).toEqual([]);
    expect(report.fix.skipped).toEqual([]);
    expect(changedFiles(dataDir)).toEqual([]);
  });

  it('--fix does exactly two things: sweeps stale context state and triggers the index rebuild — presets, grants, ledger, policy untouched', async () => {
    const dataDir = copyFixture();
    // Make the fixture's context state file a real --fix target (mtime set on the copy, never in the repo).
    const stale = path.join(dataDir, 'context', 'stale-session.json');
    const old = Date.now() - STATE_MAX_AGE_MS - 60_000;
    fs.utimesSync(stale, new Date(old), new Date(old));

    const rootDir = tmpdir();
    const report = await runDoctor({ dataDir, rootDir, settingsPath: path.join(tmpdir(), 'settings.json'), fix: true });
    expect(fs.existsSync(stale)).toBe(false);
    const joined = report.fix.applied.join('\n');
    expect(joined).toMatch(/context state file/);
    expect(joined).toMatch(/index rebuild/);
    // Only at an equal or lower schema version — the fixture index is older, so the rebuild ran.
    expect(report.fix.skipped).toEqual([]);
    // Nothing else changed: presets, ledger, policy.json, grants, memory, approvals stay byte-identical,
    // and no extra files appeared — only the two fix surfaces (context/, search.db*) may differ.
    expect(changedFiles(dataDir, ['context', 'search.db'])).toEqual([]);
  });

  it('--fix never rebuilds a NEWER search index, and without a fix target it changes nothing', async () => {
    const probe = await openSearchDb({ dataDir: tmpdir() });
    if (probe.unavailable) return;
    const dataDir = tmpdir();
    const { DatabaseSync } = await import('node:sqlite');
    const db = new DatabaseSync(path.join(dataDir, 'search.db'));
    db.exec('PRAGMA user_version = 99');
    db.close();
    const before = fs.readFileSync(path.join(dataDir, 'search.db'));
    const report = await runDoctor({ dataDir, rootDir: tmpdir(), settingsPath: path.join(tmpdir(), 'settings.json'), fix: true });
    expect(report.fix.skipped.join('\n')).toMatch(/NEWER/);
    expect(report.fix.applied.join('\n')).toMatch(/context state file/); // sweep ran (no targets: a no-op line)
    expect(fs.readFileSync(path.join(dataDir, 'search.db'))).toEqual(before);
  });

  it('--json: the report is one parseable document with checks + fix + summary', async () => {
    const dataDir = copyFixture();
    const report = await runDoctor({ dataDir, rootDir: tmpdir(), settingsPath: path.join(tmpdir(), 'settings.json') });
    const json = JSON.parse(JSON.stringify(report));
    expect(json.checks).toHaveLength(ALL_CHECK_IDS.length);
    for (const c of json.checks) {
      expect(typeof c.id).toBe('string');
      expect(['ok', 'warn', 'fail']).toContain(c.status);
      expect(typeof c.message).toBe('string');
    }
    expect(json.summary).toEqual({ total: 9, ok: json.summary.ok, warn: json.summary.warn, fail: json.summary.fail });
    expect(printDoctorReport(report, { json: true })).toBe(0);
  });

  it('CLI arg parsing: --fix/--json/--dir/--data-dir parse; unknown flags throw; the command always exits 0', async () => {
    const opts = parseDoctorArgs(['--fix', '--json', '--dir', 'X:\\scan', '--data-dir', 'X:\\data']);
    expect(opts).toMatchObject({ fix: true, json: true, dir: 'X:\\scan', dataDir: 'X:\\data' });
    expect(() => parseDoctorArgs(['--lan'])).toThrow(/Unknown argument/);

    const dataDir = copyFixture();
    const code = await runDoctorCommand(['--json', '--data-dir', dataDir, '--dir', tmpdir()], { dataDir });
    expect(code).toBe(0);
    const codeFix = await runDoctorCommand(['--data-dir', dataDir, '--dir', tmpdir()], { dataDir });
    expect(codeFix).toBe(0);
  });
});
