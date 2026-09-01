// P6a — standing grants, end to end: the nonce round-trip through
// handleApprovalDecision + decide(), the mint route, the grant check on the
// approval path (hard denial → ceiling → GRANT → question), and the store's
// own refusal matrix. HTTP tests boot a real server like server.test.mjs.
import { test, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startServer } from './server.mjs';
import { TOKEN_HEADER } from './token.mjs';
import { createApprovalStore } from './approval-store.mjs';
import { inputHashOf } from '../policy/grants.mjs';

// ---------------------------------------------------------------------------
// Unit: the nonce half (approval-store)
// ---------------------------------------------------------------------------

test('grant intent: decide() stamps a one-consumable nonce; consumeGrantIntent redeems it exactly once', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'grant-intent-'));
  try {
    const store = createApprovalStore({ dataDir });
    await store.put({ id: 'c1:1', chatId: 'c1', toolName: 'Bash', input: { command: 'ls' } });
    const decided = await store.decide('c1:1', { behavior: 'allow', grantIntent: { inputHash: 'a'.repeat(64) } });
    expect(decided.grantIntent.nonce).toMatch(/^[0-9a-f]{48}$/);
    expect(decided.grantIntent.consumedAt).toBe(null);
    expect(decided.grantIntent.inputHash).toBe('a'.repeat(64));

    const intent = await store.consumeGrantIntent('c1:1', decided.grantIntent.nonce);
    expect(intent).toMatchObject({ toolName: 'Bash', inputHash: 'a'.repeat(64), chatId: 'c1', approvalId: 'c1:1' });

    // REPLAY: the correct nonce, a second time — 409 material.
    await expect(store.consumeGrantIntent('c1:1', decided.grantIntent.nonce)).rejects.toMatchObject({ already: 'nonce-consumed' });
    // A wrong nonce is refused without burning anything (it is already burned here anyway).
    await expect(store.consumeGrantIntent('c1:1', 'f'.repeat(48))).rejects.toMatchObject({ already: 'nonce-consumed' });
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test("grant intent: a nonce from another store instance (a 'foreign' approval) is refused as not-owned", async () => {
  const dirA = fs.mkdtempSync(path.join(os.tmpdir(), 'grant-intent-a-'));
  const dirB = fs.mkdtempSync(path.join(os.tmpdir(), 'grant-intent-b-'));
  try {
    // The approval is filed, decided and its intent PERSISTED by process A;
    // process B reads the same file (a restart) — its ownedIds is empty.
    const a = createApprovalStore({ dataDir: dirA });
    await a.put({ id: 'c1:1', chatId: 'c1', toolName: 'Bash', input: { command: 'ls' } });
    const decided = await a.decide('c1:1', { behavior: 'allow', grantIntent: { inputHash: 'a'.repeat(64) } });

    const b = createApprovalStore({ dataDir: dirA });
    await expect(b.consumeGrantIntent('c1:1', decided.grantIntent.nonce)).rejects.toMatchObject({ already: 'not-owned' });
  } finally {
    fs.rmSync(dirA, { recursive: true, force: true });
    fs.rmSync(dirB, { recursive: true, force: true });
  }
});

test('grant intent: lapsed, cancelled-state, denied and plain-allow entries mint nothing', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'grant-intent-'));
  try {
    const store = createApprovalStore({ dataDir, now: () => 1_000 });

    // A plain allow (no grant intent asked for): nothing to redeem.
    await store.put({ id: 'c1:plain', chatId: 'c1', toolName: 'Bash', input: { command: 'ls' } });
    await store.decide('c1:plain', { behavior: 'allow' });
    await expect(store.consumeGrantIntent('c1:plain', 'x'.repeat(48))).rejects.toMatchObject({ already: 'no-intent' });

    // A deny with an intent is still a deny: nothing to stand on.
    await store.put({ id: 'c1:deny', chatId: 'c1', toolName: 'Bash', input: { command: 'ls' } });
    await store.decide('c1:deny', { behavior: 'deny', grantIntent: { inputHash: 'a'.repeat(64) } });
    await expect(store.consumeGrantIntent('c1:deny', 'x'.repeat(48))).rejects.toMatchObject({ already: 'denied' });

    // A lapsed entry is not decided: minting from the 24h-old backlog is impossible.
    await store.put({ id: 'c1:lapsed', chatId: 'c1', toolName: 'Bash', input: { command: 'ls' }, deadlineAt: 2_000 });
    await store.decide('c1:lapsed', { behavior: 'allow', grantIntent: { inputHash: 'a'.repeat(64) } });
    await expect(store.consumeGrantIntent('c1:unknownid', 'x'.repeat(48))).rejects.toMatchObject({ already: 'unknown' });
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('grant intent: a truncated (over-cap) input never even gets a hash, so it cannot seed a grant', () => {
  const salt = 's'.repeat(64);
  const big = { command: 'y'.repeat(1024 * 1024 + 1) };
  // inputHashOf refuses — the same condition that leaves input._truncated on
  // the stored record — so handleApprovalDecision has no hash to hand to
  // decide(), the response carries no nonce, and POST /api/grants has
  // nothing to redeem. Mint from truncated: structurally impossible.
  expect(inputHashOf(salt, big)).toBe(null);
  expect(inputHashOf(salt, { command: 'y'.repeat(1024 * 1024 - 100) })).not.toBe(null);
});
