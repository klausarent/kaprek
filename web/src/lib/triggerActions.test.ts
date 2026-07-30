// Guards the two "must this be confirmed first?" decisions. These are the
// checks that a future edit wiring the toggle straight through to the API would
// have to break visibly — before the extraction, the same edit kept every test
// green.
import { test, expect } from "vitest";
import { decideDelete, decideToggle } from "./triggerActions";
import type { TriggerStatus } from "./api";

function triggerStatus(overrides: Partial<TriggerStatus> = {}): TriggerStatus {
  return {
    id: "nightly-sync",
    type: "schedule",
    config: { everyMinutes: 60 },
    promptTemplate: "Check the notes folder.",
    escalation: "notify",
    appScope: [],
    enabled: false,
    approvalRequired: false,
    limits: { maxRunsPerDay: 24, maxCostPerDay: 1 },
    runsToday: 0,
    costToday: 0,
    approvalPath: "policy",
    blocked: null,
    supported: true,
    unsupportedReason: null,
    ...overrides,
  };
}

const clipboard = triggerStatus({ id: "copy-watch", type: "clipboard", config: { matchPattern: "^TODO:" } });

test("enabling a clipboard trigger always needs the consent step first", () => {
  expect(decideToggle(clipboard, true)).toBe("needs-consent");
});

test("the consent step is what unlocks it — never the toggle on its own", () => {
  expect(decideToggle(clipboard, true, false)).toBe("needs-consent");
  expect(decideToggle(clipboard, true, true)).toBe("apply");
});

test("disabling a clipboard trigger needs no confirmation", () => {
  expect(decideToggle(clipboard, false)).toBe("apply");
});

test("no other trigger type needs consent, in either direction", () => {
  for (const type of ["heartbeat", "schedule", "file-watch", "saved-prompt"] as const) {
    const trigger = triggerStatus({ type });
    expect(decideToggle(trigger, true)).toBe("apply");
    expect(decideToggle(trigger, false)).toBe("apply");
  }
});

test("delete always needs a confirmation, and only the confirmed call applies", () => {
  expect(decideDelete()).toBe("needs-confirm");
  expect(decideDelete(false)).toBe("needs-confirm");
  expect(decideDelete(true)).toBe("apply");
});
