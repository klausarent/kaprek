// Telling someone a question is waiting — by running a command they chose.
//
// The obvious design is a list of channels: desktop toast, ntfy, Telegram,
// email. That list is never finished, every entry is a dependency or a
// vendor, and the one on the kill list by name is "a channel zoo". So kaprek
// ships none of them and runs one command instead:
//
//   {"command": ["ntfy", "publish", "my-topic"]}
//
// The question's text goes in on stdin, a few facts go in as environment
// variables, and what the command does with them is not kaprek's business.
// A person who wants a Windows toast writes a one-line PowerShell; a person
// who wants their phone to buzz already has a tool for it.
//
// FAIL-CLOSED IN THE ONLY DIRECTION THAT MATTERS. Nothing here can approve
// anything, and a notifier that fails, hangs, or does not exist changes
// nothing about the question — it stays in the inbox exactly as it was.
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

/** How long the command gets before it is killed. A notifier is a fire-and-forget, not a step in the flow. */
export const NOTIFY_TIMEOUT_MS = 10_000;

export class InvalidNotifyError extends Error {
  constructor(message) {
    super(message);
    this.name = 'InvalidNotifyError';
  }
}

function configPath(dataDir) {
  return path.join(dataDir, 'notify.json');
}

/**
 * Reads the notify configuration.
 *
 * A missing, unreadable, or malformed file means "no notifier" — never a
 * crash and never a half-configured command that gets run anyway.
 */
export function readNotify(dataDir) {
  try {
    const parsed = JSON.parse(fs.readFileSync(configPath(dataDir), 'utf8'));
    const command = Array.isArray(parsed?.command) ? parsed.command.filter((part) => typeof part === 'string' && part !== '') : [];
    if (command.length === 0) return { command: [], configured: false };
    return { command, configured: true };
  } catch {
    return { command: [], configured: false };
  }
}

/**
 * Saves it, after checking it is a command and not a shell line.
 *
 * An array, never a string: a string would have to be split, splitting means
 * quoting rules, and quoting rules in something that gets executed is how a
 * config file becomes an injection point.
 */
export function writeNotify(dataDir, command) {
  if (!Array.isArray(command)) throw new InvalidNotifyError('command must be an array like ["ntfy", "publish", "my-topic"] — not a shell string');
  const parts = command.filter((part) => typeof part === 'string' && part.trim() !== '');
  if (parts.length === 0) throw new InvalidNotifyError('command must have at least the program to run');
  fs.mkdirSync(dataDir, { recursive: true });
  const tmp = `${configPath(dataDir)}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, `${JSON.stringify({ command: parts }, null, 2)}\n`, 'utf8');
  fs.renameSync(tmp, configPath(dataDir));
  return { command: parts, configured: true };
}

/** What the command is told about the question, as environment variables. */
export function notifyEnv({ chatId = null, toolName = null, source = null, url = null } = {}) {
  return {
    KAPREK_CHAT_ID: chatId ?? '',
    KAPREK_TOOL: toolName ?? '',
    KAPREK_SOURCE: source ?? '',
    // Where to answer it. The whole point of being told.
    KAPREK_URL: url ?? '',
  };
}

/**
 * Runs the configured command, if there is one.
 *
 * Never throws and never waits on the result: the caller is a turn that has
 * just parked a question, and a notifier that hangs must not hold it up.
 *
 * @returns {Promise<{ran: boolean, reason?: string}>}
 */
export async function notify({ dataDir, text, context = {}, spawnFn = spawn, timeoutMs = NOTIFY_TIMEOUT_MS, log = () => {} }) {
  const { command, configured } = readNotify(dataDir);
  if (!configured) return { ran: false, reason: 'no notify command configured' };

  return new Promise((resolve) => {
    let child;
    try {
      child = spawnFn(command[0], command.slice(1), {
        // No shell. The command comes from a file the user wrote, and the
        // question's text comes from an agent — putting either through a
        // shell would be handing an agent a way to run arbitrary commands by
        // choosing what to call a tool.
        shell: false,
        stdio: ['pipe', 'ignore', 'ignore'],
        env: { ...process.env, ...notifyEnv(context) },
      });
    } catch (err) {
      log(`notify: could not start ${command[0]} (${err.message})`);
      resolve({ ran: false, reason: err.message });
      return;
    }

    const timer = setTimeout(() => {
      child.kill();
      log(`notify: ${command[0]} did not finish within ${Math.round(timeoutMs / 1000)}s`);
      resolve({ ran: true, reason: 'timed out' });
    }, timeoutMs);

    child.on('error', (err) => {
      clearTimeout(timer);
      log(`notify: ${command[0]} failed (${err.message})`);
      resolve({ ran: false, reason: err.message });
    });
    child.on('exit', () => {
      clearTimeout(timer);
      resolve({ ran: true });
    });

    try {
      child.stdin?.end(String(text ?? ''));
    } catch {
      // A notifier that closed its own stdin is not a problem worth
      // reporting: it already got the environment.
    }
  });
}
