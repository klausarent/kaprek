// Tests for ed25519 task receipts. Run: npx vitest run src/receipt
import { test, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ensureKey, stableStringify, signReceipt, verifyReceipt, InvalidAgentNameError } from './receipt.mjs';

let dataDir;

beforeEach(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'receipt-test-'));
});

afterEach(() => {
  fs.rmSync(dataDir, { recursive: true, force: true });
});

function samplePayload(overrides = {}) {
  return {
    taskId: 'task-1',
    title: 'Ship the receipt feature',
    project: 'loryme',
    doc: { trigger: 'x', outcome: 'y' },
    sessionIds: ['s1', 's2'],
    gitCommit: null,
    policyVersion: null,
    ...overrides,
  };
}

test('ensureKey creates a key with {flag: "wx"} and a second call reuses it instead of erroring', () => {
  const first = ensureKey(dataDir, 'agent-a');
  expect(typeof first.pubkey).toBe('string');
  expect(first.pubkey.length).toBeGreaterThan(0);

  const keyPath = path.join(dataDir, 'keys', 'agent-a.pem');
  expect(fs.existsSync(keyPath)).toBe(true);
  const pemBefore = fs.readFileSync(keyPath, 'utf8');

  const second = ensureKey(dataDir, 'agent-a');
  expect(second.pubkey).toBe(first.pubkey);
  expect(fs.readFileSync(keyPath, 'utf8')).toBe(pemBefore); // key on disk is untouched, not regenerated

  const registry = JSON.parse(fs.readFileSync(path.join(dataDir, 'keys', 'registry.json'), 'utf8'));
  expect(registry['agent-a']).toBe(first.pubkey);
});

test('ensureKey rejects agentName injection attempts (path separators, dot-segments)', () => {
  expect(() => ensureKey(dataDir, '../evil')).toThrow(InvalidAgentNameError);
  expect(() => ensureKey(dataDir, 'a/b')).toThrow(InvalidAgentNameError);
  expect(() => ensureKey(dataDir, 'a\\b')).toThrow(InvalidAgentNameError);
  expect(() => ensureKey(dataDir, '')).toThrow(InvalidAgentNameError);
  expect(fs.existsSync(path.join(dataDir, 'keys'))).toBe(false);
});

test('stableStringify is invariant under input key order (recursively)', () => {
  const a = { b: 1, a: { d: 4, c: 3 }, e: [{ y: 2, x: 1 }] };
  const b = { a: { c: 3, d: 4 }, e: [{ x: 1, y: 2 }], b: 1 };
  expect(stableStringify(a)).toBe(stableStringify(b));
});

test('stableStringify preserves array element order', () => {
  expect(stableStringify({ a: [3, 1, 2] })).toBe('{"a":[3,1,2]}');
});

test('sign then verify roundtrips as valid', () => {
  const payload = samplePayload();
  const receipt = signReceipt({ dataDir, agentName: 'agent-a', payload });
  expect(receipt.agent).toBe('agent-a');
  expect(receipt.alg).toBe('ed25519');
  expect(typeof receipt.payloadHash).toBe('string');
  expect(typeof receipt.sig).toBe('string');
  expect(typeof receipt.signedAt).toBe('string');

  const result = verifyReceipt({ payload, receipt });
  expect(result).toEqual({ valid: true });
});

test('signReceipt is deterministic under input key order (payload field order does not change the hash)', () => {
  // signedAt is folded into the signed bytes now (see signReceipt()), so the
  // clock must be pinned for this comparison — otherwise the two calls would
  // legitimately produce different hashes even with an identical payload.
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-07-29T12:00:00.000Z'));
  try {
    const payloadA = samplePayload();
    const payloadB = { sessionIds: payloadA.sessionIds, doc: payloadA.doc, taskId: payloadA.taskId, project: payloadA.project, title: payloadA.title, gitCommit: null, policyVersion: null };
    const receiptA = signReceipt({ dataDir, agentName: 'agent-a', payload: payloadA });
    const receiptB = signReceipt({ dataDir, agentName: 'agent-a', payload: payloadB });
    expect(receiptA.payloadHash).toBe(receiptB.payloadHash);
  } finally {
    vi.useRealTimers();
  }
});

test('a one-character change to the payload (e.g. the doc) makes verification fail', () => {
  const payload = samplePayload();
  const receipt = signReceipt({ dataDir, agentName: 'agent-a', payload });

  const tampered = samplePayload({ doc: { ...payload.doc, outcome: 'z' } }); // 'y' -> 'z'
  const result = verifyReceipt({ payload: tampered, receipt });
  expect(result.valid).toBe(false);
  expect(result.reason).toBe('payload hash mismatch');
});

test('changing signedAt on a stored receipt invalidates it (signedAt is inside the signed content)', () => {
  const payload = samplePayload();
  const receipt = signReceipt({ dataDir, agentName: 'agent-a', payload });

  const tamperedReceipt = { ...receipt, signedAt: '2099-01-01T00:00:00.000Z' };
  const result = verifyReceipt({ payload, receipt: tamperedReceipt });
  expect(result.valid).toBe(false);
  expect(result.reason).toBe('payload hash mismatch');
});

test('changing agent on a stored receipt invalidates it (agent is inside the signed content)', () => {
  const payload = samplePayload();
  const receipt = signReceipt({ dataDir, agentName: 'agent-a', payload });

  const tamperedReceipt = { ...receipt, agent: 'agent-b' };
  const result = verifyReceipt({ payload, receipt: tamperedReceipt });
  expect(result.valid).toBe(false);
  expect(result.reason).toBe('payload hash mismatch');
});

test('a receipt whose pubkey belongs to a different keypair fails verification', () => {
  const payload = samplePayload();
  const receipt = signReceipt({ dataDir, agentName: 'agent-a', payload });
  const other = signReceipt({ dataDir, agentName: 'agent-b', payload });

  const foreignPubkeyReceipt = { ...receipt, pubkey: other.pubkey };
  const result = verifyReceipt({ payload, receipt: foreignPubkeyReceipt });
  expect(result.valid).toBe(false);
  expect(result.reason).toBe('signature invalid');
});

test('verifyReceipt never throws on malformed input', () => {
  expect(verifyReceipt({ payload: samplePayload(), receipt: null })).toEqual({ valid: false, reason: 'missing receipt' });
  expect(verifyReceipt({ payload: samplePayload(), receipt: {} })).toEqual({
    valid: false,
    reason: 'unsupported algorithm: undefined',
  });
  expect(
    verifyReceipt({
      payload: samplePayload(),
      receipt: { alg: 'ed25519', pubkey: 'not-base64-der', sig: 'x', payloadHash: 'y' },
    }).valid,
  ).toBe(false);
});
