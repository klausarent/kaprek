// Per-installation instance token — the thing that makes "only OUR client may
// talk to this server" enforceable at all.
//
// Loopback is NOT an authenticator: 127.0.0.1 keeps the network out, and the
// `x-app-request` CSRF header keeps a foreign WEB PAGE out (it forces a CORS
// preflight this server never answers), but any local process can set that
// header itself. Since kaprek's server starts agent turns on request (see
// src/triggers/runner.mjs), "any local process" is too wide a door. The
// pattern is Goose's (ui/desktop/src/goosed.ts + crates/goose-server/src/
// auth.rs): a random secret generated at first start, stored next to the data
// it protects, required on every API request, compared in constant time.
//
// About the file mode: `0o600` is honest only on POSIX. On Windows — kaprek's
// main platform — Node maps it to the read-only attribute and nothing else, so
// what actually keeps this file private there is the ACL on the user profile
// directory it lives in (the same protection the transcripts beside it get).
// The mode is set anyway because it costs nothing and does the right thing
// where it means something.
//
// The token is a capability, not a password: never logged, never in an error
// message, never in a URL (a query parameter lands in referrers, proxy logs
// and browser history). It reaches the browser exactly once, injected into
// the served index.html (see server.mjs::serveStatic) — and it is registered
// with src/parser/parse.mjs::registerSecret() so it is redacted out of every
// transcript/chat write path, the same as any API key.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

/** Request header carrying the token. Lowercase — that's how node:http normalizes incoming header names. */
export const TOKEN_HEADER = 'x-kaprek-token';

const TOKEN_FILE = 'instance-token';
const TOKEN_BYTES = 32;
const TOKEN_RE = /^[0-9a-f]{64}$/;

function tokenPathFor(dataDir) {
  return path.join(dataDir, TOKEN_FILE);
}

function freshToken() {
  return crypto.randomBytes(TOKEN_BYTES).toString('hex');
}

/**
 * Returns this installation's token, creating `<dataDir>/instance-token` on
 * first use: 32 random bytes as hex, written with `mode: 0o600` (see the
 * module comment on what that does and does not mean on Windows) and
 * `flag: 'wx'` (exclusive create).
 *
 * The `wx` + EEXIST path is what makes two servers starting at the same
 * moment safe: the loser of the race READS the winner's file instead of
 * overwriting it. Overwriting would silently lock out an already-running UI
 * that is holding the previous value.
 *
 * A file that exists but does not contain a well-formed token (e.g. a crash
 * left it empty) is REWRITTEN rather than treated as fatal: nothing can be
 * authenticating with an unusable value, so self-healing here costs no
 * security and avoids bricking every future start until a user deletes a file
 * they were never told about.
 */
export function ensureInstanceToken(dataDir) {
  fs.mkdirSync(dataDir, { recursive: true });
  const tokenPath = tokenPathFor(dataDir);

  try {
    const token = freshToken();
    fs.writeFileSync(tokenPath, token, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    return token;
  } catch (err) {
    if (err.code !== 'EEXIST') throw err;
  }

  const existing = fs.readFileSync(tokenPath, 'utf8').trim();
  if (TOKEN_RE.test(existing)) return existing;

  const replacement = freshToken();
  fs.writeFileSync(tokenPath, replacement, { encoding: 'utf8', mode: 0o600 });
  return replacement;
}

/**
 * Constant-time token comparison. The length is checked FIRST because
 * crypto.timingSafeEqual throws on differing buffer lengths — that check
 * leaks only the length of the presented value (which an attacker already
 * chose), never any byte of the real token. Anything that isn't a string
 * (missing header, or an array from a duplicated header) is simply false:
 * fail-closed, no coercion.
 */
export function timingSafeTokenEqual(presented, expected) {
  if (typeof presented !== 'string' || typeof expected !== 'string') return false;
  const a = Buffer.from(presented, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}
