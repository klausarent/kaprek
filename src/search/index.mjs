// FTS5 session search index.
//
// search.db (in dataDir) holds one FTS5 document per session (title +
// concatenated user/assistant text, redacted) plus a plain `indexed` table
// keyed on sessionId that records the mtime/size the doc was built from, so
// rebuilds only re-parse sessions that actually changed.
import fs from 'node:fs';
import path from 'node:path';
import { getSqlite } from '../lib/sqlite.mjs';
import { scanProjects } from '../scan/scan.mjs';
import { digestSession } from '../parser/parse.mjs';
import { extractPaths, verdictFor } from './verdict.mjs';

// `mentioned` holds the absolute paths a session's text named (see
// verdict.mjs) — extracted at index time, checked against the disk at
// search time, so a hit can say whether it still points at anything.
const SCHEMA_SQL = `
CREATE VIRTUAL TABLE IF NOT EXISTS sessions_fts USING fts5(
  sessionId UNINDEXED,
  projectSlug UNINDEXED,
  title,
  content
);
CREATE TABLE IF NOT EXISTS indexed (
  sessionId TEXT PRIMARY KEY,
  mtime REAL,
  size INTEGER
);
CREATE TABLE IF NOT EXISTS mentioned (
  sessionId TEXT NOT NULL,
  path TEXT NOT NULL,
  PRIMARY KEY (sessionId, path)
);
`;

/**
 * Bumped when the index needs a full rebuild to be right. Version 2 added
 * `mentioned`: a session indexed before it has an FTS document but no
 * paths, and "no paths" would read as "mentions nothing" — so an older
 * index is dropped whole rather than served with a silent gap, and the
 * search view offers its reindex button as it does for an empty index.
 */
export const SCHEMA_VERSION = 2;

/**
 * The specific reason reported when the index on disk was written by a NEWER
 * kaprek version (user_version > SCHEMA_VERSION): unlike the generic
 * "search not available" fallback this names the actual situation and what
 * to do about it — use the newer version, or delete search.db by hand if
 * rebuilding here is really wanted. kaprek never deletes or overwrites a
 * newer index on its own.
 */
export const FUTURE_SCHEMA_REASON =
  'Der Search-Index wurde von einer neueren kaprek-Version geschrieben. ' +
  'Bitte benutze die neuere kaprek-Version, oder lösche die Index-Datei (search.db) von Hand, ' +
  'wenn du den Index hier neu aufbauen willst.';

/**
 * Opens (creating if needed) the search DB at `<dataDir>/search.db`.
 * Returns `{ db, future: false }` after pragmas + schema applied, or
 * `{ db, future: true }` when the file was written by a newer kaprek
 * (user_version > SCHEMA_VERSION) — the caller must close `db` immediately
 * and touch nothing: no drops, no schema, no writes. Only a read of
 * user_version has happened at that point, so the file stays byte-identical.
 */
function openDbSync(dataDir, DatabaseSync) {
  fs.mkdirSync(dataDir, { recursive: true });
  const db = new DatabaseSync(path.join(dataDir, 'search.db'));
  const version = db.prepare('PRAGMA user_version').get()?.user_version ?? 0;
  if (version > SCHEMA_VERSION) {
    return { db, future: true };
  }
  if (version < SCHEMA_VERSION) {
    db.exec('DROP TABLE IF EXISTS sessions_fts; DROP TABLE IF EXISTS indexed; DROP TABLE IF EXISTS mentioned;');
    db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
  }
  // WAL lets a concurrent reader (search) and the writer (build) coexist
  // without blocking each other on every statement; busy_timeout makes lock
  // contention wait and retry for up to 5s instead of failing immediately
  // with SQLITE_BUSY. Both are connection-level pragmas, so they're applied
  // on every open rather than once at db-creation time.
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA busy_timeout = 5000');
  db.exec(SCHEMA_SQL);
  return { db, future: false };
}

/**
 * Opens the search DB (availability-checked, pragmas + schema applied).
 * Returns `{ db }` on success or `{ unavailable: true, reason }` instead of
 * throwing when node:sqlite isn't available — or when the index on disk was
 * written by a newer kaprek version (user_version > SCHEMA_VERSION): in that
 * case the file is not opened for writes, not dropped, and not rebuilt; the
 * reason is FUTURE_SCHEMA_REASON. Exported so callers/tests can
 * open the exact connection buildSearchIndex/searchSessions use, e.g. to
 * inspect PRAGMA state on that same connection.
 */
export async function openSearchDb({ dataDir, importSqlite } = {}) {
  const { available, DatabaseSync, reason } = await getSqlite(importSqlite);
  if (!available) return { unavailable: true, reason };
  const opened = openDbSync(dataDir, DatabaseSync);
  if (opened.future) {
    opened.db.close();
    return { unavailable: true, reason: FUTURE_SCHEMA_REASON };
  }
  return { db: opened.db };
}

/**
 * Turns raw user search input into a safe FTS5 MATCH query: every
 * whitespace-separated token becomes its own quoted phrase (internal quotes
 * doubled per FTS5 escaping rules), joined with implicit AND. This neutralizes
 * FTS5 query-syntax operators (AND/OR/NEAR/*, column filters like `col:`,
 * unbalanced parens, ...) in the raw input — they end up as literal phrase
 * text instead of being interpreted as query syntax.
 */
function toMatchQuery(query) {
  if (typeof query !== 'string') return '';
  const tokens = query.trim().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return '';
  return tokens.map((token) => `"${token.replace(/"/g, '""')}"`).join(' ');
}

/**
 * Builds/updates the search index by scanning `rootDir` and indexing every
 * session whose (mtime, size) differs from what's already recorded. Returns
 * `{ unavailable: true, reason }` instead of throwing when node:sqlite (or
 * its FTS5 support) is not available in this runtime.
 */
export async function buildSearchIndex({ rootDir, dataDir, onProgress, importSqlite } = {}) {
  const opened = await openSearchDb({ dataDir, importSqlite });
  if (opened.unavailable) return opened;
  const { db } = opened;
  try {
    const sessions = scanProjects(rootDir).flatMap((project) =>
      project.sessions.map((session) => ({ ...session, projectSlug: project.projectSlug })),
    );

    const selectStmt = db.prepare('SELECT mtime, size FROM indexed WHERE sessionId = ?');
    const deleteFtsStmt = db.prepare('DELETE FROM sessions_fts WHERE sessionId = ?');
    const deleteMetaStmt = db.prepare('DELETE FROM indexed WHERE sessionId = ?');
    const insertFtsStmt = db.prepare(
      'INSERT INTO sessions_fts (sessionId, projectSlug, title, content) VALUES (?, ?, ?, ?)',
    );
    const insertMetaStmt = db.prepare('INSERT INTO indexed (sessionId, mtime, size) VALUES (?, ?, ?)');
    const deleteMentionedStmt = db.prepare('DELETE FROM mentioned WHERE sessionId = ?');
    const insertMentionedStmt = db.prepare('INSERT OR IGNORE INTO mentioned (sessionId, path) VALUES (?, ?)');

    let indexed = 0;
    let skipped = 0;
    const total = sessions.length;
    let done = 0;

    for (const session of sessions) {
      const mtimeMs = new Date(session.mtime).getTime();
      const existing = selectStmt.get(session.sessionId);
      if (existing && existing.mtime === mtimeMs && existing.size === session.sizeBytes) {
        skipped += 1;
        done += 1;
        if (onProgress) onProgress(done, total);
        continue;
      }

      const digest = await digestSession(session.file, { redact: true });
      const content = digest.events
        .filter((event) => event.kind === 'user' || event.kind === 'assistant')
        .map((event) => event.text)
        .join('\n');
      const title = digest.meta.title ?? '';
      // Same redacted text the FTS document holds — a path inside a
      // redacted secret is gone before it can be recorded here.
      const mentioned = extractPaths(content, { cwd: digest.meta.cwd ?? null });

      // Wrapped so the writes commit atomically: a failure between the
      // FTS delete and the meta update (crash, disk full, ...) rolls back
      // to the PRE-attempt state, so the meta row's old (non-matching) mtime
      // is what next build's skip check sees — not a half-written state
      // where meta looks "current" while the FTS content is stale/missing.
      db.exec('BEGIN');
      try {
        deleteFtsStmt.run(session.sessionId);
        deleteMetaStmt.run(session.sessionId);
        deleteMentionedStmt.run(session.sessionId);
        insertFtsStmt.run(session.sessionId, session.projectSlug, title, content);
        insertMetaStmt.run(session.sessionId, mtimeMs, session.sizeBytes);
        for (const mentionedPath of mentioned) insertMentionedStmt.run(session.sessionId, mentionedPath);
        db.exec('COMMIT');
      } catch (err) {
        db.exec('ROLLBACK');
        throw err;
      }

      indexed += 1;
      done += 1;
      if (onProgress) onProgress(done, total);
    }

    // Orphan cleanup: a session file that no longer exists under rootDir
    // (deleted, moved, or the whole project removed) must not stay
    // searchable forever — without this, `indexed` never shrinks and a
    // search result can point at a session whose digest route now 404s.
    const currentIds = new Set(sessions.map((s) => s.sessionId));
    const existingIds = db.prepare('SELECT sessionId FROM indexed').all().map((row) => row.sessionId);
    const orphanIds = existingIds.filter((id) => !currentIds.has(id));

    let removed = 0;
    const CHUNK_SIZE = 500; // stay comfortably under SQLite's default 999-bound-parameter limit
    for (let i = 0; i < orphanIds.length; i += CHUNK_SIZE) {
      const chunk = orphanIds.slice(i, i + CHUNK_SIZE);
      const placeholders = chunk.map(() => '?').join(',');
      db.exec('BEGIN');
      try {
        db.prepare(`DELETE FROM sessions_fts WHERE sessionId IN (${placeholders})`).run(...chunk);
        db.prepare(`DELETE FROM indexed WHERE sessionId IN (${placeholders})`).run(...chunk);
        db.prepare(`DELETE FROM mentioned WHERE sessionId IN (${placeholders})`).run(...chunk);
        db.exec('COMMIT');
      } catch (err) {
        db.exec('ROLLBACK');
        throw err;
      }
      removed += chunk.length;
    }

    return { indexed, skipped, removed };
  } finally {
    db.close();
  }
}

/**
 * Searches the index built by `buildSearchIndex`. `query` is sanitized into
 * safe FTS5 phrase tokens (see `toMatchQuery`) before being bound as a MATCH
 * parameter, so it can never throw on FTS5 query-syntax errors or reach the
 * outer SQL as anything but a plain bound value.
 *
 * Every hit carries `files`: the verdict on the paths the session mentioned,
 * checked against the disk NOW (see verdict.mjs) — or null when it mentioned
 * none. `stat` is injectable so a test can decide what the disk says.
 */
export async function searchSessions({ dataDir, query, limit = 50, importSqlite, stat } = {}) {
  const matchQuery = toMatchQuery(query);
  if (!matchQuery) return [];

  const opened = await openSearchDb({ dataDir, importSqlite });
  if (opened.unavailable) return opened;
  const { db } = opened;
  try {
    const stmt = db.prepare(`
      SELECT sessionId, projectSlug, title,
             snippet(sessions_fts, 3, '<b>', '</b>', '…', 8) AS snippet
      FROM sessions_fts
      WHERE sessions_fts MATCH ?
      ORDER BY rank
      LIMIT ?
    `);
    const mentionedStmt = db.prepare('SELECT path FROM mentioned WHERE sessionId = ? ORDER BY rowid');
    const mtimeStmt = db.prepare('SELECT mtime FROM indexed WHERE sessionId = ?');
    return stmt.all(matchQuery, limit).map((row) => {
      const paths = mentionedStmt.all(row.sessionId).map((entry) => entry.path);
      const sessionMtimeMs = mtimeStmt.get(row.sessionId)?.mtime ?? NaN;
      return {
        sessionId: row.sessionId,
        projectSlug: row.projectSlug,
        title: row.title,
        snippet: row.snippet,
        files: verdictFor(paths, { sessionMtimeMs, ...(stat ? { stat } : {}) }),
      };
    });
  } finally {
    db.close();
  }
}
