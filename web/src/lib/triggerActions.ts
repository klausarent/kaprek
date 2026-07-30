// The two decisions the trigger page must never get wrong, as pure functions:
// which actions need an explicit confirmation step before they happen.
//
// They live here rather than inside the page's event handlers because that is
// what makes them testable at all — a handler inside a hook-using container is
// unreachable for this repo's element-walker tests, so a future edit that wired
// the toggle straight through to the API would have kept every test green.
import type { TriggerStatus } from "./api";

export type ToggleDecision = "needs-consent" | "apply";
export type DeleteDecision = "needs-confirm" | "apply";

/**
 * Whether flipping this trigger's switch may take effect right away.
 *
 * ENABLING a clipboard trigger always needs the consent step first: it turns on
 * "kaprek reads everything you copy", and a checkbox is not consent for that.
 * DISABLING never needs one (stopping something is always safe), and no other
 * trigger type does either.
 */
export function decideToggle(trigger: TriggerStatus, enabled: boolean, confirmed = false): ToggleDecision {
  if (trigger.type === "clipboard" && enabled && !confirmed) return "needs-consent";
  return "apply";
}

/** Deleting removes a trigger's whole configuration, so it takes a confirmation — a mis-click must not silently drop something that was running on its own. */
export function decideDelete(confirmed = false): DeleteDecision {
  return confirmed ? "apply" : "needs-confirm";
}
