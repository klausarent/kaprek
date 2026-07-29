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

async function throwOnError(res: Response): Promise<void> {
  if (res.ok) return;
  let detail = "";
  try {
    const body = await res.json();
    if (body && typeof body.error === "string") detail = `: ${body.error}`;
  } catch {
    // Best-effort — an unparseable error body is not worth failing over.
  }
  throw new Error(`Request failed (HTTP ${res.status})${detail}`);
}

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url);
  await throwOnError(res);
  return res.json() as Promise<T>;
}

// Every non-GET request needs this header — the server rejects writes
// without it (see server.mjs's CSRF hardening comment). It forces the
// browser into a CORS preflight, which fails silently for any cross-origin
// caller since this server never sends CORS headers back.
const APP_HEADERS = { "x-app-request": "1" } as const;

async function writeJson<T>(url: string, method: string, body?: unknown): Promise<T> {
  const res = await fetch(url, {
    method,
    headers: body === undefined ? APP_HEADERS : { ...APP_HEADERS, "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  await throwOnError(res);
  return res.json() as Promise<T>;
}

function postJson<T>(url: string, body?: unknown): Promise<T> {
  return writeJson<T>(url, "POST", body);
}

function patchJson<T>(url: string, body: unknown): Promise<T> {
  return writeJson<T>(url, "PATCH", body);
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

export type SearchHit = {
  sessionId: string;
  projectSlug: string;
  title: string | null;
  // Contains literal <b>…</b> markers from FTS5's snippet() — never render
  // this as HTML; callers must parse the markers themselves.
  snippet: string;
};

export type SearchResponse = { available: true; results: SearchHit[] } | { available: false; reason: string };

export type ReindexResponse =
  | { available: true; indexed: number; skipped: number }
  | { available: false; reason: string };

export function fetchSearch(query: string): Promise<SearchResponse> {
  return getJson<SearchResponse>(`/api/search?q=${encodeURIComponent(query)}`);
}

export function reindexSearch(): Promise<ReindexResponse> {
  return postJson<ReindexResponse>("/api/search/reindex");
}

// Board (src/board/store.mjs via /api/board/*)

export type BoardStatus = "backlog" | "in_progress" | "in_review" | "blocked" | "done";

export const BOARD_STATUSES: BoardStatus[] = ["backlog", "in_progress", "in_review", "blocked", "done"];

export type TaskDoc = {
  trigger?: string;
  outcome?: string;
  approach?: string;
  course?: string;
  verification?: string;
  effort?: string;
  open?: string;
};

// The 7 doc fields with their labels/descriptions, in display order — used
// to render the doc form and mirrors DOC_FIELDS in src/board/store.mjs.
export const DOC_FIELD_DEFS: { key: keyof TaskDoc; label: string; description: string }[] = [
  { key: "trigger", label: "Trigger / Why", description: "What prompted this task?" },
  { key: "outcome", label: "Outcome", description: "What was actually delivered, in concrete terms?" },
  { key: "approach", label: "Approach", description: "The approach taken and the reasoning behind it." },
  { key: "course", label: "Course / Detours", description: "How it unfolded, including dead ends and pivots." },
  { key: "verification", label: "Verification", description: "How the result was checked to actually work." },
  { key: "effort", label: "Effort", description: "Rough time or effort spent." },
  { key: "open", label: "Open items", description: "Anything left unresolved for later." },
];

// A doc field counts as "filled" once it reaches this length — mirrors
// DOC_FIELD_MIN_LENGTH in src/board/store.mjs, which the server enforces
// when a task moves to 'done'. Duplicated here only so the UI can disable
// the "Mark done" action before making a round trip.
export const DOC_FIELD_MIN_LENGTH = 20;

export type TaskSession = {
  machine?: string | null;
  projectSlug: string;
  sessionId: string;
};

export type Task = {
  id: string;
  title: string;
  project: string | null;
  tags: string[];
  status: BoardStatus;
  createdAt: string;
  updatedAt: string;
  doc: TaskDoc | null;
  sessions: TaskSession[];
  receipt: unknown;
};

export function fetchTasks(filter: { status?: BoardStatus; project?: string } = {}): Promise<Task[]> {
  const params = new URLSearchParams();
  if (filter.status) params.set("status", filter.status);
  if (filter.project) params.set("project", filter.project);
  const qs = params.toString();
  return getJson<{ tasks: Task[] }>(`/api/board/tasks${qs ? `?${qs}` : ""}`).then((r) => r.tasks);
}

export function createTask(input: { title: string; project?: string; tags?: string[] }): Promise<Task> {
  return postJson<Task>("/api/board/tasks", input);
}

export function updateTask(id: string, patch: { title?: string; project?: string; tags?: string[] }): Promise<Task> {
  return patchJson<Task>(`/api/board/tasks/${encodeURIComponent(id)}`, { op: "update", patch });
}

export function setTaskDoc(id: string, doc: TaskDoc): Promise<Task> {
  return patchJson<Task>(`/api/board/tasks/${encodeURIComponent(id)}`, { op: "setDoc", doc });
}

export function linkTaskSession(
  id: string,
  session: { machine?: string | null; projectSlug: string; sessionId: string },
): Promise<Task> {
  return patchJson<Task>(`/api/board/tasks/${encodeURIComponent(id)}`, { op: "linkSession", session });
}

/** Thrown by setTaskStatus() when the server rejects a move to 'done' (HTTP 409) because the doc is incomplete. */
export class TaskDocIncompleteError extends Error {
  missing: string[];
  constructor(missing: string[]) {
    super(`task doc incomplete, missing: ${missing.join(", ")}`);
    this.name = "TaskDocIncompleteError";
    this.missing = missing;
  }
}

export async function setTaskStatus(id: string, status: BoardStatus): Promise<Task> {
  const res = await fetch(`/api/board/tasks/${encodeURIComponent(id)}/status`, {
    method: "POST",
    headers: { ...APP_HEADERS, "Content-Type": "application/json" },
    body: JSON.stringify({ status }),
  });
  if (res.status === 409) {
    const body = await res.json();
    throw new TaskDocIncompleteError(Array.isArray(body.missing) ? body.missing : []);
  }
  await throwOnError(res);
  return res.json() as Promise<Task>;
}
