// Starting and stopping a relay run, from the chat that hosts it.
//
// Marked Experimental in the UI on purpose. The mechanism works and is
// bounded, but two agents handing work back and forth is a new way to spend
// money, and the label is the honest summary of how much mileage it has.
//
// RelayControls is exported hook-free so it can be tested without a DOM (see
// src/test/tree.tsx).
import { useState } from "react";
import { startRelayRun, stopRelayRun, type RelayRun } from "../lib/api";

/** How a run's state reads to a person. The status alone is jargon; this says what it means for them. */
export function relayStatusLine(relay: RelayRun): string {
  const progress = `${relay.rounds}/${relay.maxRounds} rounds, ${relay.turns} turns`;
  switch (relay.status) {
    case "active":
      return `Handing off — ${progress}`;
    case "waiting_gate":
      return `Waiting for you — ${progress}. Answer it in the questions box.`;
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

export function RelayControls({
  relay,
  goal,
  busy = false,
  error = null,
  onGoalChange,
  onStart,
  onStop,
}: {
  relay: RelayRun | null;
  goal: string;
  busy?: boolean;
  error?: string | null;
  onGoalChange: (goal: string) => void;
  onStart: () => void;
  onStop: () => void;
}) {
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
            placeholder="What should the two agents produce?"
            value={goal}
            onChange={(e) => onGoalChange(e.target.value)}
          />
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
      busy={busy}
      error={error}
      onGoalChange={setGoal}
      onStart={() => void run(() => startRelayRun(chatId, goal.trim()))}
      onStop={() => void run(() => (relay ? stopRelayRun(relay.runId) : Promise.resolve()))}
    />
  );
}
