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
  storableInput,
  APPROVAL_DEADLINE_INTERACTIVE_MS,
  APPROVAL_DEADLINE_UNATTENDED_MS,
  APPROVAL_HISTORY_RETENTION_MS,
  MAX_PENDING_APPROVALS,
  MAX_STORED_INPUT_BYTES,
  STORED_INPUT_PREVIEW_CHARS,
  WRITE_RETRY_DELAYS_MS,
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
function fsWith(overrides = {}, promiseOverrides = {}) {
  return { ...fs, ...overrides, promises: { ...fs.promises, ...promiseOverrides } };
}

/** Waits for everything the store has queued (see its serialized()), so a test can read the file at a defined point. */
async function settled(store) {
  await store.listPending();
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
  // The write-back runs on the store's own queue; any public call is a
  // barrier for it (see settled()).
  await settled(createApprovalStore({ dataDir }));

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
  const fsImpl = fsWith({}, {
    writeFile: async () => {
      throw Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' });
    },
  });

  const store = createApprovalStore({ dataDir, log, fsImpl });
  await settled(store);
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
  const fsImpl = fsWith({}, {
    writeFile: async (target, data, encoding) => {
      if (failWrites) throw Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' });
      return fs.promises.writeFile(target, data, encoding);
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
  const fsImpl = fsWith({}, {
    writeFile: async (target, data, encoding) => {
      if (failWrites) throw new Error('EIO: write failed');
      return fs.promises.writeFile(target, data, encoding);
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
  const fsImpl = fsWith({}, {
    writeFile: async (target, data, encoding) => {
      if (!truncateNextWrite) return fs.promises.writeFile(target, data, encoding);
      const half = String(data).slice(0, Math.floor(String(data).length / 2));
      await fs.promises.writeFile(target, half, encoding); // the bytes that DID land
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
  const fsImpl = fsWith({}, {
    writeFile: async (target, data, encoding) => {
      if (failWrites) throw new Error('EIO: write failed');
      return fs.promises.writeFile(target, data, encoding);
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

// ------------------------------------------------------------ hardening r3
//
// Bounds and blocking: what happens when the inputs get big, the queue gets
// long, another program holds the file for a moment, or two writes race.

test('approval store: an oversized input is stored as a marked stub, not verbatim', async () => {
  const dataDir = await tmpDataDir();
  const store = createApprovalStore({ dataDir, log: collectingLog() });
  const huge = { command: 'x'.repeat(MAX_STORED_INPUT_BYTES + 5_000) };

  await store.put({ id: 'big', toolName: 'Bash', input: huge, requestedAt: 0 });

  const stored = (await store.get('big')).input;
  expect(stored._truncated).toBe(true);
  expect(stored.preview.length).toBe(STORED_INPUT_PREVIEW_CHARS);
  // The preview is the START of what was asked, so the entry is still
  // recognisable rather than an empty marker.
  expect(stored.preview).toContain('command');
  // And the file it went into stays small, which is the point of the cap:
  // every later put rewrites this file in full.
  const bytes = fs.statSync(path.join(dataDir, 'approvals.json')).size;
  expect(bytes).toBeLessThan(MAX_STORED_INPUT_BYTES);
});

test('approval store: an input under the cap is stored exactly as given', async () => {
  const store = createApprovalStore({ dataDir: await tmpDataDir(), log: collectingLog() });
  const input = { command: 'git status', nested: { list: [1, 2, 3] } };
  await store.put({ id: 'small', toolName: 'Bash', input, requestedAt: 0 });
  expect((await store.get('small')).input).toEqual(input);
});

test('storableInput: the cap is on serialised bytes, and an unserialisable input says so instead of throwing', () => {
  expect(storableInput(null)).toBeNull();
  expect(storableInput({ a: 1 })).toEqual({ a: 1 });
  expect(storableInput({ a: 'x'.repeat(MAX_STORED_INPUT_BYTES) })._truncated).toBe(true);

  const cyclic = { name: 'loop' };
  cyclic.self = cyclic;
  // A cyclic input could never have been written; recording that is better
  // than throwing on the approval path, which would deny the question.
  expect(storableInput(cyclic)).toEqual({ _truncated: true, preview: '(input could not be serialised)' });
});

test('approval store: the pending queue is capped, and the refusal is loud rather than a silent drop', async () => {
  const store = createApprovalStore({ dataDir: await tmpDataDir(), log: collectingLog() });
  for (let i = 0; i < MAX_PENDING_APPROVALS; i += 1) {
    await store.put({ id: `q-${i}`, toolName: 'Bash', requestedAt: i });
  }

  await expect(store.put({ id: 'one-too-many', toolName: 'Bash', requestedAt: 999 })).rejects.toThrow(/too many approvals/);
  expect(await store.get('one-too-many')).toBeNull();
  expect(await store.listPending()).toHaveLength(MAX_PENDING_APPROVALS);

  // Answering one frees exactly one slot: the cap counts what is WAITING, not
  // what has ever been asked.
  await store.decide('q-0', { behavior: 'allow' });
  await store.put({ id: 'now-it-fits', toolName: 'Bash', requestedAt: 1000 });
  expect((await store.listPending()).map((e) => e.id)).toContain('now-it-fits');
});

test('approval store: a rename held by another program is retried, not turned into a denied approval', async () => {
  // The Windows case (Grok #4): an antivirus scanner or the search indexer
  // holds approvals.json for a moment, rename fails EPERM, and without a retry
  // put() throws, which the approval handler turns into a fail-closed deny. A
  // legitimate overnight question refused because a scanner blinked.
  const dataDir = await tmpDataDir();
  let renameAttempts = 0;
  const fsImpl = fsWith(
    {},
    {
      rename: async (from, to) => {
        renameAttempts += 1;
        if (renameAttempts === 1) throw Object.assign(new Error('EPERM: operation not permitted'), { code: 'EPERM' });
        return fs.promises.rename(from, to);
      },
    },
  );
  const store = createApprovalStore({ dataDir, log: collectingLog(), fsImpl });

  await expect(store.put({ id: 'scanned', toolName: 'Bash', requestedAt: 0 })).resolves.toMatchObject({ id: 'scanned' });
  expect(renameAttempts).toBe(2);
  expect(readApprovalFile(dataDir).approvals.map((e) => e.id)).toEqual(['scanned']);
});

test('approval store: a non-transient write error is not retried, because a full disk will not un-fill itself', async () => {
  const dataDir = await tmpDataDir();
  let writeAttempts = 0;
  const fsImpl = fsWith(
    {},
    {
      writeFile: async () => {
        writeAttempts += 1;
        throw Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' });
      },
    },
  );
  const store = createApprovalStore({ dataDir, log: collectingLog(), fsImpl });

  await expect(store.put({ id: 'doomed', toolName: 'Bash', requestedAt: 0 })).rejects.toThrow(/ENOSPC/);
  expect(writeAttempts).toBe(1);
});

test('approval store: a transient failure that never clears gives up after the configured attempts', async () => {
  const dataDir = await tmpDataDir();
  let renameAttempts = 0;
  const fsImpl = fsWith(
    {},
    {
      rename: async () => {
        renameAttempts += 1;
        throw Object.assign(new Error('EBUSY: resource busy or locked'), { code: 'EBUSY' });
      },
    },
  );
  const store = createApprovalStore({ dataDir, log: collectingLog(), fsImpl });

  await expect(store.put({ id: 'stuck', toolName: 'Bash', requestedAt: 0 })).rejects.toThrow(/EBUSY/);
  // One initial attempt plus one per configured backoff, then the error stands.
  expect(renameAttempts).toBe(WRITE_RETRY_DELAYS_MS.length + 1);
});

test('approval store: concurrent writes are serialised, so the file ends up describing all of them and not a mix', async () => {
  // With persist() async, two puts started in the same tick could otherwise
  // interleave write/rename and leave the file describing the older state.
  const dataDir = await tmpDataDir();
  const store = createApprovalStore({ dataDir, log: collectingLog() });

  await Promise.all([
    store.put({ id: 'a', toolName: 'Bash', requestedAt: 1 }),
    store.put({ id: 'b', toolName: 'Bash', requestedAt: 2 }),
    store.put({ id: 'c', toolName: 'Bash', requestedAt: 3 }),
  ]);

  expect(readApprovalFile(dataDir).approvals.map((e) => e.id).sort()).toEqual(['a', 'b', 'c']);
  expect((await store.listPending()).map((e) => e.id)).toEqual(['a', 'b', 'c']);
});

test('approval store: two decisions for the same id racing in one tick still produce exactly one', async () => {
  // The synchronous version got this for free. With awaits inside decide(),
  // only the queue keeps a second answer from slipping between the status
  // check and the write.
  const store = createApprovalStore({ dataDir: await tmpDataDir(), log: collectingLog() });
  await store.put({ id: 'contested', toolName: 'Bash', requestedAt: 0 });

  const results = await Promise.allSettled([
    store.decide('contested', { behavior: 'allow' }),
    store.decide('contested', { behavior: 'deny' }),
  ]);

  expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
  expect(results.filter((r) => r.status === 'rejected')).toHaveLength(1);
  expect(results.find((r) => r.status === 'rejected').reason.message).toMatch(/already decided/);
  expect((await store.get('contested')).decision.behavior).toBe('allow');
});
