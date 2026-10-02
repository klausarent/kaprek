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
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { learnOrg, readOrgMap } from './store.mjs';
import { loadAccounts } from '../accounts/config.mjs';

const ID_RE = /^[a-z0-9][a-z0-9_-]{0,31}$/;

/** Where Claude Code keeps .claude.json: in CLAUDE_CONFIG_DIR when set, else the home dir. */
export function defaultClaudeJsonPath({ env = process.env, homedir = os.homedir() } = {}) {
  const dir = typeof env.CLAUDE_CONFIG_DIR === 'string' ? env.CLAUDE_CONFIG_DIR.trim() : '';
  return dir ? path.join(path.resolve(dir), '.claude.json') : path.join(homedir, '.claude.json');
}

export function loginOrgFrom(claudeJsonPath) {
  try {
    const org = JSON.parse(fs.readFileSync(claudeJsonPath, 'utf8'))?.oauthAccount?.organizationUuid;
    return typeof org === 'string' && org ? org : null;
  } catch {
    return null;
  }
}

export function createAccountResolver({
  dataDir,
  loginOrg = loginOrgFrom(defaultClaudeJsonPath()),
  loginAccount = loadAccounts(dataDir).accounts.find((a) => a.tokenEnv === null)?.id ?? null,
  host = os.hostname(),
} = {}) {
  const known = (orgId) => {
    const map = readOrgMap(dataDir);
    if (orgId in map) return map[orgId];
    return loginOrg && orgId === loginOrg ? loginAccount : null;
  };

  return function resolve({ headerAccount, orgId }) {
    const tag = typeof headerAccount === 'string' && ID_RE.test(headerAccount) ? headerAccount : null;
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
