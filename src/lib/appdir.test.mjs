import { test, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getAppDir, ensureAppDir } from './appdir.mjs';

test('getAppDir uses the package name under the given homedir by default', () => {
  const dir = getAppDir({ homedir: '/home/testuser', env: {} });
  expect(dir).toBe(path.join('/home/testuser', '.kaprek'));
});

test('getAppDir honors the <NAME>_DATA_DIR env override', () => {
  const dir = getAppDir({ homedir: '/home/testuser', env: { KAPREK_DATA_DIR: '/custom/data' } });
  expect(dir).toBe('/custom/data');
});

test('getAppDir does not create the directory as a side effect', () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'kaprek-appdir-test-'));
  const dir = getAppDir({ homedir: tmpRoot, env: {} });
  expect(fs.existsSync(dir)).toBe(false);
});

test('ensureAppDir creates the directory recursively and returns its canonical path', () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'kaprek-appdir-test-'));
  const dir = ensureAppDir({ homedir: tmpRoot, env: {} });
  // Compare canonical-to-canonical: os.tmpdir() may itself come back as a
  // Windows 8.3 short name, which ensureAppDir now resolves.
  expect(dir).toBe(fs.realpathSync.native(path.join(tmpRoot, '.kaprek')));
  expect(fs.statSync(dir).isDirectory()).toBe(true);
});

test('ensureAppDir is idempotent when the directory already exists', () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'kaprek-appdir-test-'));
  const options = { homedir: tmpRoot, env: {} };
  ensureAppDir(options);
  expect(() => ensureAppDir(options)).not.toThrow();
});

test('ensureAppDir respects the env override', () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'kaprek-appdir-test-'));
  const customDir = path.join(tmpRoot, 'custom-data');
  const dir = ensureAppDir({ homedir: tmpRoot, env: { KAPREK_DATA_DIR: customDir } });
  expect(dir).toBe(fs.realpathSync.native(customDir));
  expect(fs.statSync(dir).isDirectory()).toBe(true);
});

test('ensureAppDir resolves a symlink/junction to the real directory, so lock identity and writers agree', () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'kaprek-appdir-test-'));
  const real = path.join(tmpRoot, 'real-data');
  fs.mkdirSync(real);
  const link = path.join(tmpRoot, 'link-data');
  // 'junction' works unprivileged on Windows and is ignored elsewhere.
  fs.symlinkSync(real, link, 'junction');
  const dir = ensureAppDir({ homedir: tmpRoot, env: { KAPREK_DATA_DIR: link } });
  // The instance lock hashes the canonical path; if this returned the link
  // path instead, retargeting the link mid-run would divorce the held lock
  // from the directory actually written (Codex day-4 review, finding 3).
  expect(dir).toBe(fs.realpathSync.native(real));
  expect(dir).not.toBe(link);
});
