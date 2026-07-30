// Tests for the per-installation instance token. Run: npx vitest run src/server/token.test.mjs
import { test, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ensureInstanceToken, timingSafeTokenEqual, TOKEN_HEADER } from './token.mjs';

let dataDir;

beforeEach(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kaprek-token-test-'));
});

afterEach(() => {
  fs.rmSync(dataDir, { recursive: true, force: true });
});

function tokenFile() {
  return path.join(dataDir, 'instance-token');
}

test('ensureInstanceToken creates a 64-hex-character token file on first use', () => {
  const token = ensureInstanceToken(dataDir);
  expect(token).toMatch(/^[0-9a-f]{64}$/);
  expect(fs.readFileSync(tokenFile(), 'utf8')).toBe(token);
});

test('ensureInstanceToken is idempotent: a second call returns the SAME token, never a fresh one', () => {
  const first = ensureInstanceToken(dataDir);
  const second = ensureInstanceToken(dataDir);
  expect(second).toBe(first);
});

test('two concurrent ensureInstanceToken calls agree on one token (the EEXIST loser reads, never overwrites)', async () => {
  // Both calls race on the same exclusive create; whichever loses must adopt
  // the winner's value, otherwise an already-running UI would be locked out.
  const [a, b] = await Promise.all([
    Promise.resolve().then(() => ensureInstanceToken(dataDir)),
    Promise.resolve().then(() => ensureInstanceToken(dataDir)),
  ]);
  expect(a).toBe(b);
  expect(fs.readFileSync(tokenFile(), 'utf8')).toBe(a);
});

test('a token file left empty by a crash is replaced instead of bricking every future start', () => {
  fs.writeFileSync(tokenFile(), '', 'utf8');
  const token = ensureInstanceToken(dataDir);
  expect(token).toMatch(/^[0-9a-f]{64}$/);
  expect(fs.readFileSync(tokenFile(), 'utf8')).toBe(token);
});

test('a token file with garbage in it is replaced too', () => {
  fs.writeFileSync(tokenFile(), 'not-a-token\n', 'utf8');
  expect(ensureInstanceToken(dataDir)).toMatch(/^[0-9a-f]{64}$/);
});

test('ensureInstanceToken creates a missing dataDir rather than throwing', () => {
  const nested = path.join(dataDir, 'nope', 'deeper');
  expect(ensureInstanceToken(nested)).toMatch(/^[0-9a-f]{64}$/);
});

test('the token file is created with owner-only permissions where the platform reports them', () => {
  ensureInstanceToken(dataDir);
  const mode = fs.statSync(tokenFile()).mode & 0o777;
  // Windows does not model POSIX permission bits (it reports 0o666), so this
  // is only asserted where the mode means something.
  if (process.platform !== 'win32') expect(mode).toBe(0o600);
  else expect(mode).toBeGreaterThan(0);
});

test('timingSafeTokenEqual: equal strings match, any difference does not', () => {
  const token = ensureInstanceToken(dataDir);
  expect(timingSafeTokenEqual(token, token)).toBe(true);
  expect(timingSafeTokenEqual(`${token.slice(0, -1)}0`, token)).toBe(false);
});

test('timingSafeTokenEqual: a length mismatch is false, not a throw (crypto.timingSafeEqual would throw)', () => {
  expect(timingSafeTokenEqual('short', 'a'.repeat(64))).toBe(false);
  expect(timingSafeTokenEqual('a'.repeat(65), 'a'.repeat(64))).toBe(false);
});

test('timingSafeTokenEqual: a missing or non-string presented value is false, never coerced', () => {
  const token = 'a'.repeat(64);
  expect(timingSafeTokenEqual(undefined, token)).toBe(false);
  expect(timingSafeTokenEqual(null, token)).toBe(false);
  // node:http hands over an array when a header appears twice.
  expect(timingSafeTokenEqual([token, token], token)).toBe(false);
  expect(timingSafeTokenEqual(token, undefined)).toBe(false);
});

test('TOKEN_HEADER is lowercase — node:http normalizes incoming header names that way', () => {
  expect(TOKEN_HEADER).toBe('x-kaprek-token');
  expect(TOKEN_HEADER).toBe(TOKEN_HEADER.toLowerCase());
});
