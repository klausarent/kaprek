import { describe, it, expect } from 'vitest';
import { createResumeHandler } from './resume-routes.mjs';

function fakeRes() {
  const out = { status: null, body: null };
  return { out, res: { writeHead(s, h) { out.status = s; out.headers = h; }, end(b) { out.body = b ? JSON.parse(b) : null; } } };
}
const sessions = [
  { key: 'claude:a', engine: 'claude', id: 'a', cwd: 'C:\\p', title: 'A', firstTs: '2026-08-28T06:00:00.000Z', lastTs: '2026-08-28T06:10:00.000Z', userMsgs: 3, hidden: false, crash: true },
  { key: 'codex:old', engine: 'codex', id: 'old', cwd: 'C:\\p', title: 'Old', firstTs: '2026-07-01T06:00:00.000Z', lastTs: '2026-07-01T06:10:00.000Z', userMsgs: 1, hidden: false, crash: false },
  { key: 'grok:h', engine: 'grok', id: 'h', cwd: 'C:\\p', title: 'Hidden', firstTs: '2026-08-28T05:00:00.000Z', lastTs: '2026-08-28T05:10:00.000Z', userMsgs: 0, hidden: true, crash: false },
];

function handler(overrides = {}) {
  const launched = [];
  const h = createResumeHandler({
    scanAll: async () => ({ sessions, scannedAt: '2026-08-28T07:00:00.000Z' }),
    resumeSession: async (s) => { launched.push(s.key); return { ok: true, method: 'wt-tab' }; },
    now: () => Date.parse('2026-08-28T07:00:00.000Z'),
    sleep: async () => {},
    readJsonBody: async (req) => ({ ok: true, data: req.body }),
    sendJson: (res, status, data) => { res.writeHead(status, {}); res.end(JSON.stringify(data)); },
    ...overrides,
  });
  return { h, launched };
}

describe('resume routes', () => {
  it('GET sessions filters by days and hides hidden ones by default', async () => {
    const { h } = handler();
    const { out, res } = fakeRes();
    await h({ method: 'GET' }, res, ['api', 'resume', 'sessions'], new URL('http://x/api/resume/sessions?days=7'));
    expect(out.status).toBe(200);
    expect(out.body.sessions.map((s) => s.key)).toEqual(['claude:a']);
  });

  it('GET sessions?days=0 clamps to 1 day instead of falling back to the default 7', async () => {
    // A session 3 days old: outside a 1-day window, but inside the wrong
    // (unclamped-to-default) 7-day window — the one fixture that tells the
    // two behaviors apart (the shared `sessions` fixture above cannot: its
    // sessions are either <1 day or >7 days old).
    const threeDaysOld = { key: 'claude:mid', engine: 'claude', id: 'mid', cwd: 'C:\\p', title: 'Mid', firstTs: '2026-08-25T07:00:00.000Z', lastTs: '2026-08-25T07:00:00.000Z', userMsgs: 1, hidden: false, crash: false };
    const { h } = handler({ scanAll: async () => ({ sessions: [threeDaysOld], scannedAt: '2026-08-28T07:00:00.000Z' }) });
    const { out, res } = fakeRes();
    await h({ method: 'GET' }, res, ['api', 'resume', 'sessions'], new URL('http://x/api/resume/sessions?days=0'));
    expect(out.status).toBe(200);
    expect(out.body.sessions).toEqual([]);
  });

  it('GET sessions?all=1 includes hidden', async () => {
    const { h } = handler();
    const { out, res } = fakeRes();
    await h({ method: 'GET' }, res, ['api', 'resume', 'sessions'], new URL('http://x/api/resume/sessions?days=7&all=1'));
    expect(out.body.sessions.map((s) => s.key).sort()).toEqual(['claude:a', 'grok:h']);
  });

  it('POST resume launches a known session and rejects an unknown one', async () => {
    const { h, launched } = handler();
    let r = fakeRes();
    await h({ method: 'POST', body: { engine: 'claude', id: 'a' } }, r.res, ['api', 'resume'], new URL('http://x/api/resume'));
    expect(r.out.status).toBe(200);
    expect(launched).toEqual(['claude:a']);
    r = fakeRes();
    await h({ method: 'POST', body: { engine: 'claude', id: 'zzz' } }, r.res, ['api', 'resume'], new URL('http://x/api/resume'));
    expect(r.out.status).toBe(404);
  });

  it('POST batch launches at most 30 in order and reports each', async () => {
    const { h, launched } = handler();
    const { out, res } = fakeRes();
    await h({ method: 'POST', body: { items: [{ engine: 'claude', id: 'a' }, { engine: 'codex', id: 'old' }] } }, res, ['api', 'resume', 'batch'], new URL('http://x/api/resume/batch'));
    expect(out.body.ok).toBe(true);
    expect(out.body.results.map((r) => r.id)).toEqual(['a', 'old']);
    expect(launched).toEqual(['claude:a', 'codex:old']);
  });

  it('POST batch reports a partial failure for an unknown item and flips the top-level ok to false', async () => {
    const { h, launched } = handler();
    const { out, res } = fakeRes();
    await h(
      { method: 'POST', body: { items: [{ engine: 'claude', id: 'a' }, { engine: 'codex', id: 'zzz' }] } },
      res,
      ['api', 'resume', 'batch'],
      new URL('http://x/api/resume/batch'),
    );
    expect(out.body.ok).toBe(false);
    expect(out.body.results).toContainEqual({ ok: true, method: 'wt-tab', engine: 'claude', id: 'a' });
    expect(out.body.results).toContainEqual({ ok: false, error: 'no such session', engine: 'codex', id: 'zzz' });
    expect(launched).toEqual(['claude:a']);
  });

  it('GET sessions forwards ?unfiltered=1 to scanAll, defaulting to false', async () => {
    const calls = [];
    const { h } = handler({
      scanAll: async (opts) => {
        calls.push(opts);
        return { sessions, scannedAt: 'x' };
      },
    });
    let r = fakeRes();
    await h({ method: 'GET' }, r.res, ['api', 'resume', 'sessions'], new URL('http://x/api/resume/sessions?days=7'));
    r = fakeRes();
    await h({ method: 'GET' }, r.res, ['api', 'resume', 'sessions'], new URL('http://x/api/resume/sessions?days=7&unfiltered=1'));
    expect(calls).toEqual([
      { force: false, unfiltered: false },
      { force: false, unfiltered: true },
    ]);
  });

  it('POST resume and POST batch scan unfiltered themselves, independent of the GET query', async () => {
    const calls = [];
    const { h, launched } = handler({
      scanAll: async (opts) => {
        calls.push(opts);
        return { sessions, scannedAt: 'x' };
      },
    });
    let r = fakeRes();
    await h({ method: 'POST', body: { engine: 'claude', id: 'a' } }, r.res, ['api', 'resume'], new URL('http://x/api/resume'));
    r = fakeRes();
    await h({ method: 'POST', body: { items: [{ engine: 'claude', id: 'a' }] } }, r.res, ['api', 'resume', 'batch'], new URL('http://x/api/resume/batch'));
    expect(calls.every((c) => c.unfiltered === true)).toBe(true);
    expect(launched).toEqual(['claude:a', 'claude:a']);
  });

  it('answers 405 for wrong methods', async () => {
    const { h } = handler();
    const { out, res } = fakeRes();
    await h({ method: 'DELETE' }, res, ['api', 'resume', 'sessions'], new URL('http://x/api/resume/sessions'));
    expect(out.status).toBe(405);
  });
});
