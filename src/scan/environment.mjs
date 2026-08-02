// What is on this machine — for the first five minutes of using kaprek.
//
// A fresh install cannot tell you anything useful about a machine it has
// never looked at: which CLIs exist, whether they are logged in, where the
// config files are, which MCP servers are configured, where the .env sits.
// So the first thing kaprek shows was a blank page and a question it had no
// business asking ("which engine should lead?").
//
// THE ONE RULE, Klaus' own words: "nur Pfade und Namen, nie Werte." This
// module reports that a file exists, what it is called, and which keys are
// defined in it. It never reads a secret's value, never sends anything
// anywhere, and never writes. Everything below is a read of a path or a
// listing of a directory — and the two places where a value could
// accidentally be carried out (env files, MCP config) go out of their way to
// keep only the left-hand side of the '='.
//
// It also answers the council's question. suggestAssignment() needs to know
// which engines exist before it can propose who leads; until now that list
// came from "whatever the registry happens to hold".
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * The CLIs kaprek knows how to talk to, and where each keeps its things.
 *
 * `loginHints` are files whose EXISTENCE says someone signed in. They are
 * never opened — the presence of ~/.claude/.credentials.json is the whole
 * signal, and its contents are exactly what must not be touched.
 */
export const KNOWN_CLIS = Object.freeze([
  {
    id: 'claude-code',
    command: 'claude',
    label: 'Claude Code',
    configDirs: ['.claude'],
    loginHints: ['.claude/.credentials.json', '.claude/.credentials'],
    mcpConfigs: ['.claude.json', '.claude/mcp.json'],
  },
  {
    id: 'codex',
    command: 'codex',
    label: 'Codex',
    configDirs: ['.codex'],
    loginHints: ['.codex/auth.json'],
    mcpConfigs: ['.codex/config.toml'],
  },
  {
    id: 'grok',
    command: 'grok',
    label: 'Grok',
    configDirs: ['.grok'],
    loginHints: ['.grok/auth.json', '.grok/config.json'],
    mcpConfigs: [],
  },
  {
    id: 'gemini',
    command: 'gemini',
    label: 'Gemini CLI',
    configDirs: ['.gemini'],
    loginHints: ['.gemini/oauth_creds.json'],
    mcpConfigs: ['.gemini/settings.json'],
  },
]);

/** Files worth reporting the KEY NAMES of. Never the values. */
const ENV_FILE_NAMES = ['.env', '.env.local'];

/**
 * Where an executable named `command` sits, or null.
 *
 * PATH is walked directly rather than shelling out to `where`/`which`: this
 * runs at startup and on a settings page, and a spawn per CLI per call is
 * both slower and a process kaprek does not need to start. On Windows the
 * PATHEXT extensions are tried, because `codex` on disk is `codex.cmd`.
 */
export function findOnPath(command, env = process.env) {
  const dirs = (env.PATH ?? env.Path ?? '').split(path.delimiter).filter(Boolean);
  const exts = process.platform === 'win32' ? (env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean) : [''];
  for (const dir of dirs) {
    for (const ext of exts) {
      const candidate = path.join(dir, `${command}${ext}`);
      try {
        if (fs.statSync(candidate).isFile()) return candidate;
      } catch {
        // Not there, or not readable. Either way: keep looking.
      }
    }
  }
  return null;
}

/**
 * The variable NAMES defined in an env file, in order.
 *
 * Parsed rather than read: everything to the right of the first '=' is
 * dropped before it is ever put in a return value, so a value cannot leak
 * into a response, a log line, or a UI by accident. `export FOO=…` and
 * commented lines are handled because real .env files contain both.
 */
export function envKeyNames(filePath) {
  let text;
  try {
    text = fs.readFileSync(filePath, 'utf8');
  } catch {
    return [];
  }
  const names = [];
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith('#')) continue;
    const withoutExport = trimmed.startsWith('export ') ? trimmed.slice(7).trim() : trimmed;
    const eq = withoutExport.indexOf('=');
    if (eq <= 0) continue;
    const name = withoutExport.slice(0, eq).trim();
    if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) names.push(name);
  }
  return names;
}

/**
 * The MCP server names configured for a CLI.
 *
 * Only the keys of the mcpServers object: a server's config holds commands,
 * arguments, and quite often an API key in `env`. The name is what a person
 * needs to recognize it; the rest is exactly what this module refuses to
 * carry.
 */
export function mcpServerNames(filePath) {
  let parsed;
  try {
    const text = fs.readFileSync(filePath, 'utf8');
    if (filePath.endsWith('.toml')) {
      // A deliberately small reader: TOML tables named [mcp_servers.<name>].
      // A full TOML parser is a dependency, and this file only needs names.
      return [...text.matchAll(/^\s*\[mcp_servers\.([^\]]+)\]/gm)].map((match) => match[1].trim().replace(/^"|"$/g, ''));
    }
    parsed = JSON.parse(text);
  } catch {
    return [];
  }
  const servers = parsed?.mcpServers;
  if (!servers || typeof servers !== 'object') return [];
  return Object.keys(servers);
}

function exists(target) {
  try {
    fs.statSync(target);
    return true;
  } catch {
    return false;
  }
}

/** One CLI's situation on this machine. */
function scanCli(entry, { home, env }) {
  const commandPath = findOnPath(entry.command, env);
  const configDirs = entry.configDirs.map((rel) => path.join(home, rel)).filter(exists);
  // Existence only. Opening a credentials file to check whether it looks
  // valid would be reading exactly the thing this module must not read.
  const signedIn = entry.loginHints.some((rel) => exists(path.join(home, rel)));
  const mcpServers = entry.mcpConfigs.flatMap((rel) => mcpServerNames(path.join(home, rel)));

  return {
    id: entry.id,
    label: entry.label,
    command: entry.command,
    installed: commandPath !== null,
    commandPath,
    configDirs,
    signedIn,
    mcpServers: [...new Set(mcpServers)],
  };
}

/**
 * Looks at the machine and reports what it found.
 *
 * @param {object} [options]
 * @param {string} [options.home] - overridable for tests; never guessed from
 *   anything a request could set
 * @param {string[]} [options.projectDirs] - directories whose env files are
 *   worth listing the key names of (a mission's cwd, typically)
 * @returns {{clis: object[], envFiles: object[], home: string, platform: string}}
 */
export function scanEnvironment({ home = os.homedir(), env = process.env, projectDirs = [] } = {}) {
  const clis = KNOWN_CLIS.map((entry) => scanCli(entry, { home, env }));

  const envFiles = [];
  for (const dir of [home, ...projectDirs]) {
    for (const name of ENV_FILE_NAMES) {
      const filePath = path.join(dir, name);
      if (!exists(filePath)) continue;
      const keys = envKeyNames(filePath);
      // The path and the names. A UI showing "OPENAI_API_KEY is defined in
      // C:\Users\you\.env" tells someone everything they need to fix a
      // missing key, and nothing they would not want on a screenshot.
      envFiles.push({ path: filePath, keys });
    }
  }

  return {
    home,
    platform: process.platform,
    clis,
    envFiles,
  };
}

/**
 * The engine ids worth offering, in the order they should be offered.
 *
 * Installed AND signed in comes first, because those are the ones that will
 * actually answer. suggestAssignment() makes the first id the lead, so this
 * order is the whole difference between a sensible default council and one
 * led by a CLI nobody has logged into.
 */
export function engineIdsByReadiness(scan) {
  const ready = scan.clis.filter((cli) => cli.installed && cli.signedIn);
  const installed = scan.clis.filter((cli) => cli.installed && !cli.signedIn);
  return [...ready, ...installed].map((cli) => cli.id);
}

/**
 * What is missing, in the order it is worth fixing.
 *
 * Phrased as something to do rather than something that is wrong: a fresh
 * install has all of these, and a list of complaints is a bad first screen.
 */
export function nextSteps(scan) {
  const steps = [];
  const installed = scan.clis.filter((cli) => cli.installed);
  if (installed.length === 0) {
    steps.push({
      id: 'install-a-cli',
      text: `No agent CLI was found on PATH. kaprek drives the CLIs you already have — install at least one of: ${KNOWN_CLIS.map((cli) => cli.command).join(', ')}.`,
    });
    return steps;
  }
  for (const cli of installed.filter((entry) => !entry.signedIn)) {
    steps.push({ id: `sign-in-${cli.id}`, text: `${cli.label} is installed but has no sign-in on this machine. Run \`${cli.command}\` once and log in.` });
  }
  if (installed.length === 1) {
    steps.push({
      id: 'second-engine',
      text: `Only ${installed[0].label} is installed. A second engine is what makes a second opinion possible — one model reviewing its own answer is not one.`,
    });
  }
  return steps;
}
