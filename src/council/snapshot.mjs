// What a peer is allowed to see of the disk: nothing, except what this file
// hands it.
//
// Until 0.9.0 the council package listed file PATHS and the peer read them
// itself, standing in the mission's working directory. Both blind reviews of
// 0.6.0 flagged where that ends: a mission folder with a .env in it, a peer
// pointed one directory too high, and the secrets are on another vendor's
// servers. The fix is the same shape BrainOutside uses for its visibility
// tiers: materialize what the peer may see, hand it the copy, and never let
// it near the original.
//
// Three rules:
//
//   1. A snapshot is READ HERE, REDACTED HERE, BOUNDED HERE. The peer gets
//      the result embedded in its prompt and has no reason — and, for grok,
//      no tools — to touch the disk.
//   2. Some files are never snapshotted, no matter what redaction would
//      catch: .env files, private keys, credential stores. Redaction knows
//      the secret FORMATS it has seen; a .env is one secret per line in
//      formats nobody promised to recognize.
//   3. What was left out is SAID, not swallowed. A peer judging three files
//      out of five must know there were five, or its "agree" covers less
//      than everyone reading it will assume.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { redactSecrets } from '../parser/parse.mjs';
import { isInside, realish } from '../lib/contain.mjs';

/**
 * Per-file and per-package ceilings.
 *
 * Generous enough for a plan plus a handful of source files, small enough
 * that the package stays something a model actually reads (the old comment
 * on buildPackage said it: pasting files in is how a package grows past what
 * any model reads — the answer is a budget, not a ban).
 */
export const SNAPSHOT_LIMITS = {
  maxFiles: 12,
  maxFileBytes: 48 * 1024,
  maxTotalBytes: 192 * 1024,
  /** Refused before any read: a stat() is cheap, decoding gigabytes is not. */
  maxRawBytes: 4 * 1024 * 1024,
};

/**
 * More requests than this and the tail is refused in one line — a caller
 * that names ten thousand paths is not asking for a review, and stat()ing
 * every one of them would be the denial of service it was fishing for.
 */
export const MAX_REQUESTED_PATHS = 64;

/** Basenames that end the discussion regardless of extension matching. */
const REFUSED_NAMES = new Set(['.env', '.netrc', '.npmrc', '.git-credentials', '.htpasswd', '.pgpass', 'credentials', 'credentials.json', 'secrets.json', 'secrets.yaml', 'secrets.yml']);
/** A `.env.production` is still a .env; an `id_rsa.pub` is still key material. */
const REFUSED_PREFIXES = ['.env.', 'id_rsa', 'id_ed25519', 'id_ecdsa', 'id_dsa', 'service-account'];
// `.env` itself is a suffix check (not just REFUSED_NAMES' exact ".env"):
// a file named "produktion.env" or "Überschrift.env" is exactly as much a
// dotenv file as ".env" is, and over-blocking is the safe direction here —
// someone who genuinely wants to share such a file can rename it.
/** Extensions whose files exist to hold key, credential, or secret material. */
const REFUSED_EXTENSIONS = ['.pem', '.key', '.p12', '.pfx', '.jks', '.keystore', '.tfstate', '.kdbx', '.env'];

/**
 * Why `filePath` must not be embedded in a peer package, or null if it may.
 *
 * Judged on the basename alone, before any I/O: this list is about what a
 * file IS, not what it currently contains. An empty .env is refused too —
 * the next write to it would not re-run this decision.
 */
export function refusalReason(filePath) {
  const name = path.basename(filePath).toLowerCase();
  if (REFUSED_NAMES.has(name)) return 'files of this name hold credentials';
  if (REFUSED_PREFIXES.some((prefix) => name.startsWith(prefix))) return 'files of this name hold credentials or key material';
  if (REFUSED_EXTENSIONS.some((ext) => name.endsWith(ext))) return 'files of this type hold key or credential material';
  return null;
}

/** A NUL byte in the first 4KB means binary — nothing a text review can use. */
function looksBinary(content) {
  return content.slice(0, 4096).includes('\u0000');
}

/**
 * Reads, redacts, and bounds the files a consultation wants to show its
 * peers.
 *
 * @param {string[]} paths - as given by the caller; relative ones resolve
 *   against `cwd`
 * @param {object} options
 * @param {string} options.cwd - what relative paths are relative to
 * @param {string[]} options.roots - the directories a snapshot may come
 *   from. Same containment check as the plan store (realpath both sides):
 *   a junction inside an allowed root must not reach outside it.
 * @param {object} [options.limits] - see SNAPSHOT_LIMITS
 * @returns {{snapshots: Array<{path: string, content: string, truncated: boolean, sha256: string}>,
 *            refused: Array<{path: string, reason: string}>}}
 *   `sha256` fingerprints the RAW content as read, before redaction and
 *   truncation — it answers "which version did the peers see", not "what
 *   exact bytes were embedded".
 */
export function snapshotFiles(paths, { cwd, roots, limits = SNAPSHOT_LIMITS } = {}) {
  const snapshots = [];
  const refused = [];
  const allowedRoots = (roots ?? []).filter(Boolean);
  let totalBytes = 0;

  const wanted = (paths ?? []).filter((given) => typeof given === 'string' && given.trim() !== '');
  if (wanted.length > MAX_REQUESTED_PATHS) {
    refused.push({ path: `${wanted.length - MAX_REQUESTED_PATHS} further files`, reason: `only the first ${MAX_REQUESTED_PATHS} requested paths are considered` });
    wanted.length = MAX_REQUESTED_PATHS;
  }

  for (const given of wanted) {
    const resolved = path.resolve(cwd ?? process.cwd(), given);
    // Resolve symlinks BEFORE judging the name: a friendly-named link to a
    // .env passes every basename check, and stat/readFile would follow it
    // to the real file. Judge what will actually be read. (A hard link
    // keeps its own name and defeats this — that is a documented limit,
    // not a promise. So is the race between this resolution and the read
    // below: an attacker who can retarget links inside an allowed root
    // while a consultation runs already has write access to the tree.)
    const real = realish(resolved);

    if (snapshots.length >= limits.maxFiles) {
      refused.push({ path: given, reason: `only the first ${limits.maxFiles} files are included` });
      continue;
    }
    const refusal = refusalReason(real) ?? refusalReason(resolved);
    if (refusal) {
      refused.push({ path: given, reason: refusal });
      continue;
    }
    if (allowedRoots.length === 0) {
      refused.push({ path: given, reason: 'no readable root is bound to this consultation' });
      continue;
    }
    if (!allowedRoots.some((root) => isInside(root, real))) {
      refused.push({ path: given, reason: 'outside the directories this consultation may read' });
      continue;
    }

    let content;
    try {
      const stat = fs.statSync(real);
      if (!stat.isFile()) {
        refused.push({ path: given, reason: 'not a regular file' });
        continue;
      }
      // Size gate BEFORE the read: readFileSync would decode the whole
      // file first and truncate later, which turns "snapshot my 3GB log"
      // into a hung server.
      if (stat.size > (limits.maxRawBytes ?? SNAPSHOT_LIMITS.maxRawBytes)) {
        refused.push({ path: given, reason: 'too large to snapshot' });
        continue;
      }
      content = fs.readFileSync(real, 'utf8');
    } catch (err) {
      refused.push({ path: given, reason: `could not be read: ${err?.code ?? err?.message ?? 'unknown error'}` });
      continue;
    }
    if (looksBinary(content)) {
      refused.push({ path: given, reason: 'binary file' });
      continue;
    }

    // Fingerprint of what was actually read, before redaction and cuts:
    // callers that record "the peers judged THIS version" (auto.mjs's
    // planSha256) must hash the same read that produced the snapshot, or
    // a write between two reads makes the verdict lie about its subject.
    const sha256 = crypto.createHash('sha256').update(content, 'utf8').digest('hex');

    // Redact BEFORE truncating, same order parse.mjs::truncate() insists on:
    // cutting first can split a secret so its tail survives redaction.
    content = redactSecrets(content);
    let truncated = false;
    if (Buffer.byteLength(content, 'utf8') > limits.maxFileBytes) {
      content = content.slice(0, limits.maxFileBytes);
      truncated = true;
    }
    const bytes = Buffer.byteLength(content, 'utf8');
    if (totalBytes + bytes > limits.maxTotalBytes) {
      refused.push({ path: given, reason: 'the package size budget was already spent' });
      continue;
    }
    totalBytes += bytes;
    snapshots.push({ path: given, content, truncated, sha256 });
  }

  return { snapshots, refused };
}

/**
 * The same shape snapshotFiles() gives a real file — sha256 of the raw text,
 * then redaction, then a cap — for text that was never a path on disk to
 * begin with. `kaprek council --diff` uses this for its combined
 * `git-diff.patch`: the diff comes from running git, not from reading a
 * file, so it never goes through snapshotFiles()'s path/root/refusal checks
 * (a diff's OWN secrets-file hunks are stripped separately beforehand — see
 * src/council/diff.mjs's redactSecretHunks() — before this ever sees the
 * text).
 *
 * The cap here is characters, not SNAPSHOT_LIMITS.maxFileBytes' bytes, and
 * has no shared totalBytes budget the way snapshotFiles()'s loop does: this
 * produces exactly one snapshot, standing alone, sized for a diff rather
 * than for a handful of files that share one package.
 *
 * @param {object} options
 * @param {string} options.name - the virtual path shown to the peer
 * @param {string} options.text - the raw text to include
 * @param {number} [options.maxChars] - character cap, default 200,000
 */
export function snapshotText({ name, text, maxChars = 200_000 }) {
  const raw = typeof text === 'string' ? text : '';
  const sha256 = crypto.createHash('sha256').update(raw, 'utf8').digest('hex');
  let content = redactSecrets(raw);
  let truncated = false;
  if (content.length > maxChars) {
    const cut = content.length - maxChars;
    content = `${content.slice(0, maxChars)}\n… [truncated: ${cut} more characters]`;
    truncated = true;
  }
  return { path: name, content, truncated, sha256 };
}
