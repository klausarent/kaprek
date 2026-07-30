import { test, expect } from "vitest";
import { AppCard, BlockedAppCard, policyNotes } from "./Apps";
import type { AppSummary } from "../lib/api";
import { findByType, render, textOf } from "../test/tree";

function app(overrides: Partial<AppSummary> = {}): AppSummary {
  return {
    id: "notes",
    name: "Notes",
    description: "Write a short markdown note to your local workspace.",
    icon: "📝",
    version: "1.0.0",
    toolCount: 1,
    policy: { fsWrite: true, dataEgress: false, externalAction: "never", sensitivity: "low" },
    uiSlot: "text",
    source: "bundled",
    ...overrides,
  };
}

test("a card shows name, icon, description, tool count, version and source", () => {
  const text = textOf(render(<AppCard app={app()} />));
  expect(text).toContain("Notes");
  expect(text).toContain("📝");
  expect(text).toContain("Write a short markdown note");
  expect(text).toContain("1 tool");
  expect(text).toContain("v1.0.0");
  expect(text).toContain("bundled");
});

test("the tool count is pluralized", () => {
  expect(textOf(render(<AppCard app={app({ toolCount: 3 })} />))).toContain("3 tools");
});

test("an app without an icon falls back instead of rendering nothing", () => {
  expect(textOf(render(<AppCard app={app({ icon: null })} />))).toContain("🧩");
});

test("a card is read-only — no install, enable or run control", () => {
  const tree = render(<AppCard app={app()} />);
  expect(findByType(tree, "button")).toHaveLength(0);
  expect(findByType(tree, "input")).toHaveLength(0);
});

test("policyNotes always leads with whether data can leave the machine", () => {
  expect(policyNotes(app().policy)[0]).toContain("Stays on this machine");
  expect(policyNotes(app({ policy: { ...app().policy, dataEgress: true } }).policy)[0]).toContain("May send data off this machine");
});

test("policyNotes names writing, external action and sensitivity when they apply", () => {
  const notes = policyNotes({ fsWrite: true, dataEgress: true, externalAction: "auto", sensitivity: "high" });
  expect(notes.join(" ")).toContain("Writes files in your workspace");
  expect(notes.join(" ")).toContain("Acts on the outside world without asking");
  expect(notes.join(" ")).toContain("high sensitivity");
});

test("policyNotes stays quiet about what an app cannot do", () => {
  const notes = policyNotes({ fsWrite: false, dataEgress: false, externalAction: "never", sensitivity: "low" });
  expect(notes).toEqual(["🔒 Stays on this machine"]);
});

test("a blocked third-party app is shown as switched off, with the reason and the way in", () => {
  const tree = render(<BlockedAppCard app={{ id: "weather" }} />);
  const text = textOf(tree);
  expect(text).toContain("weather");
  expect(text).toContain("not loaded");
  expect(text).toContain("share one process");
  expect(text).toContain("KAPREK_ALLOW_USER_APPS=1");
});

test("a blocked card offers no way to enable it from the UI", () => {
  // The opt-in is env-only on purpose: a click would make it a routine choice.
  const tree = render(<BlockedAppCard app={{ id: "weather" }} />);
  expect(findByType(tree, "button")).toHaveLength(0);
  expect(findByType(tree, "input")).toHaveLength(0);
});

test("an approval-gated external action is distinguished from an unattended one", () => {
  const notes = policyNotes({ fsWrite: false, dataEgress: false, externalAction: "approval", sensitivity: "low" });
  expect(notes.join(" ")).toContain("Asks before acting on the outside world");
  expect(notes.join(" ")).not.toContain("without asking");
});
