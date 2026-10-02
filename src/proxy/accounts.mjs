// Which account answered a request.
//
// Every response carries `anthropic-organization-id`, and each Claude
// subscription is its own organization. kaprek tags the sessions it starts
// with `x-kaprek-account: <id>` (stripped before forwarding); the first
// tagged answer teaches the proxy which organization that account is, and
// untagged sessions — a plain `claude` in a terminal — are recognised by it
// afterwards. The /login account is known from ~/.claude.json up front.
//
// A tag that disagrees with an organization already known (CLAUDE_TOKEN_KONTO2
// missing, so Claude Code fell back to /login) is reported as a mismatch and
// never learned: a wrong mapping would mislabel that account for good.
import os from 'node:os';
import { learnOrg, readOrgMap } from './store.mjs';
import { loadAccounts, defaultClaudeJsonPath, loginOrgFrom } from '../accounts/config.mjs';

const ID_RE = /^[a-z0-9][a-z0-9_-]{0,31}$/;

export { defaultClaudeJsonPath, loginOrgFrom };

/** This machine's /login account: an exact org binding first, else the first unbound /login account. */
function pickLoginAccount(accounts, loginOrg) {
  const login = loginOrg ? String(loginOrg).toLowerCase() : null;
  // Any account bound to the logged-in organization (with or without a token
  // for other machines) first, else the first unbound /login account.
  return (login && accounts.find((a) => a.org && login.startsWith(a.org)))?.id ?? accounts.find((a) => a.tokenEnv === null && !a.org)?.id ?? null;
}

export function createAccountResolver({
  dataDir,
  loginOrg = loginOrgFrom(defaultClaudeJsonPath()),
  // The /login account of THIS machine: bound to its organization when
  // accounts.json says so, else the first /login account.
  loginAccount = pickLoginAccount(loadAccounts(dataDir).accounts, loginOrg),
  host = os.hostname(),
} = {}) {
  const login = loginOrg ? String(loginOrg).toLowerCase() : null;
  const known = (orgId) => {
    const map = readOrgMap(dataDir);
    if (orgId in map) return map[orgId];
    return login && String(orgId).toLowerCase() === login ? loginAccount : null;
  };

  return function resolve({ headerAccount, orgId: rawOrg }) {
    const tag = typeof headerAccount === 'string' && ID_RE.test(headerAccount) ? headerAccount : null;
    const orgId = rawOrg ? String(rawOrg).toLowerCase() : null;
    if (!orgId) return { account: tag ?? 'unbekannt', mismatch: null };
    const mapped = known(orgId);
    if (tag) {
      if (mapped && mapped !== tag) return { account: mapped, mismatch: tag };
      if (!mapped) {
        try {
          learnOrg(dataDir, orgId, tag, host);
        } catch {
          // an unwritable data dir must not break the session
        }
      }
      return { account: tag, mismatch: null };
    }
    return { account: mapped ?? `org-${String(orgId).slice(0, 8)}`, mismatch: null };
  };
}
