import { test, expect } from 'vitest';
import { getSqlite, hasFts5 } from './sqlite.mjs';

test('getSqlite reports availability and a usable DatabaseSync on this Node runtime', async () => {
  const { available, DatabaseSync, reason } = await getSqlite();
  expect(available).toBe(true);
  expect(reason).toBeUndefined();
  expect(typeof DatabaseSync).toBe('function');
});

test('hasFts5 detects FTS5 support via a :memory: probe table', async () => {
  const { DatabaseSync } = await getSqlite();
  expect(hasFts5(DatabaseSync)).toBe(true);
});

test('getSqlite returns available:false with a reason when the import fails', async () => {
  const failingImport = () => Promise.reject(new Error("Cannot find module 'node:sqlite'"));
  const result = await getSqlite(failingImport);
  expect(result).toEqual({
    available: false,
    DatabaseSync: null,
    reason: "Cannot find module 'node:sqlite'",
  });
});
