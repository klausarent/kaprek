import { describe, it, expect, beforeEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createAccountResolver, loginOrgFrom } from './accounts.mjs';
import { readOrgMap } from './store.mjs';

let dataDir;
beforeEach(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kaprek-resolver-'));
});

describe('createAccountResolver', () => {
  const make = () => createAccountResolver({ dataDir, loginOrg: 'org-login', loginAccount: 'konto1', host: 'laptop' });

  it('the /login organization is the /login account without any header', () => {
    expect(make()({ headerAccount: null, orgId: 'org-login' })).toEqual({ account: 'konto1', mismatch: null });
  });

  it('a tagged session teaches the organization, later untagged sessions use it', () => {
    const r = make();
    expect(r({ headerAccount: 'konto2', orgId: 'org-two' })).toEqual({ account: 'konto2', mismatch: null });
    expect(readOrgMap(dataDir)).toEqual({ 'org-two': 'konto2' });
    expect(r({ headerAccount: null, orgId: 'org-two' })).toEqual({ account: 'konto2', mismatch: null });
  });

  it('a session tagged konto2 that answers as konto1 is reported, not learned', () => {
    // e.g. CLAUDE_TOKEN_KONTO2 was missing and Claude Code fell back to /login.
    expect(make()({ headerAccount: 'konto2', orgId: 'org-login' })).toEqual({ account: 'konto1', mismatch: 'konto2' });
    expect(readOrgMap(dataDir)).toEqual({});
  });

  it('an unknown organization without a tag gets a stable placeholder', () => {
    expect(make()({ headerAccount: null, orgId: 'abcdef12-3456' })).toEqual({ account: 'org-abcdef12', mismatch: null });
    expect(make()({ headerAccount: null, orgId: null })).toEqual({ account: 'unbekannt', mismatch: null });
  });

  it('ignores a tag that is not an account id', () => {
    expect(make()({ headerAccount: '../etc', orgId: 'org-x1234567' })).toEqual({ account: 'org-org-x123', mismatch: null });
  });
});

describe('loginOrgFrom', () => {
  it('reads oauthAccount.organizationUuid, or null', () => {
    const file = path.join(dataDir, '.claude.json');
    fs.writeFileSync(file, JSON.stringify({ oauthAccount: { organizationUuid: 'org-login', emailAddress: 'x' } }));
    expect(loginOrgFrom(file)).toBe('org-login');
    expect(loginOrgFrom(path.join(dataDir, 'nope.json'))).toBeNull();
  });
});

describe('council fixes: resolver', () => {
  it('an exact org match beats an unbound /login account listed first', () => {
    fs.writeFileSync(path.join(dataDir, 'accounts.json'), JSON.stringify({ accounts: [{ id: 'konto1', tokenEnv: null }, { id: 'konto2', tokenEnv: null, org: 'abcd1234' }] }));
    const r = createAccountResolver({ dataDir, loginOrg: 'abcd1234-0000', host: 'laptop' });
    expect(r({ headerAccount: null, orgId: 'ABCD1234-0000' })).toEqual({ account: 'konto2', mismatch: null });
  });
  it('learns organizations in lower case', () => {
    const r = createAccountResolver({ dataDir, loginOrg: null, loginAccount: null, host: 'laptop' });
    r({ headerAccount: 'konto3', orgId: 'ABCDEF' });
    expect(r({ headerAccount: null, orgId: 'abcdef' })).toEqual({ account: 'konto3', mismatch: null });
  });
});

describe('token account bound to an organization', () => {
  it("is this machine's /login account where its organization is logged in", () => {
    fs.writeFileSync(path.join(dataDir, 'accounts.json'), JSON.stringify({ accounts: [{ id: 'konto1', tokenEnv: 'CLAUDE_TOKEN_KONTO1', org: 'abcd1234' }, { id: 'konto2', tokenEnv: 'CLAUDE_TOKEN_KONTO2', org: 'ef567890' }] }));
    const r = createAccountResolver({ dataDir, loginOrg: 'ef567890-0000', host: 'srv' });
    expect(r({ headerAccount: null, orgId: 'ef567890-0000' })).toEqual({ account: 'konto2', mismatch: null });
  });
});
