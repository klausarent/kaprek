// Tests for the pure CLI argv parser. Run: npx vitest run src/cli/args.test.mjs
import { test, expect } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import { parseArgs } from './args.mjs';

test('defaults: no flags yields port 4900, ~/.claude/projects, redact+open true, help false', () => {
  const opts = parseArgs([]);
  expect(opts.port).toBe(4900);
  expect(opts.dir).toBe(path.join(os.homedir(), '.claude', 'projects'));
  expect(opts.redact).toBe(true);
  expect(opts.open).toBe(true);
  expect(opts.help).toBe(false);
});

test('--port overrides the default port', () => {
  const opts = parseArgs(['--port', '5555']);
  expect(opts.port).toBe(5555);
});

test('--dir overrides the default root directory', () => {
  const opts = parseArgs(['--dir', 'C:\\some\\other\\path']);
  expect(opts.dir).toBe('C:\\some\\other\\path');
});

test('--no-redact disables redaction', () => {
  const opts = parseArgs(['--no-redact']);
  expect(opts.redact).toBe(false);
});

test('--no-open disables auto-opening the browser', () => {
  const opts = parseArgs(['--no-open']);
  expect(opts.open).toBe(false);
});

test('--help and -h both set help to true', () => {
  expect(parseArgs(['--help']).help).toBe(true);
  expect(parseArgs(['-h']).help).toBe(true);
});

test('flags can be combined in any order', () => {
  const opts = parseArgs(['--no-open', '--port', '4901', '--no-redact', '--dir', '/tmp/x']);
  expect(opts.port).toBe(4901);
  expect(opts.dir).toBe('/tmp/x');
  expect(opts.redact).toBe(false);
  expect(opts.open).toBe(false);
});

test('non-numeric --port throws a clear error', () => {
  expect(() => parseArgs(['--port', 'abc'])).toThrow(/Invalid --port value/);
});

test('--port 0 throws (below the valid range)', () => {
  expect(() => parseArgs(['--port', '0'])).toThrow(/Invalid --port value/);
});

test('--port 65536 throws (above the valid range)', () => {
  expect(() => parseArgs(['--port', '65536'])).toThrow(/Invalid --port value/);
});

test('negative --port throws', () => {
  expect(() => parseArgs(['--port', '-1'])).toThrow(/Invalid --port value/);
});

test('--port at the end of argv with no value throws', () => {
  expect(() => parseArgs(['--port'])).toThrow(/Invalid --port value/);
});

test('--dir at the end of argv with no value throws', () => {
  expect(() => parseArgs(['--dir'])).toThrow(/--dir requires a path argument/);
});

test('an unknown flag throws', () => {
  expect(() => parseArgs(['--bogus'])).toThrow(/Unknown argument: --bogus/);
});
