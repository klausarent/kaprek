// SQLite feature detection.
//
// node:sqlite is experimental (Node 22.5+) and emits an ExperimentalWarning
// on import, which we deliberately do not suppress. A static
// `import 'node:sqlite'` would throw at module-load time on older Node and
// take down the whole process before any try/catch could run, so detection
// goes through a dynamic import instead, kept local and recoverable.
//
// `importSqlite` is injectable so tests can simulate the "module missing"
// path without needing a second Node binary.

/**
 * Detects whether node:sqlite is available in the current runtime.
 * Returns `{ available: true, DatabaseSync }` on success, or
 * `{ available: false, DatabaseSync: null, reason }` otherwise.
 */
export async function getSqlite(importSqlite = () => import('node:sqlite')) {
  try {
    const mod = await importSqlite();
    return { available: true, DatabaseSync: mod.DatabaseSync };
  } catch (err) {
    return { available: false, DatabaseSync: null, reason: err.message };
  }
}

const FTS5_PROBE_SQL = 'CREATE VIRTUAL TABLE probe USING fts5(x)';

/**
 * Checks whether the given DatabaseSync class was built with the FTS5
 * extension, by attempting to create a virtual table in a throwaway
 * in-memory database.
 */
export function hasFts5(DatabaseSync) {
  const db = new DatabaseSync(':memory:');
  try {
    db.exec(FTS5_PROBE_SQL);
    return true;
  } catch {
    return false;
  } finally {
    db.close();
  }
}
