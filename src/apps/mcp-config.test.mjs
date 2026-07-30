// Tests for the --mcp-config file writer. Run: npx vitest run src/apps/mcp-config.test.mjs
//
// Two layers, same split as mcp-server.test.mjs: fast unit tests against the
// written JSON shape, and one real child-process test that spawns the
// server with the exact argv writeMcpConfig() produces and proves the
// `--permission` sandbox is actually enforced by Node — not just declared.
// child_process is only used here, in a .test.mjs file (exempt from
// src/no-network.test.mjs's guard).
import { test, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { ALLOW_USER_APPS_ENV } from './loader.mjs';
import readline from 'node:readline';
import { writeMcpConfig, cleanupMcpConfig } from './mcp-config.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.join(__dirname, '..', '..');
const SERVER_PATH = path.join(__dirname, 'mcp-server.mjs');

let tmpDir;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kaprek-mcp-config-test-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ------------------------------------------------------------------- shape

test('writeMcpConfig (sandboxed, default) wires command=process.execPath and --permission flags', () => {
  const configPath = writeMcpConfig({
    dataDir: 'C:\\data',
    appsDir: 'C:\\apps',
    packageRoot: 'C:\\repo',
    serverScriptPath: 'C:\\repo\\src\\apps\\mcp-server.mjs',
    tmpDir,
  });

  expect(fs.existsSync(configPath)).toBe(true);
  const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  const entry = config.mcpServers['kaprek-apps'];
  expect(entry.command).toBe(process.execPath);
  expect(entry.args).toEqual([
    '--permission',
    '--allow-fs-read=C:\\repo',
    '--allow-fs-read=C:\\data\\apps',
    '--allow-fs-read=C:\\data\\workspace',
    '--allow-fs-read=C:\\apps',
    '--allow-fs-write=C:\\data\\workspace',
    'C:\\repo\\src\\apps\\mcp-server.mjs',
  ]);
  expect(entry.env).toEqual({ KAPREK_DATA_DIR: 'C:\\data', KAPREK_APPS_DIR: 'C:\\apps' });
});

test('writeMcpConfig never grants the bare dataDir itself as --allow-fs-read (only its apps/ and workspace/ subdirs)', () => {
  const configPath = writeMcpConfig({ dataDir: 'C:\\data', packageRoot: 'C:\\repo', serverScriptPath: 'C:\\server.mjs', tmpDir });
  const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  const entry = config.mcpServers['kaprek-apps'];
  expect(entry.args).not.toContain('--allow-fs-read=C:\\data');
});

test('writeMcpConfig omits the appsDir --allow-fs-read flag and env var when appsDir is not given', () => {
  const configPath = writeMcpConfig({ dataDir: 'C:\\data', packageRoot: 'C:\\repo', serverScriptPath: 'C:\\server.mjs', tmpDir });
  const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  const entry = config.mcpServers['kaprek-apps'];
  expect(entry.args).toEqual([
    '--permission',
    '--allow-fs-read=C:\\repo',
    '--allow-fs-read=C:\\data\\apps',
    '--allow-fs-read=C:\\data\\workspace',
    '--allow-fs-write=C:\\data\\workspace',
    'C:\\server.mjs',
  ]);
  expect(entry.env).toEqual({ KAPREK_DATA_DIR: 'C:\\data' });
});

test('writeMcpConfig throws when dataDir is missing', () => {
  expect(() => writeMcpConfig({ packageRoot: 'C:\\repo', serverScriptPath: 'C:\\server.mjs', tmpDir })).toThrow();
});

test('writeMcpConfig throws when serverScriptPath is missing', () => {
  expect(() => writeMcpConfig({ dataDir: 'C:\\data', packageRoot: 'C:\\repo', tmpDir })).toThrow();
});

test('writeMcpConfig throws when packageRoot is missing and sandbox is enabled (the default)', () => {
  expect(() => writeMcpConfig({ dataDir: 'C:\\data', serverScriptPath: 'C:\\server.mjs', tmpDir })).toThrow();
});

test('writeMcpConfig with sandbox:false does not require packageRoot and drops the --permission argv', () => {
  const configPath = writeMcpConfig({ dataDir: 'C:\\data', serverScriptPath: 'C:\\server.mjs', tmpDir, sandbox: false });
  const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  const entry = config.mcpServers['kaprek-apps'];
  expect(entry.command).toBe(process.execPath);
  expect(entry.args).toEqual(['C:\\server.mjs']);
});

test('two calls to writeMcpConfig produce distinct file paths', () => {
  const a = writeMcpConfig({ dataDir: 'C:\\data', packageRoot: 'C:\\repo', serverScriptPath: 'C:\\server.mjs', tmpDir });
  const b = writeMcpConfig({ dataDir: 'C:\\data', packageRoot: 'C:\\repo', serverScriptPath: 'C:\\server.mjs', tmpDir });
  expect(a).not.toBe(b);
});

test('cleanupMcpConfig removes the file', () => {
  const configPath = writeMcpConfig({ dataDir: 'C:\\data', packageRoot: 'C:\\repo', serverScriptPath: 'C:\\server.mjs', tmpDir });
  cleanupMcpConfig(configPath);
  expect(fs.existsSync(configPath)).toBe(false);
});

test('cleanupMcpConfig on an already-missing file does not throw', () => {
  expect(() => cleanupMcpConfig(path.join(tmpDir, 'nope.json'))).not.toThrow();
});

// ------------------------------------------------------- integration: sandbox enforcement

let child;
let root;

afterEach(() => {
  if (child && !child.killed) child.kill();
  child = null;
  if (root) fs.rmSync(root, { recursive: true, force: true });
  root = null;
});

/** A user app whose handler tries a raw fs.writeFileSync() OUTSIDE the workspace, bypassing src/workspace/fs.mjs entirely — proves the sandbox (not app-level code) is what stops it. */
function writeEscapeFixtureApp(dataDir, outsideFile) {
  const appDir = path.join(dataDir, 'apps', 'escape');
  fs.mkdirSync(appDir, { recursive: true });
  fs.writeFileSync(
    path.join(appDir, 'app.json'),
    JSON.stringify({
      id: 'escape',
      version: '1.0.0',
      name: 'Escape',
      description: 'Test fixture: writes outside the workspace directly via node:fs.',
      tools: [
        {
          id: 'escape.write',
          description: 'Tries fs.writeFileSync outside the workspace.',
          inputSchema: { type: 'object', properties: {} },
          handler: 'handler.mjs',
        },
      ],
      policy: { fsWrite: true, dataEgress: false, externalAction: 'never', sensitivity: 'high' },
    }),
    'utf8',
  );
  fs.writeFileSync(
    path.join(appDir, 'handler.mjs'),
    `import fs from 'node:fs';\n` +
      `export async function handler() {\n` +
      `  fs.writeFileSync(${JSON.stringify(outsideFile)}, 'escaped!');\n` +
      `  return { wrote: ${JSON.stringify(outsideFile)} };\n` +
      `}\n`,
    'utf8',
  );
}

/** Minimal newline-delimited JSON-RPC client over a spawned child's stdio (same shape as mcp-server.test.mjs's). */
function createRpcClient(proc) {
  const rl = readline.createInterface({ input: proc.stdout, crlfDelay: Infinity });
  const pending = new Map();
  rl.on('line', (line) => {
    if (!line.trim()) return;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      return;
    }
    if (msg.id !== undefined && msg.id !== null && pending.has(msg.id)) {
      pending.get(msg.id)(msg);
      pending.delete(msg.id);
    }
  });
  let nextId = 1;
  return {
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
  'sandboxed config: spawning with the exact argv writeMcpConfig() produces runs the server, and a handler that bypasses fs.mjs to write outside the workspace is denied by node --permission itself',
  async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'kaprek-mcp-config-sandbox-test-'));
    const dataDir = path.join(root, 'data');
    fs.mkdirSync(path.join(dataDir, 'workspace'), { recursive: true });
    const outsideFile = path.join(root, 'escaped.txt');
    writeEscapeFixtureApp(dataDir, outsideFile);

    const configPath = writeMcpConfig({
      dataDir,
      packageRoot: REPO_ROOT,
      serverScriptPath: SERVER_PATH,
      tmpDir: root,
    });
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    const entry = config.mcpServers['kaprek-apps'];

    child = spawn(entry.command, entry.args, {
      // Both sandbox cases put their fixture app under <dataDir>/apps, which is
      // off by default now (see loader.mjs::userAppsAllowed). They are about the
      // FILESYSTEM fence, not about that switch, so they opt in explicitly.
      env: { ...process.env, ...entry.env, [ALLOW_USER_APPS_ENV]: '1' },
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
    client.notify('notifications/initialized', {});

    const listRes = await client.request('tools/list', {});
    expect(listRes.result.tools.map((t) => t.name)).toContain('escape.write');

    const escapeRes = await client.request('tools/call', { name: 'escape.write', arguments: {} });
    expect(escapeRes.result.isError).toBe(true);
    expect(escapeRes.result.content[0].text).toMatch(/access.*denied|permission/i);
    expect(fs.existsSync(outsideFile)).toBe(false);

    child.stdin.end();
  },
  20000,
);

/** A user app whose handler tries to read an arbitrary path under dataDir directly via node:fs — proves the sandbox's --allow-fs-read scope is `<dataDir>/apps` + `<dataDir>/workspace`, never the bare dataDir (see mcp-config.mjs's module header). */
function readDataDirFixtureApp(dataDir) {
  const appDir = path.join(dataDir, 'apps', 'nosy');
  fs.mkdirSync(appDir, { recursive: true });
  fs.writeFileSync(
    path.join(appDir, 'app.json'),
    JSON.stringify({
      id: 'nosy',
      version: '1.0.0',
      name: 'Nosy',
      description: 'Test fixture: reads an arbitrary path under dataDir directly via node:fs.',
      tools: [
        {
          id: 'nosy.read',
          description: 'Tries fs.readFileSync on a path given by the caller.',
          inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
          handler: 'handler.mjs',
        },
      ],
      policy: { fsWrite: false, dataEgress: false, externalAction: 'never', sensitivity: 'high' },
    }),
    'utf8',
  );
  fs.writeFileSync(
    path.join(appDir, 'handler.mjs'),
    `import fs from 'node:fs';\n` +
      `export async function handler(args) {\n` +
      `  return { content: fs.readFileSync(args.path, 'utf8') };\n` +
      `}\n`,
    'utf8',
  );
}

test(
  'sandboxed config: --allow-fs-read is scoped to <dataDir>/apps and <dataDir>/workspace, never the bare dataDir — a sibling directory under dataDir (e.g. chats/) is denied',
  async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'kaprek-mcp-config-datadir-scope-test-'));
    const dataDir = path.join(root, 'data');
    fs.mkdirSync(path.join(dataDir, 'workspace'), { recursive: true });
    const chatsDir = path.join(dataDir, 'chats');
    fs.mkdirSync(chatsDir, { recursive: true });
    const secretFile = path.join(chatsDir, 'secret.txt');
    fs.writeFileSync(secretFile, 'this must never leave via a tool result', 'utf8');
    readDataDirFixtureApp(dataDir);

    const configPath = writeMcpConfig({ dataDir, packageRoot: REPO_ROOT, serverScriptPath: SERVER_PATH, tmpDir: root });
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    const entry = config.mcpServers['kaprek-apps'];

    child = spawn(entry.command, entry.args, {
      env: { ...process.env, ...entry.env, [ALLOW_USER_APPS_ENV]: '1' },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const client = createRpcClient(child);

    await client.request('initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'test-client', version: '0.0.0' },
    });
    client.notify('notifications/initialized', {});

    // The user app itself (under <dataDir>/apps) loads fine — proves that
    // narrowing away from the bare dataDir did not also break the one
    // subdirectory that's actually supposed to stay readable.
    const listRes = await client.request('tools/list', {});
    expect(listRes.result.tools.map((t) => t.name)).toContain('nosy.read');

    const res = await client.request('tools/call', { name: 'nosy.read', arguments: { path: secretFile } });
    expect(res.result.isError).toBe(true);
    expect(res.result.content[0].text).toMatch(/access.*denied|permission/i);

    child.stdin.end();
  },
  20000,
);
