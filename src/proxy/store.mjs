// Where the proxy writes what it saw: one line per request, the latest
// windows, and its own pid. Plain files in the kaprek data dir, read by the
// server for /api/quota. Never a token, never a body.
//
// One subdirectory per machine: ~/.kaprek is synced between Klaus' laptop
// and the home server, and two proxies writing the same file would end in
// sync conflicts. Each writes under its own hostname; readers merge all.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const ROTATE_BYTES = 20 * 1024 * 1024;

function hostKey(host) {
  return String(host || 'host').replace(/[^A-Za-z0-9._-]/g, '_');
}

export function proxyDir(dataDir, host = os.hostname()) {
  return path.join(dataDir, 'proxy', hostKey(host));
}

function hostDirs(dataDir) {
  const root = path.join(dataDir, 'proxy');
  try {
    return fs
      .readdirSync(root, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => path.join(root, e.name));
  } catch {
    return [];
  }
}

function ensure(dataDir, host) {
  const dir = proxyDir(dataDir, host);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function appendRequest(dataDir, record, host = os.hostname()) {
  const dir = ensure(dataDir, host);
  const file = path.join(dir, 'requests.jsonl');
  try {
    if (fs.statSync(file).size > ROTATE_BYTES) {
      const old = path.join(dir, 'requests.1.jsonl');
      fs.rmSync(old, { force: true });
      fs.renameSync(file, old);
    }
  } catch {
    // no file yet, or the rename lost a race with a reader: rotate next time
  }
  fs.appendFileSync(file, `${JSON.stringify(record)}\n`);
}

// Only the tail: /api/quota runs on the kaprek server thread, and a full
// 20 MB parse per request would stall it. 8 MB holds days of requests.
const READ_TAIL_BYTES = 8 * 1024 * 1024;

function readLines(file) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const size = fs.fstatSync(fd).size;
    const start = Math.max(0, size - READ_TAIL_BYTES);
    const buf = Buffer.alloc(size - start);
    fs.readSync(fd, buf, 0, buf.length, start);
    const lines = buf.toString('utf8').split('\n');
    return start > 0 ? lines.slice(1) : lines;
  } catch {
    return [];
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

export function readRequests(dataDir, { sinceMs = 0, maxLines = 50000 } = {}) {
  const lines = hostDirs(dataDir).flatMap((dir) => [...readLines(path.join(dir, 'requests.1.jsonl')), ...readLines(path.join(dir, 'requests.jsonl'))].slice(-maxLines));
  const out = [];
  for (const line of lines) {
    if (!line.trim()) continue;
    let rec;
    try {
      rec = JSON.parse(line);
    } catch {
      continue;
    }
    if (sinceMs && !(Date.parse(rec?.ts) >= sinceMs)) continue;
    out.push(rec);
  }
  return out.sort((a, b) => String(a?.ts).localeCompare(String(b?.ts)));
}

// Windows: rename onto a file another process has open (the kaprek server
// reading quota.json) fails with EPERM/EBUSY. Retry briefly, then fall back
// to a plain overwrite — a torn read is retried by the reader, a stuck
// snapshot would be wrong for hours. (Grok, council 02.10.)
function writeAtomic(file, text) {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, text);
  for (let i = 0; i < 5; i++) {
    try {
      fs.renameSync(tmp, file);
      return;
    } catch (err) {
      if (!['EPERM', 'EBUSY', 'EACCES'].includes(err?.code)) throw err;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
    }
  }
  fs.writeFileSync(file, text);
  fs.rmSync(tmp, { force: true });
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function accountKey(account) {
  return typeof account === 'string' && /^[A-Za-z0-9._-]{1,64}$/.test(account) ? account : 'unbekannt';
}

/**
 * The latest windows of one account, as seen from this host:
 * <dataDir>/proxy/<host>/quota/<account>.json. Written by the proxy on every
 * response and by the bridge watcher from its own stream log.
 */
export function writeQuota(dataDir, quota, host = os.hostname(), account = null) {
  const key = accountKey(account ?? quota?.account);
  const dir = path.join(ensure(dataDir, host), 'quota');
  fs.mkdirSync(dir, { recursive: true });
  writeAtomic(path.join(dir, `${key}.json`), JSON.stringify({ ...quota, account: key }, null, 2));
}

/** Newest snapshot per account over every host: the windows belong to the account, not the machine. */
export function readQuotas(dataDir) {
  const best = new Map();
  for (const dir of hostDirs(dataDir)) {
    let files = [];
    try {
      files = fs.readdirSync(path.join(dir, 'quota')).filter((f) => f.endsWith('.json'));
    } catch {
      // no quota dir on this host yet
    }
    const snaps = files.map((f) => readJson(path.join(dir, 'quota', f)));
    // quota.json from before accounts existed: one unnamed snapshot.
    snaps.push(readJson(path.join(dir, 'quota.json')));
    for (const q of snaps) {
      if (!q || typeof q !== 'object') continue;
      const key = accountKey(q.account);
      const prev = best.get(key);
      if (!prev || String(q.seenAt) > String(prev.seenAt)) best.set(key, { ...q, account: key });
    }
  }
  return best;
}

/** The newest snapshot of any account. */
export function readQuota(dataDir) {
  let best = null;
  for (const q of readQuotas(dataDir).values()) if (!best || String(q.seenAt) > String(best.seenAt)) best = q;
  return best;
}

/** organization id -> account id, merged over every host (first entry wins on a clash). */
export function readOrgMap(dataDir) {
  const out = {};
  for (const dir of hostDirs(dataDir)) {
    const m = readJson(path.join(dir, 'orgs.json'));
    if (!m || typeof m !== 'object') continue;
    for (const [org, acc] of Object.entries(m)) if (!(org in out) && typeof acc === 'string') out[org] = acc;
  }
  return out;
}

/**
 * Remember that `orgId` answered for `accountId`. Never overwrites: if the
 * organization is already known as another account, that one stands, and
 * the caller learns about the clash from the return value.
 */
export function learnOrg(dataDir, orgId, accountId, host = os.hostname()) {
  const known = readOrgMap(dataDir);
  if (orgId in known) return { learned: false, account: known[orgId] };
  const file = path.join(ensure(dataDir, host), 'orgs.json');
  const mine = readJson(file) ?? {};
  mine[orgId] = accountId;
  writeAtomic(file, JSON.stringify(mine, null, 2));
  return { learned: true, account: accountId };
}

export function writePid(dataDir, { pid, port }) {
  writeAtomic(path.join(ensure(dataDir, os.hostname()), 'proxy.pid.json'), JSON.stringify({ pid, port, startedAt: new Date().toISOString() }));
}

export function readPid(dataDir) {
  return readJson(path.join(proxyDir(dataDir), 'proxy.pid.json'));
}

export function clearPid(dataDir) {
  fs.rmSync(path.join(proxyDir(dataDir), 'proxy.pid.json'), { force: true });
}

export function isAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err?.code === 'EPERM';
  }
}
