// Thin wrappers around /api/resume/* (src/server/resume-routes.mjs): the
// sessions of all four agent CLIs (claude, codex, grok, kimi), and the two
// ways to bring one back as a terminal tab — one at a time, or every session
// active in the last N hours after a crash.
import { apiFetch, APP_HEADERS } from "./api";

// Set for a `claude` session the terminal-session ledger knows about (see
// src/ledger/sessions.mjs::readLedgerIndex / src/resume/scan.mjs); null for
// every other engine, and for a claude session the ledger has never heard
// from — a headless/cron run, or one from before the SessionEnd hook was
// installed. `open` is `lastType !== "end"`.
export type SessionLedgerInfo = { open: boolean; lastType: string; endReason: string | null };

export type ResumeSession = {
  key: string;
  engine: "claude" | "codex" | "grok" | "kimi";
  id: string;
  cwd: string;
  title: string;
  firstTs: string;
  lastTs: string;
  userMsgs: number;
  hidden: boolean;
  crash: boolean;
  ledger: SessionLedgerInfo | null;
};

// `ok` is optional: the server's 404 branch (unknown engine:id) answers with
// just `{ error }`, no `ok` field at all — falsy-checking `r.ok` still treats
// that as a failure, but the type must not claim a field that is sometimes
// absent (see src/server/resume-routes.mjs's `if (!session)` branch).
export type ResumeResult = { engine?: string; id?: string; ok?: boolean; method?: string; error?: string };

export async function fetchResumeSessions(days = 7): Promise<ResumeSession[]> {
  const res = await apiFetch(`/api/resume/sessions?days=${days}`);
  if (!res.ok) throw new Error(`resume sessions: ${res.status}`);
  const body = (await res.json()) as { sessions: ResumeSession[] };
  return body.sessions;
}

export async function resumeOne(engine: string, id: string): Promise<ResumeResult> {
  const res = await apiFetch("/api/resume", {
    method: "POST",
    headers: { ...APP_HEADERS, "Content-Type": "application/json" },
    body: JSON.stringify({ engine, id }),
  });
  return (await res.json()) as ResumeResult;
}

export async function resumeMany(items: { engine: string; id: string }[]): Promise<{ ok: boolean; results: ResumeResult[] }> {
  const res = await apiFetch("/api/resume/batch", {
    method: "POST",
    headers: { ...APP_HEADERS, "Content-Type": "application/json" },
    body: JSON.stringify({ items }),
  });
  return (await res.json()) as { ok: boolean; results: ResumeResult[] };
}

/** Sessions whose last activity is within the past `hours` — the "bring back last night" set. */
export function recentSessions(sessions: ResumeSession[], hours: number, nowMs = Date.now()): ResumeSession[] {
  const since = nowMs - hours * 60 * 60 * 1000;
  return sessions.filter((s) => Date.parse(s.lastTs) >= since);
}

/**
 * `recentSessions()` narrowed to ones "Alle N h fortsetzen" is actually
 * allowed to reopen: a claude session the ledger already marked ended never
 * gets swept up in a batch reopen, even if its last activity falls inside
 * the window. Other engines, and a claude session the ledger has no entry
 * for at all, carry no `ledger` and stay eligible — same as the CLI's
 * `kaprek resume --all` (see src/cli/resume.mjs).
 */
export function resumableSessions(sessions: ResumeSession[], hours: number, nowMs = Date.now()): ResumeSession[] {
  return recentSessions(sessions, hours, nowMs).filter((s) => !s.ledger || s.ledger.open);
}

/**
 * Turns a thrown fetch error — a real network failure, or MissingTokenError
 * when the page was not served with an instance token (see api.ts's
 * apiFetch/tokenHeader) — into the "Fehler: …" status text SessionList shows.
 * Always "Fehler: "-prefixed so the panel can tell an error status apart from
 * a success one by the text alone (see ResumePanel.tsx's status styling).
 */
export function resumeErrorText(err: unknown): string {
  return `Fehler: ${err instanceof Error ? err.message : String(err)}`;
}
