import { test, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openMemory } from './store.mjs';
import { syncMemoryDir, defaultMemoryDir, parseFrontmatter, resolveScopeId, MAX_TEXT_CHARS } from './sync.mjs';

let dataDir;
let memoryDir;

beforeEach(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kaprek-syncdata-'));
  memoryDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kaprek-syncmem-'));
});

afterEach(() => {
  fs.rmSync(dataDir, { recursive: true, force: true });
  fs.rmSync(memoryDir, { recursive: true, force: true });
});

function writeMemoryFile(name, { name: frontmatterName = name.replace(/\.md$/, ''), description, type = 'project', body = 'body text' } = {}) {
  const descLine = description === undefined ? '' : `description: ${description}\n`;
  const content = `---\nname: ${frontmatterName}\n${descLine}metadata: \n  node_type: memory\n  type: ${type}\n  modified: 2026-08-29T00:00:00.000Z\n---\n\n${body}\n`;
  fs.writeFileSync(path.join(memoryDir, name), content, 'utf8');
}

function stateFile() {
  return path.join(dataDir, 'memory', 'sync-state.json');
}

function readStateFiles() {
  return JSON.parse(fs.readFileSync(stateFile(), 'utf8')).files;
}

test('no memory directory at all: scanned 0, nothing written', () => {
  fs.rmSync(memoryDir, { recursive: true, force: true });
  expect(syncMemoryDir({ dataDir, memoryDir })).toEqual({ scanned: 0 });
  expect(fs.existsSync(path.join(dataDir, 'memory'))).toBe(false);
});

test('defaultMemoryDir: homedir turned into the same slug the real memory folder uses, KAPREK_MEMORY_DIR overrides it', () => {
  const homedir = 'C:\\Users\\karent';
  expect(defaultMemoryDir({ homedir, env: {} })).toBe(path.join(homedir, '.claude', 'projects', 'C--Users-karent', 'memory'));
  expect(defaultMemoryDir({ homedir, env: { KAPREK_MEMORY_DIR: 'D:\\elsewhere' } })).toBe('D:\\elsewhere');
});

test('parseFrontmatter: description survives its own colons and quotes, metadata.type comes from the indented block', () => {
  const text = [
    '---',
    'name: project-example',
    'description: "kaprek: a tool, with a comma"',
    'metadata: ',
    '  node_type: memory',
    '  type: project',
    '  modified: 2026-08-29T00:00:00.000Z',
    '---',
    '',
    'body',
    '',
  ].join('\n');
  expect(parseFrontmatter(text)).toEqual({ name: 'project-example', description: 'kaprek: a tool, with a comma', type: 'project' });
});

test('parseFrontmatter: no frontmatter block at all returns null', () => {
  expect(parseFrontmatter('just some text\nwith no dashes')).toBeNull();
});

test('a new file becomes a fact in person:local by default', () => {
  openMemory(dataDir).addScope({ id: 'person:local' });
  writeMemoryFile('feedback_something.md', { description: 'Always run the tests before saying done' });

  const result = syncMemoryDir({ dataDir, memoryDir });
  expect(result).toEqual({ scanned: 1, written: 1, confirmed: 0, skipped: 0, deferred: false });

  const memory = openMemory(dataDir);
  const facts = memory.list({ scopeId: 'person:local' });
  expect(facts).toHaveLength(1);
  expect(facts[0].text).toBe('Always run the tests before saying done');
  expect(facts[0].kind).toBe('fact');
  expect(facts[0].origin).toBe('memory-sync:feedback_something.md');
});

test('metadata.type: user becomes a profile line, anything else a fact', () => {
  const memory = openMemory(dataDir);
  memory.addScope({ id: 'person:local' });
  writeMemoryFile('user_klaus.md', { description: 'Klaus, hands-on, no bullshit', type: 'user' });

  syncMemoryDir({ dataDir, memoryDir });

  const facts = openMemory(dataDir).list({ scopeId: 'person:local' });
  expect(facts[0].kind).toBe('profile');
});

test('a changed file is remembered again — same text confirms rather than duplicates', () => {
  const memory = openMemory(dataDir);
  memory.addScope({ id: 'person:local' });
  writeMemoryFile('feedback_x.md', { description: 'Same fact both times' });
  syncMemoryDir({ dataDir, memoryDir });

  // Rewrite with the same text, then force the mtime strictly forward —
  // writeFileSync alone may or may not land on a different mtime at this
  // resolution, and the point of this test is "changed timestamp, same
  // content", not a race against filesystem clock granularity.
  const filePath = path.join(memoryDir, 'feedback_x.md');
  writeMemoryFile('feedback_x.md', { description: 'Same fact both times' });
  const future = new Date(fs.statSync(filePath).mtime.getTime() + 60_000);
  fs.utimesSync(filePath, future, future);

  const result = syncMemoryDir({ dataDir, memoryDir });
  expect(result.written).toBe(0);
  expect(result.confirmed).toBe(1);

  const facts = openMemory(dataDir).list({ scopeId: 'person:local' });
  expect(facts).toHaveLength(1);
  expect(facts[0].confirmations).toBe(2);
});

test('unverändert: a file untouched since the last run is not reopened, and produces neither a write nor a confirmation', () => {
  const memory = openMemory(dataDir);
  memory.addScope({ id: 'person:local' });
  writeMemoryFile('feedback_stable.md', { description: 'This never changes' });

  const first = syncMemoryDir({ dataDir, memoryDir });
  expect(first).toEqual({ scanned: 1, written: 1, confirmed: 0, skipped: 0, deferred: false });

  const stateBefore = readStateFiles();
  const second = syncMemoryDir({ dataDir, memoryDir });
  expect(second).toEqual({ scanned: 1, written: 0, confirmed: 0, skipped: 0, deferred: false });
  expect(readStateFiles()).toEqual(stateBefore);

  const facts = openMemory(dataDir).list({ scopeId: 'person:local' });
  expect(facts).toHaveLength(1);
  expect(facts[0].confirmations).toBe(1);
});

test('gelöscht: a file removed from disk is dropped from the state, not un-remembered', () => {
  const memory = openMemory(dataDir);
  memory.addScope({ id: 'person:local' });
  writeMemoryFile('feedback_gone.md', { description: 'Will be deleted' });
  syncMemoryDir({ dataDir, memoryDir });
  expect(Object.keys(readStateFiles())).toContain('feedback_gone.md');

  fs.rmSync(path.join(memoryDir, 'feedback_gone.md'));
  const result = syncMemoryDir({ dataDir, memoryDir });
  expect(result.scanned).toBe(0);
  expect(Object.keys(readStateFiles())).not.toContain('feedback_gone.md');

  const facts = openMemory(dataDir).list({ scopeId: 'person:local' });
  expect(facts).toHaveLength(1);
  expect(facts[0].forgotten).toBe(false);
});

test('a file with no description is skipped, not remembered as an empty fact', () => {
  const memory = openMemory(dataDir);
  memory.addScope({ id: 'person:local' });
  writeMemoryFile('feedback_empty.md', { description: undefined });

  const result = syncMemoryDir({ dataDir, memoryDir });
  expect(result).toEqual({ scanned: 1, written: 0, confirmed: 0, skipped: 1, deferred: false });
  expect(openMemory(dataDir).list({ scopeId: 'person:local' })).toEqual([]);
});

test('a description that looks like a bare secret is skipped', () => {
  const memory = openMemory(dataDir);
  memory.addScope({ id: 'person:local' });
  writeMemoryFile('feedback_secret.md', { description: 'token: sk-abcdefghijklmnopqrstuvwx' });

  const result = syncMemoryDir({ dataDir, memoryDir });
  expect(result.skipped).toBe(1);
  expect(result.written).toBe(0);
  expect(openMemory(dataDir).list({ scopeId: 'person:local' })).toEqual([]);
});

test('MEMORY.md itself is never read, subdirectories are never recursed into', () => {
  const memory = openMemory(dataDir);
  memory.addScope({ id: 'person:local' });
  writeMemoryFile('MEMORY.md', { description: 'the router file itself' });
  fs.mkdirSync(path.join(memoryDir, 'nested'));
  writeMemoryFile(path.join('nested', 'inner.md'), { description: 'nested, must not be seen' });

  const result = syncMemoryDir({ dataDir, memoryDir });
  expect(result.scanned).toBe(0);
  expect(openMemory(dataDir).list({ scopeId: 'person:local' })).toEqual([]);
});

test('a description longer than 400 characters is truncated with an ellipsis', () => {
  const memory = openMemory(dataDir);
  memory.addScope({ id: 'person:local' });
  writeMemoryFile('feedback_long.md', { description: 'x'.repeat(500) });

  syncMemoryDir({ dataDir, memoryDir });
  const facts = openMemory(dataDir).list({ scopeId: 'person:local' });
  expect(facts[0].text.length).toBe(MAX_TEXT_CHARS);
  expect(facts[0].text.endsWith('…')).toBe(true);
});

test('scope-map hit: a slug the map names goes to that scope even when it does not match the project_<x> heuristic', () => {
  const memory = openMemory(dataDir);
  memory.addScope({ id: 'person:local' });
  memory.addScope({ id: 'project:ccview', parent: 'person:local' });
  fs.mkdirSync(path.join(dataDir, 'memory'), { recursive: true });
  fs.writeFileSync(path.join(dataDir, 'memory', 'scope-map.json'), JSON.stringify({ memory_slug_to_scope: { kaprek: 'project:ccview' } }));
  writeMemoryFile('project_kaprek.md', { description: 'kaprek lives here' });

  syncMemoryDir({ dataDir, memoryDir });
  const facts = openMemory(dataDir).list({ scopeId: 'project:ccview' });
  expect(facts).toHaveLength(1);
  expect(facts[0].text).toBe('kaprek lives here');
  expect(openMemory(dataDir).list({ scopeId: 'person:local' })).toEqual([]);
});

test('heuristic: project_<x> maps to project:<x> (underscores to hyphens) when that scope already exists and there is no map hit', () => {
  const memory = openMemory(dataDir);
  memory.addScope({ id: 'person:local' });
  memory.addScope({ id: 'project:my-thing', parent: 'person:local' });
  writeMemoryFile('project_my_thing.md', { description: 'about my thing' });

  syncMemoryDir({ dataDir, memoryDir });
  const facts = openMemory(dataDir).list({ scopeId: 'project:my-thing' });
  expect(facts).toHaveLength(1);
});

test('heuristic misses (scope does not exist) falls back to person:local', () => {
  const memory = openMemory(dataDir);
  memory.addScope({ id: 'person:local' });
  writeMemoryFile('project_nonexistent.md', { description: 'no such scope' });

  syncMemoryDir({ dataDir, memoryDir });
  const facts = openMemory(dataDir).list({ scopeId: 'person:local' });
  expect(facts).toHaveLength(1);
});

test('resolveScopeId: never invents a scope — person:local missing entirely means no scope to fall back on', () => {
  expect(resolveScopeId({ stem: 'feedback_x', scopeMap: {}, existingScopeIds: new Set() })).toBeNull();
});

test('person:local missing entirely: the file is skipped rather than filed under an invented scope', () => {
  // No addScope call at all — an empty, freshly created memory store.
  writeMemoryFile('feedback_orphan.md', { description: 'nobody to own this yet' });
  const result = syncMemoryDir({ dataDir, memoryDir });
  expect(result.skipped).toBe(1);
  expect(result.written).toBe(0);
});

test('a scope-less skip is not recorded in the state: once the scope exists, the very same run of the file is written, not skipped again', () => {
  // No scope at all yet — the file has nowhere to go.
  writeMemoryFile('project_late_scope.md', { description: 'waiting for its scope to exist' });
  const first = syncMemoryDir({ dataDir, memoryDir });
  expect(first).toEqual({ scanned: 1, written: 0, confirmed: 0, skipped: 1, deferred: false });
  expect(readStateFiles()).toEqual({}); // nothing recorded — the file itself never changed

  // The scope now exists, the file on disk is untouched (same mtime/size).
  const memory = openMemory(dataDir);
  memory.addScope({ id: 'person:local' });
  memory.addScope({ id: 'project:late-scope', parent: 'person:local' });

  const second = syncMemoryDir({ dataDir, memoryDir });
  expect(second).toEqual({ scanned: 1, written: 1, confirmed: 0, skipped: 0, deferred: false });
  const facts = openMemory(dataDir).list({ scopeId: 'project:late-scope' });
  expect(facts).toHaveLength(1);
  expect(facts[0].text).toBe('waiting for its scope to exist');
});

test('a content skip (no description) IS recorded: the fast unchanged path takes over on the next run, still skipped', () => {
  const memory = openMemory(dataDir);
  memory.addScope({ id: 'person:local' });
  writeMemoryFile('feedback_no_desc.md', { description: undefined });

  const first = syncMemoryDir({ dataDir, memoryDir });
  expect(first).toEqual({ scanned: 1, written: 0, confirmed: 0, skipped: 1, deferred: false });
  const stateAfterFirst = readStateFiles();
  expect(Object.keys(stateAfterFirst)).toContain('feedback_no_desc.md');

  const second = syncMemoryDir({ dataDir, memoryDir });
  expect(second).toEqual({ scanned: 1, written: 0, confirmed: 0, skipped: 0, deferred: false }); // unchanged path: not even reopened, so not counted as skipped again
  expect(readStateFiles()).toEqual(stateAfterFirst);
  expect(openMemory(dataDir).list({ scopeId: 'person:local' })).toEqual([]);
});

test('deadline: processes what it can before the budget runs out and reports deferred, without losing progress on files already done', () => {
  const memory = openMemory(dataDir);
  memory.addScope({ id: 'person:local' });
  writeMemoryFile('feedback_a.md', { description: 'first fact' });
  writeMemoryFile('feedback_b.md', { description: 'second fact' });
  writeMemoryFile('feedback_c.md', { description: 'third fact' });

  let call = 0;
  // First call seeds `started`; the deadline check after the first file
  // already reports overdue, so exactly one file is processed this run.
  const now = () => (call++ === 0 ? 0 : 10_000);

  const result = syncMemoryDir({ dataDir, memoryDir, deadlineMs: 100, now });
  expect(result.scanned).toBe(1);
  expect(result.written).toBe(1);
  expect(result.deferred).toBe(true);

  // The next run (real clock) visits all three again — the first is still
  // in the state and costs only a stat comparison, the other two are new.
  const second = syncMemoryDir({ dataDir, memoryDir });
  expect(second.scanned).toBe(3);
  expect(second.written).toBe(2);
  expect(second.deferred).toBe(false);

  const facts = openMemory(dataDir).list({ scopeId: 'person:local' });
  expect(facts).toHaveLength(3);
});
