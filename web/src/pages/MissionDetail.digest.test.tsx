// P8, UI layer: the mission digest card. Rendered on the element-tree level
// like the memory card test (see test/tree.tsx) — the card body is
// hook-free on purpose so no DOM is needed.
import { describe, expect, test } from "vitest";
import { render, textOf, findOneByText, findAll, click } from "../test/tree";
import { DIGEST_WINDOW_NOTE, MissionDigestCardBody } from "./MissionDetail";

const MARKDOWN = [
  "# Morning digest — Zaehler-Service",
  "",
  "Fenster: 31.08.2026, lokaler Tag — 24 h Fenster",
  "",
  "## Trigger-Läufe",
  "",
  "### t-nightly",
  "",
  "- gelaufen — $0.0100, 1000 Tokens, Dauer 12,3 s",
  "",
  "## Kosten und Tokens",
  "",
  "Kosten bekannt für 1 von 1 Läufen.",
].join("\n");

function body(overrides: Partial<Parameters<typeof MissionDigestCardBody>[0]> = {}) {
  return {
    markdown: null as string | null,
    files: [],
    windowNote: DIGEST_WINDOW_NOTE,
    loading: false,
    onBuild: () => {},
    onListFiles: () => {},
    ...overrides,
  };
}

describe("MissionDigestCardBody", () => {
  test("shows the build button, the window note, and the empty state before anything is built", () => {
    const root = render(<MissionDigestCardBody {...body()} />);
    findOneByText(root, "button", "Digest erzeugen/aktualisieren");
    expect(textOf(root)).toContain("yesterday's local day");
    expect(textOf(root)).toContain("23 or 25 hours");
    expect(textOf(root)).toContain("No digest built yet");
  });

  test("previews the built markdown as plain text in a pre-block — no renderer", () => {
    const root = render(<MissionDigestCardBody {...body({ markdown: MARKDOWN })} />);
    const pres = findAll(root, (node) => node.type === "pre");
    expect(pres).toHaveLength(1);
    expect(textOf(pres[0])).toContain("# Morning digest — Zaehler-Service");
    expect(textOf(pres[0])).toContain("Kosten bekannt");
  });

  test("the build button fires onBuild; the file-list button fires onListFiles", () => {
    let built = 0;
    let listed = 0;
    const root = render(<MissionDigestCardBody {...body({ onBuild: () => (built += 1), onListFiles: () => (listed += 1) })} />);
    click(findOneByText(root, "button", "Digest erzeugen/aktualisieren"));
    click(findOneByText(root, "button", "Digest-Dateien (0)"));
    expect(built).toBe(1);
    expect(listed).toBe(1);
  });

  test("lists the stored digest files with their sizes", () => {
    const root = render(
      <MissionDigestCardBody {...body({ files: [{ name: "01.09.2026.md", path: "C:/d/01.09.2026.md", bytes: 512 }] })} />,
    );
    expect(textOf(root)).toContain("01.09.2026.md");
    expect(textOf(root)).toContain("512 bytes");
  });

  test("loading state disables the build button", () => {
    const root = render(<MissionDigestCardBody {...body({ loading: true })} />);
    const button = findOneByText(root, "button", "Building…");
    expect((button.props as { disabled?: boolean }).disabled).toBe(true);
  });
});
