// Thin wrapper around /api/handover* (server-side route owned elsewhere):
// the account-switch ledger of one "schreibe eine Übergabe, dann starte eine
// frische Session" cycle. Mirrors resume.ts's split — types + fetch/start
// calls here, state in Handover.tsx, rendering in HandoverPanel.tsx.
import { apiFetch, APP_HEADERS } from "./api";

export type HandoverStatus = "nothing" | "pending" | "failed" | "unknown" | "spawned" | "running";

export type Handover = {
  handoverId: string;
  sessionId: string | null;
  cwd: string | null;
  file: string | null;
  section: string | null;
  prompt: string | null;
  title: string;
  note: string | null;
  nothingOpen: boolean;
  recordedAt: string | null;
  status: HandoverStatus;
  startedAt: string | null;
  lastError: string | null;
  newSessionId: string | null;
  attempts: number;
};

export type MissingSession = { sessionId: string; cwd: string; title: string };

export type SwitchView = {
  switchId: string;
  openedAt: string | null;
  note: string | null;
  counts: Record<HandoverStatus, number>;
  handovers: Handover[];
  missing: MissingSession[];
  // Only on the current switch: the account logged in right now is still
  // the one the switch was opened under — nobody has run /login yet.
  loginUnchanged?: boolean;
};

export type HandoverOverview = { current: SwitchView | null; history: SwitchView[] };

export type HandoverStartResult = { handoverId: string; title: string; ok: boolean; method?: string; error?: string };

export type HandoverStartResponse = { status: number; ok: boolean; results: HandoverStartResult[]; error?: string; warning?: string };

/**
 * The status line after a start. A 200 can still carry handovers that could
 * not be started (folder gone, CLI missing) — `ok` is false then, with no
 * top-level `error`; the line names how many tabs opened and the first
 * reason one did not.
 */
export function startStatusText(r: HandoverStartResponse): string {
  if (r.status === 409) return "Fehler: Ein anderer Start läuft gerade.";
  if (r.status !== 200) return `Fehler: ${r.error ?? `HTTP ${r.status}`}`;
  const opened = r.results.filter((x) => x.ok).length;
  const firstFailure = r.results.find((x) => !x.ok);
  if (r.results.length === 0) return "Nichts zu starten.";
  if (firstFailure) return `Fehler: ${opened}/${r.results.length} Tabs geöffnet. ${firstFailure.title}: ${firstFailure.error ?? "unbekannt"}`;
  return `${opened}/${r.results.length} Tabs geöffnet`;
}

export function fetchHandover(): Promise<HandoverOverview> {
  return apiFetch("/api/handover").then(async (res) => {
    if (!res.ok) throw new Error(`handover: ${res.status}`);
    return (await res.json()) as HandoverOverview;
  });
}

/**
 * Starts the given handovers (or, with no `ids`, every waiting one). A 409
 * (another start already running) is reported, not thrown — same reasoning
 * as answerApproval()'s "gone" result in lib/api.ts: a busy-but-reachable
 * server is not a network failure, and the caller decides what to show.
 */
export async function startHandovers(body: {
  switchId: string;
  ids?: string[];
  account?: "login" | "auto";
  skip?: boolean;
  again?: boolean;
}): Promise<HandoverStartResponse> {
  const res = await apiFetch("/api/handover/start", {
    method: "POST",
    headers: { ...APP_HEADERS, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const json = (await res.json()) as { ok?: boolean; results?: HandoverStartResult[]; error?: string; warning?: string };
  return { status: res.status, ok: json.ok ?? false, results: json.results ?? [], error: json.error, warning: json.warning };
}

/** The handovers a "start" action is actually allowed to touch without `again`: waiting or previously failed. */
export function startableHandovers(view: SwitchView): Handover[] {
  return view.handovers.filter((h) => h.status === "pending" || h.status === "failed");
}

/**
 * Handovers that still need somebody: never started, failed, or started with
 * an outcome nobody has seen. Used for the banner on #/list and for earlier
 * switches, whose leftovers stay on the page instead of sinking into history.
 */
export function unresolvedHandovers(view: SwitchView): Handover[] {
  return view.handovers.filter((h) => h.status === "pending" || h.status === "failed" || h.status === "unknown" || h.status === "spawned");
}

const SUMMARY_ORDER: HandoverStatus[] = ["pending", "nothing", "failed", "unknown", "spawned", "running"];

const SUMMARY_LABELS: Record<HandoverStatus, string> = {
  pending: "warten",
  nothing: "nichts offen",
  failed: "fehlgeschlagen",
  unknown: "unklar",
  spawned: "Tab offen",
  running: "läuft",
};

/** e.g. "11 warten · 2 nichts offen · 1 läuft · 1 fehlt" — only parts with a count > 0. */
export function handoverSummary(view: SwitchView): string {
  const parts = SUMMARY_ORDER.filter((s) => view.counts[s] > 0).map((s) => `${view.counts[s]} ${SUMMARY_LABELS[s]}`);
  if (view.missing.length > 0) parts.push(`${view.missing.length} fehlt`);
  return parts.join(" · ");
}

const STATUS_LABELS: Record<HandoverStatus, string> = {
  pending: "wartet",
  nothing: "nichts offen",
  failed: "Start fehlgeschlagen",
  unknown: "Start unklar",
  spawned: "Tab geöffnet",
  running: "läuft",
};

export function statusLabel(status: HandoverStatus): string {
  return STATUS_LABELS[status];
}

/** Same "Fehler: "-prefixing as resume.ts's resumeErrorText — kept as its own copy since the two libs stay independent. */
export function handoverErrorText(err: unknown): string {
  return `Fehler: ${err instanceof Error ? err.message : String(err)}`;
}
