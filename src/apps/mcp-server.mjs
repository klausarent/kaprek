#!/usr/bin/env node
// Standalone stdio MCP server that exposes kaprek apps' tools to Claude
// Code (or any other MCP client) via `--mcp-config` (see mcp-config.mjs).
// Claude Code spawns THIS file as its own child process — kaprek's own
// server/CLI code never imports it (that's why it's fine for this file to
// read stdin/write stdout directly instead of exporting a library API; the
// pure helpers below are exported anyway so tests can unit-test them
// without paying for a subprocess every time). The sandbox itself (Node's
// --permission model) is applied by the CALLER — see mcp-config.mjs's
// writeMcpConfig(); this file has no idea whether it's running sandboxed.
//
// Protocol: JSON-RPC 2.0, one message per line on stdin/stdout. Field names
// verified against the official MCP schema (modelcontextprotocol/
// modelcontextprotocol, schema/2025-06-18/schema.json) rather than guessed:
// InitializeResult = {protocolVersion, capabilities, serverInfo}, Tool =
// {name, description, inputSchema}, CallToolResult = {content, isError?}.
// Lifecycle also follows that spec: initialize -> initialized notification
// -> normal operation (see classifyMessage()/handleMessage()'s `state`
// argument) — https://modelcontextprotocol.io/specification/2025-06-18/basic/lifecycle.
//
// Tool-id-is-canon (see manifest.mjs / loader.mjs): the registry built below
// is keyed by tool id, resolved by scanning each app's manifest.tools[] —
// never by trusting a caller-supplied handler path. tools/call's own wire
// shape only ever carries {name, arguments} (see CallToolRequest in the
// schema), so there is no handler-path field for a caller to forge in the
// first place; the registry construction here is the second line of
// defense on top of that.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { loadApps, resolveToolOwnership } from './loader.mjs';
import { readFile as wsReadFile, writeFile as wsWriteFile, listFiles as wsListFiles } from '../workspace/fs.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const PROTOCOL_VERSION = '2025-06-18';
// Exported (not just a local const) so anything that needs to recognize a
// tool call as belonging to THIS MCP server from the outside — e.g.
// src/triggers/runner.mjs's notify-escalation policy decider, matching a
// harness's qualified `mcp__<server>__<tool>` tool name — can reference the
// single source of truth instead of duplicating the literal a third time
// (mcp-config.mjs's `mcpServers` key is the second, unavoidable copy: it's
// JSON, not code, so it can't import this).
export const SERVER_NAME = 'kaprek-apps';

// A hung/misbehaving handler must not hold a request (and the client
// waiting on it) forever — see withTimeout()'s use in tools/call below.
const HANDLER_TIMEOUT_MS = 60_000;
// A CallToolResult's text is capped (UTF-8 bytes) so a runaway handler
// result can't flood the stdout pipe the client is reading — see
// truncateOutput().
const MAX_OUTPUT_BYTES = 256 * 1024;
// No single stdin line (a full JSON-RPC message) may exceed this many bytes
// — see run()'s manual buffering below for why this can't just be a
// node:readline option (it doesn't have one).
const MAX_LINE_BYTES = 4 * 1024 * 1024;
// At most this many handleMessage() calls run concurrently; the rest queue
// — an app driving many parallel tool calls must not be able to fork this
// process's work unboundedly (fan-out bound, separate from
// HANDLER_TIMEOUT_MS's per-call bound).
const MAX_CONCURRENT_REQUESTS = 8;
// MAX_CONCURRENT_REQUESTS bounds work in flight, not work waiting — a
// stdin flood (far more lines than can ever be drained at 8-at-a-time)
// would otherwise grow `queue` (see run()) without bound, one JS string per
// message, until this process runs out of memory. Once the queue is this
// deep, a new request is rejected outright (-32603) instead of queued —
// this process is falling behind and adding more work only makes it worse.
const MAX_QUEUE_DEPTH = 64;

const KNOWN_JSON_TYPES = ['string', 'number', 'boolean', 'object', 'array'];

/** The one place `<dataDir>/workspace` is spelled out — reused by mcp-config.mjs so the sandbox's --allow-fs-write target can never drift from what run() actually uses. */
export function workspaceDirFor(dataDir) {
  return path.join(dataDir, 'workspace');
}

function serverVersion() {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'package.json'), 'utf8'));
    return typeof pkg.version === 'string' ? pkg.version : '0.0.0';
  } catch {
    return '0.0.0';
  }
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Builds the tool registry: a Map from canonical tool id to
 * `{app, tool}` (`app` is the loader's `{manifest, dir, source}` entry).
 * Only ids found by iterating `app.manifest.tools[]` are ever added — see
 * the module header on why that's the whole security model here.
 *
 * Which app owns which id is decided by loader.mjs::resolveToolOwnership(),
 * the SAME function the trigger policy asks (src/triggers/runner.mjs) — one
 * answer for both, or the two could disagree about who `notes.write` belongs
 * to. A tool id claimed by two apps is registered for NEITHER (it used to
 * keep the first one found): with two claimants there is no way to tell which
 * one a caller means, and picking one by directory order is a coin toss with
 * an authorization decision on it. Reported in `warnings`, never fatal.
 */
export function buildToolRegistry(apps) {
  const registry = new Map();
  const { owners, warnings } = resolveToolOwnership(apps);
  for (const app of apps) {
    for (const tool of app.manifest.tools) {
      if (owners.get(tool.id) !== app.manifest.id) continue; // contested or owned by another app
      registry.set(tool.id, { app, tool });
    }
  }
  return { registry, warnings };
}

function okResponse(id, result) {
  return { jsonrpc: '2.0', id, result };
}

function errorResponse(id, code, message) {
  return { jsonrpc: '2.0', id: id ?? null, error: { code, message } };
}

function validRequestId(id) {
  return typeof id === 'string' || typeof id === 'number';
}

/** Extracts a usable id from a malformed message for an Invalid Request error response — null if none can be determined, per JSON-RPC 2.0's own guidance for that case ("if it was not possible ... it MUST be Null"). */
function extractIdIfValid(msg) {
  return isPlainObject(msg) && 'id' in msg && validRequestId(msg.id) ? msg.id : null;
}

/**
 * Classifies one already-JSON-parsed message before any method dispatch —
 * the JSON-RPC 2.0 envelope check the MCP spec assumes but doesn't itself
 * define: right `jsonrpc` version, a real `method` string, and an `id`
 * that's either absent (only ever treated as a true notification when the
 * method is also namespaced `notifications/...` — this server does not
 * treat an arbitrary id-less method as "fire and forget") or a valid
 * string/number (not `null`, not an object/array). Everything else is
 * `invalid`. A top-level JSON array is also `invalid` — JSON-RPC batching
 * is out of scope, matching the MCP 2025-06-18 spec, which dropped it.
 */
function classifyMessage(msg) {
  if (!isPlainObject(msg)) {
    return { kind: 'invalid', id: null, reason: 'message must be a JSON object' };
  }
  if (msg.jsonrpc !== '2.0') {
    return { kind: 'invalid', id: extractIdIfValid(msg), reason: 'jsonrpc must be "2.0"' };
  }
  if (typeof msg.method !== 'string' || msg.method.length === 0) {
    return { kind: 'invalid', id: extractIdIfValid(msg), reason: 'method must be a non-empty string' };
  }
  if (!('id' in msg)) {
    if (msg.method.startsWith('notifications/')) {
      return { kind: 'notification', method: msg.method, params: msg.params };
    }
    return { kind: 'invalid', id: null, reason: 'request is missing an id' };
  }
  if (!validRequestId(msg.id)) {
    return { kind: 'invalid', id: null, reason: 'id must be a string or number, not null/object/array' };
  }
  return { kind: 'request', id: msg.id, method: msg.method, params: msg.params };
}

/**
 * Loads the handler module for `entry` (a registry `{app, tool}` pair).
 * Two checks before `import()` ever runs, both defense in depth on top of
 * the real authorization boundary (tool id lookup in the registry — see the
 * module header), not the boundary itself:
 *   - lexical containment: the un-resolved handler path must stay inside
 *     the app directory (catches "../../evil.mjs" even before touching disk;
 *     manifest.mjs already rejects this at load time too, this is a second
 *     line of defense against a manifest that was hand-edited after loading).
 *   - real-path containment: `realpathSync` both sides and re-check —
 *     lexical containment alone says nothing about a symlink placed AT the
 *     handler path (or an ancestor of it) that resolves somewhere outside
 *     the app directory entirely; `import()` follows symlinks like any
 *     other fs read, so this is what actually stops that.
 */
async function loadHandler(entry) {
  const appDirResolved = path.resolve(entry.app.dir);
  const handlerPath = path.resolve(appDirResolved, entry.tool.handler);
  if (handlerPath !== appDirResolved && !handlerPath.startsWith(appDirResolved + path.sep)) {
    throw new Error(`handler path escapes app directory: ${entry.tool.handler}`);
  }

  let realHandlerPath;
  let realAppDir;
  try {
    realHandlerPath = fs.realpathSync(handlerPath);
    realAppDir = fs.realpathSync(appDirResolved);
  } catch (err) {
    throw new Error(`could not resolve handler path: ${err.message}`);
  }
  if (realHandlerPath !== realAppDir && !realHandlerPath.startsWith(realAppDir + path.sep)) {
    throw new Error(`handler path resolves outside the app directory (symlink?): ${entry.tool.handler}`);
  }

  const mod = await import(pathToFileURL(realHandlerPath).href);
  if (typeof mod.handler !== 'function') {
    throw new Error(`handler module does not export an async function 'handler': ${entry.tool.handler}`);
  }
  return mod.handler;
}

function typeMatches(value, type) {
  switch (type) {
    case 'string':
      return typeof value === 'string';
    case 'number':
      return typeof value === 'number' && Number.isFinite(value);
    case 'boolean':
      return typeof value === 'boolean';
    case 'object':
      return isPlainObject(value);
    case 'array':
      return Array.isArray(value);
    default:
      return true; // an unsupported/unknown declared type is not enforced here
  }
}

/**
 * Minimal, non-recursive check of a tools/call `arguments` value against
 * its tool's `inputSchema`: required top-level fields present, no unknown
 * top-level keys, and declared types for string/number/boolean/object/array
 * match. Not a JSON Schema implementation (no $ref, no nested/array-item
 * validation, no format/pattern/enum/minimum/etc.) — enough to reject an
 * obviously malformed call before it ever reaches a handler, with zero
 * added dependencies (matches this project's "zero runtime-deps" rule).
 * Returns `null` when valid or when `schema` itself isn't a usable object
 * (a handler still gets called with whatever it received in that case —
 * this is a courtesy check on top of a handler's own input validation, not
 * a replacement for it), or a message describing the first violation found.
 */
function validateToolArguments(args, schema) {
  if (!isPlainObject(schema)) return null;
  const properties = isPlainObject(schema.properties) ? schema.properties : {};
  const required = Array.isArray(schema.required) ? schema.required : [];
  const topType = schema.type ?? 'object';

  if (topType === 'object') {
    if (!isPlainObject(args)) return 'arguments must be an object';
    for (const key of Object.keys(args)) {
      if (!(key in properties)) return `unexpected argument ${JSON.stringify(key)}`;
    }
    for (const key of required) {
      if (!(key in args)) return `missing required argument ${JSON.stringify(key)}`;
    }
    for (const [key, value] of Object.entries(args)) {
      const propSchema = properties[key];
      if (isPlainObject(propSchema) && KNOWN_JSON_TYPES.includes(propSchema.type) && !typeMatches(value, propSchema.type)) {
        return `argument ${JSON.stringify(key)} must be of type ${propSchema.type}`;
      }
    }
    return null;
  }

  if (KNOWN_JSON_TYPES.includes(topType) && !typeMatches(args, topType)) {
    return `arguments must be of type ${topType}`;
  }
  return null;
}

/** Races `promise` against a `ms` timeout; rejects with `new Error(message)` if the timeout wins. Does not (cannot) cancel `promise` itself — a handler that ignores this just keeps running in the background, unobserved; the point is only to stop the REQUEST from hanging forever. */
function withTimeout(promise, ms, message) {
  let timer;
  const timeout = new Promise((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/** Caps `text` at MAX_OUTPUT_BYTES (UTF-8 bytes, not JS string length) with a trailing note when it had to cut — an oversized handler result must not flood the stdout pipe the client reads from. */
function truncateOutput(text) {
  if (Buffer.byteLength(text, 'utf8') <= MAX_OUTPUT_BYTES) return text;
  const truncated = Buffer.from(text, 'utf8').subarray(0, MAX_OUTPUT_BYTES).toString('utf8');
  return `${truncated}\n... [truncated: output exceeded ${MAX_OUTPUT_BYTES} bytes]`;
}

/**
 * Builds the `ctx.workspace` a handler actually receives — this, not a raw
 * `workspaceDir` string, is the tools/call enforcement point for
 * `manifest.mjs`'s `policy.fsWrite`. A handler is never handed
 * `workspaceDir` itself (see handleMessage()'s tools/call branch below): the
 * only way to reach the workspace is through the functions returned here,
 * so when `fsWrite` is `false` there simply IS no `writeFile` to call —
 * `ctx.workspace.writeFile(...)` throws a plain TypeError ("not a
 * function"), caught by the same try/catch already wrapping every handler
 * call and surfaced as a normal `isError: true` CallToolResult.
 *
 * Explicitly NOT a hard security boundary — kept honest, not oversold: the
 * OS-level grant behind this (`--allow-fs-write=<dataDir>/workspace`, see
 * mcp-config.mjs) is a single process-wide Node `--permission` flag that
 * every app's handler shares, regardless of that app's own `fsWrite`
 * policy. A handler could still `import()` `../../src/workspace/fs.mjs` (or
 * raw `node:fs`) itself and reconstruct the workspace path some other way,
 * and Node's OS-level permission would allow that write — this function
 * only removes the CONVENIENT path, it cannot revoke a capability the
 * process already has. Real per-app write isolation needs per-app
 * `--allow-fs-write` roots (i.e. per-app subprocesses), tracked separately
 * (see the review this responds to) — not something one shared process can
 * give one of its apps and not another.
 */
function createWorkspaceCtx({ workspaceDir, fsWrite }) {
  const workspace = {
    readFile: ({ relPath }) => wsReadFile({ workspaceDir, relPath }),
    listFiles: ({ relPath } = {}) => wsListFiles({ workspaceDir, relPath }),
  };
  if (fsWrite) {
    workspace.writeFile = ({ relPath, data }) => wsWriteFile({ workspaceDir, relPath, data });
  }
  return workspace;
}

/**
 * Handles one parsed JSON-RPC message and returns the response object to
 * write (or `null` for a notification/invalid-envelope-without-id, which
 * never gets a response on the wire).
 *
 * `ctx.state` is a small mutable `{phase}` object the CALLER owns and
 * reuses across every message of one connection (see run()) — `'
 * uninitialized' -> 'initializing' -> 'ready'`, following the MCP lifecycle:
 * nothing except `initialize` is accepted in `'uninitialized'`, and nothing
 * except `initialize`/`notifications/initialized` is accepted before
 * `'ready'`. This is deliberately strict (some real clients are lenient
 * about ordering) because "no lifecycle state at all" was the actual bug
 * being fixed here.
 *
 * Never throws: a HANDLER exception (or handler timeout) becomes a
 * CallToolResult with `isError: true` (per the MCP spec — tool-execution
 * errors belong INSIDE the result, not as a protocol-level error, so the
 * model can see and react to them); a SERVER/packaging defect (failed to
 * import the handler module, no `handler` export, unknown tool, malformed
 * envelope, wrong lifecycle state) becomes a normal JSON-RPC error
 * response instead — those are two different failure classes and must not
 * be reported the same way (see loadHandler()'s call site below).
 */
export async function handleMessage(msg, ctx) {
  const { registry, workspaceDir, state } = ctx;
  const classified = classifyMessage(msg);

  if (classified.kind === 'invalid') {
    return errorResponse(classified.id, -32600, `invalid request: ${classified.reason}`);
  }

  if (classified.kind === 'notification') {
    if (classified.method === 'notifications/initialized' && state.phase === 'initializing') {
      state.phase = 'ready';
    }
    // Any other notification (or this one arriving in an unexpected phase)
    // is acknowledged the same way every notification is: silently, no
    // response — notifications never get one on the wire.
    return null;
  }

  const { id, method, params } = classified;

  if (method === 'initialize') {
    if (state.phase !== 'uninitialized') {
      return errorResponse(id, -32600, 'server has already received "initialize"');
    }
    state.phase = 'initializing';
    return okResponse(id, {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: { tools: {} },
      serverInfo: { name: SERVER_NAME, version: serverVersion() },
    });
  }

  if (state.phase !== 'ready') {
    // -32002 is outside JSON-RPC's own reserved range (-32768..-32000) but
    // inside the range the spec explicitly leaves free for
    // implementation-defined server errors; used consistently for exactly
    // this one condition ("too early"), distinct from -32600 (malformed
    // request) and -32601 (no such method at all) — documented here since
    // the spec doesn't mandate a specific code for it.
    return errorResponse(
      id,
      -32002,
      `server not initialized: call "initialize" and send "notifications/initialized" before "${method}"`,
    );
  }

  if (method === 'tools/list') {
    const tools = [...registry.values()].map(({ tool }) => ({
      name: tool.id,
      description: tool.description,
      inputSchema: tool.inputSchema,
    }));
    return okResponse(id, { tools });
  }

  if (method === 'tools/call') {
    const name = params?.name;
    const args = params?.arguments ?? {};
    const entry = registry.get(name);
    if (!entry) {
      // "Errors in finding the tool" are a protocol-level error per the MCP
      // spec, not a CallToolResult with isError — see the module header.
      return errorResponse(id, -32602, `unknown tool: ${JSON.stringify(name)}`);
    }

    const schemaViolation = validateToolArguments(args, entry.tool.inputSchema);
    if (schemaViolation) {
      return errorResponse(id, -32602, `invalid arguments for tool ${JSON.stringify(name)}: ${schemaViolation}`);
    }

    let handler;
    try {
      handler = await loadHandler(entry);
    } catch (err) {
      // Import failure / missing export / handler-path escape are server
      // defects, not the tool "running and failing" — see this function's
      // docstring on why these two error classes are kept apart.
      return errorResponse(id, -32603, `failed to load handler for tool ${JSON.stringify(name)}: ${err.message ?? String(err)}`);
    }

    // ctx.handlerTimeoutMs overrides HANDLER_TIMEOUT_MS — only ever set by
    // tests, so they can prove the timeout path fires without a real 60s
    // wait; run() (real stdin/stdout usage) never sets it, so production
    // always gets the full HANDLER_TIMEOUT_MS.
    const timeoutMs = ctx.handlerTimeoutMs ?? HANDLER_TIMEOUT_MS;
    // No raw `dataDir`/`workspaceDir` string is ever handed to a handler —
    // only `workspace` (policy-gated, see createWorkspaceCtx()) and
    // `appDir`. `dataDir` in particular has no legitimate handler use (it's
    // a strict superset of `workspace` containing other apps'/kaprek's own
    // data) and giving it out would make the whole point of mcp-config.mjs's
    // narrowed `--allow-fs-read` moot the moment a handler reads it back.
    const workspace = createWorkspaceCtx({ workspaceDir, fsWrite: entry.app.manifest.policy.fsWrite });
    try {
      const result = await withTimeout(
        handler(args, { workspace, appDir: entry.app.dir }),
        timeoutMs,
        `tool ${JSON.stringify(name)} timed out after ${timeoutMs}ms`,
      );
      const text = typeof result === 'string' ? result : JSON.stringify(result ?? null);
      return okResponse(id, { content: [{ type: 'text', text: truncateOutput(text) }] });
    } catch (err) {
      return okResponse(id, { content: [{ type: 'text', text: truncateOutput(err.message ?? String(err)) }], isError: true });
    }
  }

  return errorResponse(id, -32601, `method not found: ${JSON.stringify(method)}`);
}

/**
 * Runs the server on real stdin/stdout: reads newline-delimited JSON
 * requests, writes newline-delimited JSON responses. `apps`-loading errors
 * (broken manifests, duplicate ids) are logged to stderr, never stdout —
 * stdout is reserved for the JSON-RPC wire, a single stray log line there
 * would corrupt the stream for the client reading it.
 */
export async function run({ dataDir, bundledDir, appsDir } = {}) {
  const effectiveDataDir = dataDir ?? process.env.KAPREK_DATA_DIR;
  const effectiveBundledDir = bundledDir ?? process.env.KAPREK_APPS_DIR ?? appsDir ?? path.join(__dirname, '..', '..', 'apps');

  if (!effectiveDataDir) {
    process.stderr.write('kaprek-apps: KAPREK_DATA_DIR is required (env var or {dataDir} option)\n');
    process.exitCode = 1;
    return;
  }

  const workspaceDir = workspaceDirFor(effectiveDataDir);
  const { apps, errors } = loadApps({ bundledDir: effectiveBundledDir, dataDir: effectiveDataDir });
  for (const error of errors) {
    process.stderr.write(`kaprek-apps: ${error.dir}: ${error.message}\n`);
  }
  const { registry, warnings } = buildToolRegistry(apps);
  for (const warning of warnings) {
    process.stderr.write(`kaprek-apps: ${warning}\n`);
  }

  const ctx = { registry, dataDir: effectiveDataDir, workspaceDir, state: { phase: 'uninitialized' } };

  // Concurrency cap (see MAX_CONCURRENT_REQUESTS): `queue` holds raw line
  // strings waiting for a free slot, `active` counts calls in flight.
  let active = 0;
  const queue = [];

  function processLine(line) {
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      process.stdout.write(`${JSON.stringify(errorResponse(null, -32700, 'parse error'))}\n`);
      return Promise.resolve();
    }
    return handleMessage(msg, ctx)
      .then((response) => {
        if (response) process.stdout.write(`${JSON.stringify(response)}\n`);
      })
      .catch((err) => {
        process.stdout.write(`${JSON.stringify(errorResponse(msg?.id ?? null, -32603, err.message ?? String(err)))}\n`);
      });
  }

  function pump() {
    while (active < MAX_CONCURRENT_REQUESTS && queue.length > 0) {
      const line = queue.shift();
      active += 1;
      processLine(line).finally(() => {
        active -= 1;
        pump();
      });
    }
  }

  function enqueue(line) {
    const trimmed = line.trim();
    if (!trimmed) return;
    if (queue.length >= MAX_QUEUE_DEPTH) {
      // Best-effort id extraction for a well-formed error response — an
      // over-limit line is rejected outright, never buffered, so this must
      // not itself risk parsing a hostile/huge payload beyond what JSON.parse
      // already does for every line (see MAX_LINE_BYTES above, which already
      // bounds `trimmed`'s size by the time we get here).
      let parsed;
      try {
        parsed = JSON.parse(trimmed);
      } catch {
        parsed = null;
      }
      const id = extractIdIfValid(parsed);
      process.stdout.write(
        `${JSON.stringify(errorResponse(id, -32603, `request queue is full (max ${MAX_QUEUE_DEPTH} pending); server is falling behind, try again later`))}\n`,
      );
      return;
    }
    queue.push(trimmed);
    pump();
  }

  // Manual newline splitting instead of node:readline: readline has no
  // option to cap how large a single buffered "line" may grow before it
  // sees '\n', which is exactly the stdin DoS this guards against — an
  // unterminated or gigantic line must not be allowed to grow this
  // process's memory unbounded. `pending` accumulates raw bytes across
  // 'data' events; `droppedTail` is set once `pending` alone (with no '\n'
  // found yet) has already exceeded MAX_LINE_BYTES, so that the eventual
  // matching '\n' — which terminates the TAIL of an already-reported
  // oversized line, not a new one — is recognized and skipped rather than
  // parsed as if it were a fresh (truncated, and therefore malformed) line.
  let pending = Buffer.alloc(0);
  let droppedTail = false;

  function reportOversizedLine() {
    process.stdout.write(`${JSON.stringify(errorResponse(null, -32700, `line exceeds ${MAX_LINE_BYTES} byte limit`))}\n`);
  }

  process.stdin.on('data', (chunk) => {
    pending = Buffer.concat([pending, chunk]);
    for (;;) {
      const nl = pending.indexOf(0x0a); // '\n'
      if (nl === -1) {
        if (pending.length > MAX_LINE_BYTES) {
          if (!droppedTail) {
            droppedTail = true;
            reportOversizedLine();
          }
          pending = Buffer.alloc(0);
        }
        break;
      }
      const lineBuf = pending.subarray(0, nl);
      pending = pending.subarray(nl + 1);
      const wasDropped = droppedTail;
      droppedTail = false;
      if (wasDropped) continue; // tail of an already-reported oversized line — resynced, not a new message
      if (lineBuf.length > MAX_LINE_BYTES) {
        reportOversizedLine();
        continue;
      }
      enqueue(lineBuf.toString('utf8'));
    }
  });

  // A final message without a trailing '\n' before the client closes stdin
  // is still a complete message — flush whatever's left in `pending` (if
  // it wasn't itself already reported as oversized) rather than silently
  // dropping the last line of the conversation.
  process.stdin.on('end', () => {
    if (!droppedTail && pending.length > 0) {
      if (pending.length > MAX_LINE_BYTES) {
        reportOversizedLine();
      } else {
        enqueue(pending.toString('utf8'));
      }
    }
    pending = Buffer.alloc(0);
  });
}

// Only run when executed directly (`node mcp-server.mjs`) — importing this
// module (e.g. from a test) must never have the side effect of attaching to
// real stdin.
const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  run();
}
