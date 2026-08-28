// Thin wrappers around /api/resume/* (src/server/resume-routes.mjs): the
// sessions of all four agent CLIs (claude, codex, grok, kimi), and the two
// ways to bring one back as a terminal tab — one at a time, or every session
// active in the last N hours after a crash.
import { apiFetch, APP_HEADERS } from "./api";

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
};

export type ResumeResult = { engine?: string; id?: string; ok: boolean; method?: string; error?: string };

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
