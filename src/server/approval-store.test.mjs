// Tests for the persistent approval inbox. Run: npx vitest run src/server/approval-store.test.mjs
//
// No fake timers and no sleeping: every deadline is passed in explicitly and
// the "previous process" case uses a REAL child process that has already
// exited, so its pid is genuinely dead rather than a number that looked free
// when the test was written.
import { test, expect, beforeAll, afterEach } from 'vitest';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import {
  createApprovalStore,
  APPROVAL_DEADLINE_INTERACTIVE_MS,
  APPROVAL_DEADLINE_UNATTENDED_MS,
  APPROVAL_HISTORY_RETENTION_MS,
} from './approval-store.mjs';

const createdDirs = [];

async function tmpDataDir() {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'kaprek-approval-store-test-'));
  createdDirs.push(dir);
  return dir;
}

/** Writes an approvals.json as a PREVIOUS process would have left it: entries still pending, nobody left to answer them. */
async function seedApprovalFile(dataDir, entries) {
  const approvals = entries.map((entry) => ({
    status: 'pending',
    decision: null,
    decidedAt: null,
    expired: null,
    chatId: null,
    requestId: entry.id,
    ...entry,
  }));
  await fsp.writeFile(path.join(dataDir, 'approvals.json'), `${JSON.stringify({ version: 1, approvals }, null, 2)}\n`, 'utf8');
}

function readApprovalFile(dataDir) {
  return JSON.parse(fs.readFileSync(path.join(dataDir, 'approvals.json'), 'utf8'));
}

/**
 * A real `fs` with one method sabotaged. Everything the store touches goes
 * through here, so a test can make exactly one write fail — the only way to
 * check what the store does about a failure it cannot prevent (a read-only
 * file, a full disk) rather than only checking the happy path.
 */
function fsWith(overrides) {
  return { ...fs, ...overrides };
}

/** Collects the store's warnings so a test can assert the failure was ANNOUNCED, not merely survived. */
function collectingLog() {
  const lines = [];
  const log = (message) => lines.push(message);
  log.lines = lines;
  log.joined = () => lines.join('\n');
  return log;
}

// A pid that is REALLY gone: a child process started and awaited here, not a
// number guessed to be free. Computed once — spawning a node process per test
// would dominate this file's runtime.
let deadPid;

beforeAll(async () => {
  deadPid = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['-e', '0'], { stdio: 'ignore' });
    const pid = child.pid;
    child.on('error', reject);
    child.on('exit', () => resolve(pid));
  });
});

afterEach(() => {
  for (const dir of createdDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

test('approval store: a pending entry is listed even when no SSE client was ever connected', async () => {
  const store = createApprovalStore({ dataDir: await tmpDataDir() });
  await store.put({ id: 'a1', toolName: 'Bash', triggerId: 't', requestedAt: 0 });
  expect((await store.listPending()).map((e) => e.id)).toEqual(['a1']);
});

test('approval store: deciding the same id twice is rejected, not silently applied twice', async () => {
  const store = createApprovalStore({ dataDir: await tmpDataDir() });
  await store.put({ id: 'a1', toolName: 'Bash', requestedAt: 0 });
  await store.decide('a1', { behavior: 'allow' });
  await expect(store.decide('a1', { behavior: 'deny' })).rejects.toThrow();
});

test('approval store: the second decision is refused AS a second decision — not mislabelled as a dead process', async () => {
  // The test above only asserts that something throws, and that is not enough:
  // an implementation that stops tracking an answered entry as live throws
  // too, with 'process gone'. A user who clicked Allow twice would then be
  // told their kaprek had died. Found by mutating the single-shot check away
  // and watching the test above stay green.
  const store = createApprovalStore({ dataDir: await tmpDataDir() });
  await store.put({ id: 'a1', toolName: 'Bash', requestedAt: 0 });
  await store.decide('a1', { behavior: 'allow' });

  await expect(store.decide('a1', { behavior: 'deny' })).rejects.toThrow(/already decided/);
  // And the first answer stands — the refused second one changed nothing.
  expect(await store.get('a1')).toMatchObject({ decision: { behavior: 'allow' } });
});

test('approval store: entries from a previous process are marked expired on load, never decidable', async () => {
  const dataDir = await tmpDataDir();
  await seedApprovalFile(dataDir, [{ id: 'old', pid: deadPid, toolName: 'Bash', requestedAt: 0 }]);
  const store = createApprovalStore({ dataDir });
  expect(await store.listPending()).toEqual([]);
  await expect(store.decide('old', { behavior: 'allow' })).rejects.toThrow(/process gone/);
});

test('approval store: an entry whose recorded pid is ALIVE is still not decidable after a load — ownership, not liveness, is the rule', async () => {
  // The tempting implementation is "expire it only if the pid is dead". It is
  // wrong twice over: pids are recycled (an entry from a crashed kaprek can
  // point at some unrelated program that is very much alive), and even a
  // genuinely still-running foreign process cannot be reached from here — the
  // promise that would resolve the CLI's `can_use_tool` request lives in THAT
  // process's memory. Seeding this process's own pid is the sharpest form of
  // the case: maximally alive, still unanswerable.
  const dataDir = await tmpDataDir();
  await seedApprovalFile(dataDir, [{ id: 'recycled', pid: process.pid, toolName: 'Bash', requestedAt: 0 }]);
  const store = createApprovalStore({ dataDir });

  expect(await store.listPending()).toEqual([]);
  await expect(store.decide('recycled', { behavior: 'allow' })).rejects.toThrow(/process gone/);
});

test('approval store: the expiry is written back to disk, so the record says what happened instead of looking pending forever', async () => {
  const dataDir = await tmpDataDir();
  await seedApprovalFile(dataDir, [{ id: 'old', pid: deadPid, toolName: 'Bash', requestedAt: 0 }]);
  createApprovalStore({ dataDir });

  const onDisk = readApprovalFile(dataDir).approvals;
  expect(onDisk).toHaveLength(1);
  expect(onDisk[0]).toMatchObject({ id: 'old', status: 'expired', expired: 'process gone' });
  // Not just a flag: the record still carries what was asked, so the entry can
  // be shown as "this died with the server" rather than vanishing silently.
  expect(onDisk[0].toolName).toBe('Bash');
});

test('approval store: a decided entry is gone from listPending but keeps its decision on disk', async () => {
  const dataDir = await tmpDataDir();
  const store = createApprovalStore({ dataDir });
  await store.put({ id: 'a1', toolName: 'Bash', requestedAt: 0 });
  await store.put({ id: 'a2', toolName: 'Write', requestedAt: 1 });
  await store.decide('a1', { behavior: 'deny', message: 'nope' });

  expect((await store.listPending()).map((e) => e.id)).toEqual(['a2']);
  expect(await store.get('a1')).toMatchObject({ status: 'decided', decision: { behavior: 'deny', message: 'nope' } });
  expect(readApprovalFile(dataDir).approvals.find((e) => e.id === 'a1')).toMatchObject({ status: 'decided' });
});

test('approval store: listPending is ordered oldest-first, so the queue is answered in the order it was asked', async () => {
  const store = createApprovalStore({ dataDir: await tmpDataDir() });
  await store.put({ id: 'later', toolName: 'Bash', requestedAt: 5000 });
  await store.put({ id: 'earlier', toolName: 'Bash', requestedAt: 1000 });
  expect((await store.listPending()).map((e) => e.id)).toEqual(['earlier', 'later']);
});

test('approval store: deciding an id that was never put throws rather than resolving nothing', async () => {
  const store = createApprovalStore({ dataDir: await tmpDataDir() });
  await expect(store.decide('never-existed', { behavior: 'allow' })).rejects.toThrow(/unknown approval/);
});

test('approval store: a decision must be allow or deny — anything else throws before it is persisted', async () => {
  const dataDir = await tmpDataDir();
  const store = createApprovalStore({ dataDir });
  await store.put({ id: 'a1', toolName: 'Bash', requestedAt: 0 });
  await expect(store.decide('a1', { behavior: 'maybe' })).rejects.toThrow(/allow|deny/);
  // Still answerable — a rejected decision must not have consumed the entry.
  expect((await store.listPending()).map((e) => e.id)).toEqual(['a1']);
});

test('approval store: putting an id that is still pending throws — a live wait must never be overwritten in silence', async () => {
  const store = createApprovalStore({ dataDir: await tmpDataDir() });
  await store.put({ id: 'a1', toolName: 'Bash', requestedAt: 0 });
  await expect(store.put({ id: 'a1', toolName: 'Write', requestedAt: 1 })).rejects.toThrow(/already pending/);
});

test('approval store: an id whose earlier entry is finished can be reused — a CLI restarts its request ids at 1 every turn', async () => {
  const store = createApprovalStore({ dataDir: await tmpDataDir() });
  await store.put({ id: 'req-1', toolName: 'Bash', requestedAt: 0 });
  await store.decide('req-1', { behavior: 'allow' });
  await store.put({ id: 'req-1', toolName: 'Write', requestedAt: 10 });
  expect((await store.listPending()).map((e) => e.toolName)).toEqual(['Write']);
});

test('approval store: the file is written atomically — no temp file survives a write, and the file is always complete JSON', async () => {
  const dataDir = await tmpDataDir();
  const store = createApprovalStore({ dataDir });
  await store.put({ id: 'a1', toolName: 'Bash', requestedAt: 0 });
  await store.decide('a1', { behavior: 'allow' });

  const leftovers = fs.readdirSync(dataDir).filter((name) => name !== 'approvals.json');
  expect(leftovers).toEqual([]);
  expect(() => readApprovalFile(dataDir)).not.toThrow();
});

test('approval store: a fresh store reads back what a previous one wrote (same process, same file)', async () => {
  const dataDir = await tmpDataDir();
  const first = createApprovalStore({ dataDir });
  await first.put({ id: 'a1', toolName: 'Bash', requestedAt: 0 });

  const second = createApprovalStore({ dataDir });
  // Read back, yes — but as an EXPIRED record, not as something this second
  // instance could answer: it never held the promise either.
  expect(await second.listPending()).toEqual([]);
  expect(await second.get('a1')).toMatchObject({ toolName: 'Bash', status: 'expired', expired: 'process gone' });
});

test('approval store: a corrupt approvals.json is set aside instead of crashing the server or being silently overwritten', async () => {
  const dataDir = await tmpDataDir();
  await fsp.writeFile(path.join(dataDir, 'approvals.json'), '{ this is not json', 'utf8');

  const store = createApprovalStore({ dataDir });
  expect(await store.listPending()).toEqual([]);
  const setAside = fs.readdirSync(dataDir).filter((name) => name.startsWith('approvals.corrupt-'));
  expect(setAside).toHaveLength(1);
  expect(fs.readFileSync(path.join(dataDir, setAside[0]), 'utf8')).toBe('{ this is not json');
});

test('approval store: finished entries are pruned once they are older than the retention window; pending ones never are', async () => {
  const dataDir = await tmpDataDir();
  let clock = 0;
  const store = createApprovalStore({ dataDir, now: () => clock });
  await store.put({ id: 'ancient', toolName: 'Bash', requestedAt: 0 });
  await store.decide('ancient', { behavior: 'allow' });
  clock = APPROVAL_HISTORY_RETENTION_MS + 1;
  await store.put({ id: 'fresh', toolName: 'Bash', requestedAt: clock });

  expect(await store.get('ancient')).toBeNull();
  expect(await store.get('fresh')).toMatchObject({ status: 'pending' });
});

test('approval store: the two deadlines are named constants, and the unattended one is the longer wait by hours', () => {
  expect(APPROVAL_DEADLINE_INTERACTIVE_MS).toBe(10 * 60_000);
  expect(APPROVAL_DEADLINE_UNATTENDED_MS).toBe(8 * 60 * 60_000);
  expect(APPROVAL_DEADLINE_UNATTENDED_MS).toBeGreaterThan(APPROVAL_DEADLINE_INTERACTIVE_MS);
});

// ---------------------------------------------------------------- failure paths
//
// Everything below is about what happens when the DISK does not cooperate.
// The store is a record of questions a CLI is currently blocked on: a record
// that cannot be written must never be able to stop kaprek from starting, and
// must never leave a question in a state where the inbox offers buttons that
// can only fail. Added in Fix-Runde 1 (panel findings C1, I1, I3, M1-M4).

test('approval store: an unreadable approvals.json degrades to an empty inbox instead of taking the process down', async () => {
  // C1's repro without needing real file permissions: an EACCES on read (what
  // a read-only file with a hostile ACL, an EIO, or a locked file produce).
  // The constructor runs from startServer's listen callback, outside any
  // promise chain, so a throw here used to be an uncaught exception on EVERY
  // start — the same broken data dir, forever.
  const dataDir = await tmpDataDir();
  await seedApprovalFile(dataDir, [{ id: 'a1', toolName: 'Bash', requestedAt: 0 }]);
  const log = collectingLog();
  const fsImpl = fsWith({
    readFileSync: () => {
      throw Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' });
    },
  });

  const store = createApprovalStore({ dataDir, log, fsImpl });
  expect(await store.listPending()).toEqual([]);
  expect(log.joined()).toMatch(/failed to read/);
  // And it still works for new questions — a lost file is a lost record, not a
  // dead store.
  await store.put({ id: 'fresh', toolName: 'Bash', requestedAt: 1 });
  expect((await store.listPending()).map((e) => e.id)).toEqual(['fresh']);
});

test('approval store: a failing write-back of expired entries costs the record, not the boot', async () => {
  const dataDir = await tmpDataDir();
  await seedApprovalFile(dataDir, [{ id: 'old', toolName: 'Bash', requestedAt: 0 }]);
  const log = collectingLog();
  const fsImpl = fsWith({
    writeFileSync: () => {
      throw Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' });
    },
  });

  const store = createApprovalStore({ dataDir, log, fsImpl });
  expect(log.joined()).toMatch(/could not record expired entries/);
  // The marking still holds in memory, which is where it decides anything.
  await expect(store.decide('old', { behavior: 'allow' })).rejects.toThrow(/process gone/);
});

test('approval store: a put() whose write fails is rolled back — no ghost entry, and the id stays usable', async () => {
  // I1: without the rollback the entry stays pending+owned in memory forever.
  // The inbox would list a question whose buttons can only 404, AND the key
  // stays taken — a CLI numbers its requests from 1 on every turn, so
  // `chatId:1` would then auto-deny the first approval of every later turn in
  // that chat for the rest of the process's life.
  const dataDir = await tmpDataDir();
  const log = collectingLog();
  let failWrites = false;
  const fsImpl = fsWith({
    writeFileSync: (target, data, encoding) => {
      if (failWrites) throw Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' });
      return fs.writeFileSync(target, data, encoding);
    },
  });
  const store = createApprovalStore({ dataDir, log, fsImpl });

  failWrites = true;
  await expect(store.put({ id: 'chat-1:1', toolName: 'Bash', requestedAt: 0 })).rejects.toThrow(/ENOSPC/);
  expect(await store.listPending()).toEqual([]);
  expect(await store.get('chat-1:1')).toBeNull();
  expect(log.joined()).toMatch(/could not record/);

  // The next turn reuses request id 1 in the same chat. It must work.
  failWrites = false;
  await store.put({ id: 'chat-1:1', toolName: 'Write', requestedAt: 10 });
  expect((await store.listPending()).map((e) => e.toolName)).toEqual(['Write']);
});

test('approval store: a put() rollback restores the entry it replaced rather than dropping the history', async () => {
  const dataDir = await tmpDataDir();
  let failWrites = false;
  const fsImpl = fsWith({
    writeFileSync: (target, data, encoding) => {
      if (failWrites) throw new Error('EIO: write failed');
      return fs.writeFileSync(target, data, encoding);
    },
  });
  const store = createApprovalStore({ dataDir, log: collectingLog(), fsImpl });
  await store.put({ id: 'req-1', toolName: 'Bash', requestedAt: 0 });
  await store.decide('req-1', { behavior: 'allow' });

  failWrites = true;
  await expect(store.put({ id: 'req-1', toolName: 'Write', requestedAt: 10 })).rejects.toThrow(/EIO/);
  // The answered entry is still the answered entry, not a half-replaced one.
  expect(await store.get('req-1')).toMatchObject({ toolName: 'Bash', status: 'decided', decision: { behavior: 'allow' } });
});

test('approval store: the write is genuinely atomic — a write that dies halfway leaves the PREVIOUS file whole', async () => {
  // I3: the old test only checked that no temp file was left lying around,
  // which a naive writeFileSync(filePath, ...) passes just as easily. This one
  // fails a write AFTER it has already put half the bytes on disk — the exact
  // shape of a crash or a full disk — and then requires approvals.json to
  // still be the complete previous version.
  const dataDir = await tmpDataDir();
  let truncateNextWrite = false;
  const fsImpl = fsWith({
    writeFileSync: (target, data, encoding) => {
      if (!truncateNextWrite) return fs.writeFileSync(target, data, encoding);
      const half = String(data).slice(0, Math.floor(String(data).length / 2));
      fs.writeFileSync(target, half, encoding); // the bytes that DID land
      throw Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' });
    },
  });
  const store = createApprovalStore({ dataDir, log: collectingLog(), fsImpl });
  await store.put({ id: 'survivor', toolName: 'Bash', requestedAt: 0 });

  truncateNextWrite = true;
  await expect(store.put({ id: 'doomed', toolName: 'Write', requestedAt: 1 })).rejects.toThrow(/ENOSPC/);

  // Whole, parseable, and the version from before the failed write.
  const onDisk = readApprovalFile(dataDir);
  expect(onDisk.approvals.map((e) => e.id)).toEqual(['survivor']);
  // And the half-written temp file did not survive to litter the data dir.
  expect(fs.readdirSync(dataDir).filter((name) => name.includes('.tmp-'))).toEqual([]);
});

test('approval store: a decision whose write fails still stands, and says so loudly', async () => {
  // M1: the opposite call from put(). By this point the caller has already
  // resolved the CLI's control request — the tool ran or it did not. Rolling
  // back would make the store disagree with reality; staying silent would let
  // the next start report an answered question as 'process gone'.
  const dataDir = await tmpDataDir();
  const log = collectingLog();
  let failWrites = false;
  const fsImpl = fsWith({
    writeFileSync: (target, data, encoding) => {
      if (failWrites) throw new Error('EIO: write failed');
      return fs.writeFileSync(target, data, encoding);
    },
  });
  const store = createApprovalStore({ dataDir, log, fsImpl });
  await store.put({ id: 'a1', toolName: 'Bash', requestedAt: 0 });

  failWrites = true;
  await expect(store.decide('a1', { behavior: 'allow' })).resolves.toMatchObject({ decision: { behavior: 'allow' } });
  expect(await store.get('a1')).toMatchObject({ status: 'decided' });
  expect(await store.listPending()).toEqual([]);
  expect(log.joined()).toMatch(/the decision stands/);
});

test('approval store: expired entries from a dead process survive later writes, so the post-mortem is still there tomorrow', async () => {
  // M2: the file promises to say what died. That promise is only kept if
  // ordinary later activity — a new question, an answer — rewrites the file
  // WITH those entries rather than over them.
  const dataDir = await tmpDataDir();
  await seedApprovalFile(dataDir, [{ id: 'from-last-night', toolName: 'Bash', requestedAt: 1 }]);
  const store = createApprovalStore({ dataDir, log: collectingLog() });

  await store.put({ id: 'new-1', toolName: 'Write', requestedAt: 2 });
  await store.decide('new-1', { behavior: 'allow' });

  const onDisk = readApprovalFile(dataDir).approvals;
  expect(onDisk.find((e) => e.id === 'from-last-night')).toMatchObject({ status: 'expired', expired: 'process gone' });
  expect(await store.get('from-last-night')).toMatchObject({ expired: 'process gone' });
});

test('approval store: a corrupt file that cannot be renamed aside is copied aside instead', async () => {
  // M3: without the fallback the evidence is gone at the next write, silently.
  const dataDir = await tmpDataDir();
  await fsp.writeFile(path.join(dataDir, 'approvals.json'), '{ half a file', 'utf8');
  const log = collectingLog();
  const fsImpl = fsWith({
    renameSync: (from, to) => {
      if (String(from).endsWith('approvals.json')) throw Object.assign(new Error('EPERM: operation not permitted'), { code: 'EPERM' });
      return fs.renameSync(from, to);
    },
  });

  const store = createApprovalStore({ dataDir, log, fsImpl });
  expect(await store.listPending()).toEqual([]);
  const copies = fs.readdirSync(dataDir).filter((name) => name.startsWith('approvals.corrupt-'));
  expect(copies).toHaveLength(1);
  expect(fs.readFileSync(path.join(dataDir, copies[0]), 'utf8')).toBe('{ half a file');
  expect(log.joined()).toMatch(/copied to/);
});

test('approval store: temp files left by a crashed run are swept at startup', async () => {
  // M4: a crash between write and rename leaves one behind, and nobody else in
  // kaprek knows the name pattern, so nobody else can clean it up.
  const dataDir = await tmpDataDir();
  fs.writeFileSync(path.join(dataDir, '.approvals.json.tmp-999-1'), 'junk', 'utf8');
  fs.writeFileSync(path.join(dataDir, '.approvals.json.tmp-999-2'), 'junk', 'utf8');
  fs.writeFileSync(path.join(dataDir, 'unrelated.json'), '{}', 'utf8');

  createApprovalStore({ dataDir, log: collectingLog() });

  const left = fs.readdirSync(dataDir);
  expect(left.filter((name) => name.includes('.tmp-'))).toEqual([]);
  expect(left).toContain('unrelated.json');
});
