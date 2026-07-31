// Thin fetch wrappers around kaprek's local HTTP API (src/server/server.mjs).
// The UI is served by that same server, so all requests are same-origin
// relative paths — no base URL, no CORS handling needed.
import { setStatus } from "./status";

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

export type DigestEvent = ToolEvent | TextEvent | SubagentEvent | CompactEvent | ApprovalEvent;

// One persisted approval, either lifecycle half (see src/chats/store.mjs's
// EVENT_SHAPES 'approval' entry — 'requested' carries the proposed call,
// 'resolved' the decision). Rendered by EventBlock.tsx as a single line.
export type ApprovalEvent = {
  kind: "approval";
  ts: string;
  phase: "requested" | "resolved";
  requestId: string;
  toolName: string | null;
  displayName?: string | null;
  input?: string | null;
  description?: string | null;
  agentId?: string | null;
  reason?: string | null;
  behavior?: "allow" | "deny" | "error" | null;
  message?: string | null;
};

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

// ---------------------------------------------------------------------------
// Instance token (src/server/token.mjs)
//
// Every /api/* route — GET included — is a 401 without the `x-kaprek-token`
// header. The server hands the token to the browser by injecting
// `<meta name="kaprek-token" content="…">` into the index.html it serves (see
// server.mjs::injectTokenMeta), so it is read from the DOM once here and
// attached to every request below, including the SSE fetches.
//
// A missing meta tag means this page was NOT served by a kaprek server that
// knows its own token (a stale cached document, a `vite dev` page, a
// hand-saved copy). There is nothing the UI can do about that on its own, so
// every call fails fast with MissingTokenError and App.tsx shows the
// restart-the-server page instead of a wall of 401s.
// ---------------------------------------------------------------------------

const TOKEN_HEADER = "x-kaprek-token";
const TOKEN_META_NAME = "kaprek-token";

/** Thrown by every request helper when index.html carried no instance-token meta tag. */
export class MissingTokenError extends Error {
  constructor() {
    super("no instance token in this page — restart the kaprek server and reload");
    this.name = "MissingTokenError";
  }
}

function readTokenMeta(): string | null {
  if (typeof document === "undefined") return null;
  const meta = document.querySelector(`meta[name="${TOKEN_META_NAME}"]`);
  const content = meta?.getAttribute("content")?.trim() ?? "";
  return content.length > 0 ? content : null;
}

// Read once, at module load: the token never changes for the lifetime of a
// served page, and re-querying the DOM per request would only invite a
// mid-session read of a token some other script had replaced.
const instanceToken = readTokenMeta();

/** False when index.html carried no token meta tag — see MissingTokenError. */
export function hasInstanceToken(): boolean {
  return instanceToken !== null;
}

function tokenHeader(): Record<string, string> {
  if (instanceToken === null) throw new MissingTokenError();
  return { [TOKEN_HEADER]: instanceToken };
}

/**
 * `fetch` plus the instance token and the reachability bookkeeping the header
 * status dot reads (see lib/status.ts). Only a fetch that REJECTS counts as
 * unreachable — a 401/404/500 is still a server that answered. An aborted
 * request (user pressed Stop, component unmounted) is neither.
 */
async function apiFetch(url: string, init: RequestInit = {}): Promise<Response> {
  const headers = { ...(init.headers as Record<string, string> | undefined), ...tokenHeader() };
  try {
    const res = await fetch(url, { ...init, headers });
    setStatus({ serverReachable: true });
    return res;
  } catch (err) {
    if ((err as Error).name !== "AbortError") setStatus({ serverReachable: false });
    throw err;
  }
}

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
  const res = await apiFetch(url);
  await throwOnError(res);
  return res.json() as Promise<T>;
}

// Every non-GET request needs this header — the server rejects writes
// without it (see server.mjs's CSRF hardening comment). It forces the
// browser into a CORS preflight, which fails silently for any cross-origin
// caller since this server never sends CORS headers back.
const APP_HEADERS = { "x-app-request": "1" } as const;

async function writeJson<T>(url: string, method: string, body?: unknown): Promise<T> {
  const res = await apiFetch(url, {
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

// Preserved scratchpad artifacts (src/artifacts/preserve.mjs via
// /api/session/<slug>/<id>/artifacts). A "skipped" entry never made it to
// disk (too large, or the session's byte budget ran out) — it still shows up
// here so the user can see what wasn't preserved, not just what was.
export type ArtifactEntry =
  | { relPath: string; size: number; mtimeMs: number; sha256: string; preservedAt: string; skipped?: undefined }
  | { relPath: string; size: number; skipped: "too-large" | "session-budget" };

export type ArtifactManifest = { files: ArtifactEntry[] };

export function fetchArtifacts(projectSlug: string, sessionId: string): Promise<ArtifactManifest> {
  const path = [projectSlug, sessionId].map(encodeURIComponent).join("/");
  return getJson<ArtifactManifest>(`/api/session/${path}/artifacts`);
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

// Mirrors the receipt shape produced by src/receipt/receipt.mjs's signReceipt().
export type Receipt = {
  agent: string;
  pubkey: string;
  alg: "ed25519";
  payloadHash: string;
  sig: string;
  signedAt: string;
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
  receipt: Receipt | null;
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
  const res = await apiFetch(`/api/board/tasks/${encodeURIComponent(id)}/status`, {
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

/** Signs a receipt for a 'done' task's current state. Server defaults agentName to 'local' when omitted. */
export function signTaskReceipt(id: string, agentName?: string): Promise<{ receipt: Receipt }> {
  return postJson<{ receipt: Receipt }>(`/api/board/tasks/${encodeURIComponent(id)}/receipt`, { agentName });
}

export type VerifyReceiptResult = { valid: boolean; reason?: string };

export function verifyTaskReceipt(id: string): Promise<VerifyReceiptResult> {
  return getJson<VerifyReceiptResult>(`/api/board/tasks/${encodeURIComponent(id)}/receipt/verify`);
}

// Chat (src/orchestrator/run.mjs via /api/chat/*)

// Mirrors src/harness/adapter.mjs's NormalizedEvent union — what a chat turn
// streams over SSE, plus the two protocol-level frames the route itself adds
// (see server.mjs's handleChatTurn doc comment): 'chat-id' up front and
// 'turn-complete' at the end. `input` on 'tool-start' is a raw object here
// (the harness's own shape, redacted but not yet truncated — see
// src/orchestrator/run.mjs::redactInputObject()), NOT the pre-stringified
// `input` DigestEvent's ToolEvent expects — see toDigestEvent() below, which
// bridges the two so EventBlock.tsx can render both live and reloaded turns
// unchanged.
/**
 * A live tool-use approval question, streamed mid-turn (see
 * server.mjs::makeApprovalHandler). `chatId` is added by the route and is
 * REQUIRED back in the answer's body — POST /api/approvals/<id> cannot look
 * an entry up without it (see server.mjs::approvalKey). `input` is a plain
 * object here (already redacted by run.mjs, NOT pre-stringified like a
 * persisted ApprovalEvent's `input`).
 *
 * There is no matching 'resolved' frame on the wire: the client learns the
 * outcome from its own answerApproval() response, and a request the server
 * decides on its own (10-minute auto-deny, turn ended) is cleaned up client-
 * side by the countdown / 'turn-complete' — see lib/approvals.ts.
 */
/** Where an approval question came from — see server.mjs::describeApprovalSource. */
export type ApprovalSource = {
  kind: "trigger" | "chat";
  triggerId: string | null;
  title: string | null;
};

export type ApprovalFrame = {
  type: "approval";
  chatId: string;
  /** Null when the chat could not be read; the dialog then shows no origin rather than a wrong one. */
  source?: ApprovalSource | null;
  id: string;
  toolName: string | null;
  displayName: string | null;
  input: Record<string, unknown> | null;
  description: string | null;
  reason: string | null;
  agentId: string | null;
  toolUseId?: string | null;
  reasonType?: string | null;
  suggestions?: unknown;
  /**
   * When the server will deny this on its own, as epoch milliseconds. Sent
   * because the deadline is no longer one number the client can assume: a
   * chat turn's question lapses in 10 minutes, a trigger's in 8 hours (see
   * src/server/approval-store.mjs). Optional only for a frame from an older
   * server; lib/approvals.ts falls back when it is missing.
   */
  deadlineAt?: number | null;
  /**
   * Which of the two limits produced `deadlineAt`: the question's own
   * approval deadline, or the turn's never-pausing wall clock. Only the
   * second one needs explaining in the UI (a question can show minutes left
   * when its nominal deadline is hours away). Absent on a frame from an older
   * server, which is treated as 'question'.
   */
  deadlineSource?: "question" | "turn";
};

export type ChatStreamEvent =
  | { type: "chat-id"; chatId: string }
  | { type: "init"; sessionId: string | null; tools: string[]; model: string | null; permissionMode: string | null }
  | { type: "text"; text: string }
  | { type: "thinking"; text: string }
  | { type: "tool-start"; id: string; name: string; input: Record<string, unknown> }
  | { type: "tool-end"; id: string; result: string; isError: boolean }
  | { type: "rate-limit"; info: unknown }
  | { type: "result"; sessionId: string | null; costUsd: number | null; usage: Record<string, unknown> | null; isError: boolean }
  | { type: "error"; message: string }
  | ApprovalFrame
  | {
      type: "turn-complete";
      chatId: string;
      cliSessionId: string | null;
      costUsd: number | null;
      stopReason: "result" | "aborted" | "error" | "timeout";
      error: { message: string } | null;
    };

// The persisted shape of one chat-store event (src/chats/store.mjs's
// EVENT_SHAPES). Unlike the live 'tool-start' event above, `input` here is
// ALREADY the pre-stringified, redacted, truncated form — src/orchestrator/
// run.mjs::sanitizeToolInput() mirrors src/parser/parse.mjs::truncateEvent()
// exactly, so a persisted chat-turn tool event has the identical shape a
// reloaded/historical digest's ToolEvent already has.
export type ChatStoredEvent =
  | { kind: "user" | "assistant" | "thinking"; ts: string; text: string; msgId?: string | null }
  | { kind: "tool"; ts: string; name: string | null; input: string | null; result: string | null; msgId?: string | null; resultRef?: string | null }
  | Omit<ApprovalEvent, "kind"> & { kind: "approval" };

export type ChatSummary = {
  id: string;
  title: string | null;
  origin?: "user" | "trigger";
  triggerId?: string | null;
  silent?: boolean;
  createdAt: string | null;
  updatedAt: string | null;
  eventCount: number;
};

/**
 * Converts one ChatStoredEvent into the DigestEvent shape EventBlock.tsx
 * already knows how to render (see parse.mjs::digestSession, whose output
 * shape the chat store deliberately mirrors). A tool event's `input` is
 * already a string in both shapes now, so this is a straight field rename,
 * not a conversion — kept as its own function since ChatStoredEvent and
 * DigestEvent are still two distinct types (e.g. optional vs. nullable
 * msgId).
 *
 * An 'approval' event has no digest counterpart at all (it is a live-turn-only
 * concept), so it is passed through as its own DigestEvent variant — that is
 * what keeps a reloaded chat containing approvals from rendering as
 * "Unknown event type: approval".
 */
export function toDigestEvent(event: ChatStoredEvent): DigestEvent {
  if (event.kind === "tool") {
    return {
      kind: "tool",
      ts: event.ts,
      msgId: event.msgId ?? null,
      name: event.name,
      input: event.input,
      result: event.result,
      resultRef: event.resultRef ?? null,
    };
  }
  if (event.kind === "approval") {
    return { ...event, kind: "approval" };
  }
  return { kind: event.kind, ts: event.ts, msgId: event.msgId ?? null, text: event.text };
}

/**
 * Chat summaries. `triggerId` narrows the list to the runs of one trigger
 * (the trigger page's "runs" link); `includeSilent` is a SEPARATE opt-in —
 * a heartbeat's silent runs stay hidden unless asked for, even when filtering
 * by trigger (see server.mjs::handleChatList).
 */
export function fetchChatList(filter: { triggerId?: string; includeSilent?: boolean } = {}): Promise<ChatSummary[]> {
  const params = new URLSearchParams();
  if (filter.triggerId) params.set("triggerId", filter.triggerId);
  if (filter.includeSilent) params.set("includeSilent", "1");
  const qs = params.toString();
  return getJson<{ chats: ChatSummary[] }>(`/api/chat/list${qs ? `?${qs}` : ""}`).then((r) => r.chats);
}

export function fetchChat(chatId: string): Promise<{ chat: ChatSummary; events: ChatStoredEvent[] }> {
  return getJson<{ chat: ChatSummary; events: ChatStoredEvent[] }>(`/api/chat/${encodeURIComponent(chatId)}`);
}

export function cancelChatTurn(chatId: string): Promise<{ cancelled: boolean }> {
  return postJson<{ cancelled: boolean }>(`/api/chat/${encodeURIComponent(chatId)}/cancel`);
}

/** Thrown by streamChatTurn() when the response body ends without ever sending a 'turn-complete' frame (see its doc comment). */
export class IncompleteStreamError extends Error {
  constructor() {
    super("stream ended unexpectedly (no turn-complete frame received)");
    this.name = "IncompleteStreamError";
  }
}

/**
 * Parses one buffer's worth of already-received SSE bytes into complete
 * `data: <json>\n\n` frames, returning the parsed frames plus whatever
 * incomplete tail remains in the buffer. Pulled out of streamChatTurn() so
 * the framing/parsing logic itself (not the fetch/reader plumbing around it)
 * can be unit-tested directly.
 */
export function parseSseChunk(buffer: string): { frames: ChatStreamEvent[]; rest: string } {
  const frames: ChatStreamEvent[] = [];
  let idx;
  while ((idx = buffer.indexOf("\n\n")) !== -1) {
    const raw = buffer.slice(0, idx);
    buffer = buffer.slice(idx + 2);
    if (!raw.startsWith("data: ")) continue;
    try {
      frames.push(JSON.parse(raw.slice("data: ".length)) as ChatStreamEvent);
    } catch {
      // A malformed frame must not kill the rest of the stream — skip it.
    }
  }
  return { frames, rest: buffer };
}

/**
 * Streams one chat turn. Deliberately NOT EventSource: EventSource cannot
 * set the `x-app-request` header this server's CSRF hardening requires on
 * every non-GET request (see server.mjs's CSRF comment), so this does its
 * own `fetch` + `ReadableStream` + manual SSE-frame parsing instead — same
 * `data: <json>\n\n` framing, just read by hand.
 *
 * Resolves once the stream ends AND a 'turn-complete' frame was seen; a
 * response body that ends (server crash, proxy/network drop, ...) without
 * ever sending one throws IncompleteStreamError instead of resolving as if
 * the turn had finished normally — `onEvent` is the only way callers
 * observe individual frames.
 */
/**
 * Drains an already-open SSE response body, handing each parsed frame to
 * `onFrame`. Shared by streamChatTurn() and fireTrigger() — both routes speak
 * the identical `data: <json>\n\n` framing, they only differ in which final
 * frame type means "this stream is done".
 */
async function readSseBody<T>(res: Response, onFrame: (frame: T) => void): Promise<void> {
  if (!res.body) throw new Error("response has no body");
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const { frames, rest } = parseSseChunk(buffer);
    buffer = rest;
    for (const frame of frames) onFrame(frame as unknown as T);
  }
}

export async function streamChatTurn({
  chatId,
  text,
  onEvent,
  signal,
}: {
  chatId?: string;
  text: string;
  onEvent: (event: ChatStreamEvent) => void;
  signal?: AbortSignal;
}): Promise<void> {
  const res = await apiFetch("/api/chat/turn", {
    method: "POST",
    headers: { ...APP_HEADERS, "Content-Type": "application/json" },
    body: JSON.stringify(chatId ? { chatId, text } : { text }),
    signal,
  });
  if (!res.ok || !res.body) {
    await throwOnError(res);
    throw new Error(`Request failed (HTTP ${res.status})`);
  }

  let sawTurnComplete = false;
  await readSseBody<ChatStreamEvent>(res, (frame) => {
    if (frame.type === "turn-complete") sawTurnComplete = true;
    onEvent(frame);
  });
  if (!sawTurnComplete) {
    throw new IncompleteStreamError();
  }
}

// ---------------------------------------------------------------------------
// Approvals (POST /api/approvals/<id>)
// ---------------------------------------------------------------------------

/**
 * Answers one pending approval. Returns 'gone' for the three responses that
 * mean "nothing left to answer" — 404 (unknown, or the turn ended), 409
 * (already decided) and 410 (the question died with the process that asked
 * it, see the inbox below). None is an error worth a red box: the entry is
 * simply dropped from the stack (see lib/approvals.ts::removeApproval) or the
 * inbox list.
 */
export async function answerApproval(
  id: string,
  { chatId, behavior, message }: { chatId: string; behavior: "allow" | "deny"; message?: string },
): Promise<"ok" | "gone"> {
  const res = await apiFetch(`/api/approvals/${encodeURIComponent(id)}`, {
    method: "POST",
    headers: { ...APP_HEADERS, "Content-Type": "application/json" },
    body: JSON.stringify(message === undefined ? { chatId, behavior } : { chatId, behavior, message }),
  });
  if (res.status === 404 || res.status === 409 || res.status === 410) return "gone";
  await throwOnError(res);
  return "ok";
}

/**
 * One entry of the durable approval inbox (GET /api/approvals, see
 * src/server/approval-store.mjs). Same fields an SSE ApprovalFrame carries,
 * plus the two timestamps a list needs — an inbox entry is often hours old,
 * so "when was this asked" and "when does it lapse" are the columns that
 * matter, unlike the live dialog's own countdown.
 *
 * Only questions this server process is still waiting on are ever listed.
 * Entries left behind by a previous process are unanswerable and deliberately
 * not offered (answering one can only fail).
 */
export type InboxApproval = ApprovalFrame & {
  requestedAt: number;
  deadlineAt: number | null;
};

export function fetchApprovalInbox(): Promise<{ approvals: InboxApproval[] }> {
  return getJson<{ approvals: InboxApproval[] }>("/api/approvals");
}

// ---------------------------------------------------------------------------
// Apps (src/apps/loader.mjs via GET /api/apps)
// ---------------------------------------------------------------------------

/** What an app is allowed to do (src/apps/manifest.mjs's policy block). */
export type AppPolicy = {
  fsWrite: boolean;
  dataEgress: boolean;
  externalAction: "never" | "approval" | "auto";
  sensitivity: "low" | "medium" | "high";
};

/** Display metadata only — the route deliberately exposes no handler paths, tool schemas or instructions. */
export type AppSummary = {
  id: string;
  name: string;
  description: string;
  icon: string | null;
  version: string;
  toolCount: number;
  policy: AppPolicy;
  uiSlot: "none" | "text" | "gallery";
  source: "bundled" | "user";
};

/** A manifest that failed to load. Carries the reason, never the path it was found at. */
export type AppLoadError = { message: string };

/** A third-party app that exists on disk but is not loaded (see loader.mjs::userAppsAllowed). Directory name only. */
export type BlockedApp = { id: string };

export type AppsResponse = { apps: AppSummary[]; blocked: BlockedApp[]; errors: AppLoadError[] };

export function fetchApps(): Promise<AppsResponse> {
  return getJson<AppsResponse>("/api/apps");
}

// ---------------------------------------------------------------------------
// Triggers (src/triggers/* via /api/triggers)
// ---------------------------------------------------------------------------

export type TriggerType = "heartbeat" | "schedule" | "file-watch" | "clipboard" | "saved-prompt";
export type Escalation = "notify" | "question" | "review";

export const TRIGGER_TYPES: TriggerType[] = ["heartbeat", "schedule", "file-watch", "clipboard", "saved-prompt"];
export const ESCALATIONS: Escalation[] = ["notify", "question", "review"];
export const FILE_WATCH_EVENTS = ["add", "change", "unlink"] as const;

/** Union of every type's config fields (see src/triggers/registry.mjs's per-type validators). */
export type TriggerConfig = {
  intervalMinutes?: number;
  checklistPath?: string;
  everyMinutes?: number;
  dailyAt?: string;
  path?: string;
  events?: string[];
  debounceMs?: number;
  maxDepth?: number;
  pollMs?: number;
  matchPattern?: string;
};

export type Trigger = {
  id: string;
  type: TriggerType;
  config: TriggerConfig;
  promptTemplate: string;
  escalation: Escalation;
  appScope: string[];
  enabled: boolean;
  approvalRequired: boolean;
  limits: { maxRunsPerDay: number; maxCostPerDay: number };
};

/**
 * A trigger as GET /api/triggers returns it: the stored trigger plus today's
 * usage and the two "can this actually work" verdicts the server computes
 * (see server.mjs::handleTriggersList).
 */
export type TriggerStatus = Trigger & {
  runsToday: number;
  costToday: number;
  /**
   * Who answers this trigger's tool-use questions: 'policy' (kaprek's own
   * code, no human), 'ui' (a live connection has to be open — the pre-inbox
   * path, still what a runner without a store reports), or 'inbox' (recorded
   * durably and answerable later, see src/server/approval-store.mjs).
   */
  approvalPath: "policy" | "ui" | "inbox";
  blocked: string | null;
  supported: boolean;
  unsupportedReason: string | null;
};

/** Thrown on POST /api/triggers 400 — carries the offending field so the form can show the message at it. */
export class TriggerValidationError extends Error {
  field: string | null;
  constructor(message: string, field: string | null) {
    super(message);
    this.name = "TriggerValidationError";
    this.field = field;
  }
}

/** Thrown by fireTrigger() on 429 — some trigger-origin turn is already in flight (see server.mjs's loop guard). */
export class TriggerBusyError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = "TriggerBusyError";
  }
}

export function fetchTriggers(): Promise<TriggerStatus[]> {
  return getJson<{ triggers: TriggerStatus[] }>("/api/triggers").then((r) => r.triggers);
}

/** Creates or replaces a trigger by id. A 400 becomes TriggerValidationError, never a generic message. */
export async function upsertTrigger(trigger: unknown): Promise<Trigger> {
  const res = await apiFetch("/api/triggers", {
    method: "POST",
    headers: { ...APP_HEADERS, "Content-Type": "application/json" },
    body: JSON.stringify(trigger),
  });
  if (res.status === 400) {
    const body = await res.json().catch(() => ({}) as Record<string, unknown>);
    const message = typeof body.error === "string" ? body.error : "invalid trigger";
    throw new TriggerValidationError(message, typeof body.field === "string" ? body.field : null);
  }
  await throwOnError(res);
  return res.json() as Promise<Trigger>;
}

export function toggleTrigger(id: string, enabled: boolean): Promise<Trigger> {
  return postJson<Trigger>(`/api/triggers/${encodeURIComponent(id)}/toggle`, { enabled });
}

export function deleteTrigger(id: string): Promise<{ removed: boolean }> {
  return writeJson<{ removed: boolean }>(`/api/triggers/${encodeURIComponent(id)}`, "DELETE");
}

/** The final frame of a manual fire (see server.mjs::handleTriggerFire). */
export type TriggerCompleteFrame = {
  type: "trigger-complete";
  fired: boolean;
  reason?: string;
  chatId?: string;
  silent?: boolean;
};

export type TriggerStreamEvent = ChatStreamEvent | TriggerCompleteFrame;

/**
 * Fires a trigger by hand. Same SSE shape a chat turn streams (a 'chat-id'
 * bootstrap frame, the turn's events, then one 'trigger-complete'), so the
 * chat view can render a manual fire live — including its approval questions.
 * Resolves with the final frame; throws TriggerBusyError on 429.
 */
export async function fireTrigger(
  id: string,
  { onEvent, signal }: { onEvent?: (event: TriggerStreamEvent) => void; signal?: AbortSignal } = {},
): Promise<TriggerCompleteFrame | null> {
  const res = await apiFetch(`/api/triggers/${encodeURIComponent(id)}/fire`, {
    method: "POST",
    headers: APP_HEADERS,
    signal,
  });
  if (res.status === 429) {
    const body = await res.json().catch(() => ({}) as Record<string, unknown>);
    throw new TriggerBusyError(typeof body.reason === "string" ? body.reason : "trigger turn in progress");
  }
  if (!res.ok || !res.body) {
    await throwOnError(res);
    throw new Error(`Request failed (HTTP ${res.status})`);
  }

  let last: TriggerCompleteFrame | null = null;
  await readSseBody<TriggerStreamEvent>(res, (frame) => {
    if (frame.type === "trigger-complete") last = frame;
    onEvent?.(frame);
  });
  return last;
}
