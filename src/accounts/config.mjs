// Which Claude accounts kaprek may start sessions on.
//
// <dataDir>/accounts.json names them; it holds no secrets. An account is
// either the /login credential of the Claude config dir (tokenEnv: null) or
// a long-lived token from `claude setup-token`, read at launch time from the
// named environment variable or from ~/.env. The token is handed to Claude
// Code as CLAUDE_CODE_OAUTH_TOKEN and never logged, stored or forwarded by
// kaprek itself.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const DEFAULT_THRESHOLDS = { fiveHour: 90, sevenDay: 95, full: 99 };
const ID_RE = /^[a-z0-9][a-z0-9_-]{0,31}$/;
const ENV_NAME_RE = /^[A-Z_][A-Z0-9_]*$/;

export function accountsPath(dataDir) {
  return path.join(dataDir, 'accounts.json');
}

function percent(value, fallback) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 && value <= 100 ? value : fallback;
}

export function loadAccounts(dataDir) {
  const fallback = { thresholds: { ...DEFAULT_THRESHOLDS }, accounts: [{ id: 'konto1', label: 'Konto 1', tokenEnv: null }], configured: false };
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(accountsPath(dataDir), 'utf8'));
  } catch {
    return fallback;
  }
  const seen = new Set();
  const accounts = [];
  for (const a of Array.isArray(raw?.accounts) ? raw.accounts : []) {
    if (!a || typeof a.id !== 'string' || !ID_RE.test(a.id) || seen.has(a.id)) continue;
    const tokenEnv = a.tokenEnv === null || a.tokenEnv === undefined ? null : a.tokenEnv;
    if (tokenEnv !== null && (typeof tokenEnv !== 'string' || !ENV_NAME_RE.test(tokenEnv))) continue;
    seen.add(a.id);
    accounts.push({ id: a.id, label: typeof a.label === 'string' && a.label.trim() ? a.label.trim() : a.id, tokenEnv });
  }
  if (accounts.length === 0) return fallback;
  const t = raw?.thresholds ?? {};
  return {
    thresholds: {
      fiveHour: percent(t.fiveHour, DEFAULT_THRESHOLDS.fiveHour),
      sevenDay: percent(t.sevenDay, DEFAULT_THRESHOLDS.sevenDay),
      full: percent(t.full, DEFAULT_THRESHOLDS.full),
    },
    accounts,
    configured: true,
  };
}

/** KEY=VALUE lines of a dotenv file. Comments, `export ` prefixes, CRLF and surrounding quotes are dropped. */
export function parseEnvFile(text) {
  const out = {};
  for (const rawLine of String(text).split('\n')) {
    const line = rawLine.replace(/\r$/, '').trim();
    if (!line || line.startsWith('#')) continue;
    const m = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line);
    if (!m) continue;
    let value = m[2].trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    out[m[1]] = value;
  }
  return out;
}

export function defaultEnvFile(home = os.homedir()) {
  return path.join(home, '.env');
}

/**
 * The credential for one account. `token: null, usable: true` is the /login
 * credential; a named variable that is empty everywhere makes it unusable.
 */
export function resolveToken(account, { env = process.env, envFile = defaultEnvFile() } = {}) {
  if (!account?.tokenEnv) return { usable: true, token: null };
  const clean = (v) => (typeof v === 'string' ? v.replace(/[\r\n]/g, '').trim().replace(/^["']|["']$/g, '') : '');
  let token = clean(env[account.tokenEnv]);
  if (!token && envFile) {
    try {
      token = clean(parseEnvFile(fs.readFileSync(envFile, 'utf8'))[account.tokenEnv]);
    } catch {
      token = '';
    }
  }
  return token ? { usable: true, token } : { usable: false, token: null };
}
