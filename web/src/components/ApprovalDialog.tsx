// One approval question, two buttons. Purely presentational — no hooks, no
// fetching: the stack, the clock and the POST all live in the Chat page (see
// pages/Chat.tsx and lib/approvals.ts), which keeps this component a plain
// function of its props and testable without a DOM.
import {
  approvalSourceLabel,
  formatCountdown,
  oldestApproval,
  remainingMs,
  shortAgentId,
  type PendingApproval,
} from "../lib/approvals";

/** The proposed tool input, pretty-printed. Rendered in a scrollable <pre> — a Write call's input can be a whole file. */
function formatInput(input: Record<string, unknown> | null): string {
  if (input === null || input === undefined) return "(no input)";
  try {
    return JSON.stringify(input, null, 2);
  } catch {
    // A cyclic/unserializable object cannot reach here over JSON-SSE, but a
    // blank dialog would be the worst possible failure mode for a security
    // prompt, so say so instead.
    return "(input could not be displayed)";
  }
}

export default function ApprovalDialog({
  approvals,
  nowMs,
  currentChatId,
  busy = false,
  error = null,
  onDecide,
}: {
  approvals: PendingApproval[];
  nowMs: number;
  /** The chat this page is showing — decides whether a question's origin is worth naming (see approvalSourceLabel). */
  currentChatId?: string;
  busy?: boolean;
  /** A failed answer attempt (not a 404/409 — those remove the entry). Shown here, next to the buttons the user has to press again. */
  error?: string | null;
  onDecide: (entry: PendingApproval, behavior: "allow" | "deny") => void;
}) {
  const entry = oldestApproval(approvals);
  if (!entry) return null;

  const others = approvals.length - 1;
  const agentLabel = shortAgentId(entry.agentId);
  const toolLabel = entry.displayName ?? entry.toolName ?? "a tool";
  const sourceLabel = approvalSourceLabel(entry, currentChatId);

  return (
    <div className="approval-dialog">
      <div className="approval-dialog-head">
        <span className="approval-dialog-title">🔐 Approval needed</span>
        {others > 0 && (
          <span className="badge approval-dialog-more">
            +{others} more waiting
          </span>
        )}
        {agentLabel && <span className="badge badge-muted approval-dialog-agent">agent {agentLabel}</span>}
      </div>

      {sourceLabel && <div className="approval-dialog-source">{sourceLabel}</div>}

      <p className="approval-dialog-question">
        The agent wants to run <strong>{toolLabel}</strong>.
      </p>

      {entry.description && <p className="approval-dialog-note">{entry.description}</p>}
      {entry.reason && <p className="approval-dialog-note">{entry.reason}</p>}

      <pre className="approval-dialog-input">{formatInput(entry.input)}</pre>

      <div className="approval-dialog-countdown">
        Denied automatically in {formatCountdown(remainingMs(entry, nowMs))} if you do not answer.
      </div>

      {error && <div className="error-box">{error}</div>}

      <div className="approval-dialog-actions">
        <button type="button" className="btn" disabled={busy} onClick={() => onDecide(entry, "allow")}>
          Allow
        </button>
        <button type="button" className="btn btn-danger" disabled={busy} onClick={() => onDecide(entry, "deny")}>
          Deny
        </button>
      </div>
    </div>
  );
}
