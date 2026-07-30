// The three facts the header's status dot shows. Deliberately a tiny
// module-level store rather than a context provider: the writers (lib/api.ts's
// fetch wrapper, the Chat page's stream handler) sit in completely different
// parts of the tree from the reader (the header in App.tsx), and none of it is
// worth a state library or a polling endpoint — every value here falls out of
// work the app is already doing.
import { useSyncExternalStore } from "react";

export type AppStatus = {
  /** False only after a fetch actually rejected — a 401/500 is still a reachable server (see api.ts::apiFetch). */
  serverReachable: boolean;
  /** A chat turn or a manual trigger fire is streaming right now. */
  turnRunning: boolean;
  /** How many approval questions are waiting for an answer. */
  approvalsOpen: number;
};

let status: AppStatus = { serverReachable: true, turnRunning: false, approvalsOpen: 0 };

const listeners = new Set<() => void>();

export function getStatus(): AppStatus {
  return status;
}

/**
 * Merges a partial update in. A no-op update (every key already equal) does
 * NOT notify — api.ts calls setStatus({serverReachable: true}) on every single
 * request, and re-rendering the header for each of those would be pointless
 * churn.
 */
export function setStatus(patch: Partial<AppStatus>): void {
  const next = { ...status, ...patch };
  if (next.serverReachable === status.serverReachable && next.turnRunning === status.turnRunning && next.approvalsOpen === status.approvalsOpen) {
    return;
  }
  status = next;
  for (const listener of listeners) listener();
}

export function subscribeStatus(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useAppStatus(): AppStatus {
  return useSyncExternalStore(subscribeStatus, getStatus, getStatus);
}

/** Test seam — resets the store to its initial values between cases. */
export function resetStatus(): void {
  status = { serverReachable: true, turnRunning: false, approvalsOpen: 0 };
  for (const listener of listeners) listener();
}

/**
 * The single label/tone the header dot shows. Ordered by urgency, not by
 * field order: an open approval is the one thing actually waiting on the user,
 * an unreachable server is the one thing that makes everything else moot.
 */
export function statusSummary(s: AppStatus): { tone: "offline" | "waiting" | "busy" | "idle"; label: string } {
  if (!s.serverReachable) return { tone: "offline", label: "Server unreachable" };
  if (s.approvalsOpen > 0) {
    return { tone: "waiting", label: s.approvalsOpen === 1 ? "1 approval waiting" : `${s.approvalsOpen} approvals waiting` };
  }
  if (s.turnRunning) return { tone: "busy", label: "Turn running" };
  return { tone: "idle", label: "Idle" };
}
