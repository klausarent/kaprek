// #/plans — where a plan is something you open, not something you go looking
// for in a folder.
//
// Klaus, on why this page exists: "man findet den Plan unter einem eigenen
// Bereich des Projektes wieder öffnen. Hier muss man immer erst den Ordner
// öffnen und selber durchklicken, weil du niemals absolute Pfade mit
// schickst." So the path is on screen, always, and copyable in one click.
//
// Ticking a step writes that line in the file itself — the plan belongs to
// the user's editor and their git, not to a database in here.
import { useCallback, useEffect, useState } from "react";
import { fetchPlan, fetchPlans, setPlanStep, type PlanDetail, type PlanSummary } from "../lib/api";
import { navigateToChat } from "../App";

/** "3 of 7 done" — the one number worth showing next to a plan. */
export function progressOf(plan: { steps: { done: boolean }[] }): string {
  const done = plan.steps.filter((step) => step.done).length;
  return `${done} of ${plan.steps.length} done`;
}

/** What to say about a plan in the list. */
export function subtitleOf(plan: PlanSummary): string {
  if (!plan.exists) return "the file is gone";
  return plan.kind === "spec" ? "design" : "plan";
}

export function PlanList({ plans, selectedId, onSelect }: { plans: PlanSummary[]; selectedId: string | null; onSelect: (id: string) => void }) {
  if (plans.length === 0) {
    return (
      <div className="empty-state">
        <p>No plans yet.</p>
        <p>
          Start a chat and say what you want to build. kaprek offers to work through it as a quiz, and the plan it writes lands here — with its full path,
          so you never have to go hunting for it.
        </p>
      </div>
    );
  }
  return (
    <ul className="plan-list">
      {plans.map((plan) => (
        <li key={plan.id}>
          <button type="button" className={plan.id === selectedId ? "plan-list-item plan-list-item-active" : "plan-list-item"} onClick={() => onSelect(plan.id)}>
            <span className="plan-list-title">{plan.title}</span>
            <span className="plan-list-meta">
              {subtitleOf(plan)}
              {!plan.exists && <span className="badge badge-muted">missing</span>}
            </span>
          </button>
        </li>
      ))}
    </ul>
  );
}

export function PlanDetailView({
  plan,
  busyStep,
  onToggleStep,
  onImplement,
  onCopyPath,
}: {
  plan: PlanDetail;
  busyStep: number | null;
  onToggleStep: (index: number, done: boolean) => void;
  onImplement: () => void;
  onCopyPath: () => void;
}) {
  return (
    <div className="plan-detail">
      <h2>{plan.title}</h2>
      <div className="plan-detail-head">
        <code className="plan-path">{plan.path}</code>
        <button type="button" className="link-button" onClick={onCopyPath}>
          Copy path
        </button>
      </div>

      {plan.steps.length > 0 && (
        <>
          <div className="plan-progress">{progressOf(plan)}</div>
          <ul className="plan-steps">
            {plan.steps.map((step) => (
              <li key={step.index}>
                <label>
                  <input type="checkbox" checked={step.done} disabled={busyStep !== null} onChange={(event) => onToggleStep(step.index, event.target.checked)} />
                  <span className={step.done ? "plan-step-done" : undefined}>{step.text}</span>
                </label>
              </li>
            ))}
          </ul>
          <button type="button" className="btn" onClick={onImplement}>
            Start working on this
          </button>
        </>
      )}

      {plan.steps.length === 0 && <p className="plan-note">No checkboxes in this one — it reads as a design document.</p>}

      <pre className="plan-content">{plan.content}</pre>
      {plan.truncated && <p className="plan-note">This file is too large to show whole; the checkboxes above still cover all of it.</p>}
    </div>
  );
}

export default function Plans() {
  const [plans, setPlans] = useState<PlanSummary[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<PlanDetail | null>(null);
  const [busyStep, setBusyStep] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const list = await fetchPlans();
      setPlans(list);
      setSelectedId((prev) => prev ?? list[0]?.id ?? null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (!selectedId) {
      setDetail(null);
      return;
    }
    let cancelled = false;
    fetchPlan(selectedId)
      .then((plan) => {
        if (!cancelled) {
          setDetail(plan);
          setError(null);
        }
      })
      .catch((err) => {
        if (!cancelled) {
          setDetail(null);
          setError(err instanceof Error ? err.message : String(err));
        }
      });
    return () => {
      cancelled = true;
    };
  }, [selectedId]);

  const toggleStep = async (index: number, done: boolean) => {
    if (!selectedId) return;
    setBusyStep(index);
    setError(null);
    try {
      setDetail(await setPlanStep(selectedId, index, done));
    } catch (err) {
      // A 409 here means the file changed underneath this page, which is
      // worth saying out loud rather than silently re-rendering stale steps.
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusyStep(null);
    }
  };

  return (
    <div className="page">
      <h1>Plans</h1>
      {error && <div className="error-box">{error}</div>}
      <div className="plan-layout">
        <PlanList plans={plans} selectedId={selectedId} onSelect={setSelectedId} />
        {detail && (
          <PlanDetailView
            plan={detail}
            busyStep={busyStep}
            onToggleStep={(index, done) => void toggleStep(index, done)}
            onCopyPath={() => void navigator.clipboard?.writeText(detail.path)}
            onImplement={() => {
              // The plan's own path is what the next chat starts from: the
              // agent reads the file rather than being handed a summary of it.
              window.sessionStorage.setItem("kaprek-first-prompt", `Work through the plan at ${detail.path}. Start with the first unchecked step.`);
              navigateToChat();
            }}
          />
        )}
      </div>
    </div>
  );
}
