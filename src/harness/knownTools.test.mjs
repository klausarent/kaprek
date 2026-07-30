import { test, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readKnownTools, learnTools } from './knownTools.mjs';

let tmpDir;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kaprek-known-tools-test-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('readKnownTools returns [] when the file does not exist yet', () => {
  expect(readKnownTools(tmpDir)).toEqual([]);
});

test('readKnownTools falls back to [] for corrupt JSON, not a crash', () => {
  fs.mkdirSync(path.join(tmpDir, 'harness'), { recursive: true });
  fs.writeFileSync(path.join(tmpDir, 'harness', 'known-tools.json'), '{ not valid json', 'utf8');
  expect(readKnownTools(tmpDir)).toEqual([]);
});

test('readKnownTools falls back to [] for an unexpected shape', () => {
  fs.mkdirSync(path.join(tmpDir, 'harness'), { recursive: true });
  fs.writeFileSync(path.join(tmpDir, 'harness', 'known-tools.json'), JSON.stringify({ notTools: [] }), 'utf8');
  expect(readKnownTools(tmpDir)).toEqual([]);
});

test('learnTools persists new tool names, sorted, readable back via readKnownTools', () => {
  const result = learnTools(tmpDir, ['ScheduleWakeup', 'Monitor']);
  expect(result).toEqual(['Monitor', 'ScheduleWakeup']);
  expect(readKnownTools(tmpDir)).toEqual(['Monitor', 'ScheduleWakeup']);

  const filePath = path.join(tmpDir, 'harness', 'known-tools.json');
  const raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  expect(raw.version).toBe(1);
  expect(raw.tools).toEqual(['Monitor', 'ScheduleWakeup']);
  expect(typeof raw.learnedAt).toBe('string');
});

test('learnTools merges into existing learned tools, deduplicated', () => {
  learnTools(tmpDir, ['ScheduleWakeup']);
  learnTools(tmpDir, ['ScheduleWakeup', 'Monitor']);
  expect(readKnownTools(tmpDir)).toEqual(['Monitor', 'ScheduleWakeup']);
});

test('learnTools filters out mcp__ names — an MCP tool is never learned', () => {
  const result = learnTools(tmpDir, ['ScheduleWakeup', 'mcp__kaprek-apps__notes.write']);
  expect(result).toEqual(['ScheduleWakeup']);
  expect(readKnownTools(tmpDir)).toEqual(['ScheduleWakeup']);
});

test('learnTools with nothing new does not rewrite the file', () => {
  learnTools(tmpDir, ['ScheduleWakeup']);
  const filePath = path.join(tmpDir, 'harness', 'known-tools.json');
  const mtimeBefore = fs.statSync(filePath).mtimeMs;

  const writeSpy = vi.spyOn(fs, 'writeFileSync');
  const result = learnTools(tmpDir, ['ScheduleWakeup']); // already known
  expect(result).toEqual(['ScheduleWakeup']);
  expect(writeSpy).not.toHaveBeenCalled();
  expect(fs.statSync(filePath).mtimeMs).toBe(mtimeBefore);
  writeSpy.mockRestore();
});

test('learnTools with only mcp__/empty/non-string entries is a no-op', () => {
  const result = learnTools(tmpDir, ['mcp__kaprek-apps__notes.write', '', null, 42]);
  expect(result).toEqual([]);
  expect(fs.existsSync(path.join(tmpDir, 'harness', 'known-tools.json'))).toBe(false);
});

test('learnTools never throws even when the write fails (best-effort)', () => {
  const writeSpy = vi.spyOn(fs, 'writeFileSync').mockImplementation(() => {
    throw new Error('disk full (simulated)');
  });
  expect(() => learnTools(tmpDir, ['ScheduleWakeup'])).not.toThrow();
  writeSpy.mockRestore();
});
