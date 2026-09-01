// Approvals page (#/approvals): the questions waiting for an answer, whether
// or not anyone was watching when they were asked.
//
// This is the counterpart to the live dialog in the chat view. That one only
// ever shows what arrived over an open connection, which is why an unattended
// trigger's question used to be unreachable: raised at 3am into a stream
// nobody was on, then auto-denied. Here the browser ASKS (GET /api/approvals)
// instead of waiting to be told, so a page opened in the morning finds it.
//
// Deliberately NOT polled on a timer: an entry that appears while you look at
// a static page is not worth a request every few seconds on a local tool, and
// a stale list is visible as stale (the refresh button is right there, and any
// answer refreshes it). The live path for a question raised while you watch is
// the chat view's dialog, which is push-based and instant.
//
// ApprovalInboxItem is exported and hook-free so it can be tested without a
// DOM (see src/test/tree.tsx).
import { useCallback, useEffect, useState } from "react";
import { answerApproval, fetchApprovalHistory, fetchApprovalInbox, fetchMissions, type HistoryApproval, type InboxApproval, type Mission } from "../lib/api";
import { approvalSourceLabel } from "../lib/approvals";

/** The proposed tool input, pretty-printed — same treatment the live dialog gives it (a Write call's input can be a whole file). */
function formatInput(input: Record<string, unknown> | null): string {
  if (input === null || input === undefined) return "(no input)";
  try {
    return JSON.stringify(input, null, 2);
  } catch {
    return "(input could not be displayed)";
  }
}

/**
 * "3 hours ago" for a timestamp that is usually not from this minute. Coarse
 * on purpose: an inbox entry's exact second tells you nothing, and a wrong
 * precise time reads worse than a right vague one.
 */
export function relativeTime(fromMs: number, nowMs: number): string {
  const seconds = Math.max(0, Math.round((nowMs - fromMs) / 1000));
  if (seconds < 60) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? "" : "s"} ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? "" : "s"} ago`;
  const days = Math.round(hours / 24);
  return `${days} day${days === 1 ? "" : "s"} ago`;
}

/**
 * How long is left before the server denies this on its own, in words. Null
 * for an entry with no deadline recorded (an older file, or a caller that did
 * not set one) — better no line than an invented one.
 */
export function deadlineLabel(deadlineAt: number | null, nowMs: number): string | null {
  if (deadlineAt === null || deadlineAt === undefined) return null;
  const remaining = deadlineAt - nowMs;
  if (remaining <= 0) return `Denied automatically by now — the server's own timer has passed.`;
  const minutes = Math.round(remaining / 60_000);
  if (minutes < 60) return `Denied automatically in about ${minutes} minute${minutes === 1 ? "" : "s"}.`;
  const hours = Math.round(minutes / 60);
  return `Denied automatically in about ${hours} hour${hours === 1 ? "" : "s"}.`;
}

export function ApprovalInboxItem({
  approval,
  nowMs,
  busy = false,
  onDecide,
}: {
  approval: InboxApproval;
  nowMs: number;
  busy?: boolean;
  onDecide: (approval: InboxApproval, behavior: "allow" | "deny") => void;
}) {
  const toolLabel = approval.displayName ?? approval.toolName ?? "a tool";
  // No currentChatId here: an inbox entry belongs to a chat this page is not
  // showing by definition, so its origin is always worth naming.
  const sourceLabel = approvalSourceLabel(approval, undefined);
  const deadline = deadlineLabel(approval.deadlineAt, nowMs);

  return (
    <div className="approval-dialog approval-inbox-item">
      <div className="approval-dialog-head">
        <span className="approval-dialog-title">🔐 {toolLabel}</span>
        <span className="badge badge-muted">asked {relativeTime(approval.requestedAt, nowMs)}</span>
        {(approval.askedCount ?? 1) > 1 && <span className="badge badge-muted">asked {approval.askedCount} times</span>}
      </div>

      {sourceLabel && <div className="approval-dialog-source">{sourceLabel}</div>}
      {approval.description && <p className="approval-dialog-note">{approval.description}</p>}
      {approval.reason && <p className="approval-dialog-note">{approval.reason}</p>}

      <pre className="approval-dialog-input">{formatInput(approval.input)}</pre>

      {(approval.input as { _truncated?: boolean } | null)?._truncated === true && (
        <p className="approval-dialog-note">
          The full input was too large to keep, so approving this will start a turn that asks again before it runs — you will
          be here to answer that one.
        </p>
      )}

      {deadline && <div className="approval-dialog-countdown">{deadline}</div>}

      <div className="approval-dialog-actions">
        <button type="button" className="btn" disabled={busy} onClick={() => onDecide(approval, "allow")}>
          Approve &amp; run now
        </button>
        <button type="button" className="btn btn-danger" disabled={busy} onClick={() => onDecide(approval, "deny")}>
          Deny
        </button>
      </div>
    </div>
  );
}

export default function Approvals() {
  const [approvals, setApprovals] = useState<InboxApproval[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [nowMs, setNowMs] = useState(() => Date.now());
  // P1: the second lifecycle half. "pending" is the inbox as it always was;
  // "history" is what happened to everything else.
  const [tab, setTab] = useState<"pending" | "history">("pending");
  const [history, setHistory] = useState<HistoryApproval[] | null>(null);
  const [missions, setMissions] = useState<Mission[]>([]);
  const [missionFilter, setMissionFilter] = useState<string>("");
  const [triggerFilter, setTriggerFilter] = useState<string>("");

  const load = useCallback(async () => {
    setError(null);
    try {
      const { approvals: list } = await fetchApprovalInbox();
      setApprovals(list);
      setNowMs(Date.now());
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  const loadHistory = useCallback(async () => {
    setError(null);
    try {
      const { approvals: list } = await fetchApprovalHistory();
      setHistory(list);
      setNowMs(Date.now());
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (tab === "history") {
      void loadHistory();
      // Missions only name the filter dropdown; a failure there must not
      // blank the history — filtering by mission simply stays unavailable.
      fetchMissions()
        .then(setMissions)
        .catch(() => {});
    }
  }, [tab, loadHistory]);

  const decide = async (approval: InboxApproval, behavior: "allow" | "deny") => {
    setBusyId(approval.id);
    setError(null);
    try {
      // 'gone' needs no message: the entry disappearing from the refreshed
      // list below IS the answer (the turn ended, or it was already decided,
      // or it died with a previous process).
      await answerApproval(approval.id, { chatId: approval.chatId, behavior });
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusyId(null);
    }
  };

  const triggerIds = [...new Set((history ?? []).map((e) => e.triggerId).filter((t): t is string => Boolean(t)))].sort();
  const filteredHistory = (history ?? []).filter((entry) => {
    if (triggerFilter && entry.triggerId !== triggerFilter) return false;
    if (missionFilter) {
      const mission = missions.find((m) => m.id === missionFilter);
      // A mission's questions are its chats' questions; an entry whose chat
      // the mission does not claim is filtered out, not silently kept.
      if (!mission || !entry.chatId || !mission.chats.includes(entry.chatId)) return false;
    }
    return true;
  });

  return (
    <div className="page">
      <header className="page-header">
        <h1>Approvals</h1>
        <p className="page-subtitle">
          Questions an agent could not answer for itself. A trigger running on its own does not wait for you: it files the
          question here, is told to carry on, and finishes its turn. Approve one and kaprek runs that single action in a
          follow-up turn; deny it, or leave it, and nothing happens. Unanswered questions lapse after a day, and a trigger
          that still wants the answer simply asks again.
        </p>
      </header>

      <div className="approval-inbox-actions">
        <button type="button" className={tab === "pending" ? "btn btn-primary" : "btn"} onClick={() => setTab("pending")}>
          Pending
        </button>
        <button type="button" className={tab === "history" ? "btn btn-primary" : "btn"} onClick={() => setTab("history")}>
          History
        </button>
        <button
          type="button"
          className="btn"
          onClick={() => void (tab === "history" ? loadHistory() : load())}
        >
          Refresh
        </button>
      </div>

      {error && <div className="error-box">{error}</div>}

      {tab === "pending" && (
        <>
          {approvals === null && !error && <div className="empty-box">Loading…</div>}
          {approvals !== null && approvals.length === 0 && <div className="empty-box">Nothing is waiting for an answer.</div>}

          {approvals?.map((approval) => (
            <ApprovalInboxItem
              key={`${approval.chatId}:${approval.id}`}
              approval={approval}
              nowMs={nowMs}
              busy={busyId === approval.id}
              onDecide={(entry, behavior) => void decide(entry, behavior)}
            />
          ))}
        </>
      )}

      {tab === "history" && (
        <>
          <div className="approval-inbox-actions">
            <select value={missionFilter} onChange={(e) => setMissionFilter(e.target.value)} className="btn" aria-label="Filter by mission">
              <option value="">All missions</option>
              {missions.map((mission) => (
                <option key={mission.id} value={mission.id}>
                  {mission.title}
                </option>
              ))}
            </select>
            <select value={triggerFilter} onChange={(e) => setTriggerFilter(e.target.value)} className="btn" aria-label="Filter by trigger">
              <option value="">All triggers</option>
              {triggerIds.map((triggerId) => (
                <option key={triggerId} value={triggerId}>
                  {triggerId}
                </option>
              ))}
            </select>
          </div>

          {history === null && !error && <div className="empty-box">Loading…</div>}
          {history !== null && filteredHistory.length === 0 && <div className="empty-box">Nothing in the history (for this filter).</div>}

          {filteredHistory.map((entry) => (
            <ApprovalHistoryItem key={`${entry.chatId}:${entry.id}`} entry={entry} nowMs={nowMs} />
          ))}
        </>
      )}
    </div>
  );
}

/** The one-line status word for a finished entry, with the reason where there is one. */
export function historyStatusLabel(entry: HistoryApproval): string {
  switch (entry.status) {
    case "decided":
      return entry.decision?.behavior === "allow" ? "allowed" : "denied";
    case "lapsed":
      return "lapsed (never answered)";
    case "cancelled":
      return `cancelled (${entry.cancelledReason ?? "unknown reason"})`;
    case "expired":
      return `expired (${entry.expired ?? "process gone"})`;
    default:
      return entry.status;
  }
}

/** How a human reads a wait in round numbers; null stays an em dash, never a guessed 0. */
function formatWait(waitMs: number | null): string {
  if (waitMs === null || waitMs === undefined || !Number.isFinite(waitMs)) return "—";
  if (waitMs < 60_000) return `${Math.round(waitMs / 1000)}s`;
  if (waitMs < 60 * 60_000) return `${Math.round(waitMs / 60_000)} min`;
  if (waitMs < 24 * 60 * 60_000) return `${Math.round(waitMs / (60 * 60_000))} h`;
  return `${Math.round(waitMs / (24 * 60 * 60_000))} d`;
}

/**
 * One history row. Deliberately plainer than an inbox card: nothing here is
 * answerable any more, so there is nothing to click — only what happened,
 * who made it happen, and how long the question sat there first.
 */
export function ApprovalHistoryItem({ entry, nowMs }: { entry: HistoryApproval; nowMs: number }) {
  const sourceLabel = approvalSourceLabel(entry, undefined);
  return (
    <div className="approval-dialog approval-inbox-item">
      <div className="approval-dialog-head">
        <span className="approval-dialog-title">🔐 {entry.displayName ?? entry.toolName ?? "a tool"}</span>
        <span className="badge badge-muted">{historyStatusLabel(entry)}</span>
        <span className="badge badge-muted">asked {relativeTime(entry.requestedAt, nowMs)}</span>
        {(entry.askedCount ?? 1) > 1 && <span className="badge badge-muted">asked {entry.askedCount} times</span>}
      </div>

      {sourceLabel && <div className="approval-dialog-source">{sourceLabel}</div>}
      {entry.description && <p className="approval-dialog-note">{entry.description}</p>}

      <p className="approval-dialog-note">
        Waited {formatWait(entry.waitMs)}
        {entry.decision?.message ? ` — "${entry.decision.message}"` : ""}
        {entry.decidedVia ? ` (via ${entry.decidedVia})` : ""}
      </p>
      {entry.runId && (
        <p className="approval-dialog-note">
          Run: {entry.runId}
        </p>
      )}
    </div>
  );
}
