// Thin fetch wrappers around loryme's local HTTP API (src/server/server.mjs).
// The UI is served by that same server, so all requests are same-origin
// relative paths — no base URL, no CORS handling needed.

export type ProjectSummary = {
  projectSlug: string;
  sessionCount: number;
};

export type SessionMeta = {
  sessionId: string;
  sizeBytes: number;
  mtime: string;
  title: string | null;
  startedAt: string | null;
  endedAt: string | null;
  turns: number;
  machineHint: string | null;
};

export type ToolEvent = {
  kind: "tool";
  ts: string;
  msgId: string | null;
  name: string | null;
  input: string | null;
  result: string | null;
  resultRef: string | null;
};

export type TextEvent = {
  kind: "user" | "assistant" | "thinking";
  ts: string;
  msgId?: string | null;
  text: string;
};

export type SubagentEvent = {
  kind: "subagent";
  ts: string;
  agentId: string | null;
  name: string | null;
  agentType: string | null;
  model: string | null;
  description: string | null;
};

export type CompactEvent = {
  kind: "compact";
  ts: string;
  preTokens: number | null;
  postTokens: number | null;
};

export type DigestEvent = ToolEvent | TextEvent | SubagentEvent | CompactEvent;

export type SubagentThread = {
  agentId: string | null;
  meta: Record<string, unknown>;
  events: DigestEvent[];
};

export type DigestMeta = {
  sessionId: string;
  projectSlug: string;
  cwd: string | null;
  title: string | null;
  startedAt: string | null;
  endedAt: string | null;
  models: string[];
  version: string | null;
  machine: string;
  turns: number;
  toolCalls: number;
  rawBytes: number;
  hasSubagents: boolean;
  gitCommits: number;
};

export type Digest = {
  meta: DigestMeta;
  events: DigestEvent[];
  subagents: SubagentThread[];
};

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) {
    let detail = "";
    try {
      const body = await res.json();
      if (body && typeof body.error === "string") detail = `: ${body.error}`;
    } catch {
      // Best-effort — an unparseable error body is not worth failing over.
    }
    throw new Error(`Request failed (HTTP ${res.status})${detail}`);
  }
  return res.json() as Promise<T>;
}

export function fetchProjects(): Promise<ProjectSummary[]> {
  return getJson<ProjectSummary[]>("/api/projects");
}

export function fetchSessions(projectSlug: string): Promise<SessionMeta[]> {
  return getJson<SessionMeta[]>(`/api/sessions?project=${encodeURIComponent(projectSlug)}`);
}

export function fetchDigest(projectSlug: string, sessionId: string): Promise<Digest> {
  const path = [projectSlug, sessionId].map(encodeURIComponent).join("/");
  return getJson<Digest>(`/api/session/${path}/digest`);
}
