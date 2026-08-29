// /api/resume/* — the sessions of all four agent CLIs, and the button that
// brings one (or all of last night's) back as a terminal tab. The scanner and
// the launcher are injected so the routes are testable without a filesystem
// or a Windows Terminal; server.mjs wires the real ones.
import { redactSecrets } from '../parser/parse.mjs';

const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_BATCH = 30;
const BATCH_GAP_MS = 700; // wt needs a breath between tabs, or they land in new windows

export function createResumeHandler({ scanAll, resumeSession, readJsonBody, sendJson, now = Date.now, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) }) {
  // Resuming a specific, already-known engine:id must always work — including
  // one surfaced through an unfiltered GET /api/resume/sessions — so both
  // findSession() and the batch loop below always scan unfiltered themselves,
  // independent of whichever listing produced the id being resumed.
  async function findSession(engine, id) {
    const { sessions } = await scanAll({ unfiltered: true });
    return sessions.find((s) => s.engine === engine && s.id === id) ?? null;
  }

  function publicList(sessions) {
    return sessions.map((s) => ({ ...s, title: redactSecrets(s.title) }));
  }

  return async function handleResumeRoutes(req, res, segments, url) {
    // GET /api/resume/sessions?days=7&all=0&unfiltered=0
    if (segments.length === 3 && segments[2] === 'sessions') {
      if (req.method !== 'GET') {
        sendJson(res, 405, { error: 'method not allowed' });
        return;
      }
      const rawDays = url.searchParams.get('days');
      const parsedDays = rawDays === null ? NaN : Number(rawDays);
      const days = Math.min(Math.max(Number.isNaN(parsedDays) ? 7 : parsedDays, 1), 90);
      const includeHidden = url.searchParams.get('all') === '1';
      // Off by default: a claude session the terminal-session ledger has
      // never heard of (headless/cron run) is hidden here, same as
      // `kaprek resume` without --unfiltered — see src/resume/scan.mjs.
      const unfiltered = url.searchParams.get('unfiltered') === '1';
      const since = now() - days * DAY_MS;
      const { sessions, scannedAt } = await scanAll({ force: url.searchParams.get('force') === '1', unfiltered });
      const picked = sessions.filter((s) => Date.parse(s.lastTs) >= since && (includeHidden || !s.hidden));
      sendJson(res, 200, { sessions: publicList(picked), scannedAt });
      return;
    }

    // POST /api/resume  { engine, id, skip? }
    if (segments.length === 2) {
      if (req.method !== 'POST') {
        sendJson(res, 405, { error: 'method not allowed' });
        return;
      }
      const body = await readJsonBody(req);
      if (!body.ok) {
        sendJson(res, body.status, { error: body.error });
        return;
      }
      const { engine, id } = body.data ?? {};
      if (typeof engine !== 'string' || typeof id !== 'string') {
        sendJson(res, 400, { error: 'engine and id must be strings' });
        return;
      }
      const session = await findSession(engine, id);
      if (!session) {
        sendJson(res, 404, { error: `no such session: ${engine}:${id}` });
        return;
      }
      const result = await resumeSession(session, { skip: body.data.skip !== false });
      sendJson(res, result.ok ? 200 : 500, result);
      return;
    }

    // POST /api/resume/batch  { items: [{engine,id}], skip? }
    if (segments.length === 3 && segments[2] === 'batch') {
      if (req.method !== 'POST') {
        sendJson(res, 405, { error: 'method not allowed' });
        return;
      }
      const body = await readJsonBody(req);
      if (!body.ok) {
        sendJson(res, body.status, { error: body.error });
        return;
      }
      const items = Array.isArray(body.data?.items) ? body.data.items.slice(0, MAX_BATCH) : [];
      const { sessions } = await scanAll({ unfiltered: true });
      const results = [];
      for (const item of items) {
        const session = sessions.find((s) => s.engine === item?.engine && s.id === item?.id);
        if (!session) {
          results.push({ engine: item?.engine, id: item?.id, ok: false, error: 'no such session' });
          continue;
        }
        const r = await resumeSession(session, { skip: body.data.skip !== false });
        results.push({ engine: session.engine, id: session.id, ...r });
        await sleep(BATCH_GAP_MS);
      }
      sendJson(res, 200, { ok: results.every((r) => r.ok), results });
      return;
    }

    sendJson(res, 404, { error: 'not found' });
  };
}
