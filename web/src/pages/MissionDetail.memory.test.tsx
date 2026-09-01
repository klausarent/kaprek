// P4a, UI layer: the mission memory card. Rendered on the element-tree level
// like the other page tests (see test/tree.tsx) — the card body is
// hook-free on purpose so no DOM is needed.
import { describe, expect, test } from "vitest";
import { render, textOf, findAll, findOneByText, click } from "../test/tree";
import {
  FORGET_REACH_WARNING,
  MissionMemoryCardBody,
  MissionMemoryRow,
  projectScopeOf,
} from "./MissionDetail";
import type { MissionMemory, MissionMemoryEntry } from "../lib/api";

const DAY = 24 * 60 * 60 * 1000;

function entry(overrides: Partial<MissionMemoryEntry> = {}): MissionMemoryEntry {
  return {
    id: "e1",
    scope: "project:kaprek",
    scopeKind: "project",
    kind: "fact",
    text: "the build needs Node 22",
    origin: "chat:abc",
    confidence: 0.8,
    firstSeenAt: "2026-09-01T10:00:00.000Z",
    lastVerifiedAt: "2026-09-01T10:00:00.000Z",
    stale: false,
    ageMs: 0,
    confirmations: 1,
    origins: ["chat:abc"],
    ...overrides,
  };
}

function memory(overrides: Partial<MissionMemory> = {}): MissionMemory {
  return {
    missionId: "m1",
    scopeId: "mission:m1",
    visibleScopes: ["mission:m1", "project:kaprek", "person:local"],
    counts: { mission: 1, project: 2, person: 1 },
    entries: [],
    recent: [entry()],
    readOnly: false,
    ...overrides,
  };
}

describe("MissionMemoryCardBody", () => {
  test("shows the last-written entries, a count per scope, and the scope reach warning — before any click", () => {
    const text = textOf(render(<MissionMemoryCardBody memory={memory()} confirmId={null} onRequestForget={() => {}} onCancelForget={() => {}} onConfirmForget={() => {}} />));
    expect(text).toContain("the build needs Node 22");
    expect(text).toContain("mission: 1 · project: 2 · person: 1");
    expect(text).toContain(FORGET_REACH_WARNING);
    // The scope the entry belongs to is on screen, so shared reach is
    // attributable at a glance.
    expect(text).toContain("project:kaprek");
  });

  test("the warning names the cross-mission reach before the Forget button does anything", () => {
    const root = render(<MissionMemoryCardBody memory={memory()} confirmId={null} onRequestForget={() => {}} onCancelForget={() => {}} onConfirmForget={() => {}} />);
    // Warning is present in the same render as the button that would start
    // the forget — nothing has to be clicked to read it.
    findOneByText(root, "button", "Forget");
    expect(textOf(root)).toContain("other missions of the same chain");
  });

  test("the first click only opens the confirmation; the second is the delete", () => {
    const requested: string[] = [];
    const confirmed: string[] = [];
    const root = render(
      <MissionMemoryCardBody
        memory={memory()}
        confirmId={null}
        onRequestForget={(id) => requested.push(id)}
        onCancelForget={() => {}}
        onConfirmForget={(id) => confirmed.push(id)}
      />,
    );
    click(findOneByText(root, "button", "Forget"));
    expect(requested).toEqual(["e1"]);
    expect(confirmed).toEqual([]);

    // The confirmation step, rendered with confirmId set, repeats the
    // warning and offers both ways out.
    const confirmRoot = render(
      <MissionMemoryCardBody
        memory={memory()}
        confirmId="e1"
        onRequestForget={() => {}}
        onCancelForget={() => {}}
        onConfirmForget={(id) => confirmed.push(id)}
      />,
    );
    expect(textOf(confirmRoot)).toContain(FORGET_REACH_WARNING);
    click(findOneByText(confirmRoot, "button", "Really forget"));
    expect(confirmed).toEqual(["e1"]);
    click(findOneByText(confirmRoot, "button", "Keep it"));
  });

  test("a read-only store (P0.5) still shows entries, with the hint and without Forget", () => {
    const root = render(<MissionMemoryCardBody memory={memory({ readOnly: true })} confirmId={null} onRequestForget={() => {}} onCancelForget={() => {}} onConfirmForget={() => {}} />);
    const text = textOf(root);
    expect(text).toContain("the build needs Node 22");
    expect(text).toContain("written by a newer kaprek version — read-only here");
    expect(findAll(root, (node) => node.type === "button" && textOf(node).trim() === "Forget")).toEqual([]);
  });

  test("five last-written are the card's slice — the rest stays on the memory page", () => {
    const recent = [1, 2, 3, 4, 5].map((n) => entry({ id: `e${n}`, text: `fact ${n}` }));
    const root = render(<MissionMemoryCardBody memory={memory({ recent })} confirmId={null} onRequestForget={() => {}} onCancelForget={() => {}} onConfirmForget={() => {}} />);
    for (let n = 1; n <= 5; n++) expect(textOf(root)).toContain(`fact ${n}`);
  });

  test("an empty chain is a readable nothing, not an error", () => {
    const text = textOf(render(<MissionMemoryCardBody memory={memory({ recent: [], counts: {} })} confirmId={null} onRequestForget={() => {}} onCancelForget={() => {}} onConfirmForget={() => {}} />));
    expect(text).toContain("Nothing readable yet");
  });
});

describe("MissionMemoryRow", () => {
  test("a stale entry says so instead of hiding", () => {
    const text = textOf(render(<MissionMemoryRow entry={entry({ stale: true, ageMs: 100 * DAY })} confirmOpen={false} onRequestForget={() => {}} onConfirmForget={() => {}} onCancelForget={() => {}} />));
    expect(text).toContain("stale");
    expect(text).toContain("100 days");
  });

  test("a shared-scope confirmation says the entry is not this mission's alone", () => {
    const text = textOf(render(<MissionMemoryRow entry={entry({ scope: "person:local", scopeKind: "person" })} confirmOpen onRequestForget={() => {}} onConfirmForget={() => {}} onCancelForget={() => {}} />));
    expect(text).toContain("This entry lives outside this mission");
  });
});

describe("projectScopeOf", () => {
  test("the deep link pre-selects the project scope — the widest the mission can read", () => {
    expect(projectScopeOf(memory())).toBe("project:kaprek");
    // No project in the chain (scope tree not built yet): fall back to the
    // mission scope rather than a dead link.
    expect(projectScopeOf(memory({ visibleScopes: ["mission:m1"], scopeId: "mission:m1" }))).toBe("mission:m1");
  });
});

describe("routing", () => {
  test("#/memory carries the preset scope filter through parseRoute", async () => {
    const { parseRoute } = await import("../App");
    const route = parseRoute("#/memory?scope=project%3Akaprek");
    expect(route).toEqual({ name: "memory", scopeId: "project:kaprek" });
    expect(parseRoute("#/memory")).toEqual({ name: "memory", scopeId: undefined });
  });
});
