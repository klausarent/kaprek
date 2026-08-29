// The one place kaprek shells out to `git`, for the council gate (has this
// session's work grown large enough to need a review?) and for
// `kaprek council --diff` (hand the diff to the peers). Always the local
// `git` binary, in a caller-given cwd, never through a shell, always with a
// timeout — a diff/status call against a huge or hung repo must never hang
// the Stop hook or the CLI.
//
// council-gate.mjs and src/council/diff.mjs never import this module
// themselves: both take `exec` as an injected function so neither one (nor
// hook-stop.mjs, which is not in src/no-network.test.mjs's allow-list
// either) needs to touch child_process directly. This file is the one
// concrete implementation, wired in by bin/cli.mjs and hook-stop.mjs, and
// the one file src/no-network.test.mjs allows to run `git`.
import { execFileSync } from 'node:child_process';

export const DEFAULT_GIT_TIMEOUT_MS = 5000;

/**
 * Runs `git <args>` in `cwd` and returns stdout as a string, or throws
 * (non-zero exit, missing git binary, cwd not a repo, or a timeout — all of
 * it is the caller's to interpret; every caller of this module treats any
 * throw as "could not determine", never as a reason to block anything).
 *
 * @param {string[]} args
 * @param {object} options
 * @param {string} options.cwd
 * @param {number} [options.timeoutMs]
 */
export function gitExec(args, { cwd, timeoutMs = DEFAULT_GIT_TIMEOUT_MS } = {}) {
  return execFileSync('git', args, {
    cwd,
    timeout: timeoutMs,
    encoding: 'utf8',
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'ignore'],
    maxBuffer: 64 * 1024 * 1024,
  });
}
