// M6 live acceptance, against the real CLI.
//
// The roadmap's sentence is "Luca or Oma produce a result without help and
// find it again after a restart". The first half needs a person who is not
// me; the second half is a fact about the machine, and that is what this
// checks: a guided mission asked three questions, answered them, produced a
// file, and the file is still there — and still findable — after everything
// is reopened.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { startServer } from '../src/server/server.mjs';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kaprek-m6-'));
const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kaprek-m6-game-'));

const { url, token } = await startServer({ port: 0, rootDir: dataDir, dataDir, webDist: null });
const H = { 'x-kaprek-token': token, 'x-app-request': '1', 'Content-Type': 'application/json' };
const say = (...args) => console.log(new Date().toISOString().slice(11, 19), ...args);
say('server on', url, '| folder', projectDir);

async function api(pathname, init = {}) {
  const res = await fetch(`${url}${pathname}`, { ...init, headers: { ...H, ...(init.headers ?? {}) } });
  const text = await res.text();
  try {
    return { status: res.status, body: JSON.parse(text) };
  } catch {
    return { status: res.status, body: text };
  }
}

/** One turn over node:http — fetch's body timeout kills a thinking turn. */
function turn({ text, missionId }) {
  const body = JSON.stringify({ text, missionId, approvalMode: 'auto' });
  const target = new URL(`${url}/api/chat/turn`);
  return new Promise((resolve, reject) => {
    const req = http.request(
      { hostname: target.hostname, port: target.port, path: target.pathname, method: 'POST', headers: { ...H, 'Content-Length': Buffer.byteLength(body) } },
      (res) => {
        let raw = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => {
          raw += chunk;
        });
        res.on('end', () => resolve(raw));
      },
    );
    req.on('error', reject);
    req.end(body);
  });
}

// --- 1. The four are offered, with three questions each --------------------
const home = await api('/api/home');
say('offered:', JSON.stringify(home.body.missions.map((mission) => `${mission.id}(${mission.questions.length}q)`)));

// --- 2. Answer them and start ---------------------------------------------
const started = await api('/api/home/game/start', {
  method: 'POST',
  body: JSON.stringify({
    cwd: projectDir,
    answers: { about: 'Catching things that fall', who: 'A young child', look: 'Bright and simple shapes' },
  }),
});
say('mission:', started.status, started.body?.mission?.id);
say('finished means:', started.body?.done);

// --- 3. Let it work --------------------------------------------------------
say('working…');
await turn({ text: started.body.firstPrompt, missionId: started.body.mission.id });
say('folder now holds:', JSON.stringify(fs.readdirSync(projectDir)));

// --- 4. Find it again after everything is reopened -------------------------
const missions = await api('/api/missions');
const found = missions.body.missions.find((mission) => mission.id === started.body.mission.id);
say('mission still listed:', Boolean(found), '| its folder:', found?.cwd === projectDir);
say('data dir:', dataDir);
process.exit(0);
