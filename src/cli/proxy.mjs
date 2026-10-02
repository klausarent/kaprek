// `kaprek proxy` — the pass-through for Claude Code, as its own process so
// restarting the kaprek server never cuts a running session.
//
//   kaprek proxy [start] [--port N]   run in the foreground until Ctrl+C
//   kaprek proxy status               is it running, and the last windows
//   kaprek proxy autostart <install|uninstall|status>
//                                     start it at login (startup folder file
//                                     kaprek-proxy.cmd, beside kaprek.cmd)
//
// Point one terminal at it with  ANTHROPIC_BASE_URL=http://127.0.0.1:4911
// Undo: remove that variable. Nothing else changes.
import { createProxyServer } from '../proxy/server.mjs';
import { writePid, readPid, clearPid, isAlive, readQuota } from '../proxy/store.mjs';
import * as autostart from './autostart.mjs';

const AUTOSTART_ACTIONS = new Set(['install', 'uninstall', 'status']);

export const DEFAULT_PROXY_PORT = 4911;

export function parseProxyArgs(args, env = process.env) {
  let sub = 'start';
  let port = Number.parseInt(env.KAPREK_PROXY_PORT ?? '', 10);
  if (!Number.isInteger(port)) port = DEFAULT_PROXY_PORT;
  if (args[0] === 'autostart') {
    return args.length === 2 && AUTOSTART_ACTIONS.has(args[1]) ? { sub: 'autostart', action: args[1], port } : { sub: 'help', port };
  }
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === 'start' || a === 'status') sub = a;
    else if (a === '--port') {
      const p = Number.parseInt(args[++i] ?? '', 10);
      if (!Number.isInteger(p) || p < 1 || p > 65535) return { sub: 'help', port };
      port = p;
    } else return { sub: 'help', port };
  }
  return { sub, port };
}

export function proxyStatus(dataDir) {
  const pidFile = readPid(dataDir);
  return { running: Boolean(pidFile && isAlive(pidFile.pid)), pid: pidFile?.pid ?? null, port: pidFile?.port ?? null, quota: readQuota(dataDir) };
}

export const PROXY_USAGE = `Usage: kaprek proxy [start] [--port N]
       kaprek proxy status
       kaprek proxy autostart <install|uninstall|status>

Relays Claude Code to api.anthropic.com unchanged and records the plan
windows and token usage it sees (never tokens or message bodies).
Use it from one terminal:  set ANTHROPIC_BASE_URL=http://127.0.0.1:${DEFAULT_PROXY_PORT}
Undo: remove ANTHROPIC_BASE_URL.`;

export async function runProxyCommand(args, { dataDir, env = process.env, log = console.log, scriptPath = process.argv[1] } = {}) {
  const { sub, port, action } = parseProxyArgs(args, env);
  if (sub === 'help') {
    log(PROXY_USAGE);
    return 1;
  }
  if (sub === 'autostart') {
    const opts = { entry: 'kaprek-proxy', scriptPath, extraArgs: ['proxy'], noOpen: false };
    if (action === 'install') log(`wrote ${autostart.install(opts).path}`);
    else if (action === 'uninstall') {
      const r = autostart.uninstall(opts);
      log(r.removed ? `removed ${r.path}` : `nothing removed (${r.reason ?? 'not installed'}): ${r.path}`);
    } else {
      const r = autostart.status(opts);
      log(r.installed ? `installed: ${r.path}` : `not installed (would be ${r.path})`);
    }
    return 0;
  }
  if (sub === 'status') {
    const s = proxyStatus(dataDir);
    log(s.running ? `kaprek proxy runs (pid ${s.pid}, http://127.0.0.1:${s.port})` : 'kaprek proxy is not running');
    if (s.quota) for (const [name, w] of Object.entries(s.quota.windows ?? {})) log(`  ${name}: ${w.usedPercent ?? '?'} % (reset ${w.resetsAt ?? '?'}), seen ${s.quota.seenAt}`);
    return s.running ? 0 : 3;
  }
  const existing = proxyStatus(dataDir);
  if (existing.running) {
    log(`kaprek proxy already runs (pid ${existing.pid}, port ${existing.port})`);
    // Asked for another port: say so, do not pretend it is there.
    return existing.port === port ? 0 : 1;
  }
  const server = createProxyServer({ dataDir });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });
  writePid(dataDir, { pid: process.pid, port });
  log(`kaprek proxy listening on http://127.0.0.1:${port} -> https://api.anthropic.com`);
  await new Promise((resolve) => {
    const stop = () => server.close(() => resolve());
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
  });
  clearPid(dataDir);
  return 0;
}
