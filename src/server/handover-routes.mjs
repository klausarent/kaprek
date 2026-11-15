// /api/handover — the account-switch protocol and the button that starts one
// fresh session per handover (see src/handover/store.mjs, service.mjs).
// Dependencies are injected so the routes are testable without a filesystem
// scan or a Windows Terminal; server.mjs wires the real ones.
//
// What a handover says (file, prompt, note) is written by the sessions
// themselves through `kaprek handover add`, never over HTTP: these routes
// read the protocol and take ids and a few bounded options, nothing that
// ends up in a command line or in a fresh session's instructions.
import { redactSecrets } from '../parser/parse.mjs';
import { ACCOUNT_MODES } from '../handover/service.mjs';

// Recognising fresh sessions means scanning the transcript stores; the page
// reloads every few seconds while a switch is in progress, the scan need not.
const CONFIRM_EVERY_MS = 10_000;
// A tab whose session never showed up within this time most likely died.
// It keeps its status and its button; kaprek stops scanning for it.
const CONFIRM_FOR_MS = 30 * 60 * 1000;
const MAX_IDS = 60;

function redactView(view) {
  if (!view) return view;
  return {
    ...view,
    note: view.note ? redactSecrets(view.note) : view.note,
    handovers: view.handovers.map((h) => ({ ...h, section: h.section ? redactSecrets(h.section) : h.section, prompt: h.prompt ? redactSecrets(h.prompt) : h.prompt, note: h.note ? redactSecrets(h.note) : h.note })),
    missing: view.missing.map((m) => ({ ...m, title: redactSecrets(m.title ?? '') })),
  };
}

export function createHandoverHandler({ overview, startHandovers, scanAll, confirmFromSessions, loginOrg = () => null, readJsonBody, sendJson, now = Date.now }) {
  let lastConfirmAt = 0;

  const awaited = (view) => view.handovers.some((h) => (h.status === 'spawned' || h.status === 'unknown') && h.lastAttemptAt && now() - Date.parse(h.lastAttemptAt) < CONFIRM_FOR_MS);

  async function confirmIfDue(views) {
    if (!views.some(awaited) || now() - lastConfirmAt < CONFIRM_EVERY_MS) return false;
    lastConfirmAt = now();
    try {
      const { sessions } = await scanAll({ unfiltered: true });
      return confirmFromSessions(sessions) > 0;
    } catch {
      return false; // the protocol is still worth showing without the confirmation pass
    }
  }

  return async function handleHandoverRoutes(req, res, segments) {
    // GET /api/handover
    if (segments.length === 2) {
      if (req.method !== 'GET') {
        sendJson(res, 405, { error: 'method not allowed' });
        return;
      }
      let view = overview({ loginOrg: loginOrg() });
      if (await confirmIfDue([view.current, ...view.history].filter(Boolean))) view = overview({ loginOrg: loginOrg() });
      sendJson(res, 200, { current: redactView(view.current), history: view.history.map(redactView) });
      return;
    }

    // POST /api/handover/start  { switchId, ids?, account?, skip?, again? }
    if (segments.length === 3 && segments[2] === 'start') {
      if (req.method !== 'POST') {
        sendJson(res, 405, { error: 'method not allowed' });
        return;
      }
      const body = await readJsonBody(req);
      if (!body.ok) {
        sendJson(res, body.status, { error: body.error });
        return;
      }
      const { switchId, ids, account = 'login', skip, again } = body.data ?? {};
      // The switch is named, never assumed: a page that was open since
      // yesterday must not start whatever switch happens to be current now.
      if (typeof switchId !== 'string' || switchId === '') {
        sendJson(res, 400, { error: 'switchId must be a string' });
        return;
      }
      if (ids !== undefined && (!Array.isArray(ids) || ids.length === 0 || ids.length > MAX_IDS || ids.some((id) => typeof id !== 'string' || !/^h-[0-9a-f]{8}$/.test(id)))) {
        sendJson(res, 400, { error: `ids must be 1–${MAX_IDS} handover ids` });
        return;
      }
      if (!ACCOUNT_MODES.includes(account)) {
        sendJson(res, 400, { error: `account must be one of ${ACCOUNT_MODES.join(', ')}` });
        return;
      }
      const result = await startHandovers({ switchId, ids: ids ?? null, account, skip: skip !== false, again: again === true, loginOrg: loginOrg() });
      if (result.busy) {
        sendJson(res, 409, { error: 'another start is running' });
        return;
      }
      if (result.notFound) {
        sendJson(res, 404, { error: result.error });
        return;
      }
      if (result.error && result.results.length === 0) {
        sendJson(res, 400, { error: result.error });
        return;
      }
      lastConfirmAt = 0; // the next GET looks for the fresh sessions right away
      sendJson(res, 200, {
        ok: result.ok,
        switchId: result.switchId,
        ...(result.warning ? { warning: result.warning } : {}),
        results: result.results.map((r) => ({ handoverId: r.handoverId, title: r.title ?? '', ok: r.ok === true, ...(r.method ? { method: r.method } : {}), ...(r.error ? { error: r.error } : {}) })),
      });
      return;
    }

    sendJson(res, 404, { error: 'not found' });
  };
}
