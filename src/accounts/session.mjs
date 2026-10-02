// The environment a Claude Code session starts with, for the account
// pickAccount chose. Claude Code itself does the authenticating:
// CLAUDE_CODE_OAUTH_TOKEN for a `claude setup-token` account, nothing (and
// no inherited token) for the /login account. The tag lets the proxy file the
// windows under the right account; the base URL points at the proxy only
// when one is running and nobody set a base URL on purpose.
import { loadAccounts, resolveCredential, defaultEnvFile, loginOrgFrom } from './config.mjs';
import { pickAccount } from './pick.mjs';
import { readQuotas, readPid, isAlive } from '../proxy/store.mjs';

const TAG = 'x-kaprek-account';

export function sessionEnv({ base = process.env, account, token, proxyPort }) {
  const env = { ...base };
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

/** Load accounts, check credentials, read the windows, pick, and build the env. */
export function chooseSession({ dataDir, env = process.env, envFile = defaultEnvFile(), now = Date.now(), loginOrg = loginOrgFrom() } = {}) {
  const { accounts, thresholds } = loadAccounts(dataDir);
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
  const pick = pickAccount({ accounts, usable, quotas: readQuotas(dataDir), thresholds, now });
  const pid = readPid(dataDir);
  const proxyPort = pid && isAlive(pid.pid) ? pid.port : null;
  const sessionEnvironment = pick.account ? sessionEnv({ base: env, account: pick.account, token: tokens.get(pick.account.id), proxyPort }) : null;
  return { pick, env: sessionEnvironment, unusable, proxyPort };
}
