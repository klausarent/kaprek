// P4a: GET /api/missions/<id>/memory — the bundled view over the scope chain
// mission:<id> → project:<label> → person:<label>.
//
// Same shape as server.test.mjs: a real server on an ephemeral port, the
// token header shadowed onto fetch, per-test temp dirs.
import { test, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startServer } from './server.mjs';
import { TOKEN_HEADER } from './token.mjs';

const APP_JSON_HEADERS = { 'x-app-request': '1', 'Content-Type': 'application/json' };

let tmpDir;
let dataDir;
let tmpRootDir;
let servers = [];
let currentToken = null;

const rawFetch = (...args) => globalThis.fetch(...args);
function fetch(input, init = {}) {
  return rawFetch(input, { ...init, headers: { ...(init.headers ?? {}), [TOKEN_HEADER]: currentToken ?? '' } });
}

beforeEach(() => {
  currentToken = null;
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mission-memory-test-'));
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mission-memory-data-'));
  tmpRootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mission-memory-tmproot-'));
  servers = [];
});

afterEach(async () => {
  for (const { server } of servers) {
    await new Promise((resolve) => server.close(resolve));
  }
  fs.rmSync(tmpDir, { recursive: true, force: true });
  fs.rmSync(dataDir, { recursive: true, force: true });
  fs.rmSync(tmpRootDir, { recursive: true, force: true });
});

async function boot() {
  const started = await startServer({ port: 0, rootDir: tmpDir, dataDir, tmpRoot: tmpRootDir });
  servers.push(started);
  currentToken = started.token;
  return started;
}

/** A mission with its full scope tree and one entry per layer of the chain. */
async function missionWithChain(url, { projectLabel }) {
  const cwd = fs.mkdtempSync(path.join(tmpRootDir, 'cwd-'));
  const { mission } = await (await fetch(`${url}/api/missions`, { method: 'POST', headers: APP_JSON_HEADERS, body: JSON.stringify({ title: 'the mission', goal: 'find out', cwd }) })).json();
  await fetch(`${url}/api/memory/scopes`, { method: 'POST', headers: APP_JSON_HEADERS, body: JSON.stringify({ id: 'person:local' }) });
  await fetch(`${url}/api/memory/scopes`, { method: 'POST', headers: APP_JSON_HEADERS, body: JSON.stringify({ id: `project:${projectLabel}`, parent: 'person:local' }) });
  await fetch(`${url}/api/memory/scopes`, { method: 'POST', headers: APP_JSON_HEADERS, body: JSON.stringify({ id: `mission:${mission.id}`, parent: `project:${projectLabel}` }) });
  const write = (scopeId, text) => fetch(`${url}/api/memory`, { method: 'POST', headers: APP_JSON_HEADERS, body: JSON.stringify({ scopeId, text, origin: 'test' }) });
  await write(`mission:${mission.id}`, 'a mission-level note');
  await write(`project:${projectLabel}`, 'a project-level note');
  await write('person:local', 'a person-level note');
  return mission;
}

test('mission memory: the whole scope chain mission → project → person is readable', async () => {
  const { url } = await boot();
  const mission = await missionWithChain(url, { projectLabel: 'kaprek' });

  const res = await fetch(`${url}/api/missions/${mission.id}/memory`);
  expect(res.status).toBe(200);
  const view = await res.json();

  expect(view.missionId).toBe(mission.id);
  expect(view.scopeId).toBe(`mission:${mission.id}`);
  // Upwards only: itself, its project, its person — nearest first.
  expect(view.visibleScopes).toEqual([`mission:${mission.id}`, 'project:kaprek', 'person:local']);
  expect(view.entries.map((entry) => entry.text).sort()).toEqual(['a mission-level note', 'a person-level note', 'a project-level note']);
  expect(view.entries.every((entry) => entry.scope && entry.firstSeenAt && entry.lastVerifiedAt && typeof entry.stale === 'boolean')).toBe(true);
  // One entry per layer of the chain.
  expect(view.counts).toEqual({ mission: 1, project: 1, person: 1 });
  // The card's five-last-written slice, newest first.
  expect(view.recent).toHaveLength(3);
});

test('mission memory: another person’s tree stays invisible', async () => {
  const { url } = await boot();
  const mission = await missionWithChain(url, { projectLabel: 'kaprek' });

  // A second root, nobody's parent — the fail-closed direction of the scope
  // rule says a mission under person:local must not see it.
  await fetch(`${url}/api/memory/scopes`, { method: 'POST', headers: APP_JSON_HEADERS, body: JSON.stringify({ id: 'person:other' }) });
  await fetch(`${url}/api/memory`, { method: 'POST', headers: APP_JSON_HEADERS, body: JSON.stringify({ scopeId: 'person:other', text: 'someone else’s private note', origin: 'test' }) });

  const view = await (await fetch(`${url}/api/missions/${mission.id}/memory`)).json();
  expect(view.entries.map((entry) => entry.text)).not.toContain('someone else’s private note');
});

test('mission memory: stale entries come first, oldest-verified ordering', async () => {
  const { url } = await boot();
  const mission = await missionWithChain(url, { projectLabel: 'kaprek' });

  // Age every written fact past the 90-day gate by shifting the logged
  // timestamps — the route re-opens the store per request, so the rewrite
  // is what it reads.
  const eventsFile = path.join(dataDir, 'memory', 'events.jsonl');
  const longAgo = new Date(Date.parse('2026-01-01T00:00:00.000Z')).toISOString();
  const aged = fs
    .readFileSync(eventsFile, 'utf8')
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => {
      const event = JSON.parse(line);
      if (event.type === 'memory.remembered') return JSON.stringify({ ...event, ts: longAgo, data: { ...event.data, createdAt: longAgo, lastVerifiedAt: longAgo } });
      return line;
    })
    .join('\n');
  fs.writeFileSync(eventsFile, `${aged}\n`, 'utf8');

  // A fresh, young fact written after the ageing: it must sort BELOW the
  // stale ones.
  await fetch(`${url}/api/memory`, { method: 'POST', headers: APP_JSON_HEADERS, body: JSON.stringify({ scopeId: `mission:${mission.id}`, text: 'written just now', origin: 'test' }) });

  const view = await (await fetch(`${url}/api/missions/${mission.id}/memory`)).json();
  const staleFlags = view.entries.map((entry) => entry.stale);
  expect(staleFlags).toContain(true);
  expect(staleFlags).toContain(false);
  expect(staleFlags.indexOf(false)).toBeGreaterThan(staleFlags.lastIndexOf(true));
  // Within the stale group, oldest verification first.
  const staleAges = view.entries.filter((entry) => entry.stale).map((entry) => entry.lastVerifiedAt);
  expect([...staleAges].sort()).toEqual(staleAges);
});

test('mission memory: an unknown mission is a 404, not an empty view', async () => {
  const { url } = await boot();
  const res = await fetch(`${url}/api/missions/no-such-mission/memory`);
  expect(res.status).toBe(404);
});

test('mission memory: read-only store (P0.5) still serves the view', async () => {
  const { url } = await boot();
  const mission = await missionWithChain(url, { projectLabel: 'kaprek' });

  // A newer kaprek's line in the log flips the store read-only.
  const eventsFile = path.join(dataDir, 'memory', 'events.jsonl');
  fs.appendFileSync(eventsFile, `${JSON.stringify({ schemaVersion: 2, id: 'x', ts: new Date().toISOString(), type: 'memory.verified', memoryId: 'none', data: {} })}\n`, 'utf8');

  const view = await (await fetch(`${url}/api/missions/${mission.id}/memory`)).json();
  expect(view.readOnly).toBe(true);
  // The entries themselves still come back — read-only means read.
  expect(view.entries.length).toBeGreaterThan(0);
});

test('mission memory: a store without entries is not read-only and crashes nobody', async () => {
  const { url } = await boot();
  const cwd = fs.mkdtempSync(path.join(tmpRootDir, 'cwd-'));
  const { mission } = await (await fetch(`${url}/api/missions`, { method: 'POST', headers: APP_JSON_HEADERS, body: JSON.stringify({ title: 'empty', cwd }) })).json();
  const view = await (await fetch(`${url}/api/missions/${mission.id}/memory`)).json();
  // No scope tree built yet — fail-closed means an empty answer, not an error.
  expect(view.entries).toEqual([]);
  expect(view.readOnly).toBe(false);
});
