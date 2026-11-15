import { describe, it, expect } from 'vitest';
import { createHandoverHandler } from './handover-routes.mjs';

function fakeRes() {
  const out = { status: null, body: null };
  return { out, res: { writeHead(s) { out.status = s; }, end(b) { out.body = b ? JSON.parse(b) : null; } } };
}

const counts = (over = {}) => ({ nothing: 0, pending: 0, failed: 0, unknown: 0, spawned: 0, running: 0, ...over });
const view = (over = {}) => ({
  switchId: 'w-1',
  openedAt: '2026-11-15T12:00:00.000Z',
  note: null,
  counts: counts({ pending: 1 }),
  handovers: [{ handoverId: 'h-aaaa0001', title: 'Shop', status: 'pending', prompt: 'token sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789 nutzen', note: null }],
  missing: [{ sessionId: 's9', cwd: 'C:\\p', title: 'B' }],
  ...over,
});

function handler(overrides = {}) {
  const calls = { start: [], scans: 0, confirms: 0 };
  let nowMs = 1_000_000;
  const h = createHandoverHandler({
    overview: () => ({ current: view(), history: [] }),
    startHandovers: async (opts) => { calls.start.push(opts); return { ok: true, switchId: opts.switchId, results: [{ handoverId: 'h-aaaa0001', title: 'Shop', ok: true, method: 'wt-tab', cwd: 'C:\\p', command: 'claude …', startFile: 'x' }] }; },
    scanAll: async () => { calls.scans += 1; return { sessions: [] }; },
    confirmFromSessions: () => { calls.confirms += 1; return 0; },
    loginOrg: () => 'org-new',
    readJsonBody: async (req) => ({ ok: true, data: req.body }),
    sendJson: (res, status, data) => { res.writeHead(status, {}); res.end(JSON.stringify(data)); },
    now: () => nowMs,
    ...overrides,
  });
  return { h, calls, tick: (ms) => { nowMs += ms; } };
}

async function call(h, method, segments, body) {
  const { out, res } = fakeRes();
  await h({ method, body }, res, segments);
  return out;
}

describe('GET /api/handover', () => {
  it('returns the protocol with secrets redacted', async () => {
    const { h, calls } = handler();
    const out = await call(h, 'GET', ['api', 'handover']);
    expect(out.status).toBe(200);
    expect(out.body.current.switchId).toBe('w-1');
    expect(out.body.current.handovers[0].prompt).not.toContain('sk-ant-api03');
    expect(out.body.history).toEqual([]);
    expect(calls.scans).toBe(0); // nothing waits for a confirmation: no scan
  });

  // handler()'s clock starts at 1_000_000 ms; an attempt one second before that
  const waitingFor = (status, attemptAtMs = 999_000) => view({ counts: counts({ [status]: 1 }), handovers: [{ handoverId: 'h-aaaa0001', title: 'Shop', status, prompt: null, note: null, lastAttemptAt: new Date(attemptAtMs).toISOString() }] });

  it('looks for fresh sessions only while a tab is unconfirmed, and not on every reload', async () => {
    const { h, calls, tick } = handler({ overview: () => ({ current: waitingFor('spawned'), history: [] }) });
    await call(h, 'GET', ['api', 'handover']);
    await call(h, 'GET', ['api', 'handover']);
    expect(calls.scans).toBe(1);
    tick(11_000);
    await call(h, 'GET', ['api', 'handover']);
    expect(calls.scans).toBe(2);
    expect(calls.confirms).toBe(2);
  });

  it('gives up looking for a session that did not show up within half an hour', async () => {
    const { h, calls, tick } = handler({ overview: () => ({ current: waitingFor('spawned'), history: [] }) });
    tick(31 * 60_000);
    const out = await call(h, 'GET', ['api', 'handover']);
    expect(out.status).toBe(200);
    expect(out.body.current.handovers[0].status).toBe('spawned'); // it keeps its status and its button
    expect(calls.scans).toBe(0);
  });

  it('also looks for the sessions of a tab opened from an earlier switch', async () => {
    const { h, calls } = handler({ overview: () => ({ current: view(), history: [waitingFor('unknown')] }) });
    await call(h, 'GET', ['api', 'handover']);
    expect(calls.scans).toBe(1);
  });

  it('still answers when the scan fails', async () => {
    const { h } = handler({ overview: () => ({ current: waitingFor('unknown'), history: [] }), scanAll: async () => { throw new Error('store gone'); } });
    expect((await call(h, 'GET', ['api', 'handover'])).status).toBe(200);
  });

  it('answers an empty protocol and rejects other methods', async () => {
    const { h } = handler({ overview: () => ({ current: null, history: [] }) });
    expect((await call(h, 'GET', ['api', 'handover'])).body).toEqual({ current: null, history: [] });
    expect((await call(h, 'DELETE', ['api', 'handover'])).status).toBe(405);
  });
});

describe('POST /api/handover/start', () => {
  it('starts the named switch and answers with ids, titles and outcomes only', async () => {
    const { h, calls } = handler();
    const out = await call(h, 'POST', ['api', 'handover', 'start'], { switchId: 'w-1' });
    expect(out.status).toBe(200);
    expect(out.body).toEqual({ ok: true, switchId: 'w-1', results: [{ handoverId: 'h-aaaa0001', title: 'Shop', ok: true, method: 'wt-tab' }] });
    expect(calls.start[0]).toEqual({ switchId: 'w-1', ids: null, account: 'login', skip: true, again: false, loginOrg: 'org-new' });
  });

  it('passes ids, account, skip and again through', async () => {
    const { h, calls } = handler();
    await call(h, 'POST', ['api', 'handover', 'start'], { switchId: 'w-1', ids: ['h-aaaa0001'], account: 'auto', skip: false, again: true });
    expect(calls.start[0]).toMatchObject({ ids: ['h-aaaa0001'], account: 'auto', skip: false, again: true });
  });

  it('refuses a request without a switch, with malformed ids or an unknown account', async () => {
    const { h, calls } = handler();
    expect((await call(h, 'POST', ['api', 'handover', 'start'], {})).status).toBe(400);
    expect((await call(h, 'POST', ['api', 'handover', 'start'], { switchId: 'w-1', ids: ['h-aaaa0001; calc'] })).status).toBe(400);
    expect((await call(h, 'POST', ['api', 'handover', 'start'], { switchId: 'w-1', ids: [] })).status).toBe(400);
    expect((await call(h, 'POST', ['api', 'handover', 'start'], { switchId: 'w-1', ids: 'h-aaaa0001' })).status).toBe(400);
    expect((await call(h, 'POST', ['api', 'handover', 'start'], { switchId: 'w-1', account: 'root' })).status).toBe(400);
    expect(calls.start).toHaveLength(0);
  });

  it('answers 409 while another start runs and 404 for an unknown switch', async () => {
    const busy = handler({ startHandovers: async () => ({ ok: false, busy: true, results: [] }) });
    expect((await call(busy.h, 'POST', ['api', 'handover', 'start'], { switchId: 'w-1' })).status).toBe(409);
    const gone = handler({ startHandovers: async () => ({ ok: false, notFound: true, error: 'no such switch: w-2', results: [] }) });
    const out = await call(gone.h, 'POST', ['api', 'handover', 'start'], { switchId: 'w-2' });
    expect(out.status).toBe(404);
    expect(out.body.error).toMatch(/no such switch/);
  });

  it('hands a warning and per-handover errors back', async () => {
    const { h } = handler({ startHandovers: async () => ({ ok: false, switchId: 'w-1', warning: 'same login', results: [{ handoverId: 'h-aaaa0001', title: 'Shop', ok: false, error: 'working directory does not exist: C:\\weg' }] }) });
    const out = await call(h, 'POST', ['api', 'handover', 'start'], { switchId: 'w-1' });
    expect(out.status).toBe(200);
    expect(out.body).toMatchObject({ ok: false, warning: 'same login', results: [{ ok: false, error: expect.stringMatching(/does not exist/) }] });
  });

  it('rejects other methods and unknown paths', async () => {
    const { h } = handler();
    expect((await call(h, 'GET', ['api', 'handover', 'start'])).status).toBe(405);
    expect((await call(h, 'POST', ['api', 'handover', 'nope'], {})).status).toBe(404);
  });
});
