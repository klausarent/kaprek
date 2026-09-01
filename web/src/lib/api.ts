// Thin fetch wrappers around kaprek's local HTTP API (src/server/server.mjs).
// The UI is served by that same server, so all requests are same-origin
// relative paths — no base URL, no CORS handling needed.
import { setStatus } from "./status";

export type ProjectSummary = {
  projectSlug: string;
  sessionCount: number;
  /** The cwd the project's sessions recorded — the readable form of the slug; null when no session carries one. */
  displayName?: string | null;
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

/**
 * One step of an agent-to-agent handoff (see src/relay/dispatcher.mjs). The
 * body of a message lives in a file under the run's artifact directory, so
 * this carries a preview and a reference rather than the text itself: a relay
 * payload can be dozens of drafts.
 */
export type RelayEvent = {
  kind: "relay";
  ts: string;
  eventType:
    | "run.created"
    | "dispatch.started"
    | "message"
    | "dispatch.failed"
    | "dispatch.retry"
    | "notice"
    | "gate.requested"
    | "gate.resolved"
    | "run.completed"
    | "run.stopped"
    | "run.interrupted";
  runId: string;
  from?: string | null;
  to?: string | null;
  round?: number | null;
  turn?: number | null;
  textPreview?: string | null;
  bodyRef?: string | null;
  bodySha256?: string | null;
  driver?: string | null;
  costUsd?: number | null;
  /** Always true for a peer turn: a subscription CLI's per-turn figure is derived from list prices nobody pays. */
  costEstimated?: boolean | null;
  status?: string | null;
  reason?: string | null;
  goal?: string | null;
  route?: string[] | null;
  recipeId?: string | null;
  /** Retry bookkeeping: which attempt, and how long it waited first. */
  attempt?: number | null;
  delayMs?: number | null;
};

/** The relay run a chat is hosting, if any. */
export type RelayRun = {
  runId: string;
  status: "active" | "waiting_gate" | "interrupted" | "completed" | "stopped";
  route: string[];
  goal: string;
  maxRounds: number;
  hardMaxTurns: number;
  rounds: number;
  turns: number;
  artifactDir?: string;
  /** Which recipe this run is walking, and where in it. */
  recipeId?: string;
  stepId?: string;
  /** Which kind of gate it is parked at, when it is parked. */
  gateReason?: "rounds" | "edge" | "peer" | null;
};

export type DigestEvent = ToolEvent | TextEvent | SubagentEvent | CompactEvent | ApprovalEvent | RelayEvent;

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
// Leitstand (GET /api/leitstand — the one read-only aggregation behind #/start)
// ---------------------------------------------------------------------------

/** One currently running turn. `abortable` is the server's own word on whether POST /api/chat/<id>/cancel can reach it — a trigger turn reports false, and the UI shows a link instead of a button that could not keep its promise. */
export type LeitstandRunning = {
  chatId: string;
  title: string | null;
  engine: string | null;
  origin: string | null;
  triggerId: string | null;
  missionId: string | null;
  abortable: boolean;
};

/** One open approval, as the leitstand narrows it for a list row. Answered through the SAME POST /api/approvals/<id> the inbox uses. */
export type LeitstandPending = {
  id: string;
  chatId: string;
  toolName: string | null;
  displayName: string | null;
  inputPreview: string | null;
  source: ApprovalSource | null;
  requestedAt: number;
  deadlineAt: number | null;
  /** Against deadlineAt; null when the record carries no deadline. */
  remainingMs: number | null;
  mode?: "interactive" | "deferred";
  kind?: string | null;
  triggerId?: string | null;
  askedCount?: number;
};

/** Run counters for one window. Sums cover only KNOWN values; the `*Unknown` counters say how many runs reported nothing — the UI renders "$1.12 + 1 unknown", never 0 for unknown. */
export type LeitstandCounts = {
  ran: number;
  skippedCondition: number;
  skippedConditionError: number;
  failed: number;
  costUsd: number;
  costKnown: number;
  costUnknown: number;
  tokens: number;
  tokensKnown: number;
  tokensUnknown: number;
};

/** One mission (or trigger without a mission) bucket of the overnight window. Runs attributable to neither appear only in totals. */
export type LeitstandGroup = LeitstandCounts & {
  missionId: string | null;
  triggerId: string | null;
  title: string | null;
};

/** The last few finished approvals, exactly as the approval store's history keeps them. */
export type LeitstandHistory = {
  id: string;
  chatId: string;
  toolName: string | null;
  displayName: string | null;
  inputPreview: string | null;
  source: ApprovalSource | null;
  requestedAt: number;
  status: "decided" | "lapsed" | "cancelled" | "expired";
  decision: { behavior: "allow" | "deny"; message?: string } | null;
  decidedAt: number | null;
  decidedVia: "web" | "phone-token" | "auto-deny" | null;
  waitMs: number | null;
};

/** One active standing grant, list-row shape. */
export type LeitstandGrant = {
  id: string;
  toolName: string | null;
  scope: string;
  match: "exact" | "shape";
  useCount: number;
  lastUsedAt: string | null;
};

export type LeitstandResponse = {
  /** The window's lower bound (epoch ms) — local midnight, or the ?since= the caller sent. */
  since: number;
  running: LeitstandRunning[];
  pending: LeitstandPending[];
  overnight: { totals: LeitstandCounts; byMission: LeitstandGroup[] };
  attention: {
    degradedTriggers: { id: string; type: string; degraded: boolean; conditionErrorStreak: number; condition: { kind: string; path: string } | null }[];
    staleGrants: { id: string; toolName: string | null; scope: string; match: "exact" | "shape" }[];
    grantsActive: number;
    /** Present only when the search index was written by a newer kaprek — absent means nothing to report, never a guess. */
    searchReadOnly?: { reason: string };
  };
  history: LeitstandHistory[];
  grants: LeitstandGrant[];
};

/** One fetch for the whole Start page. Read-only; the page refreshes it after its own actions instead of polling. */
export function fetchLeitstand(): Promise<LeitstandResponse> {
  return getJson<LeitstandResponse>("/api/leitstand");
}

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

const TOKEN_STORAGE_KEY = "kaprek-token";

/**
 * The token a QR code put in the URL.
 *
 * Only used when the page arrived WITHOUT a meta tag, which is what happens
 * over --lan: the server hands the token to loopback requests only, so a
 * phone has to bring its own. It is stored per tab and stripped from the
 * address bar immediately — a token sitting in a URL ends up in history, in
 * a screenshot, and in whatever the next person to pick up the phone sees.
 */
function readTokenFromUrl(): string | null {
  if (typeof window === "undefined") return null;
  try {
    const stored = window.sessionStorage.getItem(TOKEN_STORAGE_KEY);
    if (stored) return stored;
  } catch {
    // Storage blocked: fall through to the URL, which still works for this
    // page load.
  }

  // The token rides in the hash, after the route: #/approvals?t=...
  const hash = window.location.hash ?? "";
  const query = hash.includes("?") ? hash.slice(hash.indexOf("?") + 1) : "";
  const token = new URLSearchParams(query).get("t");
  if (!token) return null;

  try {
    window.sessionStorage.setItem(TOKEN_STORAGE_KEY, token);
  } catch {
    // Nothing to do — the token still works for this page load.
  }
  window.location.hash = hash.slice(0, hash.indexOf("?"));
  return token;
}

// Read once, at module load: the token never changes for the lifetime of a
// served page, and re-querying the DOM per request would only invite a
// mid-session read of a token some other script had replaced.
const instanceToken = readTokenMeta() ?? readTokenFromUrl();

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
export async function apiFetch(url: string, init: RequestInit = {}): Promise<Response> {
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
export const APP_HEADERS = { "x-app-request": "1" } as const;

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
  /** Whether the files this session named are still there — checked against the disk at search time; null when it named none. */
  files: SearchVerdict | null;
};

export type SearchVerdict = {
  mentioned: number;
  checked: number;
  present: number;
  changed: number;
  gone: number;
  sample: { path: string; verdict: "present" | "changed" | "gone" }[];
};

export type SearchResponse =
  | { available: true; results: SearchHit[] }
  | { available: false; reason: string; /** true when the index was written by a newer kaprek — shown with its own explanation */ future?: boolean };

export type ReindexResponse =
  | { available: true; indexed: number; skipped: number }
  | { available: false; reason: string; future?: boolean };

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

// Missions (src/missions/store.mjs via /api/missions/*)

export type MissionStatus = "active" | "waiting" | "done" | "archived";

export type Mission = {
  id: string;
  title: string;
  goal: string | null;
  /** Absolute project directory this mission's turns run in; null means the workspace default. */
  cwd: string | null;
  preset: string | null;
  /** The mission's own posture ceiling; null = the global one from policy.json. In effect only ever stricter than global. */
  posture: Posture | null;
  status: MissionStatus;
  createdAt: string;
  updatedAt: string;
  chats: string[];
  tasks: string[];
  /** Only present on the list route: how many inbox questions wait on this mission's chats. */
  pendingApprovals?: number;
};

export type Preset = {
  id: string;
  title: string;
  description: string;
  goalTemplate: string;
  firstPrompt: string;
  builtin: boolean;
};

export type MissionDetail = {
  mission: Mission;
  chats: ChatSummary[];
  tasks: Task[];
  pendingApprovals: InboxApproval[];
};

/** The posture ceiling vocabulary — the same words as the chat picker's approval stance. */
export type Posture = "ask" | "edits" | "auto";
export const POSTURES: Posture[] = ["ask", "edits", "auto"];

/** Sets (or clears, with null) a mission's own posture ceiling. */
export function setMissionPosture(id: string, posture: Posture | null): Promise<Mission> {
  return postJson<{ mission: Mission }>(`/api/missions/${encodeURIComponent(id)}/posture`, { posture }).then((r) => r.mission);
}

export function fetchMissions(): Promise<Mission[]> {
  return getJson<{ missions: Mission[] }>("/api/missions").then((r) => r.missions);
}

export function createMission(input: { title: string; goal?: string; cwd?: string; preset?: string }): Promise<Mission> {
  return postJson<{ mission: Mission }>("/api/missions", input).then((r) => r.mission);
}

export function fetchMission(id: string): Promise<MissionDetail> {
  return getJson<MissionDetail>(`/api/missions/${encodeURIComponent(id)}`);
}

/** One entry of the mission-memory view (P4a). Scope-shaped, not store-shaped. */
export type MissionMemoryEntry = {
  id: string;
  scope: string;
  scopeKind: string;
  kind: string;
  text: string;
  origin: string;
  confidence: number;
  firstSeenAt: string;
  lastVerifiedAt: string;
  stale: boolean;
  ageMs: number;
  confirmations: number;
  origins: string[];
};

/** GET /api/missions/<id>/memory — everything this mission can read, in one view. */
export type MissionMemory = {
  missionId: string;
  scopeId: string;
  visibleScopes: string[];
  counts: Record<string, number>;
  entries: MissionMemoryEntry[];
  /** The five most recently written entries, newest first. */
  recent: MissionMemoryEntry[];
  /** P0.5: a newer kaprek wrote here — display only, no writes offered. */
  readOnly: boolean;
};

export function fetchMissionMemory(id: string): Promise<MissionMemory> {
  return getJson<MissionMemory>(`/api/missions/${encodeURIComponent(id)}/memory`);
}

/** One stored digest file of a mission (P8), as the list route reports it. */
export type MissionDigestFile = {
  name: string;
  path: string;
  bytes: number;
};

/**
 * GET /api/missions/<id>/digest?since=&until= — builds (and stores) the
 * morning digest for a window and serves it as text/markdown. Since/until
 * are epoch-ms or ISO strings; omitted means yesterday's local day.
 */
export async function fetchMissionDigest(id: string, since?: string, until?: string): Promise<string> {
  const params = new URLSearchParams();
  if (since !== undefined) params.set("since", since);
  if (until !== undefined) params.set("until", until);
  const qs = params.toString();
  const res = await apiFetch(`/api/missions/${encodeURIComponent(id)}/digest${qs ? `?${qs}` : ""}`);
  await throwOnError(res);
  return res.text();
}

/** GET /api/missions/<id>/digests — the digest files already on disk, newest first. */
export function fetchMissionDigests(id: string): Promise<{ digests: MissionDigestFile[] }> {
  return getJson<{ digests: MissionDigestFile[] }>(`/api/missions/${encodeURIComponent(id)}/digests`);
}

export function setMissionStatus(id: string, status: MissionStatus): Promise<Mission> {
  return postJson<{ mission: Mission }>(`/api/missions/${encodeURIComponent(id)}/status`, { status }).then((r) => r.mission);
}

export function linkMissionTask(id: string, taskId: string): Promise<Mission> {
  return postJson<{ mission: Mission }>(`/api/missions/${encodeURIComponent(id)}/link`, { taskId }).then((r) => r.mission);
}

export function fetchPresets(): Promise<Preset[]> {
  return getJson<{ presets: Preset[] }>("/api/presets").then((r) => r.presets);
}

/** One engine's capability declaration (see src/harness/registry.mjs). */
export type Engine = {
  id: string;
  displayName: string;
  supportsCostUsd: boolean;
  supportsUpdatedInput: boolean;
  supportsAllowedTools: boolean;
  supportsMcpConfig: boolean;
  supportsSettingsPath: boolean;
};

/** A request someone has typed often enough that a trigger would serve them better. */
export type RepeatSuggestion = {
  key: string;
  count: number;
  sample: string;
  lastTs: string | null;
};

export function fetchRepeats(): Promise<RepeatSuggestion[]> {
  return getJson<{ repeats: RepeatSuggestion[] }>("/api/repeats").then((r) => r.repeats);
}

/** The latest subscription-window signal per harness, as read back from runs.jsonl. */
export type UsageEntry = {
  harness: string;
  seenAt: string | null;
  chatId: string | null;
  summary: { usedPercent: number | null; resetsAt: string | null; window: string | null; status: string | null; plan: string | null };
  info: unknown;
};

export function fetchUsage(): Promise<UsageEntry[]> {
  return getJson<{ usage: UsageEntry[] }>("/api/usage").then((r) => r.usage);
}

export function fetchEngines(): Promise<Engine[]> {
  return getJson<{ engines: Engine[] }>("/api/engines").then((r) => r.engines);
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
  /** Present on a deferred frame: the question was filed, not waited on (see server.mjs's DEFERRAL_MESSAGE). */
  mode?: "interactive" | "deferred";
  askedCount?: number;
  requestedAt?: number;
  inputPreview?: string | null;
  triggerId?: string | null;
  /**
   * Present when a standing grant covers this tool form but did NOT act
   * (P6a): 'stale' (authorities changed — the grant sleeps) or
   * 'reactivation' (the ceiling loosened — this question confirms or
   * discards the grant). The dialog shows the why, because "why is it
   * asking again?" is exactly what a person will wonder.
   */
  standingGrant?: { id: string; state: "stale" | "reactivation"; why: string | null } | null;
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
  /**
   * A consultation started beside this turn. Only the id travels on the
   * stream — the consultation itself takes minutes and outlives the turn, so
   * the result is fetched, not streamed.
   */
  | { type: "council-started"; chatId: string; consultationId: string; peers: string[] }
  | {
      type: "turn-complete";
      chatId: string;
      cliSessionId: string | null;
      costUsd: number | null;
      stopReason: "result" | "aborted" | "error" | "timeout";
      error: { message: string } | null;
      guided?: GuidedResult | null;
    };

/** A guided mode for one turn: quiz cards, the plan file, or the check of the work against it. */
export type PlanMode = "brainstorm" | "plan" | "converge";

export type QuizQuestion = {
  id: string;
  header: string;
  question: string;
  options: { label: string; description?: string }[];
  multiSelect: boolean;
  allowOther: boolean;
};

export type Quiz = { questions: QuizQuestion[]; done: boolean };

/** One answered question, keyed by question id in the answer map. */
export type QuizAnswer = { selected?: string[]; other?: string };

export type PlanSummary = {
  id: string;
  path: string;
  title: string;
  kind: "spec" | "plan";
  status: "draft" | "active" | "done" | "archived";
  chatId: string | null;
  missionId: string | null;
  createdAt: string;
  updatedAt: string;
  exists: boolean;
  /** The last convergence check, or null when none has run. */
  converge: PlanConverge | null;
  /** Set when 'done' was reached past the gate, by a person, on record. */
  override: { by: string; at: string } | null;
  /** When kaprek last saw the file's content (a registration, a tick, a converge round); null before any. */
  seenAt: string | null;
  /** Whether the file differs from what kaprek last saw — edited outside kaprek. null when nothing was seen yet or the file is gone. */
  changedOutside: boolean | null;
};

export type PlanConverge = { round: number; chatId: string | null; findings: number; converged: boolean; at: string };

export type PlanStep = { index: number; line: number; text: string; done: boolean };

export type PlanDetail = PlanSummary & { content: string; steps: PlanStep[]; truncated: boolean };

/** One gap a convergence check found between the plan and the work. */
export type Finding = {
  id: string;
  sourceRef: string;
  gapType: "missing" | "partial" | "contradicts" | "unrequested";
  severity: "critical" | "high" | "medium" | "low";
  evidence: string;
  remainingWork: string;
};

export type Findings = { converged: boolean; findings: Finding[]; checked: { requirements: number | null; files: number | null } };

/**
 * What a guided turn produced. `protocolBroken` is the honest signal that
 * the agent ignored the mode — no quiz, no file. The UI says so rather than
 * leaving a guided turn indistinguishable from an ordinary one.
 */
export type GuidedResult = {
  mode: PlanMode;
  planPath: string | null;
  quiz: Quiz | null;
  plan: PlanSummary | null;
  planError: string | null;
  /** Only on a converge turn: what the check found (null = the agent answered in prose). */
  findings?: Findings | null;
  protocolBroken: boolean;
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
  origin?: "user" | "trigger" | "relay";
  triggerId?: string | null;
  silent?: boolean;
  /** The mission this chat belongs to, if any (see src/missions/store.mjs). */
  missionId?: string | null;
  /** Which harness runs this chat's turns (a registry id, e.g. 'claude-code', 'codex'). */
  engine?: string;
  /** The relay run this chat hosts, if any (see src/relay/dispatcher.mjs). */
  relay?: RelayRun | null;
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

export function fetchChat(chatId: string): Promise<{ chat: ChatSummary; events: ChatStoredEvent[]; openQuiz?: Quiz }> {
  // openQuiz is present when the last thing the agent said was a question
  // nobody has answered yet — so reloading the page does not lose it.
  return getJson<{ chat: ChatSummary; events: ChatStoredEvent[]; openQuiz?: Quiz }>(`/api/chat/${encodeURIComponent(chatId)}`);
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

/** The approval stance for one turn — mirrors the CLI's permission modes. */
export type ApprovalMode = "ask" | "edits" | "auto";

/** Reasoning effort both CLIs accept. */
export type Effort = "low" | "medium" | "high" | "xhigh" | "max";
export const EFFORT_LEVELS: Effort[] = ["low", "medium", "high", "xhigh", "max"];

export async function streamChatTurn({
  chatId,
  missionId,
  engine,
  approvalMode,
  effort,
  mode,
  planId,
  text,
  onEvent,
  signal,
}: {
  chatId?: string;
  /** Creates the new chat inside this mission (ignored when chatId is given —
   * a follow-up turn takes its mission from the chat itself, server-side). */
  missionId?: string;
  /** Which engine runs the new chat (ignored when chatId is given — the
   * engine is fixed at chat creation, server-side). */
  engine?: string;
  /** Per-turn approval stance; omitted means 'ask'. */
  approvalMode?: ApprovalMode;
  /** Per-turn reasoning effort; omitted leaves the CLI's own default. */
  effort?: Effort;
  /** Guided mode for this turn; omitted runs an ordinary turn. */
  mode?: PlanMode;
  /** The plan a guided turn is about — a converge turn started from the plans page names the one that was clicked. */
  planId?: string;
  text: string;
  onEvent: (event: ChatStreamEvent) => void;
  signal?: AbortSignal;
}): Promise<void> {
  const res = await apiFetch("/api/chat/turn", {
    method: "POST",
    headers: { ...APP_HEADERS, "Content-Type": "application/json" },
    body: JSON.stringify({
      ...(chatId ? { chatId } : { ...(missionId ? { missionId } : {}), ...(engine ? { engine } : {}) }),
      ...(approvalMode ? { approvalMode } : {}),
      ...(effort ? { effort } : {}),
      ...(mode ? { mode } : {}),
      ...(planId ? { planId } : {}),
      text,
    }),
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
  /** A one-line form of `input`, so a list never has to load a megabyte of tool arguments (see approval-store.mjs::inputPreview). */
  inputPreview?: string | null;
  /** 'deferred' questions were filed by an unattended turn and outlive it; 'interactive' ones belong to a live dialog. */
  mode?: "interactive" | "deferred";
  /** How often the trigger has asked this same question (see the store's dedupe). */
  askedCount?: number;
  /** 'relay.gate' for a relay's "one more round?" question; absent for an ordinary tool-use approval. */
  kind?: string | null;
  triggerId?: string | null;
};

export function fetchApprovalInbox(): Promise<{ approvals: InboxApproval[] }> {
  return getJson<{ approvals: InboxApproval[] }>("/api/approvals");
}

/**
 * One finished entry of the approval history (GET /api/approvals?status=all,
 * P1): the inbox shape plus what the record knows about its END. Fields an
 * older record never had (runId, cancelledAt, decidedVia) are absent or null
 * — the UI renders "—", never an invented value.
 */
export type HistoryApproval = InboxApproval & {
  status: "decided" | "lapsed" | "cancelled" | "expired";
  /** The decision itself; null for everything that ended without one. */
  decision: { behavior: "allow" | "deny"; message?: string } | null;
  decidedAt: number | null;
  /** WHO answered: the browser, the phone token, or the server's own deadline. */
  decidedVia: "web" | "phone-token" | "auto-deny" | null;
  runId?: string;
  lapsedAt: number | null;
  expiredAt: number | null;
  expired: string | null;
  cancelledAt: number | null;
  cancelledReason: "run-aborted" | "run-failed" | "trigger-deleted" | "mission-archived" | "shutdown" | null;
  /** requestedAt -> the end that actually happened. */
  waitMs: number | null;
};

/** Query for the history: which entries, how many, since when (epoch ms). */
export function fetchApprovalHistory(
  query: { limit?: number; since?: number } = {},
): Promise<{ approvals: HistoryApproval[] }> {
  const params = new URLSearchParams({ status: "all" });
  if (query.limit !== undefined) params.set("limit", String(query.limit));
  if (query.since !== undefined) params.set("since", String(query.since));
  return getJson<{ approvals: HistoryApproval[] }>(`/api/approvals?${params.toString()}`);
}

// ---------------------------------------------------------------------------
// Standing grants (P6a — GET/POST/DELETE /api/grants, see src/policy/grants.mjs)
// ---------------------------------------------------------------------------

/**
 * One standing grant: "always for this exact form", as the person confirmed
 * it. A grant has NO expiry by design — it ends when it is revoked (an
 * event; the record stays readable) or superseded, and its authority is
 * checked against the current posture ceiling and hard denials at every
 * potential use. Timestamps are ISO strings from the server's event log.
 */
export type StandingGrant = {
  id: string;
  /** `mission:<id>` — the only mintable scope in this phase. */
  scope: string;
  toolName: string | null;
  /** 'exact' (P6a: one hashed call) or 'shape' (P6b: a derived pattern). */
  match: "exact" | "shape";
  /** P6b, shape only: the derived pattern (command head, or a directory prefix under the mission cwd). */
  pattern?: {
    v: number;
    toolName: string;
    type: "command-head" | "path-prefix";
    keys: string[];
    head?: string;
    prefix?: string;
  } | null;
  /** P6b, shape only: which version of the derivation rule produced the pattern. */
  derivationVersion?: number | null;
  /** P6b: set when a loosened ceiling owes this grant its one reactivation question. */
  reconfirmPending?: boolean;
  postureAtGrant: string;
  confirmedPosture?: string;
  hardDenialsHash: string;
  missionId: string | null;
  createdAt: string;
  createdFromApprovalId: string | null;
  useCount: number;
  lastUsedAt: string | null;
  revokedAt: string | null;
  revokedReason: string | null;
  supersededBy: string | null;
};

export function fetchGrants(): Promise<{ grants: StandingGrant[]; activeCount: number }> {
  return getJson<{ grants: StandingGrant[]; activeCount: number }>("/api/grants");
}

/**
 * Mints a grant from a just-answered question. Takes ONLY the approval id
 * and the one-consumable nonce the answer returned — there is no scope or
 * match parameter to send, because both are the server's decision (narrowest
 * scope = the chat's own mission; match = 'exact' in this phase).
 */
export function mintGrant(approvalId: string, nonce: string): Promise<{ ok: boolean; grant: StandingGrant }> {
  return postJson<{ ok: boolean; grant: StandingGrant }>("/api/grants", { approvalId, nonce });
}

/** P6b — the server-side preview of a shape grant: the rendered pattern sentence plus CONCRETE example inputs (labelled hit/miss). The dialog must render these before a shape grant can be saved; the server refuses the unconfirmed mint. */
export type ShapeGrantPreview = {
  match: "shape";
  toolName: string | null;
  pattern: StandingGrant["pattern"];
  sentence: string;
  examples: { input: Record<string, unknown>; matches: boolean }[];
  fingerprint: { posture: string; hardDenialsHash: string; missionId: string | null; derivationVersion: number };
};

/**
 * P6b — asks the server what a shape grant for this question WOULD allow:
 * the pattern sentence and the mandatory examples. Peeks only — the nonce
 * stays live for the confirming mint. A 409 'not-derivable' means the input
 * cannot be safely generalised (only the error carries; nothing is stored).
 */
export function previewShapeGrant(approvalId: string, nonce: string): Promise<{ ok: boolean; preview: ShapeGrantPreview }> {
  return postJson<{ ok: boolean; preview: ShapeGrantPreview }>("/api/grants", { approvalId, nonce, match: "shape", preview: true });
}

/**
 * P6b — saves the shape grant. The confirm field is the client's statement
 * that the preview (sentence + examples) was rendered and confirmed; the
 * server refuses the mint without it (409 'examples-not-shown').
 */
export function mintShapeGrant(approvalId: string, nonce: string): Promise<{ ok: boolean; grant: StandingGrant }> {
  return postJson<{ ok: boolean; grant: StandingGrant }>("/api/grants", { approvalId, nonce, match: "shape", confirm: true });
}

/** Revokes a grant. Revocation is an event: the record stays in the list, marked. */
export async function revokeGrant(id: string): Promise<void> {
  const res = await apiFetch(`/api/grants/${encodeURIComponent(id)}`, { method: "DELETE", headers: APP_HEADERS });
  await throwOnError(res);
}

/**
 * Answers an approval with the "always for this form" intent: allow + grant.
 * The response carries `grantNonce` — the one-time secret POST /api/grants
 * needs. A 404/409/410 is the same "nothing left to answer" as
 * answerApproval(); a 200 with a null nonce means the answer landed but the
 * question could not seed a grant (e.g. its input was too large to hash) —
 * the allow still happened either way.
 */
export async function answerApprovalWithGrant(
  id: string,
  { chatId, grantMatch = "exact" }: { chatId: string; grantMatch?: "exact" | "shape" },
): Promise<{ outcome: "ok" | "gone"; nonce: string | null }> {
  const res = await apiFetch(`/api/approvals/${encodeURIComponent(id)}`, {
    method: "POST",
    headers: { ...APP_HEADERS, "Content-Type": "application/json" },
    body: JSON.stringify({ chatId, behavior: "allow", grant: true, grantMatch }),
  });
  if (res.status === 404 || res.status === 409 || res.status === 410) return { outcome: "gone", nonce: null };
  await throwOnError(res);
  const data = (await res.json()) as { grantNonce?: string | null };
  return { outcome: "ok", nonce: data?.grantNonce ?? null };
}

// ---------------------------------------------------------------------------
// Relay (src/relay/dispatcher.mjs via /api/chat/<id>/relay and /api/relay/*)
// ---------------------------------------------------------------------------

/** Starts a handoff run on a chat. The route is fixed in v1; the goal is the operator's one input. */
/** A recipe: who takes part in a relay run, in what order, under what budget. */
export type Recipe = {
  id: string;
  title: string;
  description: string;
  steps: { id: string; agent: string; tools: "none" | "full" }[];
  edges: { from: string; to: string; requiresHuman: boolean }[];
  budgets: { maxRounds: number; hardMaxTurns: number; retriesPerDispatch: number };
  escalation: { onPeerFailure: string; onBudget: string };
  builtin: boolean;
};

export async function fetchRecipes(): Promise<Recipe[]> {
  const res = await apiFetch("/api/recipes");
  await throwOnError(res);
  return (await res.json()).recipes as Recipe[];
}

export function startRelayRun(chatId: string, goal: string, options: { maxRounds?: number; recipeId?: string } = {}): Promise<{ runId: string; status: string; route: string[]; recipeId?: string }> {
  return postJson(`/api/chat/${encodeURIComponent(chatId)}/relay`, {
    goal,
    ...(options.maxRounds === undefined ? {} : { maxRounds: options.maxRounds }),
    ...(options.recipeId ? { recipeId: options.recipeId } : {}),
  });
}

export function stopRelayRun(runId: string): Promise<{ ok: true }> {
  return postJson(`/api/relay/${encodeURIComponent(runId)}/stop`);
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

/** The skip-if precondition kinds a schedule/heartbeat trigger may carry (see src/triggers/condition.mjs). */
export type ConditionKind = "file-exists" | "file-newer-than-last-run";

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
  /** Optional precondition (P7); the stored path is absolute (resolved at save time). */
  condition?: { kind: ConditionKind; path: string };
  /** What happens when the condition cannot be judged at all; default 'skip'. */
  onConditionError?: "skip" | "run";
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
  /** P7: the trigger's condition has failed to JUDGE often enough in a row (see runner.mjs::conditionStatus). */
  degraded?: boolean;
  conditionErrorStreak?: number;
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

/** One line of a trigger's run history (GET /api/triggers/<id>/runs), as runs.jsonl stores it (see src/orchestrator/runs.mjs). */
export type TriggerRun = {
  ts: string;
  skipped: "condition" | "condition-error" | null;
  conditionKind: string | null;
  conditionError: string | null;
  costUsd: number | null;
  stopReason: string | null;
};

/** The last few runs of one trigger, newest last — including the P7 skip lines. */
export function fetchTriggerRuns(id: string): Promise<TriggerRun[]> {
  return getJson<{ runs: TriggerRun[] }>(`/api/triggers/${encodeURIComponent(id)}/runs`).then((r) => r.runs);
}

/** The answer of the form's "check the condition once before saving" probe (POST /api/triggers/probe-condition). */
export type ConditionProbeResult = {
  met: boolean;
  error: string | null;
  resolvedPath: string;
};

/** Evaluates a condition NOW, exactly as the runner would judge it, without claiming, logging or starting anything. */
export function probeCondition(kind: ConditionKind, path: string, triggerId?: string): Promise<ConditionProbeResult> {
  return postJson<ConditionProbeResult>("/api/triggers/probe-condition", {
    kind,
    path,
    ...(triggerId ? { triggerId } : {}),
  });
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

// ---------------------------------------------------------------------------
// Plans (/api/plans)
// ---------------------------------------------------------------------------

/** Every plan kaprek knows about, newest first. */
export async function fetchPlans({ missionId, chatId }: { missionId?: string; chatId?: string } = {}): Promise<PlanSummary[]> {
  const params = new URLSearchParams();
  if (missionId) params.set("missionId", missionId);
  if (chatId) params.set("chatId", chatId);
  const query = params.toString();
  const res = await apiFetch(`/api/plans${query ? `?${query}` : ""}`);
  await throwOnError(res);
  return (await res.json()).plans as PlanSummary[];
}

/** One plan with its current content and steps, read from disk. */
export async function fetchPlan(id: string): Promise<PlanDetail> {
  const res = await apiFetch(`/api/plans/${encodeURIComponent(id)}`);
  await throwOnError(res);
  return (await res.json()).plan as PlanDetail;
}

/**
 * Changes a plan's status. 'done' is gated server-side on a clean convergence
 * check; `override` passes the gate and is recorded with the name given. A
 * refused 'done' comes back as a 409 whose message says why.
 */
export async function setPlanStatus(id: string, status: PlanSummary["status"], override?: { by: string }): Promise<PlanDetail> {
  const res = await apiFetch(`/api/plans/${encodeURIComponent(id)}/status`, {
    method: "POST",
    headers: { ...APP_HEADERS, "Content-Type": "application/json" },
    body: JSON.stringify({ status, ...(override ? { override } : {}) }),
  });
  await throwOnError(res);
  await res.json();
  return fetchPlan(id);
}

/** Ticks or unticks one step, rewriting that line in the plan file. */
export async function setPlanStep(id: string, index: number, done: boolean): Promise<PlanDetail> {
  const res = await apiFetch(`/api/plans/${encodeURIComponent(id)}/step`, {
    method: "POST",
    headers: { ...APP_HEADERS, "Content-Type": "application/json" },
    body: JSON.stringify({ index, done }),
  });
  await throwOnError(res);
  return (await res.json()).plan as PlanDetail;
}

// ---------------------------------------------------------------------------
// Council (/api/council)
// ---------------------------------------------------------------------------

export type CouncilLevel = "off" | "plans" | "decisions" | "always";
export type CouncilRole = "lead" | "thinker" | "worker" | "peer";

export type CouncilAssignment = {
  lead: string | null;
  thinker: string | null;
  worker: string | null;
  peer: string[];
};

export type Council = {
  level: CouncilLevel;
  assignment: CouncilAssignment;
  configured: boolean;
  suggested: boolean;
  problem: string | null;
  status: { possible: boolean; peers: string[]; reason: string | null };
};

export type CouncilSetup = { council: Council; available: string[]; levels: CouncilLevel[]; roles: CouncilRole[] };

export type PeerVerdict = "agree" | "concerns" | "disagree";

export type Consultation = {
  consensus: boolean;
  empty: boolean;
  agreed: string[];
  dissenting: { peerId: string; verdict: PeerVerdict; summary: string; risks: string[] }[];
  unreachable: { peerId: string; error: string | null }[];
  answers?: { peerId: string; verdict: PeerVerdict | null; summary: string | null; risks: string[]; error: string | null }[];
  /** Set when there was nobody to ask — not an error, a real answer. */
  reason?: string | null;
};

export async function fetchCouncil(): Promise<CouncilSetup> {
  const res = await apiFetch("/api/council");
  await throwOnError(res);
  return (await res.json()) as CouncilSetup;
}

export async function saveCouncil(level: CouncilLevel, assignment: CouncilAssignment): Promise<Council> {
  const res = await apiFetch("/api/council", {
    method: "PUT",
    headers: { ...APP_HEADERS, "Content-Type": "application/json" },
    body: JSON.stringify({ level, assignment }),
  });
  await throwOnError(res);
  return (await res.json()).council as Council;
}

/** Asks every peer the same question. Works at every level, including off. */
export async function consultCouncil(input: { question: string; files?: string[]; constraints?: string[]; tried?: string[]; missionId?: string }): Promise<Consultation> {
  const res = await apiFetch("/api/council/consult", {
    method: "POST",
    headers: { ...APP_HEADERS, "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  await throwOnError(res);
  return (await res.json()).consultation as Consultation;
}

/** A consultation as the store keeps it: the question, who was asked, and how it ended. */
export type ConsultationRecord = {
  id: string;
  chatId: string;
  moment: string;
  question: string;
  peers: string[];
  planPath: string | null;
  status: "running" | "completed" | "failed" | "interrupted";
  startedAt: string;
  finishedAt?: string;
  result: Consultation | null;
  error: string | null;
  /** The plan changed after the peers read it — the verdict is about a document that no longer exists in that form. */
  stale: boolean;
};

export async function fetchConsultations(chatId?: string): Promise<ConsultationRecord[]> {
  const res = await apiFetch(`/api/council/consultations${chatId ? `?chatId=${encodeURIComponent(chatId)}` : ""}`);
  await throwOnError(res);
  return (await res.json()).consultations as ConsultationRecord[];
}

export async function fetchConsultation(id: string): Promise<ConsultationRecord> {
  const res = await apiFetch(`/api/council/consultations/${encodeURIComponent(id)}`);
  await throwOnError(res);
  return (await res.json()).consultation as ConsultationRecord;
}

// ---------------------------------------------------------------------------
// Environment (GET /api/environment — src/scan/environment.mjs)
//
// Paths and names only. If a value ever shows up in one of these types,
// something has gone wrong on the server side, not here.
// ---------------------------------------------------------------------------

export type CliStatus = {
  id: string;
  label: string;
  command: string;
  installed: boolean;
  commandPath: string | null;
  configDirs: string[];
  signedIn: boolean;
  mcpServers: string[];
};

export type EnvironmentScan = {
  home: string;
  platform: string;
  clis: CliStatus[];
  /** Key NAMES per file. Never values. */
  envFiles: { path: string; keys: string[] }[];
};

export type EnvironmentReport = {
  environment: EnvironmentScan;
  nextSteps: { id: string; text: string }[];
  suggestedCouncil: CouncilAssignment;
};

export async function fetchEnvironment(): Promise<EnvironmentReport> {
  const res = await apiFetch("/api/environment");
  await throwOnError(res);
  return (await res.json()) as EnvironmentReport;
}

// ---------------------------------------------------------------------------
// Memory (GET/POST /api/memory — src/memory/store.mjs)
// ---------------------------------------------------------------------------

export type MemoryScope = { id: string; kind: string; label: string; parent: string | null };

/** Where a memory was learned (P4b). Absent/null on lines written before provenance existed — valid, marked, never hidden. */
export type MemorySourceKind = "turn" | "file" | "import" | "manual";

export type MemoryEntry = {
  id: string;
  scopeId: string;
  kind: "profile" | "fact" | "evidence";
  text: string;
  origin: string;
  confidence: number;
  createdAt: string;
  /** Null on an imported entry: believed, checked by nobody until "Still true". */
  lastVerifiedAt: string | null;
  evidenceRef: { sessionId: string; eventIndex: number } | null;
  forgotten: boolean;
  forgottenReason?: string | null;
  /** Older than 90 days without a verify. Shown, never hidden. */
  stale: boolean;
  ageMs: number;
  /** How many times this was learned (the first time counts as one); a second learner confirms rather than duplicates. */
  confirmations?: number;
  /** Every distinct origin that learned it, oldest first (bounded). */
  origins?: string[];
  /** Provenance (P4b): where this was learned, rendered as a link when it points anywhere. */
  sourceKind?: MemorySourceKind | null;
  chatId?: string | null;
  runId?: string | null;
  /** Redacted like every other text; the file's contents are never copied. */
  path?: string | null;
  pathRange?: { from: number; to: number } | null;
  /** True while lastVerifiedAt is null — shown at the top, marked unconfirmed. */
  unverified?: boolean;
};

export async function fetchMemoryScopes(): Promise<MemoryScope[]> {
  const res = await apiFetch("/api/memory/scopes");
  await throwOnError(res);
  return (await res.json()).scopes as MemoryScope[];
}

export async function fetchMemories(scopeId: string, query = ""): Promise<MemoryEntry[]> {
  const params = new URLSearchParams({ scopeId, ...(query ? { q: query } : {}) });
  const res = await apiFetch(`/api/memory?${params.toString()}`);
  await throwOnError(res);
  return (await res.json()).memories as MemoryEntry[];
}

export async function verifyMemory(id: string): Promise<MemoryEntry> {
  const res = await apiFetch(`/api/memory/${encodeURIComponent(id)}/verify`, { method: "POST", headers: { ...APP_HEADERS, "Content-Type": "application/json" }, body: "{}" });
  await throwOnError(res);
  return (await res.json()).memory as MemoryEntry;
}

export async function forgetMemory(id: string, reason: string): Promise<void> {
  const res = await apiFetch(`/api/memory/${encodeURIComponent(id)}`, {
    method: "DELETE",
    headers: { ...APP_HEADERS, "Content-Type": "application/json" },
    body: JSON.stringify({ reason }),
  });
  await throwOnError(res);
}

/** A rule kaprek noticed and wrote down. Inert until somebody accepts it. */
export type RuleProposal = {
  id: string;
  pattern: string;
  rule: string;
  seenIn: string[];
  status: "proposed" | "accepted" | "rejected";
  proposedAt: string;
  decidedAt: string | null;
  reason: string | null;
};

export async function fetchProposals(status?: string): Promise<RuleProposal[]> {
  const res = await apiFetch(`/api/memory/proposals${status ? `?status=${encodeURIComponent(status)}` : ""}`);
  await throwOnError(res);
  return (await res.json()).proposals as RuleProposal[];
}

export async function decideProposal(id: string, status: "accepted" | "rejected", reason?: string): Promise<RuleProposal> {
  const res = await apiFetch(`/api/memory/proposals/${encodeURIComponent(id)}`, {
    method: "POST",
    headers: { ...APP_HEADERS, "Content-Type": "application/json" },
    body: JSON.stringify({ status, ...(reason ? { reason } : {}) }),
  });
  await throwOnError(res);
  return (await res.json()).proposal as RuleProposal;
}

// ---------------------------------------------------------------------------
// kaprek Home (GET /api/home — src/missions/home.mjs)
//
// The same machine underneath. What differs is what gets asked and what gets
// shown.
// ---------------------------------------------------------------------------

export type HomeQuestion = {
  id: string;
  header: string;
  question: string;
  options: string[];
  freeText?: boolean;
};

export type HomeMission = {
  id: string;
  title: string;
  blurb: string;
  questions: HomeQuestion[];
  /** What finished looks like, in something a person can point at. */
  done: string;
};

export async function fetchHomeMissions(): Promise<HomeMission[]> {
  const res = await apiFetch("/api/home");
  await throwOnError(res);
  return (await res.json()).missions as HomeMission[];
}

export async function startHomeMission(id: string, cwd: string, answers: Record<string, string>): Promise<{ mission: { id: string }; firstPrompt: string; done: string }> {
  const res = await apiFetch(`/api/home/${encodeURIComponent(id)}/start`, {
    method: "POST",
    headers: { ...APP_HEADERS, "Content-Type": "application/json" },
    body: JSON.stringify({ cwd, answers }),
  });
  await throwOnError(res);
  return await res.json();
}
