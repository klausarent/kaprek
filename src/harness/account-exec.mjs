// `kaprek accounts exec [--probe] -- <command> [args…]` — run an agent process
// (Paperclip's claude-agent-acp, 25.10.2026) on the Claude account with the
// most room left, and file what the run learns about that account.
//
// The pick and the environment come from chooseSession (src/accounts/session.mjs):
// CLAUDE_CODE_OAUTH_TOKEN for a token account, the /login for the login
// account. If kaprek cannot pick (every account full, broken accounts.json),
// the command still starts on the inherited environment, i.e. the /login:
// a run on a full account fails in seconds, a run that never starts is lost.
//
// stdin and stdout are relayed byte for byte (they carry the ACP JSON-RPC
// stream); stderr is inherited, and kaprek's own notes go there. While
// relaying, every stdout line that carries one of claude-agent-acp's markers
// is read:
//   _claude/rateLimit                  the account's windows → quota file
//   jetbrains.air.sessionFailure       category 'limit' without actions
//                                      (quota_exhausted) → filed 'rejected',
//                                      so the next run (and Paperclip's own
//                                      retry) picks another account;
//                                      category 'access' → filed auth-error.
import { spawn as nodeSpawn } from 'node:child_process';
import { chooseSession } from '../accounts/session.mjs';
import { defaultEnvFile, loginOrgFrom } from '../accounts/config.mjs';
import { readQuotas, writeQuota, isAlive } from '../proxy/store.mjs';
import { snapshotFromRateLimit } from './probe-account.mjs';

const RATE_KEY = '_claude/rateLimit';
const FAILURE_KEY = 'sessionFailure';
// A run streams a rate-limit reading with every model answer; the file needs one now and then.
const WRITE_EVERY_MS = 15_000;
const PARENT_CHECK_MS = 5_000;

function findKey(obj, key, depth = 0) {
  if (!obj || typeof obj !== 'object' || depth > 8) return undefined;
  if (Object.prototype.hasOwnProperty.call(obj, key)) return obj[key];
  for (const v of Object.values(obj)) {
    const hit = findKey(v, key, depth + 1);
    if (hit !== undefined) return hit;
  }
  return undefined;
}

/**
 * What one stdout line says about the account: [] for almost every line.
 * Only lines carrying a marker are parsed, so the relay stays cheap for the
 * large tool results that pass through.
 */
export function scanLine(line) {
  const hasRate = line.includes(RATE_KEY);
  const hasFailure = line.includes(FAILURE_KEY);
  if (!hasRate && !hasFailure) return [];
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return [];
  }
  const events = [];
  const info = hasRate ? findKey(msg, RATE_KEY) : undefined;
  if (info && typeof info === 'object') events.push({ type: 'rate', info });
  const failure = hasFailure ? findKey(findKey(msg, 'air'), FAILURE_KEY) : undefined;
  if (failure && typeof failure === 'object' && failure.severity === 'error') {
    const actions = Array.isArray(failure.actions) ? failure.actions : [];
    // limit + no actions = quota_exhausted; budget/context limits offer a new session, a 429 a retry.
    if (failure.category === 'limit' && actions.length === 0) events.push({ type: 'limit', title: String(failure.title ?? '') });
    if (failure.category === 'access') events.push({ type: 'auth', title: String(failure.title ?? '') });
  }
  return events;
}

/** Files readings for one account; rate readings at most every WRITE_EVERY_MS, verdicts at once. */
export function quotaRecorder({ dataDir, accountId, now = Date.now, write = writeQuota, read = readQuotas }) {
  let pending = null;
  let lastWrite = -Infinity;
  let lastWindows = null;
  let verdict = false;
  const file = (snap) => {
    try {
      write(dataDir, snap, undefined, accountId);
    } catch {
      // an unwritable data dir only costs the reading
    }
  };
  const flush = () => {
    if (pending && !verdict) file(pending);
    if (pending) lastWrite = now();
    pending = null;
  };
  return {
    event(e) {
      const seenAt = new Date(now()).toISOString();
      if (e.type === 'rate') {
        const snap = snapshotFromRateLimit(e.info, { seenAt, source: 'exec' });
        if (!snap) return;
        lastWindows = snap.windows;
        if (snap.status === 'rejected') {
          file(snap);
          verdict = true;
          pending = null;
          return;
        }
        // A model answer after a verdict: the account works again.
        verdict = false;
        pending = snap;
        if (now() - lastWrite >= WRITE_EVERY_MS) flush();
        return;
      }
      if (e.type === 'limit') {
        let windows = lastWindows;
        if (!windows) {
          try {
            windows = read(dataDir).get(accountId)?.windows ?? {};
          } catch {
            windows = {};
          }
        }
        file({ seenAt, status: 'rejected', windows, source: 'exec' });
        verdict = true;
        pending = null;
        return;
      }
      if (e.type === 'auth') {
        file({ seenAt, status: 'auth-error', authError: true, windows: {}, source: 'exec' });
        verdict = true;
        pending = null;
      }
    },
    flush,
  };
}

function pct(v) {
  return v === null || v === undefined ? '–' : `${v} %`;
}

function choose({ dataDir, env, envFile, loginOrg, probe, probeFn, now, log }) {
  try {
    return chooseSession({ dataDir, env, envFile, now, loginOrg, probe, ...(probeFn ? { probeFn } : {}) });
  } catch (err) {
    log(`kaprek: Kontowahl gescheitert (${err.message}), Start mit dem /login`);
    return null;
  }
}

export async function execWithAccount(command, args, {
  dataDir,
  env = process.env,
  envFile = defaultEnvFile(),
  loginOrg = loginOrgFrom(),
  probe = false,
  probeFn,
  now = Date.now,
  spawnFn = nodeSpawn,
  stdin = process.stdin,
  stdout = process.stdout,
  log = (l) => process.stderr.write(`${l}\n`),
  parentPid = process.ppid,
  alive = isAlive,
  parentCheckMs = PARENT_CHECK_MS,
} = {}) {
  const session = choose({ dataDir, env, envFile, loginOrg, probe, probeFn, now: now(), log });
  const pick = session?.pick;
  const accountId = session?.env ? pick.account.id : null;
  if (accountId) {
    const load = pick.load ?? {};
    log(`kaprek: ${pick.account.id} (${pick.account.label}) · 5h ${pct(load.fiveHour)} · 7d ${pct(load.sevenDay)}${pick.overThreshold ? ' · über der Schwelle, alle anderen voller' : ''}${session.probed?.length ? ` · gemessen: ${session.probed.map((p) => `${p.id} ${p.result}`).join(', ')}` : ''}`);
  } else if (session) {
    log(pick?.exhausted ? `kaprek: alle Konten voll (frühestens frei ${pick.retryAt ?? 'unbekannt'}), Start mit dem /login` : 'kaprek: kein Konto nutzbar, Start mit dem /login');
  }
  const childEnv = session?.env ?? env;
  const recorder = accountId ? quotaRecorder({ dataDir, accountId, now }) : null;

  return await new Promise((resolve) => {
    let child;
    let settled = false;
    let timer = null;
    const signals = ['SIGINT', 'SIGTERM', 'SIGBREAK', 'SIGHUP'];
    const forward = (sig) => {
      try {
        child?.kill(sig);
      } catch {
        // already gone
      }
    };
    const onEnd = () => {
      try {
        child?.stdin?.end();
      } catch {
        // already closed
      }
    };
    const done = (code) => {
      if (settled) return;
      settled = true;
      if (timer) clearInterval(timer);
      for (const s of signals) process.off(s, forward);
      stdin.off?.('end', onEnd);
      if (child?.stdin) stdin.unpipe?.(child.stdin);
      stdin.pause?.();
      // process.stdin as a pipe would keep the event loop (and this process) alive.
      stdin.unref?.();
      recorder?.flush();
      resolve(code);
    };
    try {
      // .cmd/.bat shims only start through cmd.exe on Windows.
      child = spawnFn(command, args, { env: childEnv, stdio: ['pipe', 'pipe', 'inherit'], shell: /\.(cmd|bat)$/i.test(command), windowsHide: true });
    } catch (err) {
      log(`kaprek: ${command} ließ sich nicht starten: ${err.message}`);
      done(1);
      return;
    }
    for (const s of signals) process.on(s, forward);
    child.on('error', (err) => {
      log(`kaprek: ${command} ließ sich nicht starten: ${err.message}`);
      done(1);
    });
    // 'close', not 'exit': only then has the last stdout chunk been relayed.
    child.on('close', (code, signal) => done(code ?? (signal ? 1 : 0)));

    child.stdin?.on('error', () => {});
    // Our reader is gone: the agent has nobody left to talk to.
    stdout.on?.('error', () => forward('SIGTERM'));
    stdin.pipe(child.stdin);
    stdin.on('end', onEnd);

    let rest = '';
    child.stdout.on('data', (chunk) => {
      if (!recorder) return;
      const text = rest + chunk.toString('utf8');
      const lines = text.split('\n');
      rest = lines.pop() ?? '';
      // A line that never ends (one huge tool result) is not worth holding on to.
      if (rest.length > 8 * 1024 * 1024) rest = '';
      for (const line of lines) for (const e of scanLine(line)) recorder.event(e);
    });
    child.stdout.pipe(stdout, { end: false });

    // Whoever started us died without ending stdin (a hard kill on Windows does
    // not reach grandchildren): take the agent down with us.
    if (parentPid) {
      timer = setInterval(() => {
        if (!alive(parentPid)) forward('SIGTERM');
      }, parentCheckMs);
      timer.unref?.();
    }
  });
}
