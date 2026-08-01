// Tests for the fast meta-scan (session list without a full parse).
// Run: npx vitest run src/scan
import { test, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { scanProjects, readSessionMeta, scanSessionFile, cacheFilePathFor, evictStaleCache, CACHE_DIR } from './scan.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

let tmpDir;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scan-test-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

/** Writes an array of objects as a JSONL file and returns its path. */
function writeJsonl(fileName, lines) {
  const filePath = path.join(tmpDir, fileName);
  fs.writeFileSync(filePath, lines.map((l) => JSON.stringify(l)).join('\n') + '\n', 'utf8');
  return filePath;
}

/** A minimal, valid envelope line so front/back windows have something to parse. */
function envelope(overrides = {}) {
  return {
    parentUuid: null,
    isSidechain: false,
    type: 'assistant',
    message: { model: 'claude-sonnet-5', id: 'msg_pad', type: 'message', role: 'assistant', content: [] },
    uuid: 'pad-uuid',
    timestamp: '2026-07-01T00:00:00.000Z',
    cwd: 'C:\\Users\\testuser\\Documents\\Software\\padding',
    sessionId: 'padding',
    version: '2.1.212',
    ...overrides,
  };
}

test('ai-title marker late in the file (within the back window) is found', () => {
  const padding = Array.from({ length: 300 }, (_, i) =>
    envelope({ uuid: `pad-${i}`, timestamp: `2026-07-01T00:${String(i % 60).padStart(2, '0')}:00.000Z` }),
  );
  const lines = [
    { type: 'last-prompt', leafUuid: 'irrelevant', sessionId: 'late-title' },
    ...padding,
    { type: 'ai-title', aiTitle: 'Late title found via back window', sessionId: 'late-title' },
  ];
  const filePath = writeJsonl('late-title.jsonl', lines);

  const meta = readSessionMeta(filePath, { cache: false });
  expect(meta.title).toBe('Late title found via back window');
});

test('the LAST ai-title marker in the scanned window wins, not the first', () => {
  const lines = [
    { type: 'ai-title', aiTitle: 'First title', sessionId: 'multi-title' },
    envelope({ uuid: 'mid' }),
    { type: 'ai-title', aiTitle: 'Final title', sessionId: 'multi-title' },
  ];
  const filePath = writeJsonl('multi-title.jsonl', lines);

  const meta = readSessionMeta(filePath, { cache: false });
  expect(meta.title).toBe('Final title');
});

test('reads at most a fixed byte budget regardless of file size (no full read)', () => {
  // 20 MB synthetic file — large enough to prove the read is bounded, small
  // enough to write fast in a test. The budget is a fixed constant, so the
  // same guarantee holds for a real 110 MB transcript.
  const lineObj = envelope();
  const line = JSON.stringify(lineObj) + '\n';
  const repeats = Math.ceil((20 * 1024 * 1024) / line.length);
  const filePath = path.join(tmpDir, 'huge.jsonl');
  const fd = fs.openSync(filePath, 'w');
  try {
    for (let i = 0; i < repeats; i += 1) fs.writeSync(fd, line);
  } finally {
    fs.closeSync(fd);
  }

  const { bytesRead, fileSize } = scanSessionFile(filePath, { cache: false });
  expect(fileSize).toBeGreaterThan(20 * 1024 * 1024);
  expect(bytesRead).toBeLessThan(2 * 1024 * 1024); // front + back budget, well under file size
  expect(bytesRead).toBeLessThan(fileSize / 10);
});

test('startedAt/endedAt reflect the min/max timestamp seen in the scanned window', () => {
  const lines = [
    envelope({ uuid: 'a', timestamp: '2026-07-01T09:00:00.000Z' }),
    envelope({ uuid: 'b', timestamp: '2026-07-01T09:05:00.000Z' }),
    envelope({ uuid: 'c', timestamp: '2026-07-01T08:59:00.000Z' }),
  ];
  const filePath = writeJsonl('timestamps.jsonl', lines);

  const meta = readSessionMeta(filePath, { cache: false });
  expect(meta.startedAt).toBe('2026-07-01T08:59:00.000Z');
  expect(meta.endedAt).toBe('2026-07-01T09:05:00.000Z');
});

test('turns counts distinct assistant message ids seen in the scanned window', () => {
  const lines = [
    envelope({ uuid: 'a1', message: { id: 'msg_1' } }),
    envelope({ uuid: 'a2', message: { id: 'msg_1' } }), // same turn, second content block
    envelope({ uuid: 'a3', message: { id: 'msg_2' } }),
  ];
  const filePath = writeJsonl('turns.jsonl', lines);

  const meta = readSessionMeta(filePath, { cache: false });
  expect(meta.turns).toBe(2);
});

test('title falls back to the last-prompt leafUuid\'s user message when no ai-title is present', () => {
  const lines = [
    {
      parentUuid: null, isSidechain: false, type: 'user',
      message: { role: 'user', content: 'Baue mir bitte einen Fallback-Titel-Test.' },
      uuid: 'user-leaf-uuid', timestamp: '2026-07-01T10:00:00.000Z',
      cwd: 'C:\\Users\\testuser\\proj', sessionId: 'fallback-title', version: '2.1.212',
    },
    { type: 'last-prompt', leafUuid: 'user-leaf-uuid', sessionId: 'fallback-title' },
  ];
  const filePath = writeJsonl('fallback-title.jsonl', lines);

  const meta = readSessionMeta(filePath, { cache: false });
  expect(meta.title).toBe('Baue mir bitte einen Fallback-Titel-Test.');
});

test('last-prompt fallback is skipped when the referenced message is isMeta', () => {
  const lines = [
    {
      parentUuid: null, isSidechain: false, type: 'user', isMeta: true,
      message: { role: 'user', content: '<system-reminder>not a real prompt</system-reminder>' },
      uuid: 'meta-leaf-uuid', timestamp: '2026-07-01T10:00:00.000Z',
      cwd: 'C:\\Users\\testuser\\proj', sessionId: 'meta-fallback', version: '2.1.212',
    },
    { type: 'last-prompt', leafUuid: 'meta-leaf-uuid', sessionId: 'meta-fallback' },
  ];
  const filePath = writeJsonl('meta-fallback.jsonl', lines);

  const meta = readSessionMeta(filePath, { cache: false });
  expect(meta.title).toBe(null);
});

test('machineHint is derived from a cwd field (Windows user segment)', () => {
  const lines = [envelope({ cwd: 'C:\\Users\\alicedev\\Documents\\projects\\demo-app' })];
  const filePath = writeJsonl('machine-hint.jsonl', lines);

  const meta = readSessionMeta(filePath, { cache: false });
  expect(meta.machineHint).toBe('alicedev');
});

test('machineHint is null when no cwd field is present in the scanned window', () => {
  const lines = [{ type: 'ai-title', aiTitle: 'No cwd here', sessionId: 'no-cwd' }];
  const filePath = writeJsonl('no-cwd.jsonl', lines);

  const meta = readSessionMeta(filePath, { cache: false });
  expect(meta.machineHint).toBe(null);
});

test('broken JSON lines in the scanned window are skipped, not a crash', () => {
  const filePath = path.join(tmpDir, 'broken.jsonl');
  fs.writeFileSync(
    filePath,
    [
      JSON.stringify(envelope({ uuid: 'ok-1' })),
      '{not valid json',
      JSON.stringify({ type: 'ai-title', aiTitle: 'Survives broken line', sessionId: 'broken' }),
    ].join('\n') + '\n',
    'utf8',
  );

  const meta = readSessionMeta(filePath, { cache: false });
  expect(meta.title).toBe('Survives broken line');
});

test('readSessionMeta caches its result as JSON in os.tmpdir(), keyed on path+mtime+size', () => {
  const filePath = writeJsonl('cached.jsonl', [
    { type: 'ai-title', aiTitle: 'Cached title v1', sessionId: 'cached' },
  ]);

  const cachePath = cacheFilePathFor(filePath);
  expect(fs.existsSync(cachePath)).toBe(false);

  const first = scanSessionFile(filePath); // cache: true (default)
  expect(first.cacheHit).toBe(false);
  expect(fs.existsSync(cachePath)).toBe(true);
  expect(JSON.parse(fs.readFileSync(cachePath, 'utf8')).title).toBe('Cached title v1');

  const second = scanSessionFile(filePath);
  expect(second.cacheHit).toBe(true);
  expect(second.meta.title).toBe('Cached title v1');
});

test('cache is invalidated when the file is modified (mtime/size change the cache key)', async () => {
  const filePath = writeJsonl('cache-invalidate.jsonl', [
    { type: 'ai-title', aiTitle: 'Original title', sessionId: 'inv' },
  ]);
  const first = scanSessionFile(filePath);
  expect(first.meta.title).toBe('Original title');

  // Ensure a different mtime (filesystem mtime resolution can be coarse).
  await new Promise((resolve) => setTimeout(resolve, 10));
  fs.writeFileSync(
    filePath,
    JSON.stringify({ type: 'ai-title', aiTitle: 'Updated title', sessionId: 'inv' }) + '\n',
    'utf8',
  );
  const future = new Date(Date.now() + 5000);
  fs.utimesSync(filePath, future, future);

  const second = scanSessionFile(filePath);
  expect(second.cacheHit).toBe(false);
  expect(second.meta.title).toBe('Updated title');
});

test('scanProjects lists project dirs and their .jsonl sessions, ignoring other files', () => {
  const projectA = path.join(tmpDir, 'C--Users-testuser-proj-a');
  const projectB = path.join(tmpDir, 'C--Users-testuser-proj-b');
  fs.mkdirSync(projectA);
  fs.mkdirSync(projectB);

  fs.writeFileSync(path.join(projectA, 'session-1.jsonl'), JSON.stringify(envelope()) + '\n', 'utf8');
  fs.writeFileSync(path.join(projectA, 'session-2.jsonl'), JSON.stringify(envelope()) + '\n', 'utf8');
  fs.writeFileSync(path.join(projectA, 'notes.txt'), 'not a session', 'utf8');
  fs.writeFileSync(path.join(projectB, 'session-3.jsonl'), JSON.stringify(envelope()) + '\n', 'utf8');

  const projects = scanProjects(tmpDir).sort((a, b) => a.projectSlug.localeCompare(b.projectSlug));

  expect(projects.length).toBe(2);
  expect(projects[0].projectSlug).toBe('C--Users-testuser-proj-a');
  expect(projects[0].dir).toBe(projectA);
  const sessionIds = projects[0].sessions.map((s) => s.sessionId).sort();
  expect(sessionIds).toEqual(['session-1', 'session-2']);
  for (const session of projects[0].sessions) {
    expect(session.sizeBytes).toBeGreaterThan(0);
    expect(typeof session.mtime).toBe('string');
    expect(fs.existsSync(session.file)).toBe(true);
  }

  expect(projects[1].sessions.map((s) => s.sessionId)).toEqual(['session-3']);
});

test('fallback title (derived from a user message) is redacted before it leaves the scan', () => {
  const lines = [
    {
      parentUuid: null, isSidechain: false, type: 'user',
      message: { role: 'user', content: 'My key is sk-test0000000000000000AAAA, please use it.' },
      uuid: 'user-leaf-uuid', timestamp: '2026-07-01T10:00:00.000Z',
      cwd: 'C:\\Users\\testuser\\proj', sessionId: 'fallback-title-secret', version: '2.1.212',
    },
    { type: 'last-prompt', leafUuid: 'user-leaf-uuid', sessionId: 'fallback-title-secret' },
  ];
  const filePath = writeJsonl('fallback-title-secret.jsonl', lines);

  const meta = readSessionMeta(filePath, { cache: false });
  expect(meta.title).toContain('[REDACTED]');
  expect(meta.title).not.toContain('sk-test0000000000000000AAAA');
});

test('an ai-title marker carrying a secret is redacted, not just the last-prompt fallback title', () => {
  const lines = [
    { type: 'ai-title', aiTitle: 'Fix sk-test0000000000000000AAAA before merging', sessionId: 'ai-title-secret' },
  ];
  const filePath = writeJsonl('ai-title-secret.jsonl', lines);

  const meta = readSessionMeta(filePath, { cache: false });
  expect(meta.title).toContain('[REDACTED]');
  expect(meta.title).not.toContain('sk-test0000000000000000AAAA');
});

test('evictStaleCache removes cache entries older than 30 days, keeps fresh ones', () => {
  fs.mkdirSync(CACHE_DIR, { recursive: true });
  const stalePath = path.join(CACHE_DIR, 'evict-test-stale.json');
  const freshPath = path.join(CACHE_DIR, 'evict-test-fresh.json');
  fs.writeFileSync(stalePath, '{}', 'utf8');
  fs.writeFileSync(freshPath, '{}', 'utf8');

  const stale = new Date(Date.now() - 31 * 24 * 60 * 60 * 1000);
  fs.utimesSync(stalePath, stale, stale);

  try {
    evictStaleCache();
    expect(fs.existsSync(stalePath)).toBe(false);
    expect(fs.existsSync(freshPath)).toBe(true);
  } finally {
    fs.rmSync(freshPath, { force: true });
  }
});

test('evictStaleCache is a no-op (no throw) when the cache dir does not exist yet', () => {
  const movedAway = `${CACHE_DIR}-moved-for-test`;
  fs.rmSync(movedAway, { recursive: true, force: true });
  if (fs.existsSync(CACHE_DIR)) fs.renameSync(CACHE_DIR, movedAway);
  try {
    expect(() => evictStaleCache()).not.toThrow();
  } finally {
    if (fs.existsSync(movedAway)) fs.renameSync(movedAway, CACHE_DIR);
  }
});

test('scanProjects returns an empty array for a missing rootDir instead of throwing', () => {
  const missing = path.join(tmpDir, 'does-not-exist');
  expect(scanProjects(missing)).toEqual([]);
});

test('sanity: the ported parser fixture still parses fine as input for the meta-scan window logic', () => {
  const fixture = path.join(__dirname, '..', 'parser', 'fixtures', 'mini-session.jsonl');
  const meta = readSessionMeta(fixture, { cache: false });
  expect(meta.title).toBe('Final title: Digest Parser Fixture');
});

test('scanProjects derives a readable displayName from the newest session cwd, and copes with sessions that have none', () => {
  const projDir = path.join(tmpDir, 'C--Users-u-Documents-my-tool');
  fs.mkdirSync(projDir);
  fs.writeFileSync(
    path.join(projDir, 'old.jsonl'),
    JSON.stringify(envelope({ cwd: 'C:\\Users\\u\\Documents\\old-path' })) + '\n',
    'utf8',
  );
  const newer = path.join(projDir, 'new.jsonl');
  fs.writeFileSync(newer, JSON.stringify(envelope({ cwd: 'C:\\Users\\u\\Documents\\my-tool' })) + '\n', 'utf8');
  fs.utimesSync(newer, new Date(), new Date(Date.now() + 5000));

  const bare = path.join(tmpDir, 'C--no-cwd-project');
  fs.mkdirSync(bare);
  fs.writeFileSync(path.join(bare, 's.jsonl'), '{"type":"assistant"}\n', 'utf8');

  const bySlug = Object.fromEntries(scanProjects(tmpDir).map((p) => [p.projectSlug, p]));
  expect(bySlug['C--Users-u-Documents-my-tool'].displayName).toBe('C:\\Users\\u\\Documents\\my-tool');
  expect(bySlug['C--no-cwd-project'].displayName).toBeNull();
});
