// Starting and stopping a relay run, from the chat that hosts it.
//
// Marked Experimental in the UI on purpose. The mechanism works and is
// bounded, but two agents handing work back and forth is a new way to spend
// money, and the label is the honest summary of how much mileage it has.
//
// RelayControls is exported hook-free so it can be tested without a DOM (see
// src/test/tree.tsx).
import { useEffect, useState } from "react";
import { fetchRecipes, startRelayRun, stopRelayRun, type Recipe, type RelayRun } from "../lib/api";

/** Why a run is parked, in the words of what it is actually waiting for. */
function waitingFor(relay: RelayRun): string {
  if (relay.gateReason === "edge") return `Waiting for you before it hands off to ${relay.stepId ?? "the next step"}`;
  if (relay.gateReason === "peer") return "Waiting for you — a handoff kept failing";
  return "Waiting for you";
}

/** How a run's state reads to a person. The status alone is jargon; this says what it means for them. */
export function relayStatusLine(relay: RelayRun): string {
  const progress = `${relay.rounds}/${relay.maxRounds} rounds, ${relay.turns} turns`;
  switch (relay.status) {
    case "active":
      return `Handing off — ${progress}`;
    case "waiting_gate":
      return `${waitingFor(relay)} — ${progress}. Answer it in the questions box.`;
    case "interrupted":
      return `Interrupted — kaprek stopped mid-handoff. Nothing was repeated automatically; start a new run when you want to continue.`;
    case "completed":
      return `Finished — ${progress}`;
    case "stopped":
      return `Stopped — ${progress}`;
    default:
      return progress;
  }
}

/** One line describing what a recipe will do, for the picker. */
export function recipeSummary(recipe: Recipe): string {
  const chain = recipe.steps.map((step) => step.agent).join(" → ");
  const gates = recipe.edges.filter((edge) => edge.requiresHuman).length;
  const writes = recipe.steps.filter((step) => step.tools === "full").map((step) => step.id);
  const parts = [chain];
  // Both of these change what a run can do to the machine, so neither is
  // left for the person to discover from the recipe file.
  if (writes.length > 0) parts.push(`${writes.join(", ")} may change files`);
  parts.push(gates > 0 ? `asks you at ${gates} handoff${gates === 1 ? "" : "s"}` : "asks you at the round gate only");
  return parts.join(" · ");
}

export function RelayControls({
  relay,
  goal,
  recipes = [],
  recipeId = "",
  busy = false,
  error = null,
  onGoalChange,
  onRecipeChange,
  onStart,
  onStop,
}: {
  relay: RelayRun | null;
  goal: string;
  recipes?: Recipe[];
  recipeId?: string;
  busy?: boolean;
  error?: string | null;
  onGoalChange: (goal: string) => void;
  onRecipeChange?: (id: string) => void;
  onStart: () => void;
  onStop: () => void;
}) {
  const chosen = recipes.find((recipe) => recipe.id === recipeId) ?? null;
  const running = relay !== null && ["active", "waiting_gate"].includes(relay.status);

  return (
    <div className="relay-panel">
      <div className="relay-panel-head">
        <span className="relay-panel-title">Relay</span>
        <span className="badge badge-muted">Experimental</span>
        {relay && <span className="badge">{relay.route.join(" → ")}</span>}
      </div>

      {relay && <div className="relay-panel-status">{relayStatusLine(relay)}</div>}
      {error && <div className="error-box">{error}</div>}

      {running ? (
        <button type="button" className="btn btn-danger" disabled={busy} onClick={onStop}>
          Stop the run
        </button>
      ) : (
        <div className="relay-panel-form">
          <input
            className="search-input"
            type="text"
            placeholder="What should the agents produce?"
            value={goal}
            onChange={(e) => onGoalChange(e.target.value)}
          />
          {recipes.length > 0 && (
            <select className="select" value={recipeId} onChange={(e) => onRecipeChange?.(e.target.value)} aria-label="Recipe">
              {recipes.map((recipe) => (
                <option key={recipe.id} value={recipe.id}>
                  {recipe.title}
                </option>
              ))}
            </select>
          )}
          {chosen && <div className="relay-recipe-summary">{recipeSummary(chosen)}</div>}
          <button type="button" className="btn" disabled={busy || goal.trim().length === 0} onClick={onStart}>
            Start a relay run
          </button>
        </div>
      )}
    </div>
  );
}

export default function RelayPanel({ chatId, relay, onChanged }: { chatId: string | undefined; relay: RelayRun | null; onChanged?: () => void }) {
  const [goal, setGoal] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [recipes, setRecipes] = useState<Recipe[]>([]);
  const [recipeId, setRecipeId] = useState("");

  useEffect(() => {
    let cancelled = false;
    fetchRecipes()
      .then((loaded) => {
        if (cancelled) return;
        setRecipes(loaded);
        // The first one is the v1 pairing, which is what someone who does not
        // pick anything should get.
        setRecipeId((current) => current || (loaded[0]?.id ?? ""));
      })
      .catch(() => {
        // No catalog: the panel still starts a run on the default pairing.
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (!chatId) return null;

  const run = async (action: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await action();
      onChanged?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <RelayControls
      relay={relay}
      goal={goal}
      recipes={recipes}
      recipeId={recipeId}
      busy={busy}
      error={error}
      onGoalChange={setGoal}
      onRecipeChange={setRecipeId}
      onStart={() => void run(() => startRelayRun(chatId, goal.trim(), recipeId ? { recipeId } : {}))}
      onStop={() => void run(() => (relay ? stopRelayRun(relay.runId) : Promise.resolve()))}
    />
  );
}
