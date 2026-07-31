// The floating question box: what an unattended agent asked while nobody was
// looking, on whatever page you happen to be on.
//
// It exists because a filed question has no other way to reach you. The live
// dialog only ever shows what arrived while its stream was open, and #/approvals
// only helps if you think to go there. A trigger that asked at 3am has to be
// visible at 9am without you looking for it.
//
// QuestionCard is exported and hook-free so it can be tested without a DOM
// (see src/test/tree.tsx).
import { useCallback, useEffect, useState } from "react";
import { answerApproval, fetchApprovalInbox } from "../lib/api";
import {
  dismissQuestion,
  isCollapsed,
  questionKey,
  readDismissed,
  removeQuestion,
  setCollapsed,
  setQuestions,
  useOpenQuestions,
  visibleQuestions,
  type OpenQuestion,
} from "../lib/questions";
import { relativeTime } from "../pages/Approvals";

/** One line of the proposed call. The full input lives in #/approvals; this is what fits on a card. */
function previewLine(question: OpenQuestion): string {
  if (typeof question.inputPreview === "string" && question.inputPreview.length > 0) return question.inputPreview;
  try {
    return JSON.stringify(question.input ?? {});
  } catch {
    return "(input could not be displayed)";
  }
}

export function QuestionCard({
  question,
  nowMs,
  busy = false,
  expanded = false,
  onToggleExpand,
  onDecide,
  onDismiss,
}: {
  question: OpenQuestion;
  nowMs: number;
  busy?: boolean;
  expanded?: boolean;
  onToggleExpand?: (question: OpenQuestion) => void;
  onDecide: (question: OpenQuestion, behavior: "allow" | "deny") => void;
  onDismiss: (question: OpenQuestion) => void;
}) {
  const asked = question.askedCount ?? 1;
  const preview = previewLine(question);
  const truncated = (question.input as { _truncated?: boolean } | null)?._truncated === true;

  return (
    <div className="question-card">
      <div className="question-card-head">
        <span className="question-card-tool">{question.displayName ?? question.toolName ?? "a tool"}</span>
        {question.triggerId && <span className="badge badge-muted">{question.triggerId}</span>}
        <span className="question-card-age">{relativeTime(question.requestedAt, nowMs)}</span>
        <button type="button" className="question-card-dismiss" title="Hide this for now (it stays in Approvals)" onClick={() => onDismiss(question)}>
          ×
        </button>
      </div>

      {asked > 1 && <div className="question-card-note">asked {asked} times</div>}

      <pre className={expanded ? "question-card-input question-card-input-open" : "question-card-input"}>{preview}</pre>
      {onToggleExpand && (
        <button type="button" className="link-button" onClick={() => onToggleExpand(question)}>
          {expanded ? "Show less" : "Show more"}
        </button>
      )}

      {truncated && <div className="question-card-note">The full input was too large to keep, so the agent will ask again when it runs this.</div>}

      <div className="question-card-actions">
        <button type="button" className="btn" disabled={busy} onClick={() => onDecide(question, "allow")}>
          Approve &amp; run now
        </button>
        <button type="button" className="btn btn-danger" disabled={busy} onClick={() => onDecide(question, "deny")}>
          Deny
        </button>
      </div>
    </div>
  );
}

export default function QuestionBox() {
  const all = useOpenQuestions();
  const [dismissed, setDismissed] = useState(() => readDismissed());
  const [collapsed, setCollapsedState] = useState(() => isCollapsed());
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [expandedKey, setExpandedKey] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [nowMs, setNowMs] = useState(() => Date.now());

  const load = useCallback(async () => {
    try {
      const { approvals } = await fetchApprovalInbox();
      setQuestions(approvals);
      setNowMs(Date.now());
    } catch {
      // A failed load leaves the box empty rather than showing an error over
      // every page; #/approvals is where a broken inbox is worth reporting.
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const visible = visibleQuestions(all, dismissed);
  if (visible.length === 0) return null;

  const decide = async (question: OpenQuestion, behavior: "allow" | "deny") => {
    setBusyKey(questionKey(question));
    setError(null);
    try {
      await answerApproval(question.id, { chatId: question.chatId, behavior });
      removeQuestion(questionKey(question));
    } catch (err) {
      // A 409 here is the ordinary "that chat is busy right now" answer, which
      // is worth showing: the user can simply approve again in a moment.
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusyKey(null);
    }
  };

  return (
    <aside className="question-box" aria-label="Open questions">
      <button
        type="button"
        className="question-box-toggle"
        onClick={() => {
          const next = !collapsed;
          setCollapsed(next);
          setCollapsedState(next);
        }}
      >
        {visible.length} {visible.length === 1 ? "question" : "questions"} {collapsed ? "▲" : "▼"}
      </button>

      {!collapsed && (
        <div className="question-box-body">
          {error && <div className="error-box">{error}</div>}
          {visible.map((question) => (
            <QuestionCard
              key={questionKey(question)}
              question={question}
              nowMs={nowMs}
              busy={busyKey === questionKey(question)}
              expanded={expandedKey === questionKey(question)}
              onToggleExpand={(q) => setExpandedKey(expandedKey === questionKey(q) ? null : questionKey(q))}
              onDecide={(q, behavior) => void decide(q, behavior)}
              onDismiss={(q) => setDismissed(dismissQuestion(q))}
            />
          ))}
        </div>
      )}
    </aside>
  );
}
