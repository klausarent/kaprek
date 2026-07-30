import { test, expect } from "vitest";
import {
  emptyTriggerForm,
  formFieldForServerField,
  formToTrigger,
  triggerToForm,
  type TriggerFormValue,
} from "./triggerForm";
import type { Trigger } from "./api";

function form(overrides: Partial<TriggerFormValue> = {}): TriggerFormValue {
  return { ...emptyTriggerForm(), id: "nightly-sync", promptTemplate: "Check the notes.", ...overrides };
}

test("formToTrigger builds a heartbeat config and always sends an empty appScope", () => {
  const payload = formToTrigger(form({ type: "heartbeat", intervalMinutes: "30", checklistPath: "TODO.md" }));
  expect(payload).toMatchObject({
    id: "nightly-sync",
    type: "heartbeat",
    config: { intervalMinutes: 30, checklistPath: "TODO.md" },
    appScope: [],
    escalation: "notify",
  });
});

test("formToTrigger sends exactly one of everyMinutes / dailyAt, per the schedule mode", () => {
  expect(formToTrigger(form({ type: "schedule", scheduleMode: "everyMinutes", everyMinutes: "15" })).config).toEqual({
    everyMinutes: 15,
  });
  expect(formToTrigger(form({ type: "schedule", scheduleMode: "dailyAt", dailyAt: "07:30" })).config).toEqual({
    dailyAt: "07:30",
  });
});

test("formToTrigger omits a blank numeric field instead of sending NaN or 0", () => {
  const payload = formToTrigger(form({ type: "heartbeat", intervalMinutes: "", checklistPath: "  " }));
  expect(payload.config).toEqual({});
  const limits = formToTrigger(form({ maxRunsPerDay: "", maxCostPerDay: "" })).limits;
  expect(limits).toEqual({});
});

test("formToTrigger keeps the selected file-watch events and drops an empty selection", () => {
  const some = formToTrigger(form({ type: "file-watch", watchPath: "notes", watchEvents: ["change"], debounceMs: "800" }));
  expect(some.config).toEqual({ path: "notes", events: ["change"], debounceMs: 800 });
  const none = formToTrigger(form({ type: "file-watch", watchPath: "notes", watchEvents: [] }));
  expect(none.config).toEqual({ path: "notes", debounceMs: 500 });
});

test("formToTrigger sends a saved-prompt trigger with an empty config object", () => {
  expect(formToTrigger(form({ type: "saved-prompt" })).config).toEqual({});
});

test("triggerToForm round-trips a stored trigger back into the form", () => {
  const stored: Trigger = {
    id: "watch-notes",
    type: "file-watch",
    config: { path: "notes", events: ["change"], debounceMs: 900 },
    promptTemplate: "Summarize what changed.",
    escalation: "question",
    appScope: [],
    enabled: true,
    approvalRequired: true,
    limits: { maxRunsPerDay: 6, maxCostPerDay: 0.5 },
  };
  const value = triggerToForm(stored);
  expect(value).toMatchObject({
    id: "watch-notes",
    type: "file-watch",
    escalation: "question",
    enabled: true,
    watchPath: "notes",
    watchEvents: ["change"],
    debounceMs: "900",
    maxRunsPerDay: "6",
    maxCostPerDay: "0.5",
  });
  expect(formToTrigger(value).config).toEqual({ path: "notes", events: ["change"], debounceMs: 900 });
});

test("triggerToForm picks the dailyAt schedule mode from the stored config", () => {
  const base: Omit<Trigger, "id" | "type" | "config"> = {
    promptTemplate: "x",
    escalation: "notify",
    appScope: [],
    enabled: false,
    approvalRequired: false,
    limits: { maxRunsPerDay: 1, maxCostPerDay: 1 },
  };
  expect(triggerToForm({ ...base, id: "a", type: "schedule", config: { dailyAt: "23:00" } }).scheduleMode).toBe("dailyAt");
  expect(triggerToForm({ ...base, id: "a", type: "schedule", config: { everyMinutes: 30 } }).scheduleMode).toBe("everyMinutes");
});

test("formFieldForServerField maps a server field name onto the input that caused it", () => {
  expect(formFieldForServerField("config.intervalMinutes")).toBe("intervalMinutes");
  expect(formFieldForServerField("config.matchPattern")).toBe("matchPattern");
  expect(formFieldForServerField("limits.maxCostPerDay")).toBe("maxCostPerDay");
  // The schedule XOR rule is reported on `config` itself — that belongs to the
  // mode radio, not to either number field.
  expect(formFieldForServerField("config")).toBe("scheduleMode");
  expect(formFieldForServerField("<root>")).toBeNull();
  expect(formFieldForServerField(null)).toBeNull();
});
