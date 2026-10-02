// `kaprek accounts` — which Claude account the next session runs on.
//
//   kaprek accounts              every account, its windows, the next pick
//   kaprek accounts pick --json  {id, label, tokenEnv, exhausted, retryAt, …}
//                                for scripts such as the bridge watcher; the
//                                token itself is never printed — the caller
//                                reads the variable named in tokenEnv.
//   Exit codes of pick: 0 an account, 4 every account full, 5 none usable.
import { loadAccounts, resolveCredential, defaultEnvFile, loginOrgFrom } from '../accounts/config.mjs';
import { pickAccount, accountLoad } from '../accounts/pick.mjs';
import { readQuotas } from '../proxy/store.mjs';

export const ACCOUNTS_USAGE = `Usage: kaprek accounts
       kaprek accounts pick [--json]

Accounts are listed in <dataDir>/accounts.json, e.g.
  {"accounts": [{"id": "konto1", "label": "Konto 1", "tokenEnv": null},
                {"id": "konto2", "label": "Konto 2", "tokenEnv": "CLAUDE_TOKEN_KONTO2"}]}
tokenEnv null = the /login account; otherwise the variable (environment or
~/.env) holding a token from \`claude setup-token\`. "org": "<org id prefix>"
binds a /login account to one organization, for a data dir shared between
machines logged in to different accounts.`;

function pct(v) {
  return v === null || v === undefined ? '–' : `${v} %`;
}

export async function runAccountsCommand(args, { dataDir, env = process.env, envFile = defaultEnvFile(), log = console.log, now = Date.now(), loginOrg = loginOrgFrom() } = {}) {
  const sub = args[0] ?? 'list';
  const json = args.includes('--json');
  if (!['list', 'pick'].includes(sub) || (sub === 'list' && args.length > 0 && args[0] !== 'list')) {
    log(ACCOUNTS_USAGE);
    return 1;
  }
  const { accounts, thresholds, configured } = loadAccounts(dataDir);
  const quotas = readQuotas(dataDir);
  const usable = new Set();
  const viaToken = new Set();
  const missing = new Map();
  for (const a of accounts) {
    const c = resolveCredential(a, { env, envFile, loginOrg });
    if (c.usable) usable.add(a.id);
    if (c.token) viaToken.add(a.id);
    else missing.set(a.id, c.reason === 'other-login' ? `anderer Login (Org ${a.org}…)` : `kein Token (${a.tokenEnv})`);
  }
  const pick = pickAccount({ accounts, usable, quotas, thresholds, now });

  if (sub === 'pick') {
    const out = {
      id: pick.account?.id ?? null,
      label: pick.account?.label ?? null,
      // How THIS machine reaches the account: null when it is the local /login.
      tokenEnv: pick.account && viaToken.has(pick.account.id) ? pick.account.tokenEnv : null,
      exhausted: pick.exhausted,
      overThreshold: Boolean(pick.overThreshold),
      retryAt: pick.retryAt ?? null,
      reason: pick.reason ?? null,
      load: pick.load ?? null,
    };
    if (json) log(JSON.stringify(out));
    else log(out.id ? `${out.id} (${out.label})` : `kein Konto frei${out.retryAt ? ` bis ${out.retryAt}` : ''}`);
    return out.id ? 0 : pick.exhausted ? 4 : 5;
  }

  if (!configured) log('Kein accounts.json — nur das /login-Konto. Siehe `kaprek accounts --help`.');
  for (const a of accounts) {
    const load = accountLoad(quotas.get(a.id), now);
    const seen = quotas.get(a.id)?.seenAt;
    const cred = missing.has(a.id) ? missing.get(a.id) : viaToken.has(a.id) ? `Token ${a.tokenEnv}` : '/login';
    log(`${a.id.padEnd(10)} ${a.label.padEnd(12)} 5h ${pct(load.fiveHour).padStart(5)}  7d ${pct(load.sevenDay).padStart(5)}  ${cred}${seen ? `  Stand ${seen}` : '  noch nie gemessen'}`);
  }
  if (pick.account) log(`Nächste Session: ${pick.account.id}${pick.overThreshold ? ' (über der Schwelle, aber nicht voll)' : ''}`);
  else log(pick.exhausted ? `Alle Konten voll. Frühestens frei: ${pick.retryAt ?? 'unbekannt'}` : 'Kein Konto nutzbar.');
  return 0;
}
