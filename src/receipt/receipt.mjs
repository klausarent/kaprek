// Task receipts — ed25519 signatures over a task's completion payload.
//
// A receipt seals a task's state (title/project/doc/linked sessions) at the
// moment it was signed. Verification always reconstructs the payload fresh
// from the task's CURRENT state (see server.mjs's receipt/verify route), so
// a later edit to the doc intentionally makes an existing receipt verify as
// invalid again — the receipt is a snapshot claim, not a standing approval.
//
// Keys are per-agent ed25519 keypairs stored as PKCS8 PEM files under
// <dataDir>/keys/<agentName>.pem, generated on first use and reused after
// that. No network, no child_process.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

// agentName becomes a filename (<agentName>.pem) and a registry.json key, so
// it is restricted to a safe, portable character set — no path separators,
// no '..'.
const AGENT_NAME_RE = /^[a-zA-Z0-9_@.-]+$/;

export class InvalidAgentNameError extends Error {
  constructor(agentName) {
    super(`invalid agent name: ${JSON.stringify(agentName)} (expected only letters, digits, '_', '@', '.', '-')`);
    this.name = 'InvalidAgentNameError';
    this.agentName = agentName;
  }
}

function assertValidAgentName(agentName) {
  if (typeof agentName !== 'string' || agentName.length === 0 || !AGENT_NAME_RE.test(agentName)) {
    throw new InvalidAgentNameError(agentName);
  }
}

function keysDir(dataDir) {
  return path.join(dataDir, 'keys');
}

function keyPathFor(dataDir, agentName) {
  return path.join(keysDir(dataDir), `${agentName}.pem`);
}

function registryPathFor(dataDir) {
  return path.join(keysDir(dataDir), 'registry.json');
}

/** Base64-encodes a KeyObject's SPKI DER form — the portable pubkey shape stored in receipts and registry.json. */
function pubkeyToBase64(publicKeyObject) {
  return publicKeyObject.export({ type: 'spki', format: 'der' }).toString('base64');
}

/** Atomically updates <dataDir>/keys/registry.json's {agentName: pubkeyBase64} map via write-to-tmp + rename. */
function updateRegistry(dataDir, agentName, pubkeyBase64) {
  const registryPath = registryPathFor(dataDir);
  let registry = {};
  if (fs.existsSync(registryPath)) {
    try {
      registry = JSON.parse(fs.readFileSync(registryPath, 'utf8'));
    } catch {
      registry = {}; // A corrupt registry file must not block signing — rebuild it.
    }
  }
  registry[agentName] = pubkeyBase64;
  const tmpPath = `${registryPath}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmpPath, JSON.stringify(registry, null, 2), 'utf8');
  fs.renameSync(tmpPath, registryPath);
}

/**
 * Ensures an ed25519 keypair exists for `agentName` under
 * `<dataDir>/keys/<agentName>.pem` and returns its public key (base64 SPKI
 * DER). The key file is created with `{flag: 'wx'}` so two concurrent first
 * callers can never overwrite each other's key; whichever loses the race
 * simply loads the winner's key instead of erroring. `registry.json` is
 * updated either way, so it always reflects the key actually on disk.
 */
export function ensureKey(dataDir, agentName) {
  assertValidAgentName(agentName);
  fs.mkdirSync(keysDir(dataDir), { recursive: true });
  const keyPath = keyPathFor(dataDir, agentName);

  let privateKey;
  try {
    const { privateKey: pem } = crypto.generateKeyPairSync('ed25519', {
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
      publicKeyEncoding: { type: 'spki', format: 'pem' },
    });
    fs.writeFileSync(keyPath, pem, { flag: 'wx' });
    privateKey = crypto.createPrivateKey(pem);
  } catch (err) {
    if (err.code !== 'EEXIST') throw err;
    // Lost the creation race (or a key from an earlier run already exists) — load it instead.
    privateKey = crypto.createPrivateKey(fs.readFileSync(keyPath, 'utf8'));
  }

  const pubkey = pubkeyToBase64(crypto.createPublicKey(privateKey));
  updateRegistry(dataDir, agentName, pubkey);
  return { pubkey };
}

/** Recursively sorts object keys (arrays keep their order) so JSON.stringify's output is order-independent. */
function sortKeysDeep(value) {
  if (Array.isArray(value)) return value.map(sortKeysDeep);
  if (value !== null && typeof value === 'object') {
    const sorted = {};
    for (const key of Object.keys(value).sort()) {
      sorted[key] = sortKeysDeep(value[key]);
    }
    return sorted;
  }
  return value;
}

/** Deterministic JSON serialization: recursively key-sorted, so field order in the input never changes the output. */
export function stableStringify(value) {
  return JSON.stringify(sortKeysDeep(value));
}

/**
 * Signs `payload` (a completion snapshot, see server.mjs's receiptPayloadFor)
 * with `agentName`'s ed25519 key, creating the key on first use.
 * Returns a receipt: `{agent, pubkey, alg, payloadHash, sig, signedAt}`.
 * The signature covers the canonical payload bytes directly (not the hash);
 * `payloadHash` is carried as a cheap-to-compare metadatum for callers and
 * as a second check verifyReceipt() performs alongside signature verification.
 */
export function signReceipt({ dataDir, agentName, payload }) {
  assertValidAgentName(agentName);
  const { pubkey } = ensureKey(dataDir, agentName);
  const privateKey = crypto.createPrivateKey(fs.readFileSync(keyPathFor(dataDir, agentName), 'utf8'));

  const canonicalBytes = Buffer.from(stableStringify(payload), 'utf8');
  const payloadHash = crypto.createHash('sha256').update(canonicalBytes).digest('hex');
  const sig = crypto.sign(null, canonicalBytes, privateKey).toString('base64');

  return {
    agent: agentName,
    pubkey,
    alg: 'ed25519',
    payloadHash,
    sig,
    signedAt: new Date().toISOString(),
  };
}

/**
 * Verifies `receipt` against `payload`: recomputes the payload hash (catches
 * tampering with `payload` itself) and checks the signature against the
 * public key carried IN the receipt (catches a receipt whose signature and
 * pubkey were both swapped for a different keypair, and lets verification
 * happen without any external key lookup). Returns `{valid: true}` or
 * `{valid: false, reason}`; never throws on malformed input.
 */
export function verifyReceipt({ payload, receipt }) {
  if (!receipt || typeof receipt !== 'object') return { valid: false, reason: 'missing receipt' };
  const { pubkey, alg, payloadHash, sig } = receipt;
  if (alg !== 'ed25519') return { valid: false, reason: `unsupported algorithm: ${alg}` };
  if (typeof pubkey !== 'string' || typeof sig !== 'string' || typeof payloadHash !== 'string') {
    return { valid: false, reason: 'malformed receipt' };
  }

  const canonicalBytes = Buffer.from(stableStringify(payload), 'utf8');
  const actualHash = crypto.createHash('sha256').update(canonicalBytes).digest('hex');
  if (actualHash !== payloadHash) {
    return { valid: false, reason: 'payload hash mismatch' };
  }

  let publicKey;
  try {
    publicKey = crypto.createPublicKey({ key: Buffer.from(pubkey, 'base64'), format: 'der', type: 'spki' });
  } catch {
    return { valid: false, reason: 'malformed public key' };
  }

  let sigValid;
  try {
    sigValid = crypto.verify(null, canonicalBytes, publicKey, Buffer.from(sig, 'base64'));
  } catch {
    return { valid: false, reason: 'malformed signature' };
  }
  if (!sigValid) return { valid: false, reason: 'signature invalid' };

  return { valid: true };
}
