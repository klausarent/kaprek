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
