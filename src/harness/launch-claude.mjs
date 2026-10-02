// `kaprek claude [args…]` — start Claude Code on the account with the most
// room left (see src/accounts/pick.mjs), in this terminal.
//
// Claude Code does all the authenticating: kaprek only sets
// CLAUDE_CODE_OAUTH_TOKEN for a `claude setup-token` account (or removes an
// inherited one for the /login account), tags the session for the proxy, and
// hands over the terminal. Ctrl+C belongs to Claude Code while it runs, so
// this process ignores SIGINT until claude exits.
import { spawn as nodeSpawn } from 'node:child_process';
import { resolveCli } from './claude-code.mjs';
import { chooseSession } from '../accounts/session.mjs';
import { defaultEnvFile } from '../accounts/config.mjs';

function pct(v) {
  return v === null || v === undefined ? '–' : `${v} %`;
}

export async function launchClaude(args, { dataDir, env = process.env, envFile = defaultEnvFile(), now = Date.now(), spawnFn = nodeSpawn, log = console.error } = {}) {
  const session = chooseSession({ dataDir, env, envFile, now });
  const { pick } = session;
  if (!session.env) {
    if (pick.exhausted) log(`kaprek: alle Claude-Konten voll. Frühestens frei: ${pick.retryAt ?? 'unbekannt'}`);
    else log('kaprek: kein Claude-Konto nutzbar (Token fehlen?). `kaprek accounts` zeigt Details.');
    return pick.exhausted ? 4 : 5;
  }
  const load = pick.load ?? {};
  log(
    `kaprek: Claude auf ${pick.account.label} (${pick.account.id}) · 5h ${pct(load.fiveHour)} · 7d ${pct(load.sevenDay)}` +
      `${pick.overThreshold ? ' · über der Schwelle, alle anderen voller' : ''}` +
      `${session.proxyPort ? ` · über Proxy :${session.proxyPort}` : ' · ohne Proxy'}`,
  );
  const { command, useShell } = resolveCli(session.env);
  const ignore = () => {};
  process.on('SIGINT', ignore);
  try {
    return await new Promise((resolve) => {
      let child;
      try {
        child = spawnFn(command, args, { stdio: 'inherit', env: session.env, shell: useShell });
      } catch (err) {
        log(`kaprek: claude ließ sich nicht starten: ${err.message}`);
        resolve(1);
        return;
      }
      child.on('error', (err) => {
        log(`kaprek: claude ließ sich nicht starten: ${err.message}`);
        resolve(1);
      });
      child.on('exit', (code) => resolve(code ?? 1));
    });
  } finally {
    process.off('SIGINT', ignore);
  }
}
