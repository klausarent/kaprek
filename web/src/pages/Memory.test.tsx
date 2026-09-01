import { describe, expect, test } from "vitest";
import { findByType, render, textOf } from "../test/tree";
import { MemoryRow, ProposalCard, ageLabel, orderEntries, orderScopes, provenanceLinks } from "./Memory";
import type { MemoryEntry } from "../lib/api";

const DAY = 24 * 60 * 60 * 1000;

const baseEntry: MemoryEntry = {
  id: "1",
  scopeId: "project:kaprek",
  kind: "fact",
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
  const entry = baseEntry;

  test("shows the statement and where it came from", () => {
    const text = textOf(render(<MemoryRow entry={entry} onVerify={() => {}} onForget={() => {}} />));
    expect(text).toContain("codex needs its own session id");
    expect(text).toContain("chat:abc");
  });

  test("a stale entry says so rather than disappearing", () => {
    const text = textOf(render(<MemoryRow entry={{ ...entry, stale: true, ageMs: 100 * DAY }} onVerify={() => {}} onForget={() => {}} />));
    expect(text).toContain("unverified for 100 days");
  });

  test("provenance renders as links — thread, run, file with its line range (P4b)", () => {
    const tree = render(
      <MemoryRow
        entry={{
          ...entry,
          sourceKind: "turn",
          chatId: "c-42",
          runId: "relay-run-7",
          path: "C:\\notes\\projekt.md",
          pathRange: { from: 3, to: 9 },
        }}
        onVerify={() => {}}
        onForget={() => {}}
      />,
    );
    const anchors = findByType(tree, "a");
    const hrefs = anchors.map((a) => a.props.href as string);
    expect(hrefs).toContain("#/chat/c-42");
    expect(hrefs.some((href) => href.startsWith("#/search?q=relay-run-7"))).toBe(true);
    expect(hrefs.some((href) => href.startsWith("#/search?q=C%3A%5Cnotes%5Cprojekt.md"))).toBe(true);
    expect(textOf(tree)).toContain("lines 3–9");
  });

  test("an entry without provenance is marked, not hidden (P4b)", () => {
    const text = textOf(render(<MemoryRow entry={{ ...entry, sourceKind: undefined }} onVerify={() => {}} onForget={() => {}} />));
    expect(text).toContain("codex needs its own session id");
    expect(text).toContain("ohne Herkunft");
  });

  test("an unconfirmed import says so instead of a verification age (P4b)", () => {
    const text = textOf(
      render(<MemoryRow entry={{ ...entry, lastVerifiedAt: null, unverified: true, sourceKind: "import" }} onVerify={() => {}} onForget={() => {}} />),
    );
    expect(text).toContain("unconfirmed");
    expect(text).not.toContain("verified today");
  });
});

describe("orderEntries", () => {
  test("unconfirmed entries come first, the rest keeps its order (P4b)", () => {
    const a = { ...baseEntry, id: "a" };
    const b = { ...baseEntry, id: "b", unverified: true, lastVerifiedAt: null };
    const c = { ...baseEntry, id: "c" };
    const d = { ...baseEntry, id: "d", unverified: true, lastVerifiedAt: null };
    expect(orderEntries([a, b, c, d]).map((entry) => entry.id)).toEqual(["b", "d", "a", "c"]);
  });
});

describe("provenanceLinks", () => {
  test("an entry pointing nowhere links nothing", () => {
    expect(provenanceLinks(baseEntry)).toEqual([]);
  });

  test("a file range is part of the label, not the link target", () => {
    const links = provenanceLinks({ ...baseEntry, path: "C:\\p.md", pathRange: { from: 1, to: 2 } });
    expect(links).toHaveLength(1);
    expect(links[0].label).toContain("C:\\p.md");
    expect(links[0].label).toContain("lines 1–2");
    expect(links[0].href).not.toContain("lines");
  });
});

describe("ProposalCard", () => {
  const proposal = {
    id: "p1",
    pattern: "relay step ran on the wrong engine",
    rule: "A relay step names its engine in the recipe.",
    seenIn: ["chat:1", "chat:2", "chat:3"],
    status: "proposed" as const,
    proposedAt: "2026-08-02T10:00:00.000Z",
    decidedAt: null,
    reason: null,
  };

  test("shows the rule and how often it was needed", () => {
    const text = textOf(render(<ProposalCard proposal={proposal} onDecide={() => {}} />));
    expect(text).toContain("A relay step names its engine in the recipe.");
    expect(text).toContain("seen 3 times");
  });

  test("says why it is being asked", () => {
    const text = textOf(render(<ProposalCard proposal={proposal} onDecide={() => {}} />));
    expect(text).toContain("relay step ran on the wrong engine");
  });

  test("offers both answers — a proposal nobody can refuse is not a proposal", () => {
    const text = textOf(render(<ProposalCard proposal={proposal} onDecide={() => {}} />));
    expect(text).toContain("Make it a rule");
    expect(text).toContain("No");
  });
});
