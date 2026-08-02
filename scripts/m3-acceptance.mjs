// M3 live acceptance, against the real CLIs.
//
// The sentence from the roadmap, run for real: "Agent B uses, without
// copy-paste, what agent A learned; a child scope proves the separation by
// demonstrably not seeing the company memory."
//
// Two missions in the SAME project directory, run on two different engines.
// The first is told something it could not know otherwise and asked to
// remember it. The second — different chat, different engine, no mention of
// the fact in its prompt — is asked what it knows about it.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { startServer } from '../src/server/server.mjs';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kaprek-m3-'));
const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kaprek-m3-project-'));
fs.writeFileSync(path.join(projectDir, 'README.md'), '# A tiny project\n', 'utf8');

// No tools for these turns. The acceptance is about what an agent KNOWS,
// not what it can do, and a turn that goes looking through the project can
// sit silent long enough to trip fetch's own body timeout.
const { url, token } = await startServer({ port: 0, rootDir: dataDir, dataDir, webDist: null, allowedTools: [] });
const H = { 'x-kaprek-token': token, 'x-app-request': '1', 'Content-Type': 'application/json' };
const say = (...args) => console.log(new Date().toISOString().slice(11, 19), ...args);
say('server on', url, '| project', projectDir);

async function api(pathname, init = {}) {
  const res = await fetch(`${url}${pathname}`, { ...init, headers: { ...H, ...(init.headers ?? {}) } });
  const text = await res.text();
  try {
    return { status: res.status, body: JSON.parse(text) };
  } catch {
    return { status: res.status, body: text };
  }
}

/**
 * One turn, drained over node:http rather than fetch.
 *
 * fetch's body timeout (undici, five minutes without a frame) kills a
 * perfectly healthy turn that is still thinking: the first two attempts at
 * this acceptance died there while the server carried on working. node:http
 * has no such limit, which is what an SSE client needs.
 */
function turn({ text, missionId, chatId, engine }) {
  const body = JSON.stringify({ text, ...(missionId ? { missionId } : {}), ...(chatId ? { chatId } : {}), ...(engine ? { engine } : {}) });
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
        res.on('end', () => {
          const frames = raw
            .split('\n')
            .filter((line) => line.startsWith('data: '))
            .map((line) => {
              try {
                return JSON.parse(line.slice(6));
              } catch {
                return null;
              }
            })
            .filter(Boolean);
          resolve({
            chatId: frames.find((frame) => frame.type === 'chat-id')?.chatId ?? chatId,
            complete: frames.find((frame) => frame.type === 'turn-complete'),
            text: frames.filter((frame) => frame.type === 'text').map((frame) => frame.text).join(''),
          });
        });
      },
    );
    req.on('error', reject);
    req.end(body);
  });
}

const SECRET = 'the build must be started with the flag --allow-forge-42';

// --- 1. Agent A (claude) learns something and writes it down ---------------
const missionA = (await api('/api/missions', { method: 'POST', body: JSON.stringify({ title: 'mission A', goal: 'learn a project rule', cwd: projectDir }) })).body.mission;
const a = await turn({
  missionId: missionA.id,
  engine: 'claude-code',
  text: `A rule for this project that you could not find in any file: ${SECRET}. Remember it for whoever works here next, then answer with just "noted".`,
});
say('A remembered:', JSON.stringify((a.complete?.remembered ?? []).map((entry) => entry.text)));

// --- 2. Agent B (codex), different mission, same project, asks ------------
const missionB = (await api('/api/missions', { method: 'POST', body: JSON.stringify({ title: 'mission B', goal: 'use what was learned', cwd: projectDir }) })).body.mission;
const b = await turn({
  missionId: missionB.id,
  engine: 'codex',
  text: 'Which flag does the build in this project have to be started with? Answer in one short sentence. If you do not know, say you do not know.',
});
say('B answered:', JSON.stringify(b.text.slice(0, 300)));
say('B knew it:', b.text.includes('allow-forge-42'));

// --- 3. A separate tree must NOT see it -----------------------------------
await api('/api/memory/scopes', { method: 'POST', body: JSON.stringify({ id: 'person:luca' }) });
await api('/api/memory/scopes', { method: 'POST', body: JSON.stringify({ id: 'project:spiel', parent: 'person:luca' }) });
const foreign = await api('/api/memory?scopeId=project%3Aspiel');
say('other tree sees:', JSON.stringify(foreign.body.memories?.map((entry) => entry.text) ?? []));

const scopes = (await api('/api/memory/scopes')).body.scopes.map((scope) => scope.id);
say('scopes:', JSON.stringify(scopes));
say('data dir:', dataDir);
process.exit(0);
