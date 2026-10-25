// `kaprek accounts` — which Claude account the next session runs on.
//
//   kaprek accounts              every account, its windows, the next pick
//   kaprek accounts pick --json  {id, label, tokenEnv, exhausted, retryAt, …}
//                                for scripts such as the bridge watcher; the
//                                token itself is never printed — the caller
//                                reads the variable named in tokenEnv.
//   kaprek accounts [pick] --probe
//                                first measure every account whose reading
//                                is missing or older than staleMinutes
//                                (src/harness/probe-account.mjs), then list/pick.
//   Exit codes of pick: 0 an account, 4 every account full, 5 none usable.
//   kaprek accounts exec [--probe] -- <command> [args…]
//                                run <command> on the picked account and file
//                                the windows it reports (src/harness/account-exec.mjs);
//                                Paperclip's agentCommand for claude-agent-acp.
//                                stdout belongs to the command: notes go to stderr.
import { loadAccounts, resolveCredential, defaultEnvFile, loginOrgFrom } from '../accounts/config.mjs';
import { pickAccount, accountLoad } from '../accounts/pick.mjs';
import { refreshStale } from '../accounts/session.mjs';
import { readQuotas } from '../proxy/store.mjs';
import { execWithAccount } from '../harness/account-exec.mjs';

export const ACCOUNTS_USAGE = `Usage: kaprek accounts [--probe]
       kaprek accounts pick [--json] [--probe]
       kaprek accounts exec [--probe] -- <command> [args…]

Accounts are listed in <dataDir>/accounts.json, e.g.
  {"accounts": [{"id": "konto1", "label": "Konto 1", "tokenEnv": null},
                {"id": "konto2", "label": "Konto 2", "tokenEnv": "CLAUDE_TOKEN_KONTO2"}]}
tokenEnv null = the /login account; otherwise the variable (environment or
~/.env) holding a token from \`claude setup-token\`. "org": "<org id prefix>"
binds a /login account to one organization, for a data dir shared between
machines logged in to different accounts. --probe measures stale accounts
with one tiny haiku turn each before answering. exec starts the command on
the picked account (on the /login when none is free) and files the rate
limits and limit failures it reports.`;

function pct(v) {
  return v === null || v === undefined ? '–' : `${v} %`;
}

export async function runAccountsCommand(args, { dataDir, env = process.env, envFile = defaultEnvFile(), log = console.log, now = Date.now(), loginOrg = loginOrgFrom(), probeFn, execFn = execWithAccount, errorLog = (l) => process.stderr.write(`${l}\n`) } = {}) {
  if (args[0] === 'exec') {
    const sep = args.indexOf('--');
    const flags = sep === -1 ? args.slice(1) : args.slice(1, sep);
    const command = sep === -1 ? [] : args.slice(sep + 1);
    if (!command.length || flags.some((f) => f !== '--probe')) {
      errorLog(ACCOUNTS_USAGE);
      return 1;
    }
    return execFn(command[0], command.slice(1), { dataDir, env, envFile, loginOrg, probe: flags.includes('--probe'), ...(probeFn ? { probeFn } : {}) });
  }
  const positional = args.filter((a) => !a.startsWith('--'));
  const flags = args.filter((a) => a.startsWith('--'));
  const sub = positional[0] ?? 'list';
  const json = flags.includes('--json');
  const probe = flags.includes('--probe');
  if (!['list', 'pick'].includes(sub) || positional.length > 1 || flags.some((f) => !['--json', '--probe'].includes(f))) {
    log(ACCOUNTS_USAGE);
    return 1;
  }
  const probed = probe ? refreshStale({ dataDir, env, envFile, now, loginOrg, ...(probeFn ? { probeFn } : {}) }) : [];
  const { accounts, thresholds, staleMinutes, configured } = loadAccounts(dataDir);
  const quotas = readQuotas(dataDir);
  const usable = new Set();
  const viaToken = new Set();
  const missing = new Map();
  for (const a of accounts) {
    const c = resolveCredential(a, { env, envFile, loginOrg });
    if (c.token) viaToken.add(a.id);
    if (c.usable) usable.add(a.id);
    else missing.set(a.id, c.reason === 'other-login' ? `anderer Login (Org ${a.org}…)` : `kein Token (${a.tokenEnv})`);
  }
  const pick = pickAccount({ accounts, usable, quotas, thresholds, now, staleMs: staleMinutes * 60_000 });

  if (sub === 'pick') {
    const out = {
      id: pick.account?.id ?? null,
      label: pick.account?.label ?? null,
      // How THIS machine reaches the account: null when it is the local /login.
      tokenEnv: pick.account && viaToken.has(pick.account.id) ? pick.account.tokenEnv : null,
      exhausted: pick.exhausted,
      overThreshold: Boolean(pick.overThreshold),
      unmeasured: Boolean(pick.unmeasured),
      retryAt: pick.retryAt ?? null,
      reason: pick.reason ?? null,
      load: pick.load ?? null,
      probed,
    };
    if (json) log(JSON.stringify(out));
    else log(out.id ? `${out.id} (${out.label})` : `kein Konto frei${out.retryAt ? ` bis ${out.retryAt}` : ''}`);
    return out.id ? 0 : pick.exhausted ? 4 : 5;
  }

  if (!configured) log('Kein accounts.json — nur das /login-Konto. Siehe `kaprek accounts --help`.');
  for (const a of accounts) {
    const snap = quotas.get(a.id);
    const load = accountLoad(snap, now);
    const seen = snap?.seenAt;
    const old = seen && now - Date.parse(seen) > staleMinutes * 60_000 ? ' (alt)' : '';
    const cred = missing.has(a.id) ? missing.get(a.id) : viaToken.has(a.id) ? `Token ${a.tokenEnv}` : '/login';
    const auth = snap?.authError ? '  Auth-Fehler' : snap?.status === 'rejected' ? '  abgelehnt' : '';
    log(`${a.id.padEnd(10)} ${a.label.padEnd(12)} 5h ${pct(load.fiveHour).padStart(5)}  7d ${pct(load.sevenDay).padStart(5)}  ${cred}${auth}${seen ? `  Stand ${seen}${old}` : '  noch nie gemessen'}`);
  }
  if (probed.length) log(`Gemessen: ${probed.map((p) => `${p.id} ${p.result}`).join(', ')}`);
  if (pick.account) log(`Nächste Session: ${pick.account.id}${pick.overThreshold ? ' (über der Schwelle, aber nicht voll)' : pick.unmeasured ? ' (noch nie gemessen)' : ''}`);
  else log(pick.exhausted ? `Alle Konten voll. Frühestens frei: ${pick.retryAt ?? 'unbekannt'}` : 'Kein Konto nutzbar.');
  return 0;
}
