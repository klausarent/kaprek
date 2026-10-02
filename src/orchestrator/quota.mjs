// /api/quota: where each subscription stands and what used it.
//
// Claude: the proxy's last snapshot (live headers), else the last
// rate_limit_event a kaprek turn logged. codex: its own rollout files.
// Usage per project: the proxy's request log, joined to the cwd each
// Claude Code session reported to kaprek's session ledger.
import os from 'node:os';
import path from 'node:path';
import { readQuota, readQuotas, readRequests, readPid, isAlive } from '../proxy/store.mjs';
import { loadAccounts, resolveToken, defaultEnvFile } from '../accounts/config.mjs';
import { pickAccount } from '../accounts/pick.mjs';
import { latestCodexLimits } from './codex-limits.mjs';
import { latestRateLimits } from './usage.mjs';
import { readLedgerIndex } from '../ledger/sessions.mjs';

const WINDOW_ORDER = ['5h', '7d'];
// rate_limit_event says five_hour/seven_day, the headers say 5h/7d: one
// vocabulary for the page, whichever source answered. (Council.)
const WINDOW_ALIAS = { five_hour: '5h', seven_day: '7d' };

function sortWindows(list) {
  const named = list.map((w) => ({ ...w, name: WINDOW_ALIAS[w.name] ?? w.name }));
  const rank = (n) => (WINDOW_ORDER.includes(n) ? WINDOW_ORDER.indexOf(n) : WINDOW_ORDER.length);
  return named.sort((a, b) => rank(a.name) - rank(b.name) || a.name.localeCompare(b.name));
}

function windowsOf(snap) {
  return sortWindows(Object.entries(snap?.windows ?? {}).map(([name, w]) => ({ name, usedPercent: w?.usedPercent ?? null, resetsAt: w?.resetsAt ?? null })));
}

const BASE = { id: 'claude', limitId: null, plan: null, account: null, credential: null, next: false };

/**
 * One card per account from accounts.json (plus organizations the proxy saw
 * but no account claims), the next pick marked. Without accounts.json: the
 * single card from before.
 */
function claudeProviders(dataDir, { env, envFile, now }) {
  const { accounts, thresholds, configured } = loadAccounts(dataDir);
  if (!configured) return [claudeProvider(dataDir)];
  const quotas = readQuotas(dataDir);
  const usable = new Set();
  const credential = new Map();
  for (const a of accounts) {
    const ok = resolveToken(a, { env, envFile }).usable;
    if (ok) usable.add(a.id);
    credential.set(a.id, !ok ? 'missing' : a.tokenEnv ? 'token' : 'login');
  }
  const next = pickAccount({ accounts, usable, quotas, thresholds, now }).account?.id ?? null;
  const card = (id, label) => {
    const snap = quotas.get(id);
    return { ...BASE, label: `Claude · ${label}`, account: id, credential: credential.get(id) ?? null, next: id === next, source: snap ? 'proxy' : 'none', seenAt: snap?.seenAt ?? null, status: snap?.status ?? null, windows: windowsOf(snap) };
  };
  const cards = accounts.map((a) => card(a.id, a.label));
  for (const key of quotas.keys()) if (key !== 'unbekannt' && !accounts.some((a) => a.id === key)) cards.push(card(key, key));
  return cards;
}

function claudeProvider(dataDir) {
  const snap = readQuota(dataDir);
  if (snap?.windows) {
    return { ...BASE, label: 'Claude', source: 'proxy', seenAt: snap.seenAt ?? null, status: snap.status ?? null, windows: windowsOf(snap) };
  }
  const run = latestRateLimits(dataDir).find((u) => u.harness === 'claude-code');
  if (run?.summary?.windows?.length) {
    return { ...BASE, label: 'Claude', source: 'runs', seenAt: run.seenAt, status: run.summary.status, windows: sortWindows(run.summary.windows) };
  }
  return { ...BASE, label: 'Claude', source: 'none', seenAt: null, status: null, windows: [] };
}

function codexProvider(home) {
  const c = latestCodexLimits({ home });
  const codex = { account: null, credential: null, next: false };
  if (!c) return { id: 'codex', label: 'Codex', limitId: null, source: 'none', seenAt: null, status: null, plan: null, windows: [], ...codex };
  return { ...codex, id: 'codex', label: 'Codex', limitId: c.limitId ?? null, source: 'rollouts', seenAt: c.seenAt, status: null, plan: c.plan, windows: c.windows.map(({ name, usedPercent, resetsAt }) => ({ name, usedPercent, resetsAt })) };
}

function projectsFrom(dataDir, sinceMs) {
  const ledger = readLedgerIndex(dataDir);
  const byProject = new Map();
  let lastRequestAt = null;
  for (const r of readRequests(dataDir, { sinceMs })) {
    if (!lastRequestAt || r.ts > lastRequestAt) lastRequestAt = r.ts;
    const cwd = ledger.get(r.sessionId)?.cwd ?? null;
    const project = cwd ? path.basename(cwd) : 'unbekannt';
    const p = byProject.get(project) ?? { project, sessionIds: new Set(), requests: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, lastAt: r.ts };
    if (r.sessionId) p.sessionIds.add(r.sessionId);
    p.requests += 1;
    p.inputTokens += r.inputTokens ?? 0;
    p.outputTokens += r.outputTokens ?? 0;
    p.cacheReadTokens += r.cacheReadTokens ?? 0;
    p.cacheCreationTokens += r.cacheCreationTokens ?? 0;
    if (r.ts > p.lastAt) p.lastAt = r.ts;
    byProject.set(project, p);
  }
  const projects = [...byProject.values()]
    .map(({ sessionIds, ...rest }) => ({ ...rest, sessions: sessionIds.size }))
    .sort((a, b) => b.outputTokens + b.inputTokens - (a.outputTokens + a.inputTokens));
  return { projects, lastRequestAt };
}

export function buildQuotaReport({ dataDir, home = os.homedir(), now = Date.now, days = 7, env = process.env, envFile = defaultEnvFile(home) } = {}) {
  const pid = readPid(dataDir);
  const { projects, lastRequestAt } = projectsFrom(dataDir, now() - days * 86400000);
  return {
    generatedAt: new Date(now()).toISOString(),
    proxy: { running: Boolean(pid && isAlive(pid.pid)), port: pid?.port ?? null, lastRequestAt },
    providers: [...claudeProviders(dataDir, { env, envFile, now: now() }), codexProvider(home)],
    projects,
  };
}
