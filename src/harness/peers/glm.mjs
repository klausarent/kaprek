// The GLM peer driver: one prompt in, one schema-constrained answer out.
//
// Verified against the installed CLI (ZCode CLI 0.16.9, 27.09.2026). ZCode is
// the desktop app that ships GLM-5.3 as its default model under the user's
// GLM Coding Plan (a subscription, same shape as Grok's); its headless entry
// point is a plain node script bundled inside the app, not a PATH command:
//
//   node <install dir>\resources\glm\zcode.cjs
//     -p "<short instruction>"
//     --attach <file1> --attach <file2> ...
//     --mode plan --json
//     --disallowed-tools "<GLM_DISALLOWED_TOOLS>"
//     --cwd <scratch dir>
//
// Every choice on that line is doing a specific job:
//   --mode plan       the write barrier. `-p` defaults to permission mode
//                      "yolo" — verified live — so this flag is never
//                      optional. IMPORTANT, also verified live: --mode plan
//                      is NOT a tool lock by itself. A live run in plan mode
//                      still executed `Bash whoami` (ZCode classifies it
//                      read-only and lets it through). The actual lock is
//                      --disallowed-tools naming every tool by exact name
//                      (`mcp__*` wildcards do NOT work — verified live, a
//                      wildcard still let mcp__node_repl__js run arbitrary
//                      JS), the pre-flight plugin/MCP check, and the
//                      post-turn audit — belt, braces, and a third belt.
//   --disallowed-tools strips the tool-capable set by exact name (see
//                      GLM_DISALLOWED_TOOLS).
//   --attach, not a    ZCode only shows a SINGLE attachment up to ~64 KB
//   single big file    (~610 lines) to the model; past that it is silently
//                      truncated. Splitting a big prompt into several
//                      attachments works — a 114 KB prompt in 3 parts was
//                      read completely, verified live. So the prompt never
//                      goes on the -p line (argv limits, quoting) and never
//                      in one file (the 64 KB wall): it goes out as N files
//                      of at most GLM_ATTACHMENT_MAX_BYTES each, headered
//                      "[Teil k von n]" so the model knows there is more and
//                      in what order to read it (chunkPromptForZcode()).
//   --json             stdout is a JSON envelope, sometimes preceded by plain
//                      log lines ("ZCode Built-in skipped (not-due)") and
//                      sometimes by an unrelated, valid "diagnostic JSON"
//                      line of its own — parseGlmStdout() does a real
//                      balanced-brace scan for the first candidate that has
//                      a string `response` field, rather than assuming byte
//                      0 is the envelope or that the WHOLE rest of stdout is
//                      one JSON value.
//   --cwd <scratch>    ALWAYS a fresh, private, per-turn directory this
//                      driver creates — never the caller's `cwd`, and never
//                      the mission tree. A peer stands next to nothing but
//                      its own attachments, the same rule
//                      src/council/ask.mjs enforces for every driver.
//
// ZCODE_BUILTIN_PROVIDER_CONFIG_FILE. Without this env var the CLI aborts
// before the model ever runs ("无法定位 CLI ZCode Built-in Provider Config",
// verified live). It has to be computed relative to whichever zcode.cjs the
// driver resolved (resources\glm\zcode.cjs -> resources\config\provider\
// zcode-builtin.json, see providerConfigPathFor()) rather than hardcoded,
// because KAPREK_ZCODE_PATH can point anywhere. Set only when the caller has
// not already set one — a deliberate override must win.
//
// Model. The CLI has no --model flag; every turn runs whatever the user's
// ZCode default is (GLM-5.3 as installed, 27.09.2026). Switching to
// GLM-5.3-Flash needs the app-server protocol's `session/setModel`, which is
// a different, stateful integration than this one-shot `-p` driver — out of
// scope here, same way grok.mjs does not manage Grok's own model setting.
//
// Hardened after council review round 1 (Codex + Grok, 27.09.2026): taskkill
// runs before child.kill() and is awaited; the ZCode process always runs in
// a fresh, unique per-turn scratch directory this driver creates, never the
// caller's `cwd`; an already-aborted signal is checked before any artifact
// is created; stdout/stderr are decoded with setEncoding('utf8'); envelope
// parsing does a balanced-brace scan; chunkPromptForZcode() refuses an
// attachment cap below 1024 bytes and guarantees forward progress; and a
// post-turn audit reads ZCode's own session log for tool calls the static
// --disallowed-tools list missed.
//
// Hardened further after council round 2 (Codex, 27.09.2026):
//   - A pre-flight runs `plugins list` and refuses any ENABLED plugin
//     exposing an MCP tool outside KNOWN_SAFE_MCP or any hooks at all, and
//     separately refuses if ~/.zcode/cli/config.json defines a user-level
//     MCP server — fail-closed if that file cannot be read or parsed (see
//     ensurePluginsPreflight()). Runs before EVERY turn, uncached (round 3
//     dropped the original 10-minute cache: a plugin enabled or a config.json
//     edited between two turns is exactly what a cache would miss, and it
//     means a turn's own cancellation can only ever fail THAT turn).
//   - The child's environment is a small allowlist (PATH, TEMP, ZCODE_*,
//     ...), never process.env wholesale — a peer that inherited the whole
//     environment would have every secret in it regardless of what its
//     tools are locked down to (see buildGlmChildEnv()).
//   - The post-turn audit now requires POSITIVE evidence (at least one log
//     line naming this exact sessionId), fails closed on a malformed line
//     that merely mentions the sessionId, streams each day's log file
//     line-by-line under a byte cap and an overall time budget, and checks
//     only the turn's own start/end calendar dates rather than a blanket
//     ±1 day around audit time (see auditNoToolsRan()).
//   - Attachment paths are registered in the cleanup list BEFORE they are
//     written, so a failure partway through writing them still gets
//     cleaned up.
//   - Termination (timeout/abort/overflow) goes through one idempotent
//     terminate() — the first trigger's reason wins and no second killTree()
//     call happens, the same fix applied to grok.mjs.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { spawn } from 'node:child_process';
import {
  PEER_MAX_STDOUT_BYTES,
  PEER_OUTPUT_SCHEMA,
  PEER_TIMEOUT_MS,
  parsePeerAnswer,
  registerPeerDriver,
} from './driver.mjs';

/**
 * The biggest prompt this driver will hand the CLI, in UTF-8 bytes.
 *
 * Unlike GROK_MAX_PROMPT_BYTES this is not a technical wall — ZCode's
 * attachment scheme (see chunkPromptForZcode()) can in principle carry an
 * arbitrarily large prompt across enough files. It is kept equal to grok's
 * verified cap anyway: src/council/consult.mjs::fitPackage trims a package
 * per peer to whatever `maxPromptBytes` says, and a council round comparing
 * two peers' verdicts on packages of wildly different size is a worse signal
 * than one comparing two peers who both saw the same trimmed material.
 */
export const GLM_MAX_PROMPT_BYTES = 150_000;

/** The most one ZCode attachment file may weigh, header included. Verified live: a single attachment is shown to the model up to ~64 KB (~610 lines); this stays well under that. */
export const GLM_ATTACHMENT_MAX_BYTES = 40_000;

/**
 * Room reserved inside GLM_ATTACHMENT_MAX_BYTES for the "[Teil k von n]\n"
 * header line. Generous on purpose (the header itself never exceeds ~23
 * bytes short of six-digit part counts) so the body-size math in
 * chunkPromptForZcode() never has to re-measure after adding the header.
 */
const GLM_CHUNK_HEADER_RESERVE_BYTES = 32;

/**
 * The smallest attachmentMaxBytes chunkPromptForZcode() accepts. Below this,
 * GLM_CHUNK_HEADER_RESERVE_BYTES plus one worst-case 4-byte UTF-8 character
 * stops leaving enough room to guarantee a chunk can always hold at least
 * one character — the exact condition that once made sliceUtf8() return an
 * empty head and loop forever on an unchanged remainder (council review,
 * 27.09.2026). 1024 is generous headroom above the ~36-byte floor that alone
 * would prevent that, chosen so nobody has to reason about the exact margin.
 */
export const GLM_ATTACHMENT_MIN_BYTES = 1024;

/**
 * What `--disallowed-tools` strips for a text-only turn: every exact tool
 * name ZCode 0.16.9 ships with — core tools plus every bundled MCP plugin —
 * verified live, 27.09.2026, against a real run. `--disallowed-tools` only
 * matches EXACT names (a `mcp__*` wildcard does not work — verified live,
 * `mcp__node_repl__js` still ran with one), so every installed tool has to
 * be named rather than pattern-matched. KAPREK_GLM_EXTRA_DISALLOWED extends
 * this list at runtime for a plugin installed after this file was last
 * updated, without a code change (see effectiveDisallowedTools()); the
 * pre-flight (ensurePluginsPreflight()) and the post-turn audit
 * (auditNoToolsRan()) are the actual fail-closed guards for whatever a
 * stale list still misses.
 */
const GLM_DISALLOWED_TOOLS_LIST = [
  // Core tools.
  'Agent',
  'AskUserQuestion',
  'Bash',
  'Edit',
  'EnterPlanMode',
  'ExitPlanMode',
  'Read',
  'Skill',
  'TaskOutput',
  'TaskStop',
  'TodoRead',
  'TodoWrite',
  'WebFetch',
  'WebSearch',
  'Write',
  'SendMessage',
  'ReadSessionContext',
  'CreateWorkflow',
  'AmendWorkflow',
  'SaveWorkflow',
  'ResumeWorkflowRun',
  'EvalWorkflowSnippet',
  'ListWorkflowRuns',
  'GetWorkflowRun',
  'ListSavedWorkflows',
  'ResolveWorkflowQuestion',
  'ListModels',
  'Glob',
  'Grep',
  'Task',
  'NotebookEdit',
  // Bundled MCP / plugin tools.
  'mcp__4_5v_mcp__analyze_image',
  'mcp__node_repl__js',
  'mcp__web_reader__webReader',
  'mcp__plugin_android-emulator_android-emulator__android_build_and_run',
  'mcp__plugin_android-emulator_android-emulator__android_build_app',
  'mcp__plugin_android-emulator_android-emulator__android_create_app',
  'mcp__plugin_android-emulator_android-emulator__android_create_avd',
  'mcp__plugin_android-emulator_android-emulator__android_discover_project',
  'mcp__plugin_android-emulator_android-emulator__android_install_app',
  'mcp__plugin_android-emulator_android-emulator__android_launch_app',
  'mcp__plugin_android-emulator_android-emulator__android_list_avds',
  'mcp__plugin_android-emulator_android-emulator__android_list_devices',
  'mcp__plugin_android-emulator_android-emulator__android_logs',
  'mcp__plugin_android-emulator_android-emulator__android_open_url',
  'mcp__plugin_android-emulator_android-emulator__android_preflight',
  'mcp__plugin_android-emulator_android-emulator__android_screenshot',
  'mcp__plugin_android-emulator_android-emulator__android_start_emulator',
  'mcp__plugin_android-emulator_android-emulator__android_stop_emulator',
  'mcp__plugin_android-emulator_android-emulator__android_terminate_app',
  'mcp__plugin_android-emulator_android-emulator__android_ui_describe',
  'mcp__plugin_android-emulator_android-emulator__android_ui_keyevent',
  'mcp__plugin_android-emulator_android-emulator__android_ui_resolve',
  'mcp__plugin_android-emulator_android-emulator__android_ui_status',
  'mcp__plugin_android-emulator_android-emulator__android_ui_swipe',
  'mcp__plugin_android-emulator_android-emulator__android_ui_tap',
  'mcp__plugin_android-emulator_android-emulator__android_ui_type_text',
  'mcp__plugin_ios-simulator_ios-simulator__ios_build_and_run',
  'mcp__plugin_ios-simulator_ios-simulator__ios_build_app',
  'mcp__plugin_ios-simulator_ios-simulator__ios_create_app',
  'mcp__plugin_ios-simulator_ios-simulator__ios_discover_project',
  'mcp__plugin_ios-simulator_ios-simulator__ios_install_app',
  'mcp__plugin_ios-simulator_ios-simulator__ios_launch_app',
  'mcp__plugin_ios-simulator_ios-simulator__ios_list_simulators',
  'mcp__plugin_ios-simulator_ios-simulator__ios_logs',
  'mcp__plugin_ios-simulator_ios-simulator__ios_open_url',
  'mcp__plugin_ios-simulator_ios-simulator__ios_preflight',
  'mcp__plugin_ios-simulator_ios-simulator__ios_screenshot',
  'mcp__plugin_ios-simulator_ios-simulator__ios_start_simulator',
  'mcp__plugin_ios-simulator_ios-simulator__ios_stop_simulator',
  'mcp__plugin_ios-simulator_ios-simulator__ios_terminate_app',
  'mcp__plugin_ios-simulator_ios-simulator__ios_ui_button',
  'mcp__plugin_ios-simulator_ios-simulator__ios_ui_describe',
  'mcp__plugin_ios-simulator_ios-simulator__ios_ui_status',
  'mcp__plugin_ios-simulator_ios-simulator__ios_ui_swipe',
  'mcp__plugin_ios-simulator_ios-simulator__ios_ui_tap',
  'mcp__plugin_ios-simulator_ios-simulator__ios_ui_type_text',
];

/**
 * One exported constant, used in exactly one place (buildGlmArgs' default) —
 * so updating the tool inventory later (Klaus is separately re-verifying it)
 * is a one-line diff to the array above, not a hunt through the file.
 */
export const GLM_DISALLOWED_TOOLS = GLM_DISALLOWED_TOOLS_LIST.join(' ');

/** Extends GLM_DISALLOWED_TOOLS at runtime, space-separated, for a plugin installed after this file was last verified — see effectiveDisallowedTools(). */
export const GLM_EXTRA_DISALLOWED_ENV = 'KAPREK_GLM_EXTRA_DISALLOWED';

/** Set to '1' to bypass the post-turn tool audit (auditNoToolsRan()) — an escape hatch for a machine where ZCode's log genuinely is not where defaultZcodeLogDir() looks, never a default. */
export const GLM_TOOL_AUDIT_SKIP_ENV = 'KAPREK_GLM_SKIP_TOOL_AUDIT';

/** GLM_DISALLOWED_TOOLS plus whatever KAPREK_GLM_EXTRA_DISALLOWED names, space-separated — the static list's one runtime escape hatch for a plugin this file does not know about yet. */
export function effectiveDisallowedTools(env = process.env, base = GLM_DISALLOWED_TOOLS) {
  const extra = String(env?.[GLM_EXTRA_DISALLOWED_ENV] ?? '').trim();
  return extra ? `${base} ${extra}` : base;
}

/**
 * Every environment variable NAME passed through to the child verbatim,
 * plus every `ZCODE_*` one — never process.env wholesale. A peer whose tools
 * are locked down but whose environment is inherited whole still has
 * GITHUB_TOKEN, ANTHROPIC_API_KEY and everything else the calling process
 * carries sitting in its own `process.env`, reachable by anything that ever
 * gets a foothold (a prompt-injected shell command, a plugin bug, a future
 * regression in the tool lock) — the allowlist is what actually keeps a
 * secret out of reach, not a hope that --disallowed-tools covers everything
 * (council review round 2, 27.09.2026).
 */
const GLM_CHILD_ENV_ALLOWLIST = [
  'PATH',
  'SystemRoot',
  'SYSTEMROOT',
  'windir',
  'ComSpec',
  'PATHEXT',
  'TEMP',
  'TMP',
  'USERPROFILE',
  'HOME',
  'HOMEDRIVE',
  'HOMEPATH',
  'APPDATA',
  'LOCALAPPDATA',
  'ProgramData',
  'NUMBER_OF_PROCESSORS',
  'PROCESSOR_ARCHITECTURE',
  'OS',
  'LANG',
];

/** Builds the child's ENTIRE environment from `env` — the allowlist above plus every `ZCODE_*` variable (including a caller-set ZCODE_BUILTIN_PROVIDER_CONFIG_FILE, honored by runGlmTurn's own "do not overwrite" logic afterward). Nothing else survives. */
export function buildGlmChildEnv(env = process.env) {
  const child = {};
  for (const key of GLM_CHILD_ENV_ALLOWLIST) {
    if (env[key] !== undefined) child[key] = env[key];
  }
  for (const [key, value] of Object.entries(env)) {
    if (key.startsWith('ZCODE_')) child[key] = value;
  }
  return child;
}

/**
 * MCP ids exempted from the pre-flight refusal. Empty by default — a
 * caller-vetted allowlist, never populated here silently; the whole point
 * of the pre-flight is that an enabled plugin exposing an MCP tool is
 * refused unless someone explicitly said it was fine.
 */
export const KNOWN_SAFE_MCP = Object.freeze([]);

/** How long the `plugins list` metadata call may take — short, because unlike a model turn this does no thinking at all. */
const GLM_PREFLIGHT_TIMEOUT_MS = 30_000;

/**
 * Parses `zcode plugins list`'s output into one record per plugin block, or
 * throws "unrecognized `zcode plugins list` output" — fail closed, on
 * purpose. A safety check that silently passes on output it does not
 * understand (an unrelated error message, a future CLI version's reshuffled
 * format, a truncated stream) is worse than no check at all, because it
 * LOOKS like the plugin surface was verified when it was not — the exact
 * defect council review round 3 found: an early version of this parser
 * quietly treated arbitrary unrelated text as "zero plugins found" and let
 * the turn through.
 *
 * Verified live shape (27.09.2026):
 *   Plugins (2)
 *   - android-emulator@zcode-plugins-official [enabled]
 *     skills: 1, commands: 1, hooks: 0, mcp: plugin:android-emulator:android-emulator
 *   - ios-simulator@zcode-plugins-official [disabled]
 *     skills: 1, commands: 1, hooks: 0, mcp: none
 *
 * Three things must hold or this refuses outright:
 *   1. A `Plugins (N)` header line exists at all.
 *   2. Exactly N plugin blocks were actually found.
 *   3. Every ENABLED block has its own recognized stats line — a numeric
 *      `hooks:` and an explicit `mcp:` value, not a default guessed in the
 *      header's absence.
 */
function parsePluginsList(text) {
  const raw = String(text ?? '');
  const headerMatch = raw.match(/^Plugins\s*\((\d+)\)\s*$/m);
  if (!headerMatch) {
    throw new Error('unrecognized `zcode plugins list` output: no "Plugins (N)" header found — refusing rather than guessing what this means');
  }
  const expectedCount = Number(headerMatch[1]);

  const blocks = [];
  let current = null;
  const headerRe = /^-\s+(.+?)@(\S+)\s+\[(enabled|disabled)\]\s*$/;
  const statsRe = /skills:\s*(\d+)\s*,\s*commands:\s*(\d+)\s*,\s*hooks:\s*(\d+)\s*,\s*mcp:\s*(.+?)\s*$/;
  for (const rawLine of raw.split('\n')) {
    const line = rawLine.replace(/\r$/, '');
    const header = line.match(headerRe);
    if (header) {
      if (current) blocks.push(current);
      current = { name: header[1], source: header[2], enabled: header[3] === 'enabled', hooks: null, mcp: null };
      continue;
    }
    const stats = line.match(statsRe);
    if (stats && current) {
      current.hooks = Number(stats[3]);
      current.mcp = stats[4].trim();
    }
  }
  if (current) blocks.push(current);

  if (blocks.length !== expectedCount) {
    throw new Error(`unrecognized \`zcode plugins list\` output: header said Plugins (${expectedCount}) but ${blocks.length} plugin block(s) were actually found`);
  }
  for (const block of blocks) {
    if (block.enabled && (block.hooks === null || block.mcp === null)) {
      throw new Error(`unrecognized \`zcode plugins list\` output: enabled plugin "${block.name}" has no recognized stats line (hooks/mcp)`);
    }
  }
  return blocks;
}

/**
 * Refuses (throws) if any ENABLED plugin block exposes an MCP tool whose id
 * is not in `knownSafeMcp`, or has any hooks at all. A disabled plugin is not
 * inspected further — it cannot run regardless of what it would expose.
 */
function auditPluginsList(blocks, { knownSafeMcp = KNOWN_SAFE_MCP } = {}) {
  for (const block of blocks) {
    if (!block.enabled) continue;
    if (block.hooks > 0) {
      throw new Error(`glm pre-flight refused: plugin "${block.name}" is enabled with ${block.hooks} hook(s)`);
    }
    if (block.mcp && block.mcp !== 'none') {
      const ids = block.mcp
        .split(',')
        .map((id) => id.trim())
        .filter(Boolean);
      const unsafe = ids.filter((id) => !knownSafeMcp.includes(id));
      if (unsafe.length > 0) {
        throw new Error(`glm pre-flight refused: plugin "${block.name}" exposes MCP tool(s) not in KNOWN_SAFE_MCP: ${unsafe.join(', ')}`);
      }
    }
  }
}

/** Where ZCode's own CLI config sits — a second surface a user-level MCP server can be defined on, independent of the plugin registry `plugins list` reports. Injectable (runGlmTurn's `zcodeConfigPath` option) so a test never has to touch the real machine's ~/.zcode. */
export function defaultZcodeConfigPath() {
  return path.join(os.homedir(), '.zcode', 'cli', 'config.json');
}

/** Depth-bounded search for the first non-empty value at one of `keys`, anywhere in `node` — config.json's own shape is not documented, so this looks under the exact key names asked for at any nesting rather than assuming they sit at the top level. */
function findNonEmptyMcpKey(node, keys, depth = 0) {
  if (depth > 6 || !node || typeof node !== 'object') return null;
  for (const key of keys) {
    const value = node[key];
    if (Array.isArray(value) && value.length > 0) {
      return { key, names: value.map((entry, idx) => (typeof entry === 'string' ? entry : `#${idx}`)) };
    }
    if (value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length > 0) {
      return { key, names: Object.keys(value) };
    }
  }
  for (const value of Object.values(node)) {
    if (value && typeof value === 'object') {
      const found = findNonEmptyMcpKey(value, keys, depth + 1);
      if (found) return found;
    }
  }
  return null;
}

/**
 * Refuses (throws) if `configPath` defines a user-level MCP server anywhere
 * under a `mcpServers` / `mcp` / `servers` key, and fails closed — same
 * throw — if the file cannot be read or does not parse as JSON. A config
 * this driver cannot make sense of is not "probably fine"; it is refused the
 * same way an actual MCP server entry would be.
 */
function auditUserConfigMcpServers(configPath) {
  let text;
  try {
    text = fs.readFileSync(configPath, 'utf8');
  } catch (err) {
    throw new Error(`glm pre-flight could not read ${configPath}: ${err.message}`);
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new Error(`glm pre-flight found a malformed ${configPath}: ${err.message}`);
  }
  const found = findNonEmptyMcpKey(parsed, ['mcpServers', 'mcp', 'servers']);
  if (found) {
    throw new Error(`glm pre-flight refused: ${configPath} defines user-level MCP server(s) under "${found.key}": ${found.names.join(', ')}`);
  }
}

/**
 * Runs one ZCode metadata subcommand (`plugins list` today) and returns its
 * stdout, or throws. Deliberately simpler than the main turn's executor
 * below — a metadata call does no model thinking, so PEER_TIMEOUT_MS would
 * be a strange bound for it — but shares the same termination shape: an
 * idempotent terminate() so an abort and the pre-flight's own timeout
 * cannot both try to kill the same child.
 */
function runZcodeSubcommand({ command, argsPrefix, args, childEnv, spawnFn, cwd, signal, timeoutMs = GLM_PREFLIGHT_TIMEOUT_MS }) {
  return new Promise((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    let settled = false;
    let child = null;
    let timer = null;
    let terminating = null;

    const finish = (err, value) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      signal?.removeEventListener?.('abort', onAbort);
      if (err) reject(err);
      else resolve(value);
    };
    const terminate = (err) => {
      if (terminating) return terminating;
      terminating = (child ? killTree(child) : Promise.resolve()).then(() => finish(err));
      return terminating;
    };
    const onAbort = () => terminate(new Error('the relay run was stopped'));
    signal?.addEventListener?.('abort', onAbort, { once: true });
    if (signal?.aborted) {
      onAbort();
      return;
    }

    try {
      child = spawnFn(command, [...argsPrefix, ...args], {
        cwd,
        env: childEnv,
        windowsHide: true,
        detached: process.platform !== 'win32',
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (err) {
      finish(new Error(`could not start glm: ${err.message}`));
      return;
    }

    timer = setTimeout(() => terminate(new Error(`glm pre-flight did not answer within ${timeoutMs}ms`)), timeoutMs);

    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', (chunk) => {
      stdout += chunk;
      if (Buffer.byteLength(stdout, 'utf8') > PEER_MAX_STDOUT_BYTES) terminate(new Error('glm pre-flight printed too much output'));
    });
    child.stderr?.on('data', (chunk) => {
      stderr += chunk;
      if (Buffer.byteLength(stderr, 'utf8') > PEER_MAX_STDOUT_BYTES) stderr = stderr.slice(-4096);
    });
    child.on('error', (err) => {
      if (terminating) return;
      finish(new Error(`could not start glm: ${err.message}`));
    });
    child.on('close', (code) => {
      if (terminating) return;
      if (code === 0) finish(null, stdout);
      else finish(new Error(`glm pre-flight exited with code ${code}${stderr ? `: ${stderr.slice(-400).trim()}` : ''}`));
    });
  });
}

/**
 * Prevention, not only detection: before a turn is allowed to run at all,
 * checks that nothing on this machine could let a "text-only" turn reach a
 * tool anyway. Two independent surfaces, both fail-closed:
 *   1. `plugins list` — refuses an enabled plugin with hooks, or with an MCP
 *      tool not in `knownSafeMcp` (see auditPluginsList()).
 *   2. `~/.zcode/cli/config.json` — refuses a user-level MCP server defined
 *      there, and refuses just as hard if the file cannot be read or parsed
 *      (see auditUserConfigMcpServers()).
 *
 * Runs before EVERY turn, uncached, on purpose (council review round 3): a
 * plugin can be enabled, or config.json edited, in the ten minutes after a
 * cached "safe" result was recorded — an install a user does BETWEEN two
 * turns is exactly when a stale cache would matter most. It also means a
 * turn's own cancellation (an aborted signal, a timeout) can only ever fail
 * THAT turn: there is nothing left behind that a later, unrelated turn could
 * inherit. The cost is one extra short-lived process per turn, which is
 * cheap next to what it is guarding.
 */
async function ensurePluginsPreflight({ command, argsPrefix, childEnv, spawnFn, signal, zcodeConfigPath, knownSafeMcp = KNOWN_SAFE_MCP }) {
  const stdout = await runZcodeSubcommand({ command, argsPrefix, args: ['plugins', 'list'], childEnv, spawnFn, cwd: os.tmpdir(), signal });
  auditPluginsList(parsePluginsList(stdout), { knownSafeMcp });
  auditUserConfigMcpServers(zcodeConfigPath);
}

/**
 * Where ZCode's CLI entry sits when nothing overrides it: the app's own
 * install directory, resolved the same way an Electron installer lays it
 * out on Windows. `env.LOCALAPPDATA` is honored rather than assumed, and
 * falls back to the usual `%LOCALAPPDATA%` shape under the home directory
 * so a caller that hands in a partial env (a test, for instance) still gets
 * a plausible path rather than `path.join(undefined, ...)` throwing.
 */
export function defaultZcodeCjsPath(env = process.env) {
  const localAppData = env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
  return path.join(localAppData, 'Programs', 'ZCode', 'resources', 'glm', 'zcode.cjs');
}

/**
 * Resolves what to spawn for one GLM turn.
 *
 * `KAPREK_ZCODE_PATH` may name the `zcode.cjs` script itself or a standalone
 * `.exe` built from it; everything else is `node <the resolved entry>`,
 * spawned directly — there is no PATH walk and no npm shim to resolve the
 * way grok.mjs needs one, because ZCode is not installed through npm and
 * this driver never guesses at a bare command name.
 */
export function resolveZcodeCli(env = process.env, { execPath = process.execPath } = {}) {
  const entryPath = env.KAPREK_ZCODE_PATH || defaultZcodeCjsPath(env);
  if (/\.exe$/i.test(entryPath)) return { command: entryPath, argsPrefix: [], entryPath };
  return { command: execPath, argsPrefix: [entryPath], entryPath };
}

/**
 * Where the provider config ZCode needs lives, relative to the entry it was
 * resolved from: `resources\glm\zcode.cjs` (or an `.exe` beside it) sits next
 * to `resources\config\provider\zcode-builtin.json`. Computed rather than
 * hardcoded so a KAPREK_ZCODE_PATH override still finds its own config.
 */
export function providerConfigPathFor(entryPath) {
  return path.join(path.dirname(entryPath), '..', 'config', 'provider', 'zcode-builtin.json');
}

/**
 * Takes as many leading characters of `str` as fit within `maxBytes` of
 * UTF-8, cutting only at character boundaries (a surrogate pair is never
 * split). Guarantees forward progress: the FIRST character is always taken,
 * however many bytes it costs, rather than returning an empty head when
 * even one character does not fit under `maxBytes` — an empty head here
 * once fed packLines() an unchanged remainder and looped forever (council
 * review, 27.09.2026). Only relevant at all below GLM_ATTACHMENT_MIN_BYTES,
 * which chunkPromptForZcode() already refuses; kept here anyway because a
 * helper's own correctness should not depend on its caller enforcing that.
 */
function sliceUtf8(str, maxBytes) {
  if (str.length === 0) return ['', ''];
  if (Buffer.byteLength(str, 'utf8') <= maxBytes) return [str, ''];
  let bytes = 0;
  let i = 0;
  while (i < str.length) {
    const codePoint = str.codePointAt(i);
    const char = String.fromCodePoint(codePoint);
    const charBytes = Buffer.byteLength(char, 'utf8');
    if (i > 0 && bytes + charBytes > maxBytes) break;
    bytes += charBytes;
    i += char.length; // 1 normally, 2 across a surrogate pair
    if (bytes >= maxBytes) break;
  }
  return [str.slice(0, i), str.slice(i)];
}

/**
 * Packs `text` into chunks of at most `limit` UTF-8 bytes, breaking on line
 * boundaries wherever it can — a chunk boundary lands right after a `\n`,
 * never mid-line. The one exception is a single line that alone exceeds
 * `limit`: there is nowhere else to cut it, so it is hard-split by bytes.
 * The `head === ''` guard is defense in depth for sliceUtf8()'s own forward-
 * progress guarantee: failing loudly beats looping forever if that
 * guarantee is ever broken by a future change.
 */
function packLines(text, limit) {
  const chunks = [];
  let current = '';
  const lines = text.split('\n');
  lines.forEach((line, idx) => {
    let piece = idx < lines.length - 1 ? `${line}\n` : line;
    while (Buffer.byteLength(piece, 'utf8') > limit) {
      if (current !== '') {
        chunks.push(current);
        current = '';
      }
      const [head, rest] = sliceUtf8(piece, limit);
      if (head === '') throw new Error('chunkPromptForZcode: internal error — no progress splitting an oversized line');
      chunks.push(head);
      piece = rest;
    }
    if (piece === '') return;
    const candidate = current + piece;
    if (current !== '' && Buffer.byteLength(candidate, 'utf8') > limit) {
      chunks.push(current);
      current = piece;
    } else {
      current = candidate;
    }
  });
  if (current !== '') chunks.push(current);
  return chunks;
}

/**
 * Splits a prompt into ZCode attachment files, each headered `[Teil k von n]`
 * so the model reads them in order and knows when it has seen the whole
 * task. This is what lets an arbitrarily large council package reach the
 * model at all: ZCode only shows a SINGLE attachment up to ~64 KB, and a
 * 114 KB prompt split into 3 parts of ~40 KB was read completely (verified
 * live, 27.09.2026) — grok hits a comparable wall around 24 KB with no
 * equivalent way around it, which is the whole reason --verbatim exists over
 * there instead of a chunking scheme here.
 *
 * `attachmentMaxBytes` below GLM_ATTACHMENT_MIN_BYTES is refused outright
 * (see that constant's own note) rather than silently accepted and left to
 * sliceUtf8()'s forward-progress guarantee to save the day.
 */
export function chunkPromptForZcode(prompt, { attachmentMaxBytes = GLM_ATTACHMENT_MAX_BYTES } = {}) {
  if (!(attachmentMaxBytes >= GLM_ATTACHMENT_MIN_BYTES)) {
    throw new Error(`attachmentMaxBytes must be at least ${GLM_ATTACHMENT_MIN_BYTES} bytes (got ${attachmentMaxBytes})`);
  }
  const bodyLimit = attachmentMaxBytes - GLM_CHUNK_HEADER_RESERVE_BYTES;
  const bodies = packLines(prompt, bodyLimit);
  const parts = bodies.length ? bodies : [''];
  const n = parts.length;
  return parts.map((body, idx) => `[Teil ${idx + 1} von ${n}]\n${body}`);
}

/**
 * The -p instruction: short on purpose, because the actual task lives in the
 * attachments. States the schema literally rather than trusting the model to
 * remember it from training — the dispatcher acts on `status`, so an answer
 * that drifts from {status, message} is a protocol error (see driver.mjs).
 * "Benutze keine Tools" is belt and braces here: the real locks are
 * --disallowed-tools, the pre-flight, and the post-turn audit, not this
 * sentence.
 */
export function buildGlmInstruction(schema = PEER_OUTPUT_SCHEMA, partCount = 1) {
  return (
    `Die angehängten Dateien "Teil 1 von ${partCount}" bis "Teil ${partCount} von ${partCount}" ` +
    'sind zusammen die vollständige Aufgabe. Lies sie in dieser Reihenfolge, benutze keine Tools ' +
    'und starte keinen eigenen Planungs- oder Recherche-Workflow. Antworte NUR mit einem einzigen ' +
    `JSON-Objekt, das exakt diesem Schema entspricht: ${JSON.stringify(schema)} ` +
    '— kein Fließtext davor oder danach, keine Code-Fences.'
  );
}

/**
 * The argv for one turn, minus the binary. Exported so a test can assert the
 * contract rather than trusting a comment. `cwd` is always the scratch
 * directory runGlmTurn() creates — see its own note on why the caller's cwd
 * never reaches here.
 */
export function buildGlmArgs({ instruction, attachmentPaths = [], cwd, mode = 'plan', disallowedTools = GLM_DISALLOWED_TOOLS } = {}) {
  const args = ['-p', instruction];
  for (const attachmentPath of attachmentPaths) args.push('--attach', attachmentPath);
  args.push('--mode', mode, '--json', '--disallowed-tools', disallowedTools);
  if (cwd) args.push('--cwd', cwd);
  return args;
}

/** A fenced ```json block around the answer, stripped if present — verified live: the model wraps `response` in one despite the schema being spelled out in the instruction. */
function stripJsonFences(text) {
  const trimmed = text.trim();
  const match = trimmed.match(/^```(?:json)?\s*\n?([\s\S]*?)\n?```$/);
  return match ? match[1].trim() : trimmed;
}

/**
 * Every position where a '{' begins a line (optional leading whitespace
 * allowed), in order. Restricting candidates to line-starts is what keeps a
 * brace inside a log MESSAGE ("missing key {retries}") from being mistaken
 * for the start of a JSON object — the naive "first '{' anywhere" this
 * replaced could pick that one and fail the whole parse over a coincidence
 * in a diagnostic line (council review, 27.09.2026).
 */
function candidateBraceIndexes(text) {
  const indexes = [];
  const re = /^[ \t]*\{/gm;
  let match = re.exec(text);
  while (match !== null) {
    indexes.push(match.index + match[0].length - 1);
    match = re.exec(text);
  }
  return indexes;
}

/**
 * The balanced `{...}` substring starting at `text[start]` (which must be
 * '{'), or null if the braces never close. Quotes and escapes are tracked so
 * a brace inside a JSON string does not end the object early — the same
 * technique src/council/consult.mjs::jsonObjects() uses for the same reason
 * (a peer's own answer is exactly the kind of text that contains braces).
 * Stopping at the matching close (rather than slicing to end-of-string, the
 * bug this replaced) is what lets a trailing log line after the envelope not
 * break the parse.
 */
function balancedObjectAt(text, start) {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i += 1) {
    const char = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') inString = true;
    else if (char === '{') depth += 1;
    else if (char === '}') {
      depth -= 1;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

/**
 * Pulls the answer out of what the CLI printed.
 *
 * ZCode's `--json` stdout is a JSON envelope, but rarely just that: plain log
 * lines can sit ahead of it ("ZCode Built-in skipped (not-due)"), an
 * unrelated but perfectly valid "diagnostic JSON" line can sit ahead of it
 * too, and a log line can trail after it. So this scans every line-start
 * '{' candidate in order, balanced-brace-extracts the object there, and
 * takes the FIRST one that parses AND has a string `response` field —
 * skipping a diagnostic object that parses fine but is not the envelope,
 * and never assuming the object that starts first is the one that matters
 * or that nothing follows it.
 */
export function parseGlmStdout(stdout, { validate = true } = {}) {
  const text = typeof stdout === 'string' ? stdout : '';
  const head = () => text.slice(0, 400).trim() || '(empty)';
  const candidates = candidateBraceIndexes(text);
  if (candidates.length === 0) throw new Error(`glm did not print JSON; first bytes: ${head()}`);

  let envelope = null;
  let lastParseError = null;
  for (const start of candidates) {
    const raw = balancedObjectAt(text, start);
    if (raw === null) continue;
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      lastParseError = err;
      continue;
    }
    if (parsed && typeof parsed === 'object' && typeof parsed.response === 'string') {
      envelope = parsed;
      break;
    }
  }
  if (envelope === null) {
    throw new Error(`glm did not print a JSON envelope with a "response" field; first bytes: ${head()}${lastParseError ? ` (${lastParseError.message})` : ''}`);
  }

  const stripped = stripJsonFences(envelope.response);
  // A relay turn must answer in the relay's own {status, message} shape; a
  // COUNCIL turn (src/council/ask.mjs) answers in a different shape entirely
  // and validates it itself — see grok.mjs's parseGrokStdout for the same
  // split and why.
  const answer = validate ? parsePeerAnswer(stripped) : { status: 'done', message: stripped };
  return {
    ...answer,
    usage: envelope?.usage ?? null,
    // ZCode never prints a cost figure at all (a subscription CLI billing a
    // plan, not a turn — see driver.mjs's PEER_COST_ESTIMATED): null, never
    // a guessed number, and never the 0 that would read as "this was free".
    costUsd: null,
    // Carried through only for auditNoToolsRan() to check against ZCode's
    // own session log; runGlmTurn() strips it back off before returning the
    // PeerTurnResult driver.mjs's contract describes.
    sessionId: typeof envelope?.sessionId === 'string' ? envelope.sessionId : null,
  };
}

/** Where ZCode writes its own per-day session log. Injectable (runGlmTurn's `zcodeLogDir` option) so a test never has to touch the real machine's ~/.zcode. */
export function defaultZcodeLogDir() {
  return path.join(os.homedir(), '.zcode', 'cli', 'log');
}

/** The most one session log file is trusted to weigh. A file heavier than this is refused outright rather than streamed regardless — reading an unbounded log defeats the point of streaming it in the first place. */
export const GLM_AUDIT_LOG_MAX_BYTES = 50 * 1024 * 1024;

/** The whole post-turn audit — every day's file, every line — gets this long in total before it fails closed. A hung or absurdly slow disk must not hold a turn's result hostage forever. */
export const GLM_AUDIT_TIME_BUDGET_MS = 10_000;

function localDateStamp(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/**
 * Streams one day's session log looking for `sessionId`, collecting
 * `toolName`s into the shared `toolNames` set. Returns whether at least one
 * line actually named this session — the POSITIVE evidence
 * auditNoToolsRan() requires, because a log file that exists but never
 * mentions this session is not proof that nothing ran, only proof that
 * nobody checked the right thing.
 *
 * Fails closed rather than skipping anything ambiguous, and does so with
 * REAL enforcement rather than a check that only fires between events:
 *   - a file already over `maxBytes` at open time is refused outright
 *     (fs.statSync, before a stream is even opened) — but a file that GROWS
 *     past the cap WHILE being read is caught too, by a running counter on
 *     the underlying stream's own 'data' event (not the readline line count,
 *     which says nothing about bytes actually read off disk). Council review
 *     round 3: the upfront size check alone samples the size once and trusts
 *     it for the rest of the read.
 *   - `deadlineAt` is enforced by an independent `setTimeout`, not merely
 *     checked between lines — a stream that never emits a line at all (or
 *     never ends) would otherwise let `for await` hang forever, since the
 *     loop body only runs once a line actually arrives. The timer destroys
 *     the underlying stream (not just the readline interface — closing only
 *     `rl` leaves a slow or stuck read in flight) so the process actually
 *     stops, not merely stops being listened to.
 *   - a line that CONTAINS the sessionId substring but does not parse as
 *     JSON might be a truncated or corrupted record hiding a tool call, so
 *     it stops the whole audit rather than being silently ignored.
 *
 * `createStream` is injectable (default `fs.createReadStream`) so a test can
 * exercise the deadline and byte-cap enforcement against a stream that never
 * ends or that grows mid-read, without needing a real 50 MB file or a real
 * stuck pipe.
 */
export async function scanSessionLogFile(filePath, sessionId, { toolNames = new Set(), deadlineAt = Date.now() + GLM_AUDIT_TIME_BUDGET_MS, maxBytes = GLM_AUDIT_LOG_MAX_BYTES, timeBudgetMs = GLM_AUDIT_TIME_BUDGET_MS, createStream } = {}) {
  let initialSize;
  try {
    initialSize = fs.statSync(filePath).size;
  } catch {
    return { found: false }; // no file for this day — not an error, just nothing to scan
  }
  if (initialSize > maxBytes) {
    throw new Error(`glm's session log ${filePath} is ${initialSize} bytes, over the ${maxBytes}-byte audit cap — answer discarded`);
  }

  const remainingMs = deadlineAt - Date.now();
  if (remainingMs <= 0) {
    throw new Error(`glm's post-turn tool audit exceeded its ${timeBudgetMs}ms budget — answer discarded`);
  }

  const makeStream = createStream ?? ((p) => fs.createReadStream(p, { encoding: 'utf8' }));
  const readStream = makeStream(filePath);
  const rl = readline.createInterface({ input: readStream, crlfDelay: Infinity });

  let bytesRead = 0;
  let overBudget = false; // the byte cap was exceeded WHILE reading (the file grew)
  let timedOut = false;

  readStream.on('data', (chunk) => {
    bytesRead += Buffer.byteLength(chunk, 'utf8');
    if (bytesRead > maxBytes) {
      overBudget = true;
      rl.close();
      readStream.destroy();
    }
  });
  // An independent timer, not a check inside the line loop: the loop body
  // only runs when a line actually arrives, so a stream that never emits
  // one (or never ends) would never trip a deadline that lived only inside
  // it. destroy(), not just rl.close() — closing the interface stops
  // READLINE from processing further, but leaves the underlying fs read (or
  // a stuck pipe) running in the background.
  const timer = setTimeout(() => {
    timedOut = true;
    rl.close();
    readStream.destroy();
  }, remainingMs);

  let found = false;
  try {
    for await (const line of rl) {
      if (line.trim() === '' || !line.includes(sessionId)) continue;
      let parsed;
      try {
        parsed = JSON.parse(line);
      } catch (err) {
        throw new Error(`glm's session log ${filePath} has a line mentioning the session that is not valid JSON — answer discarded (cannot confirm no tool ran): ${err.message}`);
      }
      if (parsed?.sessionId !== sessionId) continue; // a substring hit on a DIFFERENT session's id
      found = true;
      if (typeof parsed?.toolName === 'string') toolNames.add(parsed.toolName);
    }
  } finally {
    clearTimeout(timer);
    rl.close();
    readStream.destroy();
  }

  if (overBudget) {
    throw new Error(`glm's session log ${filePath} grew past the ${maxBytes}-byte audit cap while being read — answer discarded`);
  }
  if (timedOut) {
    throw new Error(`glm's post-turn tool audit exceeded its ${timeBudgetMs}ms budget — answer discarded`);
  }
  return { found };
}

/**
 * Every `toolName` a given session actually invoked, read from ZCode's own
 * JSONL log, PLUS whether the session was actually found at all. Only the
 * log files for the turn's own start and end LOCAL calendar dates are
 * opened — not a blanket window around whenever the audit happens to run —
 * so a turn that starts at 23:59 and ends at 00:01 still gets both of its
 * two files checked, and nothing else is read.
 */
export async function toolNamesForSession(sessionId, { zcodeLogDir, startedAt, endedAt, maxBytes = GLM_AUDIT_LOG_MAX_BYTES, timeBudgetMs = GLM_AUDIT_TIME_BUDGET_MS, createStream }) {
  const toolNames = new Set();
  const dateStamps = new Set([localDateStamp(startedAt), localDateStamp(endedAt)]);
  const deadlineAt = Date.now() + timeBudgetMs;
  let anyFound = false;
  for (const stamp of dateStamps) {
    const filePath = path.join(zcodeLogDir, `zcode-${stamp}.jsonl`);
    // eslint-disable-next-line no-await-in-loop -- each day's file must finish (or fail) before the next starts, so the shared deadline and byte cap mean what they say
    const { found } = await scanSessionLogFile(filePath, sessionId, { toolNames, deadlineAt, maxBytes, timeBudgetMs, createStream });
    if (found) anyFound = true;
  }
  return { names: [...toolNames], anyFound };
}

/**
 * The fail-closed guard the static --disallowed-tools list and the
 * pre-flight alone cannot be: checks ZCode's OWN log for whatever tools the
 * session actually invoked. Requires POSITIVE evidence — at least one log
 * line naming this exact sessionId — rather than treating "a log file
 * exists for today" as good enough; a session that was never logged at all
 * (crashed, wrong directory, log rotated away) fails exactly like a tool
 * call would, not like a pass. Unless KAPREK_GLM_SKIP_TOOL_AUDIT=1, an
 * escape hatch for a machine where the log genuinely is not where
 * defaultZcodeLogDir() looks.
 */
async function auditNoToolsRan(sessionId, { env = process.env, zcodeLogDir = defaultZcodeLogDir(), startedAt, endedAt, maxBytes, timeBudgetMs } = {}) {
  if (String(env?.[GLM_TOOL_AUDIT_SKIP_ENV] ?? '') === '1') return;
  if (typeof sessionId !== 'string' || sessionId === '') {
    throw new Error(`glm answered with no sessionId to audit — answer discarded (cannot confirm no tool ran; set ${GLM_TOOL_AUDIT_SKIP_ENV}=1 to bypass)`);
  }
  const { names, anyFound } = await toolNamesForSession(sessionId, { zcodeLogDir, startedAt, endedAt, maxBytes, timeBudgetMs });
  if (!anyFound) {
    throw new Error(`glm's session log has no evidence for session ${sessionId} — answer discarded (cannot confirm no tool ran; set ${GLM_TOOL_AUDIT_SKIP_ENV}=1 to bypass)`);
  }
  if (names.length > 0) {
    throw new Error(`glm peer invoked tools: ${names.join(', ')} — answer discarded (text-only contract violated)`);
  }
}

/**
 * Kills a child and, on Windows, the process tree under it.
 *
 * Order matters, and reversing it was a real bug (council review,
 * 27.09.2026): `taskkill /pid <pid> /t /f` needs the pid to still be a live
 * process when it runs, because `/t` asks Windows to enumerate that pid's
 * CURRENT children. Calling `child.kill()` first can make node's own child
 * exit before taskkill ever looks, and `/pid <an-already-exited-pid> /t`
 * then finds nothing and kills nothing — orphaning whatever grandchild the
 * CLI had spawned. So on win32 taskkill runs FIRST, spawned with
 * `windowsHide` and its own `error` listener (a helper that fails to start
 * must not throw out of here), and is AWAITED — with a short timeout of its
 * own, so a stuck taskkill cannot hang the caller — before `child.kill()`
 * runs as the fallback for whatever taskkill's snapshot missed. Returns a
 * promise so a caller reports the turn as over only once the kill attempt
 * has actually settled, not merely been requested.
 */
export function killTree(child, { spawnFn = spawn } = {}) {
  return new Promise((resolve) => {
    let settled = false;
    let guard = null;
    const finish = () => {
      if (settled) return;
      settled = true;
      if (guard) clearTimeout(guard);
      try {
        child.kill();
      } catch {
        // already gone
      }
      resolve();
    };

    if (!child.pid || process.platform !== 'win32') {
      if (child.pid && process.platform !== 'win32') {
        try {
          process.kill(-child.pid, 'SIGKILL');
        } catch {
          // no process group, or already gone
        }
      }
      finish();
      return;
    }

    let killer;
    try {
      killer = spawnFn('taskkill', ['/pid', String(child.pid), '/t', '/f'], { windowsHide: true, stdio: 'ignore' });
    } catch {
      finish();
      return;
    }
    killer.on('error', finish);
    killer.on('close', finish);
    guard = setTimeout(finish, 3_000);
    guard.unref?.();
  });
}

/**
 * Runs one GLM turn.
 *
 * Never rejects for a turn-level failure — same contract as runGrokTurn() —
 * but must never hang: a timeout kills the tree, and stdout past the cap
 * ends the turn instead of growing until the process runs out of memory.
 *
 * `cwd` is accepted (the PeerDriver contract in driver.mjs describes it) but
 * deliberately never used to decide where the ZCode process itself runs —
 * see the fresh scratch directory built below.
 */
export async function runGlmTurn({
  cwd,
  prompt,
  timeoutMs = PEER_TIMEOUT_MS,
  signal,
  logDir = null,
  spawnFn = spawn,
  env = process.env,
  schema = PEER_OUTPUT_SCHEMA,
  validate = true,
  attachmentMaxBytes = GLM_ATTACHMENT_MAX_BYTES,
  zcodeLogDir = defaultZcodeLogDir(),
  zcodeConfigPath = defaultZcodeConfigPath(),
  knownSafeMcp = KNOWN_SAFE_MCP,
  auditLogMaxBytes = GLM_AUDIT_LOG_MAX_BYTES,
  auditTimeBudgetMs = GLM_AUDIT_TIME_BUDGET_MS,
} = {}) {
  // Checked before ANYTHING else — no scratch directory, no attachment file,
  // no spawn — for a signal that was already aborted when this turn was
  // asked for.
  if (signal?.aborted) throw new Error('the relay run was stopped');
  if (typeof prompt !== 'string' || prompt.trim().length === 0) throw new Error('a peer turn needs a prompt');
  const promptBytes = Buffer.byteLength(prompt, 'utf8');
  if (promptBytes > GLM_MAX_PROMPT_BYTES) {
    throw new Error(`the prompt is ${promptBytes} bytes; keep it under ${GLM_MAX_PROMPT_BYTES} bytes (GLM_MAX_PROMPT_BYTES)`);
  }

  const { command, argsPrefix, entryPath } = resolveZcodeCli(env);
  const providerConfigPath = providerConfigPathFor(entryPath);
  // The child's WHOLE environment, built from an allowlist — never
  // process.env passed through (see buildGlmChildEnv's own note) — plus this
  // one addition, never overwritten when it is already set (a caller's
  // ZCODE_BUILTIN_PROVIDER_CONFIG_FILE, picked up by the ZCODE_ prefix rule,
  // still wins). Without it the CLI aborts before the model ever runs.
  const childEnv = buildGlmChildEnv(env);
  if (!childEnv.ZCODE_BUILTIN_PROVIDER_CONFIG_FILE) childEnv.ZCODE_BUILTIN_PROVIDER_CONFIG_FILE = providerConfigPath;

  // Prevention before detection: refuses before a turn ever starts if this
  // machine's plugin/MCP surface could let a "text-only" turn reach a tool
  // anyway. Runs every turn, uncached (see ensurePluginsPreflight's note).
  await ensurePluginsPreflight({ command, argsPrefix, childEnv, spawnFn, signal, zcodeConfigPath, knownSafeMcp });

  const turnStartedAt = new Date();
  const startedAt = turnStartedAt.getTime();
  let turnDir = null;
  let rawLogPath = null;
  let attachmentPaths = [];
  try {
    // A fresh, unique directory per turn — mkdtemp'd, never the caller's
    // `cwd` (never the mission tree the caller might pass): this is both
    // where the ZCode process itself stands (--cwd below, always) and where
    // its own attachment files and raw log live, so two concurrent turns
    // that happen to share `logDir` cannot collide the way two turns racing
    // to the same millisecond-and-pid stamp once could (council review,
    // 27.09.2026).
    const parentDir = logDir ?? os.tmpdir();
    fs.mkdirSync(parentDir, { recursive: true });
    turnDir = fs.mkdtempSync(path.join(parentDir, 'kaprek-glm-turn-'));
    rawLogPath = path.join(turnDir, 'glm-raw.log');

    const parts = chunkPromptForZcode(prompt, { attachmentMaxBytes });
    for (let idx = 0; idx < parts.length; idx += 1) {
      const partPath = path.join(turnDir, `glm-prompt-${idx + 1}.txt`);
      // Registered BEFORE it is written: a failure writing THIS file (disk
      // full, permissions) still leaves its path in the cleanup list, so the
      // finally block below does not skip it just because the write itself
      // never finished (council review round 2, 27.09.2026).
      attachmentPaths.push(partPath);
      fs.writeFileSync(partPath, parts[idx], 'utf8');
    }

    const instruction = buildGlmInstruction(schema, parts.length);
    const args = [
      ...argsPrefix,
      ...buildGlmArgs({ instruction, attachmentPaths, cwd: turnDir, disallowedTools: effectiveDisallowedTools(env) }),
    ];

    const result = await new Promise((resolve) => {
      let stdout = '';
      let stderr = '';
      let overflowed = false;
      let settled = false;
      let child = null;
      let timer = null;

      const finish = (value) => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        signal?.removeEventListener?.('abort', onAbort);
        resolve(value);
      };

      // The single, idempotent path into a deliberate termination.
      // `terminating` is the lock: the FIRST of timeout/abort/overflow to
      // fire is the one whose reason wins, committed as that call's own
      // argument rather than a shared variable a second trigger could
      // overwrite before the first's callback ever reads it back. A second
      // trigger here is a no-op: no second killTree() call, no reason swap
      // (council review round 2, 27.09.2026 — the same fix as grok.mjs's).
      let terminating = null;
      const terminate = (reason) => {
        if (terminating) return terminating;
        terminating = (child ? killTree(child) : Promise.resolve()).then(() => finish(reason));
        return terminating;
      };

      const onAbort = () => terminate({ error: 'the relay run was stopped', stdout, stderr });
      signal?.addEventListener?.('abort', onAbort, { once: true });
      // Checked again right here: the signal could only have become aborted
      // between the top-of-function check and this point through something
      // this function itself did, and everything up to here is synchronous
      // — but a defensive re-check costs nothing and does not rely on that
      // reasoning staying true after a future refactor.
      if (signal?.aborted) {
        onAbort();
        return;
      }

      try {
        child = spawnFn(command, args, {
          cwd: turnDir,
          env: childEnv,
          windowsHide: true,
          // Own process group on POSIX so the timeout can take the whole tree.
          detached: process.platform !== 'win32',
          stdio: ['ignore', 'pipe', 'pipe'],
        });
      } catch (err) {
        finish({ error: `could not start glm: ${err.message}`, stdout, stderr });
        return;
      }

      timer = setTimeout(() => {
        terminate({ error: `glm did not answer within ${timeoutMs}ms`, stdout, stderr });
      }, timeoutMs);

      // Decoded here, not concatenated as raw Buffers: setEncoding buffers an
      // incomplete multi-byte sequence internally and only emits whole
      // characters, so a character split across two 'data' events comes out
      // correct instead of as replacement characters at the seam (council
      // review, 27.09.2026).
      child.stdout?.setEncoding('utf8');
      child.stderr?.setEncoding('utf8');

      child.stdout?.on('data', (chunk) => {
        if (overflowed) return;
        stdout += chunk;
        if (Buffer.byteLength(stdout, 'utf8') > PEER_MAX_STDOUT_BYTES) {
          overflowed = true;
          terminate({ error: `glm printed more than ${PEER_MAX_STDOUT_BYTES} bytes`, stdout, stderr });
        }
      });
      child.stderr?.on('data', (chunk) => {
        stderr += chunk;
        if (Buffer.byteLength(stderr, 'utf8') > PEER_MAX_STDOUT_BYTES) stderr = stderr.slice(-4096);
      });

      child.on('error', (err) => {
        if (terminating) return; // the pending termination's own finish() call owns the outcome
        finish({ error: `could not start glm: ${err.message}`, stdout, stderr });
      });
      child.on('close', (code) => {
        if (terminating) return; // ditto — this close is the kill taking effect, not a new fact
        if (code === 0) finish({ stdout, stderr });
        else finish({ error: `glm exited with code ${code}${stderr ? `: ${stderr.slice(-400).trim()}` : ''}`, stdout, stderr });
      });
    });

    try {
      fs.writeFileSync(rawLogPath, `--- stdout ---\n${result.stdout ?? ''}\n--- stderr ---\n${result.stderr ?? ''}\n`, 'utf8');
    } catch {
      // The log is a convenience; losing it must not lose the turn.
    }

    if (result.error) {
      const err = new Error(result.error);
      err.rawLogPath = rawLogPath;
      throw err;
    }

    const { sessionId, ...parsed } = parseGlmStdout(result.stdout, { validate });
    // The fail-closed guard: a text-only turn that ZCode's own log says
    // invoked a tool anyway is discarded here, before the caller ever sees
    // it — see auditNoToolsRan()'s own note for why the static
    // --disallowed-tools list and the pre-flight alone are not enough.
    await auditNoToolsRan(sessionId, {
      env,
      zcodeLogDir,
      startedAt: turnStartedAt,
      endedAt: new Date(),
      maxBytes: auditLogMaxBytes,
      timeBudgetMs: auditTimeBudgetMs,
    });
    return { ...parsed, durationMs: Date.now() - startedAt, rawLogPath };
  } finally {
    // The raw log stays (it is the one place a post-mortem can look); only
    // the attachment files — the draft itself — are removed.
    for (const partPath of attachmentPaths) {
      try {
        fs.unlinkSync(partPath);
      } catch {
        // best-effort
      }
    }
  }
}

export const glmDriver = registerPeerDriver({
  id: 'glm',
  available(env = process.env) {
    // File existence, never a spawn — a settings page deciding what to offer
    // must not start processes (same rule grok.mjs's available() follows).
    const { entryPath } = resolveZcodeCli(env);
    return fs.existsSync(entryPath);
  },
  runTurn: runGlmTurn,
  maxPromptBytes: GLM_MAX_PROMPT_BYTES,
});
