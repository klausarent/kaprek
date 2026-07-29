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
const WORKSPACE_FS_PATH = path.join(__dirname, '..', 'workspace', 'fs.mjs');

// ------------------------------------------------------------ unit: registry

function appEntry(id, tools, dir = `/apps/${id}`) {
  return { manifest: { id, tools }, dir, source: 'bundled' };
}

function tool(id, handler = 'handler.mjs') {
  return { id, description: `desc for ${id}`, inputSchema: { type: 'object' }, handler };
}

test('buildToolRegistry indexes tools by id across apps', () => {
  const apps = [appEntry('notes', [tool('notes.write')]), appEntry('weather', [tool('weather.forecast')])];
  const { registry, warnings } = buildToolRegistry(apps);
  expect(warnings).toEqual([]);
  expect([...registry.keys()].sort()).toEqual(['notes.write', 'weather.forecast']);
  expect(registry.get('notes.write').app.manifest.id).toBe('notes');
});

test('buildToolRegistry keeps the first app on a duplicate tool id and warns', () => {
  const apps = [appEntry('a', [tool('x.do')]), appEntry('b', [tool('x.do')])];
  const { registry, warnings } = buildToolRegistry(apps);
  expect(registry.get('x.do').app.manifest.id).toBe('a');
  expect(warnings).toHaveLength(1);
});

// ------------------------------------------------------------- unit: messages

test('handleMessage: initialize returns the MCP-shaped result', async () => {
  const { registry } = buildToolRegistry([]);
  const res = await handleMessage(
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'x', version: '1' } } },
    { registry, dataDir: '/data', workspaceDir: '/data/workspace' },
  );
  expect(res.id).toBe(1);
  expect(res.result.capabilities).toEqual({ tools: {} });
  expect(res.result.serverInfo.name).toBe('kaprek-apps');
  expect(typeof res.result.protocolVersion).toBe('string');
});

test('handleMessage: notifications/initialized (no id) returns null — no response for a notification', async () => {
  const { registry } = buildToolRegistry([]);
  const res = await handleMessage({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} }, { registry });
  expect(res).toBeNull();
});

test('handleMessage: tools/list returns entries from the registry', async () => {
  const { registry } = buildToolRegistry([appEntry('notes', [tool('notes.write')])]);
  const res = await handleMessage({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }, { registry });
  expect(res.result.tools).toEqual([{ name: 'notes.write', description: 'desc for notes.write', inputSchema: { type: 'object' } }]);
});

test('handleMessage: tools/call for an unknown tool id returns a JSON-RPC error, not a tool result', async () => {
  const { registry } = buildToolRegistry([]);
  const res = await handleMessage(
    { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'no.such.tool', arguments: {} } },
    { registry },
  );
  expect(res.result).toBeUndefined();
  expect(res.error).toBeDefined();
  expect(res.error.code).toBe(-32602);
});

test('handleMessage: unknown method returns a JSON-RPC method-not-found error', async () => {
  const { registry } = buildToolRegistry([]);
  const res = await handleMessage({ jsonrpc: '2.0', id: 4, method: 'bogus/method', params: {} }, { registry });
  expect(res.error.code).toBe(-32601);
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

/** Relative import specifier from `fromDir` to the real src/workspace/fs.mjs, so a fixture handler can use the actual write-path guard. */
function importPathTo(fromDir, target) {
  let rel = path.relative(fromDir, target).split(path.sep).join('/');
  if (!rel.startsWith('.')) rel = `./${rel}`;
  return rel;
}

/** Writes a fixture app (id 'echo') whose handler writes args.relPath/args.data verbatim through the real workspace fs guard — used to prove the server rejects traversal end to end, not just that the notes app happens to sanitize its title. */
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
      ],
      policy: { fsWrite: true, dataEgress: false, externalAction: 'never', sensitivity: 'low' },
    }),
    'utf8',
  );
  fs.writeFileSync(
    path.join(appDir, 'handler.mjs'),
    `import { writeFile } from '${importPathTo(appDir, WORKSPACE_FS_PATH)}';\n` +
      `export async function handler(args, ctx) {\n` +
      `  writeFile({ workspaceDir: ctx.workspaceDir, relPath: args.relPath, data: args.data ?? '' });\n` +
      `  return { relPath: args.relPath };\n` +
      `}\n`,
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

test(
  'mcp-server subprocess: initialize, tools/list, tools/call (success + unknown tool + path traversal) over real stdio JSON-RPC',
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

    const initRes = await client.request('initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'test-client', version: '0.0.0' },
    });
    expect(initRes.result.serverInfo.name).toBe('kaprek-apps');
    expect(initRes.result.capabilities).toEqual({ tools: {} });

    // A notification must never produce a response line on stdout.
    client.notify('notifications/initialized', {});

    const listRes = await client.request('tools/list', {});
    expect(listRes.result.tools.map((t) => t.name)).toEqual(['echo.write']);

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

    const unknownRes = await client.request('tools/call', { name: 'no.such.tool', arguments: {} });
    expect(unknownRes.result).toBeUndefined();
    expect(unknownRes.error.code).toBe(-32602);

    // Exactly one stdout line per request (3 real requests: initialize, tools/list, tools/call x3) —
    // the notification above must not have added a fourth/extra line.
    expect(client.received).toHaveLength(5);

    child.stdin.end();
  },
  20000,
);
