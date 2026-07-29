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
`;

/** Opens (creating if needed) the search DB at `<dataDir>/search.db` with schema applied. */
function openDb(dataDir, DatabaseSync) {
  fs.mkdirSync(dataDir, { recursive: true });
  const db = new DatabaseSync(path.join(dataDir, 'search.db'));
  db.exec(SCHEMA_SQL);
  return db;
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
  const { available, DatabaseSync, reason } = await getSqlite(importSqlite);
  if (!available) return { unavailable: true, reason };

  const db = openDb(dataDir, DatabaseSync);
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

      deleteFtsStmt.run(session.sessionId);
      deleteMetaStmt.run(session.sessionId);
      insertFtsStmt.run(session.sessionId, session.projectSlug, title, content);
      insertMetaStmt.run(session.sessionId, mtimeMs, session.sizeBytes);

      indexed += 1;
      done += 1;
      if (onProgress) onProgress(done, total);
    }

    return { indexed, skipped };
  } finally {
    db.close();
  }
}

/**
 * Searches the index built by `buildSearchIndex`. `query` is sanitized into
 * safe FTS5 phrase tokens (see `toMatchQuery`) before being bound as a MATCH
 * parameter, so it can never throw on FTS5 query-syntax errors or reach the
 * outer SQL as anything but a plain bound value.
 */
export async function searchSessions({ dataDir, query, limit = 50, importSqlite } = {}) {
  const { available, DatabaseSync, reason } = await getSqlite(importSqlite);
  if (!available) return { unavailable: true, reason };

  const matchQuery = toMatchQuery(query);
  if (!matchQuery) return [];

  const db = openDb(dataDir, DatabaseSync);
  try {
    const stmt = db.prepare(`
      SELECT sessionId, projectSlug, title,
             snippet(sessions_fts, 3, '<b>', '</b>', '…', 8) AS snippet
      FROM sessions_fts
      WHERE sessions_fts MATCH ?
      ORDER BY rank
      LIMIT ?
    `);
    return stmt.all(matchQuery, limit).map((row) => ({
      sessionId: row.sessionId,
      projectSlug: row.projectSlug,
      title: row.title,
      snippet: row.snippet,
    }));
  } finally {
    db.close();
  }
}
