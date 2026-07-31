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
import { answerApproval, fetchApprovalInbox, type InboxApproval } from "../lib/api";
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
export function deadlineLabel(
  deadlineAt: number | null,
  nowMs: number,
  deadlineSource: "question" | "turn" = "question",
): string | null {
  if (deadlineAt === null || deadlineAt === undefined) return null;
  // WHY the suffix: when the turn's own wall clock is the nearer limit, an
  // eight-hour question can show two minutes left. The number is true, but
  // without the reason it reads as a bug or as a deadline someone shortened
  // (see server.mjs::effectiveApprovalDeadline).
  const because = deadlineSource === "turn" ? " This is limited by the turn's own time budget, not by the approval deadline." : "";
  const remaining = deadlineAt - nowMs;
  if (remaining <= 0) return `Denied automatically by now — the server's own timer has passed.${because}`;
  const minutes = Math.round(remaining / 60_000);
  if (minutes < 60) return `Denied automatically in about ${minutes} minute${minutes === 1 ? "" : "s"}.${because}`;
  const hours = Math.round(minutes / 60);
  return `Denied automatically in about ${hours} hour${hours === 1 ? "" : "s"}.${because}`;
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
  const deadline = deadlineLabel(approval.deadlineAt, nowMs, approval.deadlineSource ?? "question");

  return (
    <div className="approval-dialog approval-inbox-item">
      <div className="approval-dialog-head">
        <span className="approval-dialog-title">🔐 {toolLabel}</span>
        <span className="badge badge-muted">asked {relativeTime(approval.requestedAt, nowMs)}</span>
      </div>

      {sourceLabel && <div className="approval-dialog-source">{sourceLabel}</div>}
      {approval.description && <p className="approval-dialog-note">{approval.description}</p>}
      {approval.reason && <p className="approval-dialog-note">{approval.reason}</p>}

      <pre className="approval-dialog-input">{formatInput(approval.input)}</pre>

      {deadline && <div className="approval-dialog-countdown">{deadline}</div>}

      <div className="approval-dialog-actions">
        <button type="button" className="btn" disabled={busy} onClick={() => onDecide(approval, "allow")}>
          Allow
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

  useEffect(() => {
    void load();
  }, [load]);

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

  return (
    <div className="page">
      <header className="page-header">
        <h1>Approvals</h1>
        <p className="page-subtitle">
          Questions raised by a running turn, including one a trigger started while you were away. They wait here instead of
          needing you to be watching when they are asked. A question does <strong>not</strong> survive a restart of kaprek:
          the agent process it belongs to dies with the server, and the entry is dropped as unanswerable.
        </p>
      </header>

      <div className="approval-inbox-actions">
        <button type="button" className="btn" onClick={() => void load()}>
          Refresh
        </button>
      </div>

      {error && <div className="error-box">{error}</div>}

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
    </div>
  );
}
