// "You have asked for this three times" — the one nudge towards a trigger.
// Shown once per repeated request; dismissing it is remembered, because a
// suggestion that comes back after you said no is not a suggestion.
import { useEffect, useState } from "react";
import { fetchRepeats, type RepeatSuggestion } from "../lib/api";
import { navigateToTriggers } from "../App";

const DISMISSED_KEY = "kaprek-dismissed-repeats";

function readDismissed(): string[] {
  try {
    const raw = window.localStorage.getItem(DISMISSED_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed.filter((k) => typeof k === "string") : [];
  } catch {
    return [];
  }
}

export default function RepeatHint({ reloadKey }: { reloadKey: number }) {
  const [suggestion, setSuggestion] = useState<RepeatSuggestion | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetchRepeats()
      .then((repeats) => {
        if (cancelled) return;
        const dismissed = readDismissed();
        setSuggestion(repeats.find((r) => !dismissed.includes(r.key)) ?? null);
      })
      .catch(() => setSuggestion(null));
    return () => {
      cancelled = true;
    };
  }, [reloadKey]);

  if (!suggestion) return null;

  const dismiss = () => {
    try {
      window.localStorage.setItem(DISMISSED_KEY, JSON.stringify([...readDismissed(), suggestion.key]));
    } catch {
      // storage blocked — hiding it for this session is still right
    }
    setSuggestion(null);
  };

  return (
    <div className="repeat-hint">
      <span>
        You have asked for this {suggestion.count} times: <em>{suggestion.sample.slice(0, 90)}</em>. Run it on a schedule
        instead?
      </span>
      <span className="repeat-hint-actions">
        <button type="button" className="btn btn-small" onClick={() => navigateToTriggers()}>
          Set up a trigger
        </button>
        <button type="button" className="link-button" onClick={dismiss}>
          No thanks
        </button>
      </span>
    </div>
  );
}
