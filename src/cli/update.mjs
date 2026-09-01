// `kaprek update` — the one command that is allowed to talk to the internet.
//
// Everything else in kaprek stays on this machine; asking npm which version
// exists obviously cannot. That is stated out loud when it happens rather
// than done quietly, and it happens only when someone typed `update`. There
// is no background check on start: a tool that phones home every time it
// boots is a tool nobody can reason about, and the one thing it would buy is
// a line you can get by asking for it.
//
// THE HARD PART is not fetching a version number, it is knowing what to do
// with it. kaprek can be running as a global install, through npx (no
// install at all), as a dependency of some other project, or straight out of
// a git clone. Only one of those can be updated by `npm i -g`, and running
// that in the other three is somewhere between useless and destructive.
import https from 'node:https';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { askInstance } from '../lib/instance-lock.mjs';
import { gitExec } from '../lib/git-exec.mjs';

const REGISTRY_URL = 'https://registry.npmjs.org/kaprek/latest';

/**
 * The way out when anything about the update goes wrong.
 *
 * It works from every situation this command can end up in: no npm on PATH,
 * a global install the user cannot write to, a registry that did not answer,
 * an npx run with nothing installed. It fetches and runs the newest version
 * without installing anything, so it is also the answer for someone who does
 * not want a global install in the first place.
 */
export const FALLBACK_COMMAND = 'npx kaprek@latest';

/** How this copy of kaprek got onto the machine. */
export const INSTALL_KINDS = ['global', 'npx', 'local', 'repo'];

/**
 * Works out how kaprek is running from the path it is running from.
 *
 * @param {string} packageRoot - the directory containing package.json
 * @param {object} [env]
 * @returns {'global'|'npx'|'local'|'repo'}
 */
export function installKind(packageRoot, env = process.env) {
  const normalized = packageRoot.split(path.sep).join('/').toLowerCase();
  // npx unpacks into a cache directory named _npx. Nothing to update there —
  // the next `npx kaprek@latest` fetches whatever is newest anyway.
  if (normalized.includes('/_npx/')) return 'npx';
  if (!normalized.includes('/node_modules/')) return 'repo';
  // A global install lives under the npm prefix; anything else under
  // node_modules is a dependency of some project.
  const prefix = (env.npm_config_prefix ?? env.APPDATA ?? '').split(path.sep).join('/').toLowerCase();
  if (prefix && normalized.startsWith(prefix)) return 'global';
  return normalized.includes('/npm/node_modules/') || normalized.includes('/lib/node_modules/') ? 'global' : 'local';
}

/**
 * Compares two semver strings, ignoring anything after a prerelease dash.
 *
 * @returns {number} negative when `a` is older, 0 when equal, positive when newer
 */
export function compareVersions(a, b) {
  const parts = (value) =>
    String(value)
      .split('-')[0]
      .split('.')
      .map((piece) => Number.parseInt(piece, 10) || 0);
  const left = parts(a);
  const right = parts(b);
  for (let i = 0; i < 3; i += 1) {
    if ((left[i] ?? 0) !== (right[i] ?? 0)) return (left[i] ?? 0) - (right[i] ?? 0);
  }
  return 0;
}

/**
 * Asks the npm registry what the newest published version is.
 *
 * @param {object} [options]
 * @param {number} [options.timeoutMs] - short on purpose: this is a
 *   convenience, and a hanging update check is worse than not knowing
 * @returns {Promise<string>}
 */
export function latestVersion({ timeoutMs = 8000, get = https.get } = {}) {
  return new Promise((resolve, reject) => {
    const req = get(REGISTRY_URL, { headers: { accept: 'application/json' } }, (res) => {
      if (res.statusCode !== 200) {
        res.resume();
        reject(new Error(`the npm registry answered ${res.statusCode}`));
        return;
      }
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        body += chunk;
        // A slow drip or an enormous answer must not grow without limit —
        // the thing being read is one version string. (Codex' review.)
        if (body.length > 64 * 1024) {
          res.destroy();
          reject(new Error('the npm registry sent more than a version number'));
        }
      });
      res.on('end', () => {
        try {
          const version = JSON.parse(body).version;
          // Checked before it reaches a terminal or a comparison: an answer
          // is not a promise, and control characters in it would be printed
          // as-is. (Codex' review.)
          if (typeof version !== 'string' || !/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(version)) {
            throw new Error('the registry did not answer with a version number');
          }
          resolve(version);
        } catch (err) {
          reject(new Error(`could not read the registry's answer: ${err.message}`));
        }
      });
    });
    req.on('error', (err) => reject(new Error(`could not reach the npm registry: ${err.message}`)));
    req.setTimeout(timeoutMs, () => {
      req.destroy(new Error(`the npm registry did not answer within ${Math.round(timeoutMs / 1000)}s`));
    });
  });
}

/**
 * What to tell someone in each situation, and whether there is anything to run.
 *
 * Split out from the doing so it can be tested without a network or a
 * package manager, and so every branch reads as one sentence rather than as
 * a nest of ifs.
 *
 * `repoDirty` is the `git status --porcelain` result for a git checkout, and
 * it is decided BEFORE this message is built — a clean/dirty verdict that
 * arrives after the advice would be an afterthought nobody acts on.
 */
export function updatePlan({ kind, current, latest, repoDirty = false }) {
  const behind = compareVersions(current, latest) < 0;
  if (!behind) {
    return { action: 'none', message: compareVersions(current, latest) > 0 ? `You are on ${current}, which is newer than the published ${latest}.` : `Already on the newest version (${current}).` };
  }

  if (kind === 'npx') {
    return {
      action: 'none',
      message: [
        `${latest} is out (you are running ${current}).`,
        'You started kaprek through npx, so there is nothing installed to update —',
        'run `npx kaprek@latest` and npx fetches it. Without @latest npx may reuse',
        'the copy it already has in its cache.',
      ].join('\n'),
    };
  }

  if (kind === 'repo') {
    return {
      action: 'none',
      message: [
        `${latest} is published (this checkout says ${current}).`,
        'This is a git checkout, so updating it means `git pull` — npm would overwrite your working tree.',
        // Only said when it is true, and said as a prohibition rather than a
        // warning: git pull refuses to run over uncommitted changes, so the
        // working copy is safe — but the pull simply will not happen until
        // the changes are committed or stashed.
        ...(repoDirty
          ? ['This checkout has uncommitted changes, and `git pull` is not allowed to overwrite your working copy — commit or stash them first.']
          : []),
      ].join('\n'),
    };
  }

  if (kind === 'local') {
    return {
      action: 'none',
      message: [`${latest} is out (you are running ${current}).`, "kaprek is installed as a dependency of another project, so update it there: `npm i kaprek@latest` in that project's directory."].join('\n'),
    };
  }

  return {
    action: 'install',
    command: ['npm', 'install', '-g', 'kaprek@latest'],
    message: `${latest} is out (you are running ${current}). Installing it globally.`,
  };
}

/**
 * What to print when an update could not be done, whatever the reason.
 *
 * Always ends with the same escape hatch. Someone reading a failure message
 * wants the next thing to type, not a description of what went wrong — the
 * reason comes first, then the line that works anyway.
 */
export function fallbackAdvice(reason) {
  return [reason, 'You can always run the newest version directly, without installing anything:', '', `  ${FALLBACK_COMMAND}`].join('\n');
}

/** Runs the install, streaming npm's own output. Resolves with the exit code. */
export function runInstall(command, { spawnFn = spawn } = {}) {
  return new Promise((resolve) => {
    // shell: true on Windows, where npm is a .cmd and cannot be spawned
    // directly. The command is a fixed array from updatePlan, never anything
    // a user typed, so there is nothing here for a shell to interpolate.
    const child = spawnFn(command[0], command.slice(1), { stdio: 'inherit', shell: process.platform === 'win32' });
    child.on('error', (err) => {
      console.error(fallbackAdvice(`Could not run ${command.join(' ')}: ${err.message}`));
      resolve(1);
    });
    child.on('exit', (code) => resolve(code ?? 1));
  });
}

/**
 * True when a git checkout has uncommitted changes.
 *
 * Any failure to ask (no git, not a repo, timeout) counts as dirty: a false
 * "clean" here would promise a pull that then refuses mid-run, while a false
 * "dirty" only costs one extra honest sentence. Never throws.
 */
export function gitStatusDirty(packageRoot, { git = gitExec } = {}) {
  try {
    return git(['status', '--porcelain'], { cwd: packageRoot }).trim().length > 0;
  } catch {
    return true;
  }
}

/**
 * Asks the running instance of THIS data dir which version it carries — the
 * same loopback greeting the instance lock answers on start, never a second
 * transport. Any failure to ask reads as "no instance": an install that
 * succeeded must not be reported as failed just because a question did not.
 *
 * @param {object} [options]
 * @param {string} options.dataDir
 * @param {typeof askInstance} [options.ask] - injectable for tests; tests fake
 *   the greeting at THIS level (the one the lock provides), not the network.
 * @returns {Promise<{running: boolean, version?: string}>}
 */
export async function askRunningInstance({ dataDir, ask = askInstance } = {}) {
  try {
    const answer = await ask({ dataDir });
    return { running: Boolean(answer.running), version: answer.version };
  } catch {
    return { running: false };
  }
}

/**
 * The honest-success sentence, or null when there is nothing to add.
 *
 * Four shapes, decided only from the greeting the lock provided:
 *   - no instance running  -> null (nothing to be stale)
 *   - running == installed -> null (plain success stands)
 *   - running != installed -> the restart note with both versions
 *   - no version field     -> "unbekannt", for a holder older than this logic
 */
export function runningInstanceNotice({ installed, running }) {
  if (!running || !running.running) return null;
  const version = running.version;
  const restart = 'der laufende Server startet beim nächsten kaprek stop neu.';
  if (typeof version !== 'string') {
    return `Läuft Version: unbekannt (älter als diese Update-Meldung) — ${restart}`;
  }
  if (version === installed) return null;
  return `Installiert ${installed}, läuft noch ${version} — ${restart}`;
}
