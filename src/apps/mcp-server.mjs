#!/usr/bin/env node
// Standalone stdio MCP server that exposes kaprek apps' tools to Claude
// Code (or any other MCP client) via `--mcp-config` (see mcp-config.mjs).
// Claude Code spawns THIS file as its own child process — kaprek's own
// server/CLI code never imports it (that's why it's fine for this file to
// read stdin/write stdout directly instead of exporting a library API; the
// pure helpers below are exported anyway so tests can unit-test them
// without paying for a subprocess every time).
//
// Protocol: JSON-RPC 2.0, one message per line on stdin/stdout. Field names
// verified against the official MCP schema (modelcontextprotocol/
// modelcontextprotocol, schema/2025-06-18/schema.json) rather than guessed:
// InitializeResult = {protocolVersion, capabilities, serverInfo}, Tool =
// {name, description, inputSchema}, CallToolResult = {content, isError?}.
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
import readline from 'node:readline';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { loadApps } from './loader.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const PROTOCOL_VERSION = '2025-06-18';
const SERVER_NAME = 'kaprek-apps';

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

/**
 * Builds the tool registry: a Map from canonical tool id to
 * `{app, tool}` (`app` is the loader's `{manifest, dir, source}` entry).
 * Only ids found by iterating `app.manifest.tools[]` are ever added — see
 * the module header on why that's the whole security model here. A tool id
 * duplicated across two different apps keeps the first one found and drops
 * the rest (surfaced in `warnings`, since two apps claiming the same id is
 * a packaging bug worth knowing about, but must not crash the server).
 */
export function buildToolRegistry(apps) {
  const registry = new Map();
  const warnings = [];
  for (const app of apps) {
    for (const tool of app.manifest.tools) {
      if (registry.has(tool.id)) {
        warnings.push(`duplicate tool id "${tool.id}" (app "${app.manifest.id}"), keeping the first registration`);
        continue;
      }
      registry.set(tool.id, { app, tool });
    }
  }
  return { registry, warnings };
}

/** True if `msg` is a JSON-RPC notification (no response expected) rather than a request. */
function isNotification(msg) {
  return msg && typeof msg === 'object' && !('id' in msg);
}

function okResponse(id, result) {
  return { jsonrpc: '2.0', id, result };
}

function errorResponse(id, code, message) {
  return { jsonrpc: '2.0', id: id ?? null, error: { code, message } };
}

/**
 * Loads the handler module for `entry` (a registry `{app, tool}` pair),
 * bound-checked to stay inside `entry.app.dir` even though the handler path
 * comes from an already-validated manifest (defense in depth, not the
 * authorization boundary — see the module header).
 */
async function loadHandler(entry) {
  const appDirResolved = path.resolve(entry.app.dir);
  const handlerPath = path.resolve(appDirResolved, entry.tool.handler);
  if (handlerPath !== appDirResolved && !handlerPath.startsWith(appDirResolved + path.sep)) {
    throw new Error(`handler path escapes app directory: ${entry.tool.handler}`);
  }
  const mod = await import(pathToFileURL(handlerPath).href);
  if (typeof mod.handler !== 'function') {
    throw new Error(`handler module does not export an async function 'handler': ${entry.tool.handler}`);
  }
  return mod.handler;
}

/**
 * Handles one parsed JSON-RPC message and returns the response object to
 * write (or `null` for a notification, which never gets a response).
 * Never throws: a handler exception becomes a CallToolResult with
 * `isError: true` (per the MCP spec — tool-execution errors belong INSIDE
 * the result, not as a protocol-level error, so the model can see and
 * react to them); everything else that goes wrong becomes a normal
 * JSON-RPC error response.
 */
export async function handleMessage(msg, { registry, dataDir, workspaceDir }) {
  if (isNotification(msg)) {
    // 'notifications/initialized' and any other notification: acknowledged
    // by doing nothing (notifications never get a response on the wire).
    return null;
  }

  const { id, method, params } = msg;

  if (method === 'initialize') {
    return okResponse(id, {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: { tools: {} },
      serverInfo: { name: SERVER_NAME, version: serverVersion() },
    });
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
    try {
      const handler = await loadHandler(entry);
      const result = await handler(args, { dataDir, workspaceDir, appDir: entry.app.dir });
      const text = typeof result === 'string' ? result : JSON.stringify(result ?? null);
      return okResponse(id, { content: [{ type: 'text', text }] });
    } catch (err) {
      return okResponse(id, { content: [{ type: 'text', text: err.message ?? String(err) }], isError: true });
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

  const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  rl.on('line', (rawLine) => {
    const line = rawLine.trim();
    if (!line) return;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      process.stdout.write(`${JSON.stringify(errorResponse(null, -32700, 'parse error'))}\n`);
      return;
    }
    handleMessage(msg, { registry, dataDir: effectiveDataDir, workspaceDir })
      .then((response) => {
        if (response) process.stdout.write(`${JSON.stringify(response)}\n`);
      })
      .catch((err) => {
        process.stdout.write(`${JSON.stringify(errorResponse(msg?.id ?? null, -32603, err.message ?? String(err)))}\n`);
      });
  });
}

// Only run when executed directly (`node mcp-server.mjs`) — importing this
// module (e.g. from a test) must never have the side effect of attaching to
// real stdin.
const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  run();
}
