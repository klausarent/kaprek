// Tests for the --mcp-config file writer. Run: npx vitest run src/apps/mcp-config.test.mjs
import { test, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { writeMcpConfig, cleanupMcpConfig } from './mcp-config.mjs';

let tmpDir;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kaprek-mcp-config-test-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('writeMcpConfig writes a file with the mcpServers/command/args/env shape Claude Code expects', () => {
  const configPath = writeMcpConfig({
    dataDir: 'C:\\data',
    appsDir: 'C:\\apps',
    serverScriptPath: 'C:\\repo\\src\\apps\\mcp-server.mjs',
    tmpDir,
  });

  expect(fs.existsSync(configPath)).toBe(true);
  const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  expect(config).toEqual({
    mcpServers: {
      'kaprek-apps': {
        command: 'node',
        args: ['C:\\repo\\src\\apps\\mcp-server.mjs'],
        env: {
          KAPREK_DATA_DIR: 'C:\\data',
          KAPREK_APPS_DIR: 'C:\\apps',
        },
      },
    },
  });
});

test('writeMcpConfig omits KAPREK_APPS_DIR when appsDir is not given', () => {
  const configPath = writeMcpConfig({ dataDir: 'C:\\data', serverScriptPath: 'C:\\server.mjs', tmpDir });
  const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  expect(config.mcpServers['kaprek-apps'].env).toEqual({ KAPREK_DATA_DIR: 'C:\\data' });
});

test('writeMcpConfig throws when dataDir is missing', () => {
  expect(() => writeMcpConfig({ serverScriptPath: 'C:\\server.mjs', tmpDir })).toThrow();
});

test('writeMcpConfig throws when serverScriptPath is missing', () => {
  expect(() => writeMcpConfig({ dataDir: 'C:\\data', tmpDir })).toThrow();
});

test('two calls to writeMcpConfig produce distinct file paths', () => {
  const a = writeMcpConfig({ dataDir: 'C:\\data', serverScriptPath: 'C:\\server.mjs', tmpDir });
  const b = writeMcpConfig({ dataDir: 'C:\\data', serverScriptPath: 'C:\\server.mjs', tmpDir });
  expect(a).not.toBe(b);
});

test('cleanupMcpConfig removes the file', () => {
  const configPath = writeMcpConfig({ dataDir: 'C:\\data', serverScriptPath: 'C:\\server.mjs', tmpDir });
  cleanupMcpConfig(configPath);
  expect(fs.existsSync(configPath)).toBe(false);
});

test('cleanupMcpConfig on an already-missing file does not throw', () => {
  expect(() => cleanupMcpConfig(path.join(tmpDir, 'nope.json'))).not.toThrow();
});
