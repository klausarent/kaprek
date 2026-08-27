import { test, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openMissions } from '../missions/store.mjs';
import { openChats } from '../chats/store.mjs';
import { openMemory } from '../memory/store.mjs';
import { openPolicy } from '../memory/policy.mjs';
import { buildSessionStartContext, missionForCwd, openQuestionsForMission, memoryLinesForCwd, MAX_CONTEXT_CHARS } from './session-start.mjs';

let dataDir;
let cwd;

beforeEach(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kaprek-sessionstart-'));
  cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'kaprek-project-'));
});

afterEach(() => {
  fs.rmSync(dataDir, { recursive: true, force: true });
  fs.rmSync(cwd, { recursive: true, force: true });
});

function snapshot(dir) {
  const files = [];
  const walk = (d) => {
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, entry.name);
      if (entry.isDirectory()) walk(p);
      else files.push(`${path.relative(dir, p)}:${fs.statSync(p).size}`);
    }
  };
  walk(dir);
  return files.sort();
}

test('a directory kaprek knows nothing about gets nothing — and nothing is written to find that out', () => {
  expect(buildSessionStartContext({ dataDir, cwd })).toBe('');
  expect(fs.readdirSync(dataDir)).toEqual([]);
});

test('a mission directory gets the mission, its goal, and an active one wins over a done one', () => {
  const missions = openMissions(dataDir);
  missions.create({ title: 'Old errand', goal: 'was done', cwd });
  const old = missions.list()[0];
  missions.setStatus(old.id, 'done');
  missions.create({ title: 'Ship the newsletter', goal: 'Send issue 12 by Friday', cwd: `${cwd}${path.sep}` });
  const picked = missionForCwd({ dataDir, cwd: process.platform === 'win32' ? cwd.toUpperCase() : cwd });
  expect(picked.title).toBe('Ship the newsletter');
  const text = buildSessionStartContext({ dataDir, cwd });
  expect(text).toContain('mission "Ship the newsletter" (active)');
  expect(text).toContain('Goal: Send issue 12 by Friday');
  expect(text).not.toContain('inbox');
});

test('open deferred questions of the mission are counted, with the address when kaprek is running', () => {
  const missions = openMissions(dataDir);
  missions.create({ title: 'M', cwd });
  const mission = missions.list()[0];
  const other = missions.create({ title: 'Other', cwd: path.join(cwd, 'elsewhere') });
  const chats = openChats(dataDir);
  const mine = chats.createChat({ title: 'mine', missionId: mission.id });
  const theirs = chats.createChat({ title: 'theirs', missionId: other.id });
  fs.writeFileSync(
    path.join(dataDir, 'approvals.json'),
    JSON.stringify({
      version: 1,
      approvals: [
        { id: 'a', chatId: mine.id, status: 'pending', mode: 'deferred' },
        { id: 'b', chatId: mine.id, status: 'pending', mode: 'interactive' },
        { id: 'c', chatId: mine.id, status: 'approved', mode: 'deferred' },
        { id: 'd', chatId: theirs.id, status: 'pending', mode: 'deferred' },
        { id: 'e', chatId: 'gone-chat', status: 'pending', mode: 'deferred' },
      ],
    }),
  );
  expect(openQuestionsForMission({ dataDir, missionId: mission.id })).toBe(1);
  fs.writeFileSync(path.join(dataDir, 'instance.lock'), JSON.stringify({ kaprek: 1, pid: 1, url: 'http://127.0.0.1:7788' }));
  const text = buildSessionStartContext({ dataDir, cwd });
  expect(text).toContain('1 question from earlier turns of this mission is waiting in the kaprek inbox — http://127.0.0.1:7788/#/approvals');
});

test('accepted rules reach every directory; proposals nobody answered do not', () => {
  const policy = openPolicy(dataDir);
  // A rule is proposed after the same failure was seen PROPOSE_AFTER times, and active only once a person accepts it.
  let accepted = null;
  for (let i = 0; i < 3; i += 1) accepted = policy.sawFailure({ pattern: 'tests-skipped', where: `chat:${i}`, rule: 'Run the tests before saying done' }).proposal ?? accepted;
  policy.decide(accepted.id, 'accepted');
  for (let i = 0; i < 3; i += 1) policy.sawFailure({ pattern: 'other', where: `chat:${i}`, rule: 'Never mind this one' });
  const text = buildSessionStartContext({ dataDir, cwd });
  expect(text).toContain('## Rules for this machine');
  expect(text).toContain('- Run the tests before saying done');
  expect(text).not.toContain('Never mind this one');
});

test('memory shows only for a project scope that already exists, profile first, without inventing one', () => {
  expect(memoryLinesForCwd({ dataDir, cwd })).toEqual([]);
  const memory = openMemory(dataDir);
  memory.addScope({ id: 'person:local' });
  const scopeId = `project:${path.basename(cwd)}`;
  memory.addScope({ id: scopeId, parent: 'person:local' });
  memory.remember({ scopeId, text: 'Deploys go through wrangler, never the dashboard', kind: 'fact', confidence: 0.9, origin: 'chat:x' });
  memory.remember({ scopeId, text: 'An Astro site on Cloudflare Pages', kind: 'profile', confidence: 0.9, origin: 'chat:x' });
  const before = snapshot(dataDir);
  const text = buildSessionStartContext({ dataDir, cwd });
  expect(text).toContain('## What kaprek remembers about this project');
  expect(text.indexOf('An Astro site')).toBeLessThan(text.indexOf('Deploys go through wrangler'));
  expect(text).toContain('Only turns run through kaprek can add to this');
  expect(snapshot(dataDir)).toEqual(before);
});

test('the block is capped and says so', () => {
  const missions = openMissions(dataDir);
  missions.create({ title: 'Long', goal: 'x'.repeat(5000), cwd });
  const text = buildSessionStartContext({ dataDir, cwd });
  expect(text.length).toBeLessThanOrEqual(MAX_CONTEXT_CHARS);
  expect(text.endsWith('[kaprek] (cut here — the full picture is in the kaprek UI)')).toBe(true);
});

test('a corrupt store costs its section, not the block', () => {
  const missions = openMissions(dataDir);
  missions.create({ title: 'Still here', cwd });
  fs.writeFileSync(path.join(dataDir, 'approvals.json'), '{not json');
  fs.mkdirSync(path.join(dataDir, 'memory'), { recursive: true });
  fs.writeFileSync(path.join(dataDir, 'memory', 'events.jsonl'), '{"broken":\n');
  const text = buildSessionStartContext({ dataDir, cwd });
  expect(text).toContain('Still here');
});
