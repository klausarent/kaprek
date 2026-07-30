// Tests for the stdio MCP server. Run: npx vitest run src/apps/mcp-server.test.mjs
//
// Two layers: fast in-process unit tests against handleMessage()/
// buildToolRegistry() (no subprocess), and a full integration test that
// spawns mcp-server.mjs as a real child process and drives it over actual
// stdin/stdout JSON-RPC — the only way to catch a wire-protocol mistake
// (wrong field name, wrong framing) that an in-process call can't.
// child_process is only used here, in a .test.mjs file, which is exempt
// from src/no-network.test.mjs's guard.
import { test, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import readline from 'node:readline';
import { buildToolRegistry, handleMessage } from './mcp-server.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SERVER_PATH = path.join(__dirname, 'mcp-server.mjs');

// ------------------------------------------------------------ unit: registry

// Default policy matches what parseManifest() would fill in for a real
// app.json — real registry entries always have one (manifest.mjs requires
// it), so tools/call's policy-gated workspace ctx (see createWorkspaceCtx()
// in mcp-server.mjs) can assume `manifest.policy` exists without an `?.`.
function appEntry(id, tools, dir = `/apps/${id}`, policy = { fsWrite: true, dataEgress: false, externalAction: 'never', sensitivity: 'low' }) {
  return { manifest: { id, tools, policy }, dir, source: 'bundled' };
}

function tool(id, handler = 'handler.mjs', inputSchema = { type: 'object' }) {
  return { id, description: `desc for ${id}`, inputSchema, handler };
}

test('buildToolRegistry indexes tools by id across apps', () => {
  const apps = [appEntry('notes', [tool('notes.write')]), appEntry('weather', [tool('weather.forecast')])];
  const { registry, warnings } = buildToolRegistry(apps);
  expect(warnings).toEqual([]);
  expect([...registry.keys()].sort()).toEqual(['notes.write', 'weather.forecast']);
  expect(registry.get('notes.write').app.manifest.id).toBe('notes');
});

test('buildToolRegistry registers a contested tool id for NEITHER app, and warns', () => {
  const apps = [appEntry('a', [tool('x.do')]), appEntry('b', [tool('x.do')])];
  const { registry, warnings } = buildToolRegistry(apps);
  // Keeping the first would make an authorization decision depend on
  // directory listing order, and would let a second app redefine what the
  // first one's tool id means (see loader.mjs::resolveToolOwnership).
  expect(registry.has('x.do')).toBe(false);
  expect(warnings).toHaveLength(1);
  expect(warnings[0]).toMatch(/claimed by both/);
});

test('buildToolRegistry drops only the contested id — every other tool of both apps stays', () => {
  const apps = [appEntry('a', [tool('x.do'), tool('a.own')]), appEntry('b', [tool('x.do'), tool('b.own')])];
  const { registry } = buildToolRegistry(apps);
  expect([...registry.keys()].sort()).toEqual(['a.own', 'b.own']);
});

// -------------------------------------------------------------- unit: helpers

/** ctx for handleMessage() with lifecycle already past the handshake — for tests that aren't themselves about lifecycle. */
function readyCtx(extra = {}) {
  const { registry } = buildToolRegistry([]);
  return { registry, dataDir: '/data', workspaceDir: '/data/workspace', state: { phase: 'ready' }, ...extra };
}

function freshState() {
  return { phase: 'uninitialized' };
}

// --------------------------------------------------------- unit: envelope (2a)

test('handleMessage: {} (no method, no id) gets a -32600 Invalid Request response, not silent notification handling', async () => {
  const res = await handleMessage({}, readyCtx());
  expect(res.error.code).toBe(-32600);
  expect(res.id).toBeNull();
});

test('handleMessage: a top-level array is rejected as -32600 (no batch support)', async () => {
  const res = await handleMessage([], readyCtx());
  expect(res.error.code).toBe(-32600);
});

test('handleMessage: wrong jsonrpc version is rejected as -32600', async () => {
  const res = await handleMessage({ jsonrpc: '1.0', id: 1, method: 'tools/list' }, readyCtx());
  expect(res.error.code).toBe(-32600);
  expect(res.id).toBe(1);
});

test('handleMessage: id:null is rejected as -32600 with a null id in the response', async () => {
  const res = await handleMessage({ jsonrpc: '2.0', id: null, method: 'tools/list' }, readyCtx());
  expect(res.error.code).toBe(-32600);
  expect(res.id).toBeNull();
});

test('handleMessage: an object id is rejected as -32600', async () => {
  const res = await handleMessage({ jsonrpc: '2.0', id: { x: 1 }, method: 'tools/list' }, readyCtx());
  expect(res.error.code).toBe(-32600);
});

test('handleMessage: an array id is rejected as -32600', async () => {
  const res = await handleMessage({ jsonrpc: '2.0', id: [1], method: 'tools/list' }, readyCtx());
  expect(res.error.code).toBe(-32600);
});

test('handleMessage: a request with no id and a non-"notifications/" method is rejected as -32600 (not treated as fire-and-forget)', async () => {
  const res = await handleMessage({ jsonrpc: '2.0', method: 'tools/list' }, readyCtx());
  expect(res.error.code).toBe(-32600);
});

test('handleMessage: a real notification (no id, "notifications/..." method) returns null — no response on the wire', async () => {
  const res = await handleMessage({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} }, readyCtx());
  expect(res).toBeNull();
});

test('handleMessage: an unrelated "notifications/..." notification returns null and does not affect lifecycle state', async () => {
  const state = { phase: 'ready' };
  const res = await handleMessage({ jsonrpc: '2.0', method: 'notifications/progress', params: {} }, readyCtx({ state }));
  expect(res).toBeNull();
  expect(state.phase).toBe('ready');
});

// --------------------------------------------------------- unit: lifecycle (2b)

test('handleMessage: initialize returns the MCP-shaped result and advances state to "initializing"', async () => {
  const state = freshState();
  const res = await handleMessage(
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'x', version: '1' } } },
    readyCtx({ state }),
  );
  expect(res.id).toBe(1);
  expect(res.result.capabilities).toEqual({ tools: {} });
  expect(res.result.serverInfo.name).toBe('kaprek-apps');
  expect(typeof res.result.protocolVersion).toBe('string');
  expect(state.phase).toBe('initializing');
});

test('handleMessage: tools/list before initialize is rejected with a JSON-RPC error, not served', async () => {
  const res = await handleMessage({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }, readyCtx({ state: freshState() }));
  expect(res.result).toBeUndefined();
  expect(res.error).toBeDefined();
  expect(res.error.code).toBe(-32002);
});

test('handleMessage: tools/call before initialize is rejected with a JSON-RPC error', async () => {
  const res = await handleMessage(
    { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'x', arguments: {} } },
    readyCtx({ state: freshState() }),
  );
  expect(res.error.code).toBe(-32002);
});

test('handleMessage: tools/list after initialize but before notifications/initialized is still rejected', async () => {
  const state = { phase: 'initializing' };
  const res = await handleMessage({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }, readyCtx({ state }));
  expect(res.error.code).toBe(-32002);
});

test('handleMessage: notifications/initialized moves "initializing" to "ready", after which tools/list works', async () => {
  const state = { phase: 'initializing' };
  const notifyRes = await handleMessage({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} }, readyCtx({ state }));
  expect(notifyRes).toBeNull();
  expect(state.phase).toBe('ready');

  const listRes = await handleMessage({ jsonrpc: '2.0', id: 3, method: 'tools/list', params: {} }, readyCtx({ state }));
  expect(listRes.result.tools).toEqual([]);
});

test('handleMessage: a second initialize is rejected once already initializing', async () => {
  const state = { phase: 'initializing' };
  const res = await handleMessage({ jsonrpc: '2.0', id: 4, method: 'initialize', params: {} }, readyCtx({ state }));
  expect(res.error.code).toBe(-32600);
  expect(state.phase).toBe('initializing'); // unchanged by the rejected re-init
});

test('handleMessage: a second initialize is rejected once ready', async () => {
  const res = await handleMessage({ jsonrpc: '2.0', id: 5, method: 'initialize', params: {} }, readyCtx());
  expect(res.error.code).toBe(-32600);
});

// ---------------------------------------------------------------- unit: messages

test('handleMessage: tools/list returns entries from the registry', async () => {
  const { registry } = buildToolRegistry([appEntry('notes', [tool('notes.write')])]);
  const res = await handleMessage({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }, readyCtx({ registry }));
  expect(res.result.tools).toEqual([{ name: 'notes.write', description: 'desc for notes.write', inputSchema: { type: 'object' } }]);
});

test('handleMessage: tools/call for an unknown tool id returns a JSON-RPC error, not a tool result', async () => {
  const res = await handleMessage(
    { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'no.such.tool', arguments: {} } },
    readyCtx(),
  );
  expect(res.result).toBeUndefined();
  expect(res.error).toBeDefined();
  expect(res.error.code).toBe(-32602);
});

test('handleMessage: unknown method returns a JSON-RPC method-not-found error', async () => {
  const res = await handleMessage({ jsonrpc: '2.0', id: 4, method: 'bogus/method', params: {} }, readyCtx());
  expect(res.error.code).toBe(-32601);
});

// ---------------------------------------------------- unit: inputSchema validation (2c)

test('handleMessage: tools/call rejects a missing required argument with -32602, without invoking the handler', async () => {
  const apps = [appEntry('notes', [tool('notes.write', 'handler.mjs', { type: 'object', properties: { title: { type: 'string' } }, required: ['title'] })])];
  const { registry } = buildToolRegistry(apps);
  const res = await handleMessage(
    { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'notes.write', arguments: {} } },
    readyCtx({ registry }),
  );
  expect(res.error.code).toBe(-32602);
  expect(res.error.message).toMatch(/title/);
});

test('handleMessage: tools/call rejects an unknown top-level argument with -32602', async () => {
  const apps = [appEntry('notes', [tool('notes.write', 'handler.mjs', { type: 'object', properties: { title: { type: 'string' } } })])];
  const { registry } = buildToolRegistry(apps);
  const res = await handleMessage(
    { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'notes.write', arguments: { title: 'x', evil: true } } },
    readyCtx({ registry }),
  );
  expect(res.error.code).toBe(-32602);
  expect(res.error.message).toMatch(/evil/);
});

test('handleMessage: tools/call rejects a wrong-typed argument with -32602', async () => {
  const apps = [appEntry('notes', [tool('notes.write', 'handler.mjs', { type: 'object', properties: { title: { type: 'string' } } })])];
  const { registry } = buildToolRegistry(apps);
  const res = await handleMessage(
    { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'notes.write', arguments: { title: 123 } } },
    readyCtx({ registry }),
  );
  expect(res.error.code).toBe(-32602);
  expect(res.error.message).toMatch(/title/);
});

// -------------------------------------------------- unit: handler error separation (2d)

test('handleMessage: a handler-loading failure (bad import) is a JSON-RPC -32603 error, not a CallToolResult', async () => {
  const apps = [appEntry('broken', [tool('broken.run', 'does-not-exist.mjs')], path.join(os.tmpdir(), 'kaprek-broken-app-fixture'))];
  const { registry } = buildToolRegistry(apps);
  const res = await handleMessage(
    { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'broken.run', arguments: {} } },
    readyCtx({ registry }),
  );
  expect(res.result).toBeUndefined();
  expect(res.error).toBeDefined();
  expect(res.error.code).toBe(-32603);
});

// integration test below (real handler exception -> isError:true) covers the
// other half of this split, since it needs a real importable handler module.

// ------------------------------------------------- unit: timeout + truncation (2e)

test('handleMessage: a handler that never resolves times out and surfaces as isError:true', async () => {
  const appDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kaprek-hang-handler-'));
  fs.writeFileSync(
    path.join(appDir, 'handler.mjs'),
    `export async function handler() {\n  return new Promise(() => {}); // never resolves\n}\n`,
    'utf8',
  );
  try {
    const apps = [appEntry('hang', [tool('hang.run')], appDir)];
    const { registry } = buildToolRegistry(apps);
    // handlerTimeoutMs is a test-only ctx override (see mcp-server.mjs) so
    // this doesn't have to wait out the real 60s HANDLER_TIMEOUT_MS.
    const res = await handleMessage(
      { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'hang.run', arguments: {} } },
      readyCtx({ registry, handlerTimeoutMs: 20 }),
    );
    expect(res.result.isError).toBe(true);
    expect(res.result.content[0].text).toMatch(/timed out/);
  } finally {
    fs.rmSync(appDir, { recursive: true, force: true });
  }
});

test('handleMessage: an oversized handler result is truncated to the output byte cap', async () => {
  const appDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kaprek-huge-handler-'));
  fs.writeFileSync(
    path.join(appDir, 'handler.mjs'),
    `export async function handler() {\n  return 'x'.repeat(300 * 1024);\n}\n`,
    'utf8',
  );
  try {
    const apps = [appEntry('huge', [tool('huge.run')], appDir)];
    const { registry } = buildToolRegistry(apps);
    const res = await handleMessage(
      { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'huge.run', arguments: {} } },
      readyCtx({ registry }),
    );
    expect(res.result.isError).toBeUndefined();
    expect(Buffer.byteLength(res.result.content[0].text, 'utf8')).toBeLessThan(300 * 1024);
    expect(res.result.content[0].text).toMatch(/truncated/);
  } finally {
    fs.rmSync(appDir, { recursive: true, force: true });
  }
});

// -------------------------------------------------------- unit: policy gate

test('handleMessage: a handler only ever sees ctx.workspace + ctx.appDir — no raw workspaceDir or dataDir string', async () => {
  const appDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kaprek-ctx-shape-handler-'));
  fs.writeFileSync(
    path.join(appDir, 'handler.mjs'),
    `export async function handler(args, ctx) {\n  return { keys: Object.keys(ctx).sort(), hasWriteFile: typeof ctx.workspace?.writeFile === 'function' };\n}\n`,
    'utf8',
  );
  try {
    const apps = [appEntry('introspect', [tool('introspect.run')], appDir)];
    const { registry } = buildToolRegistry(apps);
    const res = await handleMessage(
      { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'introspect.run', arguments: {} } },
      readyCtx({ registry }),
    );
    const { keys, hasWriteFile } = JSON.parse(res.result.content[0].text);
    expect(keys).toEqual(['appDir', 'workspace']);
    expect(hasWriteFile).toBe(true); // appEntry()'s default policy has fsWrite: true
  } finally {
    fs.rmSync(appDir, { recursive: true, force: true });
  }
});

test('handleMessage: policy.fsWrite: false leaves ctx.workspace without a writeFile — a write attempt fails as isError:true, not silently', async () => {
  const appDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kaprek-fswrite-false-handler-'));
  fs.writeFileSync(
    path.join(appDir, 'handler.mjs'),
    `export async function handler(args, ctx) {\n  ctx.workspace.writeFile({ relPath: 'x.txt', data: 'nope' });\n  return { ok: true };\n}\n`,
    'utf8',
  );
  try {
    const apps = [
      appEntry('readonly', [tool('readonly.run')], appDir, { fsWrite: false, dataEgress: false, externalAction: 'never', sensitivity: 'low' }),
    ];
    const { registry } = buildToolRegistry(apps);
    const res = await handleMessage(
      { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'readonly.run', arguments: {} } },
      readyCtx({ registry }),
    );
    expect(res.result.isError).toBe(true);
    expect(res.result.content[0].text).toMatch(/writeFile is not a function/);
  } finally {
    fs.rmSync(appDir, { recursive: true, force: true });
  }
});

test('handleMessage: policy.fsWrite: false still allows ctx.workspace.readFile/listFiles', async () => {
  const appDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kaprek-fswrite-false-read-handler-'));
  fs.writeFileSync(
    path.join(appDir, 'handler.mjs'),
    `export async function handler(args, ctx) {\n  return { hasReadFile: typeof ctx.workspace.readFile === 'function', hasListFiles: typeof ctx.workspace.listFiles === 'function' };\n}\n`,
    'utf8',
  );
  try {
    const apps = [
      appEntry('readonly2', [tool('readonly2.run')], appDir, { fsWrite: false, dataEgress: false, externalAction: 'never', sensitivity: 'low' }),
    ];
    const { registry } = buildToolRegistry(apps);
    const res = await handleMessage(
      { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'readonly2.run', arguments: {} } },
      readyCtx({ registry }),
    );
    expect(JSON.parse(res.result.content[0].text)).toEqual({ hasReadFile: true, hasListFiles: true });
  } finally {
    fs.rmSync(appDir, { recursive: true, force: true });
  }
});

// ------------------------------------------------------- integration: process

let child;
let root;

afterEach(() => {
  if (child && !child.killed) child.kill();
  child = null;
  if (root) fs.rmSync(root, { recursive: true, force: true });
  root = null;
});

/** Writes a fixture app (id 'echo') whose handler writes args.relPath/args.data verbatim through ctx.workspace.writeFile() (itself backed by the real workspace fs guard) — used to prove the server rejects traversal end to end, not just that the notes app happens to sanitize its title. */
function writeEchoFixtureApp(bundledDir) {
  const appDir = path.join(bundledDir, 'echo');
  fs.mkdirSync(appDir, { recursive: true });
  fs.writeFileSync(
    path.join(appDir, 'app.json'),
    JSON.stringify({
      id: 'echo',
      version: '1.0.0',
      name: 'Echo',
      description: 'Writes whatever relPath/data it is given (test fixture).',
      tools: [
        {
          id: 'echo.write',
          description: 'Writes relPath/data to the workspace.',
          inputSchema: { type: 'object', properties: { relPath: { type: 'string' }, data: { type: 'string' } } },
          handler: 'handler.mjs',
        },
        {
          id: 'echo.throw',
          description: 'Always throws (test fixture for handler-exception isError:true).',
          inputSchema: { type: 'object', properties: {} },
          handler: 'throw.mjs',
        },
      ],
      policy: { fsWrite: true, dataEgress: false, externalAction: 'never', sensitivity: 'low' },
    }),
    'utf8',
  );
  fs.writeFileSync(
    path.join(appDir, 'handler.mjs'),
    `export async function handler(args, ctx) {\n` +
      `  ctx.workspace.writeFile({ relPath: args.relPath, data: args.data ?? '' });\n` +
      `  return { relPath: args.relPath };\n` +
      `}\n`,
    'utf8',
  );
  fs.writeFileSync(
    path.join(appDir, 'throw.mjs'),
    `export async function handler() {\n` + `  throw new Error('deliberate fixture failure');\n` + `}\n`,
    'utf8',
  );
  return appDir;
}

/** Minimal newline-delimited JSON-RPC client over a spawned child's stdio. */
function createRpcClient(proc) {
  const rl = readline.createInterface({ input: proc.stdout, crlfDelay: Infinity });
  const pending = new Map();
  const received = [];
  rl.on('line', (line) => {
    if (!line.trim()) return;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      return;
    }
    received.push(msg);
    if (msg.id !== undefined && msg.id !== null && pending.has(msg.id)) {
      pending.get(msg.id)(msg);
      pending.delete(msg.id);
    }
  });
  let nextId = 1;
  return {
    received,
    request(method, params) {
      const id = nextId++;
      const promise = new Promise((resolve) => pending.set(id, resolve));
      proc.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
      return promise;
    },
    notify(method, params) {
      proc.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`);
    },
  };
}

/** Drives the full MCP handshake (initialize + notifications/initialized) so the rest of a test can call tools/* — every integration test needs this now that lifecycle is enforced. */
async function handshake(client) {
  const initRes = await client.request('initialize', {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'test-client', version: '0.0.0' },
  });
  client.notify('notifications/initialized', {});
  return initRes;
}

test(
  'mcp-server subprocess: full lifecycle, tools/list, tools/call (success + unknown tool + path traversal + handler exception) over real stdio JSON-RPC',
  async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'kaprek-mcp-server-test-'));
    const bundledDir = path.join(root, 'apps');
    const dataDir = path.join(root, 'data');
    fs.mkdirSync(bundledDir, { recursive: true });
    fs.mkdirSync(dataDir, { recursive: true });
    writeEchoFixtureApp(bundledDir);

    child = spawn(process.execPath, [SERVER_PATH], {
      env: { ...process.env, KAPREK_DATA_DIR: dataDir, KAPREK_APPS_DIR: bundledDir },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stderr = '';
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString('utf8');
    });

    const client = createRpcClient(child);

    // tools/list before the handshake completes must be rejected, not served.
    const tooEarlyRes = await client.request('tools/list', {});
    expect(tooEarlyRes.error).toBeDefined();
    expect(tooEarlyRes.error.code).toBe(-32002);

    const initRes = await handshake(client);
    expect(initRes.result.serverInfo.name).toBe('kaprek-apps');
    expect(initRes.result.capabilities).toEqual({ tools: {} });

    const listRes = await client.request('tools/list', {});
    expect(listRes.result.tools.map((t) => t.name).sort()).toEqual(['echo.throw', 'echo.write']);

    const okRes = await client.request('tools/call', {
      name: 'echo.write',
      arguments: { relPath: 'ok/hello.txt', data: 'hi there' },
    });
    expect(okRes.result.isError).toBeUndefined();
    expect(okRes.result.content[0].type).toBe('text');
    expect(fs.readFileSync(path.join(dataDir, 'workspace', 'ok', 'hello.txt'), 'utf8')).toBe('hi there');

    const traversalRes = await client.request('tools/call', {
      name: 'echo.write',
      arguments: { relPath: '../../escaped.txt', data: 'evil' },
    });
    expect(traversalRes.result.isError).toBe(true);
    expect(fs.existsSync(path.join(root, 'escaped.txt'))).toBe(false);
    expect(fs.existsSync(path.join(path.dirname(root), 'escaped.txt'))).toBe(false);

    const throwRes = await client.request('tools/call', { name: 'echo.throw', arguments: {} });
    expect(throwRes.result.isError).toBe(true);
    expect(throwRes.result.content[0].text).toMatch(/deliberate fixture failure/);

    const unknownRes = await client.request('tools/call', { name: 'no.such.tool', arguments: {} });
    expect(unknownRes.result).toBeUndefined();
    expect(unknownRes.error.code).toBe(-32602);

    const badArgsRes = await client.request('tools/call', { name: 'echo.write', arguments: { relPath: 5 } });
    expect(badArgsRes.result).toBeUndefined();
    expect(badArgsRes.error.code).toBe(-32602);

    // Exactly one stdout line per real request (8: tooEarly, initialize,
    // tools/list, tools/call x5) — the notifications/initialized above must
    // not have added an extra line.
    expect(client.received).toHaveLength(8);

    child.stdin.end();
  },
  20000,
);

test(
  'mcp-server subprocess: at most MAX_CONCURRENT_REQUESTS (8) tools/call handlers run at once, the rest queue',
  async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'kaprek-mcp-server-concurrency-test-'));
    const bundledDir = path.join(root, 'apps');
    const dataDir = path.join(root, 'data');
    fs.mkdirSync(bundledDir, { recursive: true });
    fs.mkdirSync(dataDir, { recursive: true });
    const appDir = path.join(bundledDir, 'conc');
    fs.mkdirSync(appDir, { recursive: true });
    fs.writeFileSync(
      path.join(appDir, 'app.json'),
      JSON.stringify({
        id: 'conc',
        version: '1.0.0',
        name: 'Concurrency probe',
        description: 'Tracks how many calls run at once (test fixture).',
        tools: [
          {
            id: 'conc.run',
            description: 'Sleeps briefly, tracking concurrent in-flight calls; {peek:true} returns the max seen.',
            inputSchema: { type: 'object', properties: { peek: { type: 'boolean' } } },
            handler: 'handler.mjs',
          },
        ],
        policy: { fsWrite: false, dataEgress: false, externalAction: 'never', sensitivity: 'low' },
      }),
      'utf8',
    );
    // Module-scoped `active`/`maxSeen` persist across calls because
    // dynamic import() caches the module by resolved URL — every
    // conc.run call in this test hits the same module instance.
    fs.writeFileSync(
      path.join(appDir, 'handler.mjs'),
      'let active = 0;\n' +
        'let maxSeen = 0;\n' +
        'export async function handler(args) {\n' +
        '  if (args?.peek) return { maxSeen };\n' +
        '  active += 1;\n' +
        '  maxSeen = Math.max(maxSeen, active);\n' +
        '  await new Promise((resolve) => setTimeout(resolve, 150));\n' +
        '  active -= 1;\n' +
        '  return { ok: true };\n' +
        '}\n',
      'utf8',
    );

    child = spawn(process.execPath, [SERVER_PATH], {
      env: { ...process.env, KAPREK_DATA_DIR: dataDir, KAPREK_APPS_DIR: bundledDir },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const client = createRpcClient(child);
    await handshake(client);

    const calls = Array.from({ length: 20 }, () => client.request('tools/call', { name: 'conc.run', arguments: {} }));
    await Promise.all(calls);

    const peekRes = await client.request('tools/call', { name: 'conc.run', arguments: { peek: true } });
    const { maxSeen } = JSON.parse(peekRes.result.content[0].text);
    expect(maxSeen).toBeLessThanOrEqual(8);
    expect(maxSeen).toBeGreaterThan(1); // proves real concurrency, not accidental full serialization

    child.stdin.end();
  },
  20000,
);

test(
  'mcp-server subprocess: once MAX_CONCURRENT_REQUESTS + MAX_QUEUE_DEPTH requests are pending, further ones are rejected with -32603 instead of queued forever',
  async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'kaprek-mcp-server-queue-depth-test-'));
    const bundledDir = path.join(root, 'apps');
    const dataDir = path.join(root, 'data');
    fs.mkdirSync(bundledDir, { recursive: true });
    fs.mkdirSync(dataDir, { recursive: true });
    const appDir = path.join(bundledDir, 'slow');
    fs.mkdirSync(appDir, { recursive: true });
    fs.writeFileSync(
      path.join(appDir, 'app.json'),
      JSON.stringify({
        id: 'slow',
        version: '1.0.0',
        name: 'Slow',
        description: 'Sleeps long enough to keep the queue backed up (test fixture).',
        tools: [
          {
            id: 'slow.run',
            description: 'Sleeps 500ms then returns.',
            inputSchema: { type: 'object', properties: {} },
            handler: 'handler.mjs',
          },
        ],
        policy: { fsWrite: false, dataEgress: false, externalAction: 'never', sensitivity: 'low' },
      }),
      'utf8',
    );
    fs.writeFileSync(
      path.join(appDir, 'handler.mjs'),
      `export async function handler() {\n  await new Promise((resolve) => setTimeout(resolve, 500));\n  return { ok: true };\n}\n`,
      'utf8',
    );

    child = spawn(process.execPath, [SERVER_PATH], {
      env: { ...process.env, KAPREK_DATA_DIR: dataDir, KAPREK_APPS_DIR: bundledDir },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const client = createRpcClient(child);
    await handshake(client);

    // 8 (MAX_CONCURRENT_REQUESTS) + 64 (MAX_QUEUE_DEPTH) = 72 can be
    // in-flight/queued at once; firing well more than that, all before
    // awaiting any of them, must overflow the queue.
    const calls = Array.from({ length: 90 }, () => client.request('tools/call', { name: 'slow.run', arguments: {} }));
    const results = await Promise.all(calls);

    const overflowed = results.filter((r) => r.error?.code === -32603 && /queue is full/.test(r.error.message));
    const succeeded = results.filter((r) => r.result?.isError === undefined && r.result?.content);
    expect(overflowed.length).toBeGreaterThan(0);
    expect(succeeded.length).toBeLessThanOrEqual(72);
    expect(overflowed.length + succeeded.length).toBe(90);

    child.stdin.end();
  },
  20000,
);

test(
  'mcp-server subprocess: a line over the 4 MB limit is rejected with a parse-error response and does not crash the server',
  async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'kaprek-mcp-server-oversize-test-'));
    const bundledDir = path.join(root, 'apps');
    const dataDir = path.join(root, 'data');
    fs.mkdirSync(bundledDir, { recursive: true });
    fs.mkdirSync(dataDir, { recursive: true });

    child = spawn(process.execPath, [SERVER_PATH], {
      env: { ...process.env, KAPREK_DATA_DIR: dataDir, KAPREK_APPS_DIR: bundledDir },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const client = createRpcClient(child);
    await handshake(client);

    // A single line whose JSON payload alone exceeds MAX_LINE_BYTES (4 MB).
    const oversizedArg = 'x'.repeat(5 * 1024 * 1024);
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 999, method: 'tools/list', params: { junk: oversizedArg } })}\n`);

    // The server must still be alive and answering afterwards.
    const listRes = await client.request('tools/list', {});
    expect(listRes.result.tools).toEqual([]);

    // The oversized line got a parse-error response (id:null, since it was
    // never actually parsed), not silently ignored.
    const oversizeResponse = client.received.find((m) => m.error?.code === -32700);
    expect(oversizeResponse).toBeDefined();
    expect(oversizeResponse.id).toBeNull();

    child.stdin.end();
  },
  20000,
);
