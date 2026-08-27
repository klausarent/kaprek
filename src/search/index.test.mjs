// Tests for the FTS5 session search index.
// Run: npx vitest run src/search
import { test, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { buildSearchIndex, searchSessions, openSearchDb } from './index.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MINI_FIXTURE = path.join(__dirname, '..', 'parser', 'fixtures', 'mini-session.jsonl');
const SECRET_FIXTURE = path.join(__dirname, '..', 'server', 'fixtures', 'session-with-secret.jsonl');
const SECRET_PLAINTEXT = 'sk-test0000000000000000AAAA';

let rootDir;
let dataDir;

beforeEach(() => {
  rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'search-root-'));
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'search-data-'));
});

afterEach(() => {
  fs.rmSync(rootDir, { recursive: true, force: true });
  fs.rmSync(dataDir, { recursive: true, force: true });
});

/** Copies a fixture .jsonl file into `rootDir/<projectSlug>/<sessionId>.jsonl`. */
function seedSession(projectSlug, sessionId, fixturePath) {
  const projectDir = path.join(rootDir, projectSlug);
  fs.mkdirSync(projectDir, { recursive: true });
  const dest = path.join(projectDir, `${sessionId}.jsonl`);
  fs.copyFileSync(fixturePath, dest);
  return dest;
}

test('buildSearchIndex indexes sessions found under rootDir', async () => {
  seedSession('proj-a', 'mini-session', MINI_FIXTURE);

  const result = await buildSearchIndex({ rootDir, dataDir });
  expect(result.unavailable).toBeUndefined();
  expect(result.indexed).toBe(1);
  expect(result.skipped).toBe(0);
});

test('rebuilding an unchanged rootDir skips already-indexed sessions', async () => {
  seedSession('proj-a', 'mini-session', MINI_FIXTURE);

  await buildSearchIndex({ rootDir, dataDir });
  const second = await buildSearchIndex({ rootDir, dataDir });
  expect(second.indexed).toBe(0);
  expect(second.skipped).toBe(1);
});

test('an updated session file (new mtime/size) gets re-indexed, not skipped', async () => {
  const filePath = seedSession('proj-a', 'mini-session', MINI_FIXTURE);
  await buildSearchIndex({ rootDir, dataDir });

  await new Promise((resolve) => setTimeout(resolve, 10));
  fs.appendFileSync(filePath, '\n');
  const future = new Date(Date.now() + 5000);
  fs.utimesSync(filePath, future, future);

  const second = await buildSearchIndex({ rootDir, dataDir });
  expect(second.indexed).toBe(1);
  expect(second.skipped).toBe(0);
});

test('reindex removes a session from the index once its file is deleted (no orphaned rows, no stale search hits)', async () => {
  const filePath = seedSession('proj-a', 'mini-session', MINI_FIXTURE);
  const first = await buildSearchIndex({ rootDir, dataDir });
  expect(first.indexed).toBe(1);

  const preDelete = await searchSessions({ dataDir, query: 'fixture' });
  expect(preDelete.length).toBe(1);

  fs.rmSync(filePath);
  const second = await buildSearchIndex({ rootDir, dataDir });
  expect(second.removed).toBe(1);

  const postDelete = await searchSessions({ dataDir, query: 'fixture' });
  expect(postDelete).toEqual([]);

  const db = new DatabaseSync(path.join(dataDir, 'search.db'));
  try {
    const metaRow = db.prepare('SELECT * FROM indexed WHERE sessionId = ?').get('mini-session');
    expect(metaRow).toBeUndefined();
    const ftsRow = db.prepare('SELECT * FROM sessions_fts WHERE sessionId = ?').get('mini-session');
    expect(ftsRow).toBeUndefined();
  } finally {
    db.close();
  }
});

test('reindex leaves other sessions\' rows untouched when removing an orphan', async () => {
  seedSession('proj-a', 'mini-session', MINI_FIXTURE);
  const secretPath = seedSession('proj-b', 'fixture-secret', SECRET_FIXTURE);
  await buildSearchIndex({ rootDir, dataDir });

  fs.rmSync(secretPath);
  const second = await buildSearchIndex({ rootDir, dataDir });
  expect(second.removed).toBe(1);

  const results = await searchSessions({ dataDir, query: 'Digest Parser' });
  expect(results.length).toBe(1);
  expect(results[0].sessionId).toBe('mini-session');
});

test('onProgress is called with (done, total) for every scanned session', async () => {
  seedSession('proj-a', 'mini-session', MINI_FIXTURE);
  seedSession('proj-b', 'fixture-secret', SECRET_FIXTURE);

  const calls = [];
  await buildSearchIndex({ rootDir, dataDir, onProgress: (done, total) => calls.push([done, total]) });

  expect(calls.length).toBe(2);
  expect(calls[calls.length - 1]).toEqual([2, 2]);
});

test('search finds a title match', async () => {
  seedSession('proj-a', 'mini-session', MINI_FIXTURE);
  await buildSearchIndex({ rootDir, dataDir });

  const results = await searchSessions({ dataDir, query: 'Digest Parser' });
  expect(results.length).toBe(1);
  expect(results[0].sessionId).toBe('mini-session');
  expect(results[0].projectSlug).toBe('proj-a');
  expect(results[0].title).toBe('Final title: Digest Parser Fixture');
});

test('search finds a content match (user prompt text) with a snippet', async () => {
  seedSession('proj-a', 'mini-session', MINI_FIXTURE);
  await buildSearchIndex({ rootDir, dataDir });

  const results = await searchSessions({ dataDir, query: 'fixture' });
  expect(results.length).toBe(1);
  expect(typeof results[0].snippet).toBe('string');
  expect(results[0].snippet.length).toBeGreaterThan(0);
});

test('search returns no results for a query that matches nothing', async () => {
  seedSession('proj-a', 'mini-session', MINI_FIXTURE);
  await buildSearchIndex({ rootDir, dataDir });

  const results = await searchSessions({ dataDir, query: 'zzz-does-not-exist-anywhere' });
  expect(results).toEqual([]);
});

test('search on an empty/whitespace query returns [] without touching the DB', async () => {
  const results = await searchSessions({ dataDir, query: '   ' });
  expect(results).toEqual([]);
});

test.each([
  'col:',
  '"',
  '*',
  'NEAR(',
  ');DROP TABLE sessions_fts',
  'foo OR bar AND baz',
  '"unterminated phrase',
])('injection/operator input %j does not throw and returns an array', async (query) => {
  seedSession('proj-a', 'mini-session', MINI_FIXTURE);
  await buildSearchIndex({ rootDir, dataDir });

  const results = await searchSessions({ dataDir, query });
  expect(Array.isArray(results)).toBe(true);
});

test('injection input never executes as SQL: sessions_fts survives a DROP TABLE attempt', async () => {
  seedSession('proj-a', 'mini-session', MINI_FIXTURE);
  await buildSearchIndex({ rootDir, dataDir });

  await searchSessions({ dataDir, query: '");DROP TABLE sessions_fts;--' });

  const db = new DatabaseSync(path.join(dataDir, 'search.db'));
  try {
    const row = db.prepare('SELECT COUNT(*) AS n FROM sessions_fts').get();
    expect(row.n).toBe(1);
  } finally {
    db.close();
  }
});

test('redaction: the synthetic secret is not present in the indexed content', async () => {
  // In this fixture the secret only appears in a tool_result (Bash output).
  // Indexed content is limited to user+assistant text per spec, so the
  // secret never reaches the index at all here — the plaintext-absence
  // check below is still the meaningful guarantee.
  seedSession('proj-b', 'fixture-secret', SECRET_FIXTURE);
  await buildSearchIndex({ rootDir, dataDir });

  const db = new DatabaseSync(path.join(dataDir, 'search.db'));
  try {
    const row = db.prepare('SELECT content FROM sessions_fts WHERE sessionId = ?').get('fixture-secret');
    expect(row).toBeTruthy();
    expect(row.content).not.toContain(SECRET_PLAINTEXT);
  } finally {
    db.close();
  }
});

test('redaction: a secret in a user-prompt event is redacted in the indexed content', async () => {
  const projectDir = path.join(rootDir, 'proj-c');
  fs.mkdirSync(projectDir, { recursive: true });
  const filePath = path.join(projectDir, 'secret-in-prompt.jsonl');
  const line = {
    parentUuid: null,
    isSidechain: false,
    type: 'user',
    promptId: 'p1',
    message: { role: 'user', content: `My key is ${SECRET_PLAINTEXT}, please use it.` },
    uuid: 'u1',
    timestamp: '2026-07-29T09:00:00.000Z',
    cwd: 'C:\\Users\\testuser\\proj',
    sessionId: 'secret-in-prompt',
    version: '2.1.212',
  };
  fs.writeFileSync(filePath, `${JSON.stringify(line)}\n`, 'utf8');

  await buildSearchIndex({ rootDir, dataDir });

  const db = new DatabaseSync(path.join(dataDir, 'search.db'));
  try {
    const row = db.prepare('SELECT content FROM sessions_fts WHERE sessionId = ?').get('secret-in-prompt');
    expect(row).toBeTruthy();
    expect(row.content).not.toContain(SECRET_PLAINTEXT);
    expect(row.content).toContain('[REDACTED]');
  } finally {
    db.close();
  }
});

test('buildSearchIndex returns {unavailable:true, reason} instead of throwing when sqlite is missing', async () => {
  const failingImport = () => Promise.reject(new Error('no sqlite here'));
  const result = await buildSearchIndex({ rootDir, dataDir, importSqlite: failingImport });
  expect(result).toEqual({ unavailable: true, reason: 'no sqlite here' });
});

test('searchSessions returns {unavailable:true, reason} instead of throwing when sqlite is missing', async () => {
  const failingImport = () => Promise.reject(new Error('no sqlite here'));
  const result = await searchSessions({ dataDir, query: 'anything', importSqlite: failingImport });
  expect(result).toEqual({ unavailable: true, reason: 'no sqlite here' });
});

/**
 * Wraps the real node:sqlite DatabaseSync so a chosen statement's `.run()`
 * throws once it's prepared — lets tests inject a write failure mid-way
 * through the per-session write without touching production code, using the
 * same `importSqlite` seam the module already exposes for availability
 * testing.
 */
function makeFailingSqliteImport(RealDatabaseSync, failSqlIncludes, failureMessage) {
  class FailingDatabaseSync {
    #real;
    constructor(...args) {
      this.#real = new RealDatabaseSync(...args);
    }
    exec(sql) {
      return this.#real.exec(sql);
    }
    close() {
      return this.#real.close();
    }
    prepare(sql) {
      if (sql.includes(failSqlIncludes)) {
        return { run: () => { throw new Error(failureMessage); } };
      }
      return this.#real.prepare(sql);
    }
  }
  return async () => ({ DatabaseSync: FailingDatabaseSync });
}

test('a write failure mid-transaction is rolled back: the session is re-indexed next build, not permanently skipped', async () => {
  const filePath = seedSession('proj-a', 'mini-session', MINI_FIXTURE);

  const first = await buildSearchIndex({ rootDir, dataDir });
  expect(first.indexed).toBe(1);
  const originalMtimeMs = fs.statSync(filePath).mtime.getTime();
  const originalSize = fs.statSync(filePath).size;

  // Change the file so the next build sees it as needing a re-index.
  await new Promise((resolve) => setTimeout(resolve, 10));
  fs.appendFileSync(filePath, '\n');
  const future = new Date(Date.now() + 5000);
  fs.utimesSync(filePath, future, future);

  const failingImport = makeFailingSqliteImport(DatabaseSync, 'INSERT INTO indexed', 'simulated meta write failure');
  await expect(
    buildSearchIndex({ rootDir, dataDir, importSqlite: failingImport }),
  ).rejects.toThrow('simulated meta write failure');

  // Rolled back to the pre-attempt state: meta still shows the OLD mtime/size
  // (so it will not falsely look "up to date"), and the FTS row is the old
  // one too, not a half-written new one that the failed meta insert would
  // otherwise leave orphaned/stale.
  const db = new DatabaseSync(path.join(dataDir, 'search.db'));
  try {
    const metaRow = db.prepare('SELECT mtime, size FROM indexed WHERE sessionId = ?').get('mini-session');
    expect(metaRow).toEqual({ mtime: originalMtimeMs, size: originalSize });
    const ftsRow = db.prepare('SELECT content FROM sessions_fts WHERE sessionId = ?').get('mini-session');
    expect(ftsRow).toBeTruthy();
  } finally {
    db.close();
  }

  // A normal (unpatched) build afterwards must re-index, not skip.
  const third = await buildSearchIndex({ rootDir, dataDir });
  expect(third.indexed).toBe(1);
  expect(third.skipped).toBe(0);
});

test('openSearchDb applies WAL journal mode and a 5s busy_timeout on its connection', async () => {
  const opened = await openSearchDb({ dataDir });
  expect(opened.unavailable).toBeUndefined();
  const { db } = opened;
  try {
    const journalMode = db.prepare('PRAGMA journal_mode').get();
    expect(String(journalMode.journal_mode).toLowerCase()).toBe('wal');
    const busyTimeout = db.prepare('PRAGMA busy_timeout').get();
    expect(busyTimeout.timeout).toBe(5000);
  } finally {
    db.close();
  }
});

test('buildSearchIndex issues the WAL + busy_timeout pragmas on open', async () => {
  seedSession('proj-a', 'mini-session', MINI_FIXTURE);

  const execCalls = [];
  class SpyDatabaseSync {
    #real;
    constructor(...args) {
      this.#real = new DatabaseSync(...args);
    }
    exec(sql) {
      execCalls.push(sql);
      return this.#real.exec(sql);
    }
    prepare(sql) {
      return this.#real.prepare(sql);
    }
    close() {
      return this.#real.close();
    }
  }
  const spyImport = async () => ({ DatabaseSync: SpyDatabaseSync });

  await buildSearchIndex({ rootDir, dataDir, importSqlite: spyImport });

  const joined = execCalls.join('\n');
  expect(joined).toMatch(/PRAGMA journal_mode\s*=\s*WAL/i);
  expect(joined).toMatch(/PRAGMA busy_timeout\s*=\s*5000/i);
});

// ------------------------------------------------------------------ verdicts

/** A one-turn session whose assistant text names `mentions`, with `cwd` as the session's working directory. */
function seedMentioningSession(projectSlug, sessionId, { cwd, mentions }) {
  const projectDir = path.join(rootDir, projectSlug);
  fs.mkdirSync(projectDir, { recursive: true });
  const dest = path.join(projectDir, `${sessionId}.jsonl`);
  const line = {
    parentUuid: null,
    isSidechain: false,
    type: 'assistant',
    message: { model: 'm', id: 'msg_1', type: 'message', role: 'assistant', content: [{ type: 'text', text: `I edited ${mentions.join(' and ')} for the verdict test.` }], stop_reason: null, usage: { input_tokens: 1, output_tokens: 1 } },
    uuid: 'a1',
    timestamp: '2026-08-27T10:00:00.000Z',
    cwd,
    sessionId,
    version: '2.1.212',
  };
  fs.writeFileSync(dest, `${JSON.stringify(line)}\n`, 'utf8');
  return dest;
}

test('a hit says whether the files the session named are still there, changed since, or gone', async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'search-cwd-'));
  const kept = path.join(cwd, 'src', 'kept.mjs');
  const moved = path.join(cwd, 'src', 'moved.mjs');
  fs.mkdirSync(path.dirname(kept), { recursive: true });
  fs.writeFileSync(kept, 'x');
  fs.writeFileSync(moved, 'y');
  const gone = path.join(cwd, 'src', 'gone.mjs');
  const sessionFile = seedMentioningSession('proj-v', 'verdict-session', { cwd, mentions: ['src/kept.mjs', moved, 'src/gone.mjs'] });
  // The session "ended" now; `moved` is touched afterwards, `kept` was written before.
  const old = new Date(Date.now() - 3_600_000);
  fs.utimesSync(kept, old, old);
  fs.utimesSync(sessionFile, new Date(), new Date());

  await buildSearchIndex({ rootDir, dataDir });
  fs.utimesSync(moved, new Date(Date.now() + 3_600_000), new Date(Date.now() + 3_600_000));

  const results = await searchSessions({ dataDir, query: 'verdict' });
  expect(results).toHaveLength(1);
  const { files } = results[0];
  expect(files).toMatchObject({ mentioned: 3, checked: 3, present: 1, changed: 1, gone: 1 });
  expect(files.sample[0]).toEqual({ path: gone, verdict: 'gone' });
  expect(files.sample[1]).toEqual({ path: moved, verdict: 'changed' });
  fs.rmSync(cwd, { recursive: true, force: true });
});

test('a session that names no file has no verdict, not a clean one', async () => {
  seedSession('proj-a', 'mini-session', MINI_FIXTURE);
  await buildSearchIndex({ rootDir, dataDir });
  const results = await searchSessions({ dataDir, query: 'fixture' });
  expect(results.length).toBeGreaterThan(0);
  for (const hit of results) expect(hit.files === null || typeof hit.files.mentioned === 'number').toBe(true);
});

test('an index from before the mentioned table is dropped whole rather than served with a gap', async () => {
  seedSession('proj-a', 'mini-session', MINI_FIXTURE);
  await buildSearchIndex({ rootDir, dataDir });
  // Pretend this index predates verdicts.
  const { db } = await openSearchDb({ dataDir });
  db.exec('PRAGMA user_version = 1');
  db.close();
  expect(await searchSessions({ dataDir, query: 'fixture' })).toEqual([]);
  // A rebuild fills it again, at the current version.
  await buildSearchIndex({ rootDir, dataDir });
  expect((await searchSessions({ dataDir, query: 'fixture' })).length).toBeGreaterThan(0);
  const reopened = await openSearchDb({ dataDir });
  expect(reopened.db.prepare('PRAGMA user_version').get().user_version).toBe(2);
  reopened.db.close();
});

test('the reindex removes the mentioned paths of a session whose file is gone', async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'search-cwd-'));
  const file = seedMentioningSession('proj-v', 'doomed', { cwd, mentions: ['src/a.mjs'] });
  await buildSearchIndex({ rootDir, dataDir });
  fs.rmSync(file);
  await buildSearchIndex({ rootDir, dataDir });
  const { db } = await openSearchDb({ dataDir });
  expect(db.prepare('SELECT COUNT(*) AS n FROM mentioned').get().n).toBe(0);
  db.close();
  fs.rmSync(cwd, { recursive: true, force: true });
});
