import { test, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { extractPaths, verdictFor, MAX_PATHS_PER_SESSION } from './verdict.mjs';

const CWD = 'C:\\work\\demo';

test('absolute Windows and POSIX paths are found, trailing punctuation and line numbers dropped', () => {
  const text = 'See C:\\work\\demo\\src\\a.mjs:12 and (C:\\work\\demo\\README.md). Also /home/klaus/notes/todo.md, then done.';
  const found = extractPaths(text);
  expect(found).toEqual([path.resolve('C:\\work\\demo\\src\\a.mjs'), path.resolve('C:\\work\\demo\\README.md'), path.resolve('/home/klaus/notes/todo.md')]);
});

test('relative paths need a cwd; without one they are dropped rather than anchored to the process', () => {
  const text = 'edit src/search/index.mjs and web/src/pages/Search.tsx';
  expect(extractPaths(text)).toEqual([]);
  expect(extractPaths(text, { cwd: CWD })).toEqual([path.resolve(CWD, 'src/search/index.mjs'), path.resolve(CWD, 'web/src/pages/Search.tsx')]);
});

test('a bare filename, a URL and a route are not places', () => {
  const text = 'index.mjs is imported; fetch https://example.com/a/b.js; GET /api/plans/status; POST /api/search';
  expect(extractPaths(text, { cwd: CWD })).toEqual([]);
});

test('duplicates collapse (case-insensitively on Windows), the parent walk is skipped, and the cap holds', () => {
  const same = extractPaths('C:\\x\\y.md and c:\\x\\Y.md', { cwd: CWD });
  expect(same).toHaveLength(process.platform === 'win32' ? 1 : 2);
  expect(extractPaths('../secrets/x.env', { cwd: CWD })).toEqual([]);
  const many = Array.from({ length: MAX_PATHS_PER_SESSION + 20 }, (_, i) => `C:\\p\\f${i}.txt`).join(' ');
  expect(extractPaths(many)).toHaveLength(MAX_PATHS_PER_SESSION);
});

test('the verdict is stat plus a date: present, changed since the session, gone — directories are only ever present', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kaprek-verdict-'));
  const before = path.join(dir, 'before.txt');
  const after = path.join(dir, 'after.txt');
  fs.writeFileSync(before, 'x');
  fs.writeFileSync(after, 'y');
  const sessionMtimeMs = Date.now() + 60_000; // the session "ended" a minute from now
  fs.utimesSync(after, new Date(sessionMtimeMs + 120_000), new Date(sessionMtimeMs + 120_000));
  const gone = path.join(dir, 'gone.txt');
  const result = verdictFor([before, after, gone, dir], { sessionMtimeMs });
  expect(result).toMatchObject({ mentioned: 4, checked: 4, present: 2, changed: 1, gone: 1 });
  expect(result.sample.map((s) => s.verdict)).toEqual(['gone', 'changed', 'present', 'present']);
  expect(result.sample[0].path).toBe(gone);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('nothing mentioned is no verdict, and the check is bounded', () => {
  expect(verdictFor([], { sessionMtimeMs: 0 })).toBeNull();
  expect(verdictFor(null, { sessionMtimeMs: 0 })).toBeNull();
  const fakeStat = () => ({ isDirectory: () => false, mtimeMs: 0 });
  const result = verdictFor(Array.from({ length: 80 }, (_, i) => `/p/${i}.txt`), { sessionMtimeMs: 1, limit: 10, stat: fakeStat });
  expect(result).toMatchObject({ mentioned: 80, checked: 10, present: 10 });
  expect(result.sample).toHaveLength(5);
});
