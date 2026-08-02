import { describe, expect, test } from "vitest";
import { render, textOf } from "../test/tree";
import CouncilPanel, { headline } from "./CouncilPanel";
import type { Consultation } from "../lib/api";

const base: Consultation = { consensus: true, empty: false, agreed: ["codex", "grok"], dissenting: [], unreachable: [] };

describe("the headline", () => {
  test("names disagreement before agreement, because that is the answer worth reading", () => {
    expect(headline(base)).toBe("All 2 agree");
    expect(
      headline({ ...base, consensus: false, agreed: ["codex"], dissenting: [{ peerId: "grok", verdict: "disagree", summary: "no", risks: [] }] }),
    ).toContain("disagree");
    expect(
      headline({ ...base, consensus: false, agreed: ["codex"], dissenting: [{ peerId: "grok", verdict: "concerns", summary: "hm", risks: [] }] }),
    ).toContain("concerns");
  });

  test("nobody to ask is stated, not dressed up as agreement", () => {
    const empty = headline({ ...base, empty: true, consensus: false, agreed: [], reason: "Only one engine is installed" });
    expect(empty).toContain("Only one engine");
    expect(headline({ ...base, empty: true, consensus: false, agreed: [] })).toContain("No peer answered");
  });
});

describe("the panel", () => {
  test("a dissenting peer gets its own words and its risks", () => {
    const text = textOf(
      render(
        <CouncilPanel
          consultation={{
            ...base,
            consensus: false,
            agreed: ["codex"],
            dissenting: [{ peerId: "grok", verdict: "disagree", summary: "the containment check is lexical", risks: ["a junction escapes it"] }],
          }}
        />,
      ),
    );
    expect(text).toContain("grok");
    expect(text).toContain("the containment check is lexical");
    expect(text).toContain("a junction escapes it");
    // Agreement is not hidden, just not the headline.
    expect(text).toContain("codex");
  });

  test("a peer that never answered is named with its reason", () => {
    const text = textOf(render(<CouncilPanel consultation={{ ...base, unreachable: [{ peerId: "grok", error: "no answer within 240s" }] }} />));
    expect(text).toContain("no answer within 240s");
  });

  test("asking shows that it is happening, and nothing shows before it starts", () => {
    expect(textOf(render(<CouncilPanel consultation={null} busy />))).toContain("Asking the other engines");
    expect(textOf(render(<CouncilPanel consultation={null} />))).toBe("");
  });
});
