// The environment a Claude Code session starts with, for the account
// pickAccount chose. Claude Code itself does the authenticating:
// CLAUDE_CODE_OAUTH_TOKEN for a `claude setup-token` account, nothing (and
// no inherited token) for the /login account. The tag lets the proxy file the
// windows under the right account; the base URL points at the proxy only
// when one is running and nobody set a base URL on purpose.
import fs from 'node:fs';
import path from 'node:path';
import { loadAccounts, resolveCredential, defaultEnvFile, loginOrgFrom } from './config.mjs';
import { pickAccount } from './pick.mjs';
import { probeAccount } from '../harness/probe-account.mjs';
import { readQuotas, writeQuota, readPid, isAlive, proxyDir } from '../proxy/store.mjs';

const TAG = 'x-kaprek-account';
// Paperclip starts dozens of runs at once through `kaprek accounts exec
// --probe`: one of them probes, the others wait for its readings instead of
// probing the same accounts again. A lock older than this is a crashed prober.
export const PROBE_LOCK_STALE_MS = 3 * 60_000;
const PROBE_LOCK_WAIT_MS = 90_000;

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** Take <proxyDir>/probe.lock; returns a release function, or null after waitMs. */
export function acquireProbeLock(dataDir, { waitMs = PROBE_LOCK_WAIT_MS, now = Date.now, sleep = sleepSync } = {}) {
  const dir = proxyDir(dataDir);
  const file = path.join(dir, 'probe.lock');
  const until = now() + waitMs;
  for (;;) {
    try {
      fs.mkdirSync(dir, { recursive: true });
      const fd = fs.openSync(file, 'wx');
      fs.writeSync(fd, JSON.stringify({ pid: process.pid, at: new Date(now()).toISOString() }));
      fs.closeSync(fd);
      return () => {
        try {
          fs.unlinkSync(file);
        } catch {
          // already gone: a waiter took it over as stale
        }
      };
    } catch (err) {
      if (err?.code !== 'EEXIST') return null;
    }
    try {
      if (now() - fs.statSync(file).mtimeMs > PROBE_LOCK_STALE_MS) {
        fs.unlinkSync(file);
        continue;
      }
    } catch {
      continue;
    }
    if (now() >= until) return null;
    sleep(250);
  }
}

export function sessionEnv({ base = process.env, account, token, proxyPort, strip = [] }) {
  const env = { ...base };
  // An API key or bearer token outranks every subscription credential in
  // Claude Code, and the other accounts' tokens have no business in this
  // session: none of them reach the child.
  for (const name of ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', ...strip]) delete env[name];
  if (token) env.CLAUDE_CODE_OAUTH_TOKEN = token;
  else delete env.CLAUDE_CODE_OAUTH_TOKEN;
  const others = String(env.ANTHROPIC_CUSTOM_HEADERS ?? '')
    .split('\n')
    .filter((line) => line.trim() && !line.toLowerCase().startsWith(`${TAG}:`));
  env.ANTHROPIC_CUSTOM_HEADERS = [...others, `${TAG}: ${account.id}`].join('\n');
  if (proxyPort && !env.ANTHROPIC_BASE_URL) env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${proxyPort}`;
  env.KAPREK_ACCOUNT = account.id;
  return env;
}

function credentials(accounts, { env, envFile, loginOrg }) {
  const tokens = new Map();
  const usable = new Set();
  const unusable = [];
  for (const a of accounts) {
    const t = resolveCredential(a, { env, envFile, loginOrg });
    if (t.usable) {
      usable.add(a.id);
      tokens.set(a.id, t.token);
    } else unusable.push(a.id);
  }
  return { tokens, usable, unusable };
}

/**
 * Probe every usable account whose reading is missing or older than
 * staleMinutes, and file what came back. An account known to be full until
 * a reset still ahead is left alone: there is nothing new to learn.
 * Returns [{id, result: 'ok' | 'auth-error' | 'none'}].
 */
export function refreshStale({ dataDir, env = process.env, envFile = defaultEnvFile(), now = Date.now(), loginOrg = loginOrgFrom(), probeFn = probeAccount, lock = acquireProbeLock } = {}) {
  const { accounts, thresholds, staleMinutes } = loadAccounts(dataDir);
  const { tokens, usable } = credentials(accounts, { env, envFile, loginOrg });
  const strip = accounts.map((a) => a.tokenEnv).filter(Boolean);
  const staleRows = () =>
    pickAccount({ accounts, usable, quotas: readQuotas(dataDir), thresholds, now, staleMs: staleMinutes * 60_000 }).rows.filter((r) => r.stale && !r.full);
  if (!staleRows().length) return [];
  const release = lock(dataDir);
  // Waited too long for another prober: pick from what is there.
  if (!release) return [];
  const probed = [];
  try {
    // Read again under the lock: whoever held it may have measured already.
    for (const row of staleRows()) {
      const id = row.account.id;
      const snap = probeFn({ env: sessionEnv({ base: env, account: row.account, token: tokens.get(id), proxyPort: null, strip }) });
      if (snap) {
        try {
          writeQuota(dataDir, snap, undefined, id);
        } catch {
          // an unwritable data dir only costs the fresh reading
        }
      }
      probed.push({ id, result: !snap ? 'none' : snap.authError ? 'auth-error' : 'ok' });
    }
  } finally {
    release();
  }
  return probed;
}

/** Load accounts, check credentials, read the windows (fresh ones with `probe`), pick, and build the env. */
export function chooseSession({ dataDir, env = process.env, envFile = defaultEnvFile(), now = Date.now(), loginOrg = loginOrgFrom(), probe = false, probeFn } = {}) {
  const probed = probe ? refreshStale({ dataDir, env, envFile, now, loginOrg, ...(probeFn ? { probeFn } : {}) }) : [];
  const { accounts, thresholds, staleMinutes } = loadAccounts(dataDir);
  const { tokens, usable, unusable } = credentials(accounts, { env, envFile, loginOrg });
  const pick = pickAccount({ accounts, usable, quotas: readQuotas(dataDir), thresholds, now, staleMs: staleMinutes * 60_000 });
  const pid = readPid(dataDir);
  const proxyPort = pid && isAlive(pid.pid) ? pid.port : null;
  const strip = accounts.map((a) => a.tokenEnv).filter(Boolean);
  const sessionEnvironment = pick.account ? sessionEnv({ base: env, account: pick.account, token: tokens.get(pick.account.id), proxyPort, strip }) : null;
  return { pick, env: sessionEnvironment, unusable, proxyPort, probed };
}
