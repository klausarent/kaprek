import { describe, expect, test } from "vitest";
import { render, textOf } from "../test/tree";
import { MemoryRow, ageLabel, orderScopes } from "./Memory";

const DAY = 24 * 60 * 60 * 1000;

describe("ageLabel", () => {
  test("says how long it has been unverified when it is stale", () => {
    expect(ageLabel({ ageMs: 95 * DAY, stale: true })).toBe("unverified for 95 days");
  });

  test("says when it was last checked otherwise", () => {
    expect(ageLabel({ ageMs: 0, stale: false })).toBe("verified today");
    expect(ageLabel({ ageMs: 1 * DAY, stale: false })).toBe("verified 1 day ago");
    expect(ageLabel({ ageMs: 3 * DAY, stale: false })).toBe("verified 3 days ago");
  });
});

describe("orderScopes", () => {
  test("puts children under their parent, indented", () => {
    const ordered = orderScopes([
      { id: "mission:m3", kind: "mission", label: "m3", parent: "project:kaprek" },
      { id: "person:local", kind: "person", label: "local", parent: null },
      { id: "project:kaprek", kind: "project", label: "kaprek", parent: "person:local" },
    ]);
    expect(ordered.map((scope) => scope.id)).toEqual(["person:local", "project:kaprek", "mission:m3"]);
    expect(ordered[2].label.startsWith("— — ")).toBe(true);
  });

  test("an orphan is not dropped from the list", () => {
    // A scope whose parent is missing still belongs on screen — losing it
    // would hide memories nobody could then find.
    const ordered = orderScopes([{ id: "project:orphan", kind: "project", label: "orphan", parent: "person:gone" }]);
    expect(ordered.map((scope) => scope.id)).toEqual([]);
  });
});

describe("MemoryRow", () => {
  const entry = {
    id: "1",
    scopeId: "project:kaprek",
    kind: "fact" as const,
    text: "codex needs its own session id",
    origin: "chat:abc",
    confidence: 0.8,
    createdAt: "2026-08-02T10:00:00.000Z",
    lastVerifiedAt: "2026-08-02T10:00:00.000Z",
    evidenceRef: null,
    forgotten: false,
    stale: false,
    ageMs: 0,
  };

  test("shows the statement and where it came from", () => {
    const text = textOf(render(<MemoryRow entry={entry} onVerify={() => {}} onForget={() => {}} />));
    expect(text).toContain("codex needs its own session id");
    expect(text).toContain("chat:abc");
  });

  test("a stale entry says so rather than disappearing", () => {
    const text = textOf(render(<MemoryRow entry={{ ...entry, stale: true, ageMs: 100 * DAY }} onVerify={() => {}} onForget={() => {}} />));
    expect(text).toContain("unverified for 100 days");
  });
});
