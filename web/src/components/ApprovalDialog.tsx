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
import type { ShapeGrantPreview } from "../lib/api";

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

/**
 * P6b — the second stage of the shape flow: the server-derived pattern
 * sentence and the mandatory concrete examples, one labelled hit/miss each.
 * The Save button stays disabled until the checkbox confirms these were
 * actually rendered — and the server refuses the mint without the confirm
 * anyway, so this is a doubled lock, not the only one.
 */
function ShapePreviewStep({
  preview,
  confirmed,
  busy,
  onToggle,
  onSave,
  onSkip,
}: {
  preview: ShapeGrantPreview;
  confirmed: boolean;
  busy: boolean;
  onToggle: () => void;
  onSave: () => void;
  onSkip: () => void;
}) {
  return (
    <div className="approval-dialog-shape">
      <p className="approval-dialog-note">
        Would also allow: <strong>{preview.sentence}</strong>
      </p>
      <ul className="approval-dialog-shape-examples">
        {preview.examples.map((example, i) => (
          <li key={i} className={example.matches ? "shape-example-hit" : "shape-example-miss"}>
            {example.matches ? "✓ would be allowed:" : "✗ would NOT be allowed:"}{" "}
            <code>{JSON.stringify(example.input)}</code>
          </li>
        ))}
      </ul>
      <label className="approval-dialog-shape-confirm">
        <input type="checkbox" checked={confirmed} onChange={onToggle} disabled={busy} />
        I have read what this pattern would allow
      </label>
      <div className="approval-dialog-actions">
        <button type="button" className="btn" disabled={busy || !confirmed} onClick={onSave}>
          Save standing grant
        </button>
        <button type="button" className="btn" disabled={busy} onClick={onSkip}>
          Allow once only
        </button>
      </div>
    </div>
  );
}

export default function ApprovalDialog({
  approvals,
  nowMs,
  currentChatId,
  busy = false,
  error = null,
  onDecide,
  onGrant,
  onGrantShape,
  shapePreview = null,
  shapeConfirmed = false,
  onShapeConfirmToggle,
  onShapeSave,
  onShapeSkip,
}: {
  approvals: PendingApproval[];
  nowMs: number;
  /** The chat this page is showing — decides whether a question's origin is worth naming (see approvalSourceLabel). */
  currentChatId?: string;
  busy?: boolean;
  /** A failed answer attempt (not a 404/409 — those remove the entry). Shown here, next to the buttons the user has to press again. */
  error?: string | null;
  onDecide: (entry: PendingApproval, behavior: "allow" | "deny") => void;
  /**
   * P6a: "always, for this exact form" — allow AND seed a standing grant
   * from this very question. Optional: only offered where the server can
   * mint (a mission chat); when absent, the button simply does not exist.
   */
  onGrant?: (entry: PendingApproval) => void;
  /**
   * P6b: "always, for this form of call" — allow AND seed a SHAPE grant.
   * The dialog then moves to the preview step (pattern + examples) before
   * anything is saved. Optional like onGrant.
   */
  onGrantShape?: (entry: PendingApproval) => void;
  /** P6b: set while the shape preview step is open (the answer already happened; only the grant is pending). */
  shapePreview?: ShapeGrantPreview | null;
  shapeConfirmed?: boolean;
  onShapeConfirmToggle?: () => void;
  onShapeSave?: () => void;
  onShapeSkip?: () => void;
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
      {entry.standingGrant && (
        <p className="approval-dialog-note">
          {entry.standingGrant.state === "reactivation"
            ? "A standing grant covers this form, but the posture loosened since you confirmed it — answering this question once confirms the grant again, or denies it away."
            : "A standing grant covers this form, but it may not act right now (the rules it was made under changed) — so you are being asked."}
          {entry.standingGrant.why ? ` (${entry.standingGrant.why})` : ""}
        </p>
      )}

      <pre className="approval-dialog-input">{formatInput(entry.input)}</pre>

      <div className="approval-dialog-countdown">
        Denied automatically in {formatCountdown(remainingMs(entry, nowMs))} if you do not answer.
      </div>

      {error && <div className="error-box">{error}</div>}

      {shapePreview && onShapeSave && onShapeSkip && onShapeConfirmToggle ? (
        <ShapePreviewStep
          preview={shapePreview}
          confirmed={shapeConfirmed}
          busy={busy}
          onToggle={onShapeConfirmToggle}
          onSave={onShapeSave}
          onSkip={onShapeSkip}
        />
      ) : (
        <div className="approval-dialog-actions">
          <button type="button" className="btn" disabled={busy} onClick={() => onDecide(entry, "allow")}>
            Allow
          </button>
          {onGrant && (
            <button type="button" className="btn" disabled={busy} onClick={() => onGrant(entry)} title="Allow this call, and stop asking for this exact form in this mission">
              Always for this form
            </button>
          )}
          {onGrantShape && (
            <button
              type="button"
              className="btn"
              disabled={busy}
              onClick={() => onGrantShape(entry)}
              title="Allow this call, and stop asking for this shape of call in this mission — the server shows you first what the pattern would and would not allow"
            >
              Always for this form of call
            </button>
          )}
          <button type="button" className="btn btn-danger" disabled={busy} onClick={() => onDecide(entry, "deny")}>
            Deny
          </button>
        </div>
      )}
    </div>
  );
}
