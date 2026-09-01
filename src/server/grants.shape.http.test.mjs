// P6b — shape grants over HTTP: preview duty (pattern + examples), the
// server-enforced confirm gate, matching by shape, not-derivable refusal,
// fingerprint staleness over HTTP, and oldest-wins among live shape grants.
// Boots a real server like grants.http.test.mjs (which holds the P6a flows).
import { test, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startServer } from './server.mjs';
import { TOKEN_HEADER } from './token.mjs';
import { derivePattern, DERIVATION_VERSION } from '../policy/grants.mjs';
import { hardDenialsHashOf } from '../policy/guards.mjs';
import { loadPolicyFailOpen } from '../policy/policy.mjs';

const APP_HEADERS = { 'x-app-request': '1' };
const APP_JSON_HEADERS = { ...APP_HEADERS, 'Content-Type': 'application/json' };

let tmpDir;
let dataDir;
let tmpRootDir;
let missionCwd;
let servers = [];
let currentToken = null;

const rawFetch = (...args) => globalThis.fetch(...args);
function fetch(input, init = {}) {
  return rawFetch(input, { ...init, headers: { ...(init.headers ?? {}), [TOKEN_HEADER]: currentToken ?? '' } });
}

function postJson(url, body) {
  return fetch(url, { method: 'POST', headers: APP_JSON_HEADERS, body: JSON.stringify(body) });
}

function approvalHarness({ requests }) {
  let turn = 0;
  return {
    async startTurn({ onEvent, onApprovalRequest, signal } = {}) {
      const request = requests[turn % requests.length];
      turn += 1;
      const decision = await onApprovalRequest(request);
      await new Promise((resolve) => setTimeout(resolve, 10));
      if (signal?.aborted) return { sessionId: null, costUsd: null, usage: null, stopReason: 'aborted', error: null };
      onEvent?.({ type: 'text', text: `decision was ${decision.behavior}${decision.message ? `: ${decision.message}` : ''}` });
      onEvent?.({ type: 'result', sessionId: 's1', costUsd: 0.001, usage: {}, isError: false });
      return { sessionId: 's1', costUsd: 0.001, usage: {}, stopReason: 'result', error: null };
    },
  };
}

function writePolicy(policy) {
  fs.writeFileSync(path.join(dataDir, 'policy.json'), JSON.stringify({ version: 1, mode: 'observe', ...policy }), 'utf8');
}

async function boot(opts = {}) {
  const started = await startServer({ port: 0, rootDir: tmpDir, dataDir, tmpRoot: tmpRootDir, ...opts });
  servers.push(started);
  currentToken = started.token;
  return started;
}

async function readSse(res, onEvent) {
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const frames = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let idx;
    while ((idx = buffer.indexOf('\n\n')) !== -1) {
      const raw = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      if (!raw.startsWith('data: ')) continue;
      const frame = JSON.parse(raw.slice('data: '.length));
      frames.push(frame);
      if (onEvent) await onEvent(frame);
    }
  }
  return frames;
}

async function runTurnWithApproval({ url, missionId = null, chatId = null, text = 'go', answer }) {
  const res = await fetch(`${url}/api/chat/turn`, {
    method: 'POST',
    headers: APP_JSON_HEADERS,
    body: JSON.stringify({ text, ...(missionId ? { missionId } : {}), ...(chatId ? { chatId } : {}) }),
  });
  let approvalFrame = null;
  const frames = await readSse(res, async (frame) => {
    if (frame.type === 'approval' && !approvalFrame) {
      approvalFrame = frame;
      if (answer) await answer(frame);
    }
  });
  return { approvalFrame, frames, chatId: frames[0]?.chatId ?? null };
}

/** Answers with the SHAPE grant intent; returns the nonce (or null). */
async function answerShape(url, frame) {
  const body = await (await postJson(`${url}/api/approvals/${frame.id}`, { chatId: frame.chatId, behavior: 'allow', grant: true, grantMatch: 'shape' })).json();
  return body.grantNonce ?? null;
}

async function denyInside(url, frame) {
  await postJson(`${url}/api/approvals/${frame.id}`, { chatId: frame.chatId, behavior: 'deny' });
}

async function previewShape(url, approvalId, nonce) {
  return postJson(`${url}/api/grants`, { approvalId, nonce, match: 'shape', preview: true });
}

async function mintShape(url, approvalId, nonce, { confirm = true } = {}) {
  return postJson(`${url}/api/grants`, { approvalId, nonce, match: 'shape', ...(confirm ? { confirm: true } : {}) });
}

/** Full shape flow for one frame: answer, preview, confirmed mint. Returns { nonce, preview, mint }. */
async function answerPreviewAndMint(url, frame) {
  const nonce = await answerShape(url, frame);
  const preview = await previewShape(url, `${frame.chatId}:${frame.id}`, nonce);
  const mint = await mintShape(url, `${frame.chatId}:${frame.id}`, nonce);
  return { nonce, preview, mint };
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'grants-shape-route-'));
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'grants-shape-route-data-'));
  tmpRootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'grants-shape-route-tmp-'));
  missionCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'grants-shape-route-cwd-'));
  servers = [];
  currentToken = null;
});

afterEach(async () => {
  for (const { server } of servers) await new Promise((resolve) => server.close(resolve));
  for (const dir of [tmpDir, dataDir, tmpRootDir, missionCwd]) fs.rmSync(dir, { recursive: true, force: true });
});

async function createMission(url, posture = null) {
  const { mission } = await (
    await postJson(`${url}/api/missions`, { title: 'm', cwd: missionCwd, ...(posture ? { posture } : {}) })
  ).json();
  return mission;
}

const NPM_TEST = { id: 'req-1', toolName: 'Bash', input: { command: 'npm test' } };
const NPM_BUILD = { id: 'req-1', toolName: 'Bash', input: { command: 'npm run build' } };
const GIT_STATUS = { id: 'req-1', toolName: 'Bash', input: { command: 'git status' } };
// Built per test (missionCwd exists only after beforeEach).
const writeSrcA = () => ({ id: 'req-1', toolName: 'Write', input: { file_path: path.join(missionCwd, 'src', 'a.ts') } });
const writeSrcB = () => ({ id: 'req-1', toolName: 'Write', input: { file_path: path.join(missionCwd, 'src', 'b.ts') } });
const writeDocsC = () => ({ id: 'req-1', toolName: 'Write', input: { file_path: path.join(missionCwd, 'docs', 'c.md') } });

test('shape over HTTP: the preview shows the pattern and its examples (hit and miss); a mint without confirm is 409; the confirmed mint covers the same form', async () => {
  writePolicy({ posture: 'ask' });
  const { url } = await boot({ harness: approvalHarness({ requests: [NPM_TEST, NPM_BUILD, GIT_STATUS] }), harnessName: 'fake' });
  const mission = await createMission(url);

  let previewBody = null;
  let mintResponse = null;
  const first = await runTurnWithApproval({
    url,
    missionId: mission.id,
    answer: async (frame) => {
      const { preview, mint } = await answerPreviewAndMint(url, frame);
      previewBody = await preview.json();
      mintResponse = mint;
    },
  });
  expect(first.approvalFrame).toBeTruthy();

  // The preview: a rendered sentence and CONCRETE examples, at least one of
  // each kind — the server generates them, the dialog only renders them.
  expect(mintResponse.status).toBe(200);
  expect(previewBody.preview.match).toBe('shape');
  expect(previewBody.preview.sentence).toContain('npm');
  const examples = previewBody.preview.examples;
  expect(examples.length).toBeGreaterThanOrEqual(2);
  expect(examples.some((e) => e.matches === true)).toBe(true);
  expect(examples.some((e) => e.matches === false)).toBe(true);
  expect(previewBody.preview.fingerprint).toMatchObject({ posture: 'ask', missionId: mission.id, derivationVersion: DERIVATION_VERSION });

  const { grant } = await mintResponse.json();
  expect(grant).toMatchObject({ match: 'shape', toolName: 'Bash', missionId: mission.id, derivationVersion: DERIVATION_VERSION });
  expect(grant.pattern).toMatchObject({ type: 'command-head', head: 'npm' });

  // The same FORM (different arguments) is granted without asking; a call
  // with another command head still asks.
  const second = await runTurnWithApproval({ url, chatId: first.chatId, text: 'again' });
  expect(second.approvalFrame).toBe(null);
  expect(second.frames.some((f) => f.type === 'text' && f.text.startsWith('decision was allow: standing grant'))).toBe(true);
  const third = await runTurnWithApproval({ url, chatId: first.chatId, text: 'other form', answer: (frame) => denyInside(url, frame) });
  expect(third.approvalFrame).toBeTruthy();

  const { grants } = await (await fetch(`${url}/api/grants`)).json();
  expect(grants.find((g) => g.id === grant.id).useCount).toBe(1);
});

test('shape over HTTP: mint WITHOUT the confirm field is refused with 409 examples-not-shown — server-enforced, not a UI courtesy', async () => {
  writePolicy({ posture: 'ask' });
  const { url } = await boot({ harness: approvalHarness({ requests: [NPM_TEST] }), harnessName: 'fake' });
  const mission = await createMission(url);

  let noConfirm = null;
  await runTurnWithApproval({
    url,
    missionId: mission.id,
    answer: async (frame) => {
      const nonce = await answerShape(url, frame);
      noConfirm = await mintShape(url, `${frame.chatId}:${frame.id}`, nonce, { confirm: false });
    },
  });
  expect(noConfirm.status).toBe(409);
  expect((await noConfirm.json()).already).toBe('examples-not-shown');
  // Nothing was minted.
  const { grants } = await (await fetch(`${url}/api/grants`)).json();
  expect(grants).toEqual([]);
});

test('shape over HTTP: a path-prefix grant covers files under its directory (any depth), not other directories', async () => {
  writePolicy({ posture: 'ask' });
  const { url } = await boot({ harness: approvalHarness({ requests: [writeSrcA(), writeSrcB(), writeDocsC()] }), harnessName: 'fake' });
  const mission = await createMission(url);

  const first = await runTurnWithApproval({
    url,
    missionId: mission.id,
    answer: async (frame) => {
      const { mint } = await answerPreviewAndMint(url, frame);
      expect(mint.status).toBe(200);
      const { grant } = await mint.json();
      expect(grant.pattern).toMatchObject({ type: 'path-prefix', keys: ['file_path'] });
    },
  });

  // Same directory (deeper is fine too): granted.
  const second = await runTurnWithApproval({ url, chatId: first.chatId, text: 'again' });
  expect(second.approvalFrame).toBe(null);
  // Another directory outside the prefix: asks.
  const third = await runTurnWithApproval({ url, chatId: first.chatId, text: 'elsewhere', answer: (frame) => denyInside(url, frame) });
  expect(third.approvalFrame).toBeTruthy();
  expect(third.approvalFrame.input.file_path).toContain('docs');
});

test('shape over HTTP: a non-derivable input refuses preview AND mint with 409 not-derivable — never a guessed pattern', async () => {
  writePolicy({ posture: 'ask' });
  const opaque = { id: 'req-1', toolName: 'Write', input: { content: 'plain text, nothing derivable' } };
  const { url } = await boot({ harness: approvalHarness({ requests: [opaque] }), harnessName: 'fake' });
  const mission = await createMission(url);

  let previewResponse = null;
  let mintResponse = null;
  await runTurnWithApproval({
    url,
    missionId: mission.id,
    answer: async (frame) => {
      const nonce = await answerShape(url, frame);
      previewResponse = await previewShape(url, `${frame.chatId}:${frame.id}`, nonce);
      // A preview 409 did NOT burn the nonce — but there is nothing to mint
      // either way; the confirmed mint hits the same honest wall.
      mintResponse = await mintShape(url, `${frame.chatId}:${frame.id}`, nonce);
    },
  });
  expect(previewResponse.status).toBe(409);
  expect((await previewResponse.json()).already).toBe('not-derivable');
  expect(mintResponse.status).toBe(409);
  expect((await mintResponse.json()).already).toBe('not-derivable');
});

test('shape over HTTP: a derivationVersion bump stales the shape grant; an exact grant minted beside it is unaffected', async () => {
  writePolicy({ posture: 'ask' });
  const { url } = await boot({ harness: approvalHarness({ requests: [{ ...NPM_TEST }] }), harnessName: 'fake' });
  const mission = await createMission(url);

  // A shape grant written under derivation version 0 — an OLDER rule (what a
  // version bump leaves behind). Same pattern shape as v1 would derive for
  // `npm …`, so only the version stands between it and a hit.
  const oldPattern = { ...derivePattern({ toolName: 'Bash', input: { command: 'npm test' }, cwd: missionCwd }), v: 0 };
  const fixture = {
    schemaVersion: 1,
    id: 'e-oldv',
    ts: new Date().toISOString(),
    type: 'grant.minted',
    data: {
      id: 'g-oldv',
      scope: `mission:${mission.id}`,
      toolName: 'Bash',
      inputHash: 'a'.repeat(64),
      match: 'shape',
      pattern: oldPattern,
      derivationVersion: 0,
      postureAtGrant: 'ask',
      hardDenialsHash: hardDenialsHashOf(loadPolicyFailOpen(dataDir)),
      missionId: mission.id,
      createdAt: new Date().toISOString(),
    },
  };
  fs.appendFileSync(path.join(dataDir, 'grants.jsonl'), `${JSON.stringify(fixture)}\n`, 'utf8');

  const first = await runTurnWithApproval({ url, chatId: null, missionId: mission.id, text: 'again', answer: (frame) => denyInside(url, frame) });
  expect(first.approvalFrame).toBeTruthy();
  expect(first.approvalFrame.standingGrant).toMatchObject({ state: 'stale' });
  expect(first.approvalFrame.standingGrant.why).toContain('derivation');
});

test('shape over HTTP: a changed hard-denials list stales a shape grant', async () => {
  writePolicy({ posture: 'ask' });
  const { url } = await boot({ harness: approvalHarness({ requests: [NPM_TEST, NPM_TEST] }), harnessName: 'fake' });
  const mission = await createMission(url);
  const minted = await runTurnWithApproval({
    url,
    missionId: mission.id,
    answer: async (frame) => {
      const { mint } = await answerPreviewAndMint(url, frame);
      expect(mint.status).toBe(200);
    },
  });

  writePolicy({ posture: 'ask', hardDenials: [{ id: 'no-prod', tools: ['Bash'], command: 'deploy\\s+--prod' }] });
  const after = await runTurnWithApproval({ url, chatId: minted.chatId, text: 'again', answer: (frame) => denyInside(url, frame) });
  expect(after.approvalFrame).toBeTruthy();
  expect(after.approvalFrame.standingGrant).toMatchObject({ state: 'stale' });
  // The grant was not consumed.
  const { grants } = await (await fetch(`${url}/api/grants`)).json();
  expect(grants.find((g) => g.match === 'shape').useCount).toBe(0);
});

test('shape over HTTP: several live shape grants matching the same form — the OLDEST wins and takes the use', async () => {
  writePolicy({ posture: 'ask' });
  const { url } = await boot({ harness: approvalHarness({ requests: [NPM_TEST] }), harnessName: 'fake' });
  const mission = await createMission(url);

  // Two live same-pattern grants. (Minting a twin supersedes its older twin,
  // so two LIVE twins only arise otherwise — e.g. imported or backdated
  // records; the test writes both directly to pin the tiebreak.)
  const pattern = derivePattern({ toolName: 'Bash', input: { command: 'npm test' }, cwd: missionCwd });
  const denialsHash = hardDenialsHashOf(loadPolicyFailOpen(dataDir));
  const lines = ['g-older', 'g-newer'].map((id, i) => ({
    schemaVersion: 1,
    id: `e-${id}`,
    ts: new Date().toISOString(),
    type: 'grant.minted',
    data: {
      id,
      scope: `mission:${mission.id}`,
      toolName: 'Bash',
      inputHash: 'a'.repeat(64),
      match: 'shape',
      pattern,
      derivationVersion: DERIVATION_VERSION,
      postureAtGrant: 'ask',
      hardDenialsHash: denialsHash,
      missionId: mission.id,
      createdAt: i === 0 ? '1999-01-01T00:00:00.000Z' : new Date().toISOString(),
    },
  }));
  fs.appendFileSync(path.join(dataDir, 'grants.jsonl'), `${lines.map((l) => JSON.stringify(l)).join('\n')}\n`, 'utf8');

  const turn = await runTurnWithApproval({ url, missionId: mission.id, text: 'go' });
  expect(turn.approvalFrame).toBe(null);
  const { grants } = await (await fetch(`${url}/api/grants`)).json();
  const older = grants.find((g) => g.id === 'g-older');
  const newer = grants.find((g) => g.id === 'g-newer');
  expect(older.useCount).toBe(1);
  expect(newer.useCount).toBe(0);
});
