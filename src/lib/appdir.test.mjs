import { test, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getAppDir, ensureAppDir } from './appdir.mjs';

test('getAppDir uses the package name under the given homedir by default', () => {
  const dir = getAppDir({ homedir: '/home/testuser', env: {} });
  expect(dir).toBe(path.join('/home/testuser', '.loryme'));
});

test('getAppDir honors the <NAME>_DATA_DIR env override', () => {
  const dir = getAppDir({ homedir: '/home/testuser', env: { LORYME_DATA_DIR: '/custom/data' } });
  expect(dir).toBe('/custom/data');
});

test('getAppDir does not create the directory as a side effect', () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'loryme-appdir-test-'));
  const dir = getAppDir({ homedir: tmpRoot, env: {} });
  expect(fs.existsSync(dir)).toBe(false);
});

test('ensureAppDir creates the directory recursively and returns its path', () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'loryme-appdir-test-'));
  const dir = ensureAppDir({ homedir: tmpRoot, env: {} });
  expect(dir).toBe(path.join(tmpRoot, '.loryme'));
  expect(fs.statSync(dir).isDirectory()).toBe(true);
});

test('ensureAppDir is idempotent when the directory already exists', () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'loryme-appdir-test-'));
  const options = { homedir: tmpRoot, env: {} };
  ensureAppDir(options);
  expect(() => ensureAppDir(options)).not.toThrow();
});

test('ensureAppDir respects the env override', () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'loryme-appdir-test-'));
  const customDir = path.join(tmpRoot, 'custom-data');
  const dir = ensureAppDir({ homedir: tmpRoot, env: { LORYME_DATA_DIR: customDir } });
  expect(dir).toBe(customDir);
  expect(fs.statSync(dir).isDirectory()).toBe(true);
});
