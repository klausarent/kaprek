// P8: the digest routes — GET /api/missions/<id>/digest (build + store +
// serve as text/markdown) and GET /api/missions/<id>/digests (the files on
// disk). Same shape as mission-memory.test.mjs: a real server on an
// ephemeral port, the token header shadowed onto fetch, per-test temp dirs.
import { test, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startServer } from './server.mjs';
import { TOKEN_HEADER } from './token.mjs';
import { appendRun } from '../orchestrator/runs.mjs';
import { openChats } from '../chats/store.mjs';

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
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mission-digest-test-'));
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mission-digest-data-'));
  tmpRootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mission-digest-tmproot-'));
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

async function createMission(url) {
  const cwd = fs.mkdtempSync(path.join(tmpRootDir, 'cwd-'));
  const res = await fetch(`${url}/api/missions`, { method: 'POST', headers: APP_JSON_HEADERS, body: JSON.stringify({ title: 'Zaehler-Service', cwd }) });
  const { mission } = await res.json();
  // The mission's chat, written through the same store the server uses (the
  // HTTP API only creates chats together with a turn).
  const chats = openChats(dataDir);
  const chat = chats.createChat({ title: 'night shift', missionId: mission.id });
  return { mission, chat };
}

/** A two-hour explicit window around `now` and its expected <datum> file name. */
function windowAroundNow() {
  const now = Date.now();
  const since = now - 60 * 60_000;
  const until = now + 60 * 60_000;
  const end = new Date(until);
  const name = `${String(end.getDate()).padStart(2, '0')}.${String(end.getMonth() + 1).padStart(2, '0')}.${end.getFullYear()}`;
  return { since: String(since), until: String(until), name };
}

test('digest route: builds, stores, and serves the markdown; a second build overwrites byte-identically', async () => {
  const { url } = await boot();
  const { mission, chat } = await createMission(url);
  const { since, until, name } = windowAroundNow();
  appendRun(dataDir, {
    ts: new Date().toISOString(),
    chatId: chat.id,
    origin: 'trigger',
    triggerId: 't-nightly',
    costUsd: 0.02,
    tokens: 1500,
    durationMs: 61_000,
    stopReason: 'end_turn',
  });
  appendRun(dataDir, { ts: new Date().toISOString(), chatId: chat.id, origin: 'trigger', triggerId: 't-nightly', skipped: 'condition', conditionKind: 'file-exists' });

  const res = await fetch(`${url}/api/missions/${mission.id}/digest?since=${since}&until=${until}`);
  expect(res.status).toBe(200);
  expect(res.headers.get('content-type')).toContain('text/markdown');
  const markdown = await res.text();
  expect(markdown).toContain('# Morning digest — Zaehler-Service');
  expect(markdown).toContain('### t-nightly');
  expect(markdown).toContain('übersprungen (condition false)');
  expect(markdown).toContain('Kosten bekannt für 1 von 2 Läufen.');

  const filePath = path.join(dataDir, 'missions', mission.id, 'digests', `${name}.md`);
  expect(fs.readFileSync(filePath, 'utf8')).toBe(markdown);

  // Second build: same file, byte-equal — a report, not a store.
  const second = await fetch(`${url}/api/missions/${mission.id}/digest?since=${since}&until=${until}`);
  expect(await second.text()).toBe(markdown);

  const list = await (await fetch(`${url}/api/missions/${mission.id}/digests`)).json();
  expect(list.digests).toHaveLength(1);
  expect(list.digests[0].name).toBe(`${name}.md`);
});

test('digest route: an empty mission still yields a digest with its 0-line, and it is stored', async () => {
  const { url } = await boot();
  const { mission } = await createMission(url);
  const { since, until, name } = windowAroundNow();

  const res = await fetch(`${url}/api/missions/${mission.id}/digest?since=${since}&until=${until}`);
  expect(res.status).toBe(200);
  const markdown = await res.text();
  expect(markdown).toContain('0 Läufe im Fenster');
  expect(markdown).toContain('0 offene Fragen.');
  expect(fs.existsSync(path.join(dataDir, 'missions', mission.id, 'digests', `${name}.md`))).toBe(true);
});

test('digest route: an unreadable window is a 400, an unknown mission a 404', async () => {
  const { url } = await boot();
  const { mission } = await createMission(url);

  const bad = await fetch(`${url}/api/missions/${mission.id}/digest?since=x&until=1`);
  expect(bad.status).toBe(400);
  const inverted = await fetch(`${url}/api/missions/${mission.id}/digest?since=200&until=100`);
  expect(inverted.status).toBe(400);

  const missing = await fetch(`${url}/api/missions/no-such-mission/digest`);
  expect(missing.status).toBe(404);
  const missingList = await fetch(`${url}/api/missions/no-such-mission/digests`);
  expect(missingList.status).toBe(404);
});

test('digest route: only POST-less methods are refused, the list route speaks JSON', async () => {
  const { url } = await boot();
  const { mission } = await createMission(url);
  const post = await fetch(`${url}/api/missions/${mission.id}/digest`, { method: 'POST', headers: APP_JSON_HEADERS, body: '{}' });
  expect(post.status).toBe(405);
  const list = await fetch(`${url}/api/missions/${mission.id}/digests`);
  expect(list.status).toBe(200);
  expect((await list.json()).digests).toEqual([]);
});
