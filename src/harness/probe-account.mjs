// A fresh reading of one account's plan windows, for when the last one is
// old or missing.
//
// The windows are only known from answers: the proxy sees them when a
// session runs through it, the bridge watcher after each of its runs, a
// kaprek turn after it ends. Everything else on the same subscription (a
// terminal on the laptop, Paperclip's agents on the server) uses it unseen,
// so a reading from this morning says little about now — on 24.10.2026
// konto3 read 23 % from 12:01 and was at 100 % by 14:15.
//
// The probe is one Claude Code turn on that account: haiku, no tools, no
// settings files (so no hooks), no MCP servers, nothing persisted, from an
// empty directory. Claude Code reports the windows as a rate_limit_event
// before the answer. A full account is rejected at no cost; one with room
// costs about 11k haiku cache tokens and three seconds. /api/oauth/usage
// would be free, but a `claude setup-token` token lacks its user:profile
// scope (403, tried 24.10.2026).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { resolveCli } from './claude-code.mjs';

const ALIASES = { five_hour: '5h', seven_day: '7d' };
const AUTH_RE = /OAuth token (has )?expired|authentication_error|invalid bearer token|invalid x-api-key|Please run \/login|Not logged in/i;

function isoOf(raw) {
  const n = Number.parseFloat(raw);
  if (!Number.isFinite(n) || n <= 0) return null;
  return new Date(n < 1e11 ? n * 1000 : n).toISOString();
}

/**
 * Claude Code's rate_limit_info as a quota snapshot (the proxy's shape), or
 * null when it names no window. A rejection without window data marks the
 * binding window full until its reset.
 */
export function snapshotFromRateLimit(info, { seenAt = new Date().toISOString(), source = null } = {}) {
  if (!info || typeof info !== 'object') return null;
  const windows = {};
  for (const [name, w] of Object.entries(info.unifiedWindows ?? {})) {
    if (!w || typeof w !== 'object') continue;
    const u = Number(w.utilization);
    windows[ALIASES[name] ?? name] = { usedPercent: Number.isFinite(u) && u >= 0 ? Math.round(u * 100) : null, resetsAt: isoOf(w.resetsAt) };
  }
  if (Object.keys(windows).length === 0 && info.status === 'rejected' && typeof info.rateLimitType === 'string') {
    windows[ALIASES[info.rateLimitType] ?? info.rateLimitType] = { usedPercent: 100, resetsAt: isoOf(info.resetsAt) };
  }
  if (Object.keys(windows).length === 0) return null;
  return { seenAt, status: typeof info.status === 'string' ? info.status : null, windows, ...(source ? { source } : {}) };
}

export function probeDir() {
  return path.join(os.tmpdir(), 'kaprek-probe');
}

/**
 * One probe turn under `env` (the session environment of the account, see
 * sessionEnv). Returns a snapshot, an auth-error snapshot, or null when the
 * probe said nothing usable (network down, CLI missing).
 */
export function probeAccount({ env, cwd = probeDir(), spawnFn = spawnSync, timeoutMs = 60_000, now = Date.now } = {}) {
  const { command, useShell } = resolveCli(env);
  try {
    fs.mkdirSync(cwd, { recursive: true });
  } catch {
    return null;
  }
  // `--tools ""` turns every tool off; through cmd.exe the empty argument
  // has to be spelled out or it vanishes.
  const args = ['-p', '--model', 'haiku', '--output-format', 'stream-json', '--verbose', '--max-turns', '1', '--setting-sources', 'project', '--strict-mcp-config', '--tools', useShell ? '""' : '', '--no-session-persistence', '--disable-slash-commands'];
  let r;
  try {
    r = spawnFn(command, args, { cwd, env, input: 'Antworte nur mit: ok', encoding: 'utf8', timeout: timeoutMs, shell: useShell, windowsHide: true, maxBuffer: 4 * 1024 * 1024 });
  } catch {
    return null;
  }
  const out = String(r?.stdout ?? '');
  let info = null;
  for (const line of out.split('\n')) {
    if (!line.includes('"rate_limit_event"')) continue;
    try {
      const obj = JSON.parse(line);
      if (obj?.type === 'rate_limit_event' && obj.rate_limit_info) info = obj.rate_limit_info;
    } catch {
      // a torn line: the next one may still carry the windows
    }
  }
  const seenAt = new Date(now()).toISOString();
  const snap = snapshotFromRateLimit(info, { seenAt, source: 'probe' });
  if (snap) return snap;
  if (AUTH_RE.test(`${out}\n${r?.stderr ?? ''}`)) return { seenAt, status: 'auth-error', authError: true, windows: {}, source: 'probe' };
  return null;
}
