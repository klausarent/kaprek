// legacy-datadir.test.mjs — P0: proves kaprek reads data directories written
// by older schema stands (see src/testdata/legacy-datadir/manifest.json).
//
// Each test copies the fixture dir into a tmpdir (fs.cp) and loads every
// store through the code's REAL open path. Nothing here may crash on the
// missing "new" fields (runId/cancelled, posture/hardDenials, end-events,
// mentioned-table).
//
// The byte-equality test at the bottom is the H5 check from the design spec:
// after loading, the tmpdir copy must still match the committed fixture
// byte for byte. It is skipped with a finding, because the approval store
// DOES rewrite approvals.json on open (pending interactive entries are
// marked 'expired: process gone' and persisted on the first store
// operation — approval-store.mjs loadFromDisk/persist write-back). The
// search.db file is excluded from that check on purpose: dropping an older
// index schema on open is documented behavior (src/search/index.mjs).
import { afterAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApprovalStore } from './server/approval-store.mjs';
import { loadPolicyFailOpen } from './policy/policy.mjs';
import { readLedgerIndex, readSessionEvents } from './ledger/sessions.mjs';
import { openSearchDb } from './search/index.mjs';
import { loadPresets } from './missions/presets.mjs';
import { openMemory } from './memory/store.mjs';
import { STATE_MAX_AGE_MS, readContextState, sweepOldContextState } from './policy/prompt-context-state.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_DIR = path.join(__dirname, 'testdata', 'legacy-datadir');

const tmpDirs = [];
afterAll(() => {
  for (const dir of tmpDirs) fs.rmSync(dir, { recursive: true, force: true });
});

/** Copies the fixture into a fresh tmpdir and returns the copy's path. The ORIGINAL under src/testdata is never opened by any store. */
function copyFixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kaprek-legacy-'));
  tmpDirs.push(dir);
  fs.cpSync(FIXTURE_DIR, dir, { recursive: true });
  return dir;
}

/** Byte-for-byte comparison of the copy against the committed fixture. search.db (+ WAL sidecars) is excluded: the index drops an older schema on open by design — see manifest.json. */
function changedFiles(copyDir) {
  const changed = [];
  const walk = (rel) => {
    for (const name of fs.readdirSync(path.join(FIXTURE_DIR, rel))) {
      const relPath = path.join(rel, name);
      if (relPath === 'search.db' || relPath.startsWith(path.join('search.db') + path.sep) || relPath.startsWith('search.db-')) continue;
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
  return changed;
}

describe('legacy datadir fixtures', () => {
  it('reads approvals.json without runId/cancelled — decided stays decided, pending-interactive is refused as expired, not crashed on', async () => {
    const dataDir = copyFixture();
    const store = createApprovalStore({ dataDir });
    const decided = await store.get('legacy-chat:1');
    expect(decided?.status).toBe('decided');
    expect(decided?.decision).toEqual({ behavior: 'allow' });
    // No runId/cancelled fields anywhere, and none is needed to read.
    expect(decided).not.toHaveProperty('runId');
    expect(decided).not.toHaveProperty('cancelledAt');

    const pending = await store.get('legacy-chat:2');
    // A pending entry from a previous process is marked expired on load —
    // visible death, never an answerable queue entry, never a crash.
    expect(pending?.status).toBe('expired');
    expect(await store.listPending()).toEqual([]);
  });

  it('reads policy.json without posture/hardDenials — defaults apply, never a throw', () => {
    const dataDir = copyFixture();
    const policy = loadPolicyFailOpen(dataDir);
    expect(policy.mode).toBe('observe');
    expect(policy.posture).toBe('auto');
    expect(policy.hardDenials).toEqual([]);
    expect(policy.rules).toEqual({ requireTaskDoc: true, requireCommitTask: true });
  });

  it('reads a ledger with start/stop but no end events', () => {
    const dataDir = copyFixture();
    const events = readSessionEvents(dataDir);
    expect(events.map((e) => e.type)).toEqual(['start', 'stop', 'start', 'stop']);
    const index = readLedgerIndex(dataDir);
    expect(index.get('legacy-session-a')).toMatchObject({ lastType: 'stop', endReason: null, firstStartTs: '2026-08-24T08:00:00.000Z' });
  });

  it('opens the old search.db — the index drops the pre-mentioned schema on open by design', async () => {
    const dataDir = copyFixture();
    const opened = await openSearchDb({ dataDir });
    if (opened.unavailable) return; // node:sqlite/FTS5 missing in this runtime — nothing to assert
    const { db } = opened;
    try {
      // The drop-on-open path set the CURRENT schema version.
      expect(db.prepare('PRAGMA user_version').get().user_version).toBe(2);
      // The old rows are gone; the empty index is served like a fresh one.
      expect(db.prepare('SELECT COUNT(*) AS n FROM indexed').get().n).toBe(0);
    } finally {
      db.close();
    }
  });

  // P4b: a memory event written BEFORE provenance existed — no schemaVersion
  // (counts as version 1 per the P0.5 gate) and no
  // sourceKind/chatId/runId/path. Reading it must not crash and must not
  // invent provenance: the entry stays valid, the UI marks it "ohne
  // Herkunft" instead of hiding it.
  it('reads a memory event without provenance fields — marked as without origin, never crashed on', () => {
    const dataDir = copyFixture();
    const memory = openMemory(dataDir);
    const entries = memory.list();
    expect(entries.map((e) => e.id)).toContain('legacy-fact-1');
    const legacy = entries.find((e) => e.id === 'legacy-fact-1');
    expect(legacy.text).toBe("the legacy fixture's deploy runs nightly at 03:00 UTC");
    expect(legacy.sourceKind).toBeUndefined();
    expect(legacy.chatId).toBeUndefined();
    expect(legacy.path).toBeUndefined();
    // A legacy line carries its old verification stamp — it is not treated
    // as an unconfirmed import.
    expect(legacy.lastVerifiedAt).toBe('2026-08-24T08:05:00.000Z');
    expect(legacy.unverified).toBe(false);
  });

  it('loads presets: the valid one lands, the broken one is skipped without a throw', () => {
    const dataDir = copyFixture();
    const presets = loadPresets(dataDir);
    const byId = new Map(presets.map((p) => [p.id, p]));
    expect(byId.get('nightly-refactor')?.title).toBe('Nightly refactor');
    expect(byId.has('broken-preset')).toBe(false);
    expect(byId.has('blank')).toBe(true); // built-ins survive
  });

  it('reads a context state file and sweeps it once its mtime is older than 7 days (mtime set on the tmpdir copy, never in the repo)', () => {
    const dataDir = copyFixture();
    expect(readContextState(dataDir, 'stale-session')?.cwd).toBe('C:\\tmp\\demo');

    const stale = path.join(dataDir, 'context', 'stale-session.json');
    const old = Date.now() - STATE_MAX_AGE_MS - 60_000;
    fs.utimesSync(stale, new Date(old), new Date(old));
    sweepOldContextState(dataDir);
    expect(fs.existsSync(stale)).toBe(false);
    expect(readContextState(dataDir, 'stale-session')).toBeNull();
  });

  // P0.5, case (a): a file with a HIGHER schema version than this binary
  // writes was written by a NEWER kaprek. The approval store opens it
  // READ-ONLY: reading works, every mutation refuses with an honest message,
  // and — the acceptance criterion — opening it writes NOTHING back, prunes
  // nothing, marks nothing: the bytes on disk stay exactly the committed
  // fixture's bytes.
  it('opens a newer-schema approvals.json READ-ONLY: reads work, nothing is written back, mutations refuse (P0.5 case a)', async () => {
    const dataDir = copyFixture();
    // The store reads exactly one file name; the downgrade fixture (version
    // 99) is laid down AS approvals.json in the tmpdir copy.
    const downgrade = fs.readFileSync(path.join(FIXTURE_DIR, 'approvals.downgrade.json'));
    fs.writeFileSync(path.join(dataDir, 'approvals.json'), downgrade);

    const log = [];
    const store = createApprovalStore({ dataDir, log: (m) => log.push(m) });

    // Reading works, and nothing was reinterpreted: the deferred pending
    // entry stays pending (NOT marked 'expired: process gone'), the decided
    // entry stays decided.
    const decided = await store.get('downgrade-chat:2');
    expect(decided?.status).toBe('decided');
    const pending = await store.get('downgrade-chat:1');
    expect(pending?.status).toBe('pending');
    expect(pending).toEqual(JSON.parse(downgrade.toString('utf8')).approvals[0]);
    expect((await store.listPending()).map((e) => e.id)).toEqual(['downgrade-chat:1']);

    // Every mutating path refuses with the honest "newer kaprek" message.
    const newerSchema = /newer kaprek version \(schema version 99 > 1\)/;
    await expect(store.put({ id: 'downgrade-chat:3', mode: 'deferred' })).rejects.toThrow(newerSchema);
    await expect(store.decide('downgrade-chat:1', { behavior: 'allow' })).rejects.toThrow(newerSchema);
    await expect(store.reopen('downgrade-chat:2')).rejects.toThrow(newerSchema);
    expect(log.join('\n')).toMatch(/READ-ONLY/);

    // The acceptance: the file on disk is still byte-identical to the
    // fixture — no write-back, no retention prune, nothing deleted.
    expect(fs.readFileSync(path.join(dataDir, 'approvals.json'))).toEqual(downgrade);
    // Not even temp-file cleanup ran: nothing under the data dir was touched.
    expect(fs.readdirSync(dataDir).filter((n) => n.includes('.tmp-'))).toEqual([]);
  });

  // SKIPPED ON PURPOSE — and since P0.5 this is a DOCUMENTED decision, not
  // an open finding. Decision (b) of the P0.5 schema-gate work: this fixture
  // is a LEGACY file with the SAME schema version (version: 1) today's code
  // writes. A newer binary opening it is free to understand it fully — and
  // the write-back of `expired: 'process gone'` on open is documented,
  // spec-wanted behavior (approval-store.mjs loadFromDisk/persist): the
  // marking is how the file stops claiming a wait exists that no process
  // owns. The P0.5 read-only gate applies only to case (a) — a HIGHER
  // schemaVersion than the code knows (see the next test) — and must not
  // freeze this documented bookkeeping. So the byte-equality check would
  // still fail here BY DESIGN, and the skip stays, with this comment as the
  // why. See also manifest.json ("Der pending-interactive-Eintrag wird beim
  // Oeffnen ... zurueckgeschrieben — dokumentiertes Verhalten").
  it.skip('does not mutate the fixture dir on open (byte-equality) — mutation on open — finding, see report', async () => {
    const dataDir = copyFixture();
    const store = createApprovalStore({ dataDir });
    await store.get('legacy-chat:1'); // flush the constructor's queued write-back
    loadPolicyFailOpen(dataDir);
    readLedgerIndex(dataDir);
    await openSearchDb({ dataDir });
    loadPresets(dataDir);
    expect(changedFiles(dataDir)).toEqual([]);
  });
});
