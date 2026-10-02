// `kaprek proxy` — the pass-through for Claude Code, as its own process so
// restarting the kaprek server never cuts a running session.
//
//   kaprek proxy [start] [--port N]   run in the foreground until Ctrl+C
//   kaprek proxy status               is it running, and the last windows
//
// Point one terminal at it with  ANTHROPIC_BASE_URL=http://127.0.0.1:4911
// Undo: remove that variable. Nothing else changes.
import { createProxyServer } from '../proxy/server.mjs';
import { writePid, readPid, clearPid, isAlive, readQuota } from '../proxy/store.mjs';

export const DEFAULT_PROXY_PORT = 4911;

export function parseProxyArgs(args, env = process.env) {
  let sub = 'start';
  let port = Number.parseInt(env.KAPREK_PROXY_PORT ?? '', 10);
  if (!Number.isInteger(port)) port = DEFAULT_PROXY_PORT;
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

Relays Claude Code to api.anthropic.com unchanged and records the plan
windows and token usage it sees (never tokens or message bodies).
Use it from one terminal:  set ANTHROPIC_BASE_URL=http://127.0.0.1:${DEFAULT_PROXY_PORT}
Undo: remove ANTHROPIC_BASE_URL.`;

export async function runProxyCommand(args, { dataDir, env = process.env, log = console.log } = {}) {
  const { sub, port } = parseProxyArgs(args, env);
  if (sub === 'help') {
    log(PROXY_USAGE);
    return 1;
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
