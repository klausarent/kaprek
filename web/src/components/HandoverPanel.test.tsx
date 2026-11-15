import { describe, it, expect, vi } from "vitest";
import { HandoverPanel } from "./HandoverPanel";
import type { Handover, HandoverOverview, SwitchView } from "../lib/handover";
import { click, findByType, render, textOf } from "../test/tree";

const counts = (over: Partial<Record<Handover["status"], number>> = {}): SwitchView["counts"] => ({
  nothing: 0,
  pending: 0,
  failed: 0,
  unknown: 0,
  spawned: 0,
  running: 0,
  ...over,
});

const h = (over: Partial<Handover>): Handover => ({
  handoverId: "h1",
  sessionId: "s1",
  cwd: "C:\\p\\projekt",
  file: "status.md",
  section: "Übergabe",
  prompt: null,
  title: "Aufgabe A",
  note: null,
  nothingOpen: false,
  recordedAt: "2026-11-15T07:00:00.000Z",
  status: "pending",
  startedAt: null,
  lastError: null,
  newSessionId: null,
  attempts: 0,
  ...over,
});

const view = (over: Partial<SwitchView> = {}): SwitchView => ({
  switchId: "sw1",
  openedAt: "2026-11-15T07:00:00.000Z",
  note: null,
  counts: counts({ pending: 1 }),
  handovers: [h({})],
  missing: [],
  ...over,
});

const overview = (over: Partial<HandoverOverview> = {}): HandoverOverview => ({ current: view(), history: [], ...over });

const baseProps = {
  account: "login" as const,
  onAccountChange: () => {},
  skip: true,
  onSkipChange: () => {},
  onStartAll: () => {},
  onStartOne: () => {},
  busy: false,
  statusText: "",
};

describe("HandoverPanel", () => {
  it("shows the empty box when no switch has been recorded yet", () => {
    const tree = render(<HandoverPanel overview={overview({ current: null })} {...baseProps} />);
    expect(textOf(tree)).toContain("Noch kein Kontowechsel protokolliert");
  });

  it("renders the summary, each handover's title/status, cwd and file", () => {
    const tree = render(<HandoverPanel overview={overview()} {...baseProps} />);
    const text = textOf(tree);
    expect(text).toContain("1 warten");
    expect(text).toContain("Aufgabe A");
    expect(text).toContain("wartet");
    expect(text).toContain("C:\\p\\projekt");
    expect(text).toContain("status.md");
    expect(text).toContain("Übergabe");
  });

  it("'Alle neu starten' shows the startable count and fires onStartAll", () => {
    const onStartAll = vi.fn();
    const tree = render(
      <HandoverPanel overview={overview()} {...baseProps} onStartAll={onStartAll} />,
    );
    const allButton = findByType(tree, "button").find((b) => textOf(b).includes("Alle neu starten"));
    expect(allButton && textOf(allButton)).toContain("Alle neu starten (1)");
    click(allButton!);
    expect(onStartAll).toHaveBeenCalled();
  });

  it("disables 'Alle neu starten' when nothing is startable, even while idle", () => {
    const tree = render(
      <HandoverPanel overview={overview({ current: view({ counts: counts({ running: 1 }), handovers: [h({ status: "running" })] }) })} {...baseProps} />,
    );
    const allButton = findByType(tree, "button").find((b) => textOf(b).includes("Alle neu starten"));
    expect(allButton?.props.disabled).toBe(true);
  });

  it("a pending/failed row offers 'Neu starten' and calls onStartOne with again=false", () => {
    const onStartOne = vi.fn();
    const tree = render(<HandoverPanel overview={overview()} {...baseProps} onStartOne={onStartOne} />);
    const row = findByType(tree, "button").find((b) => textOf(b) === "Neu starten");
    expect(row).toBeTruthy();
    click(row!);
    expect(onStartOne).toHaveBeenCalledWith("sw1", "h1", false);
  });

  it("an unknown/spawned/running row offers 'Nochmal starten' and calls onStartOne with again=true", () => {
    const onStartOne = vi.fn();
    const tree = render(
      <HandoverPanel
        overview={overview({ current: view({ handovers: [h({ status: "running", newSessionId: "abcdef1234567890" })] }) })}
        {...baseProps}
        onStartOne={onStartOne}
      />,
    );
    const text = textOf(tree);
    expect(text).toContain("abcdef12");
    const row = findByType(tree, "button").find((b) => textOf(b) === "Nochmal starten");
    expect(row).toBeTruthy();
    click(row!);
    expect(onStartOne).toHaveBeenCalledWith("sw1", "h1", true);
  });

  it("a 'nothing' row offers no restart button", () => {
    const tree = render(
      <HandoverPanel overview={overview({ current: view({ handovers: [h({ status: "nothing" })] }) })} {...baseProps} />,
    );
    const buttons = findByType(tree, "button").filter((b) => textOf(b).includes("starten") && textOf(b) !== "Alle neu starten (0)");
    expect(buttons).toEqual([]);
  });

  it("shows the lastError for a failed handover", () => {
    const tree = render(
      <HandoverPanel
        overview={overview({ current: view({ handovers: [h({ status: "failed", lastError: "spawn ENOENT" })] }) })}
        {...baseProps}
      />,
    );
    expect(textOf(tree)).toContain("spawn ENOENT");
  });

  it("shows the 'Noch ohne Meldung' section only when there are missing sessions", () => {
    const withoutMissing = render(<HandoverPanel overview={overview()} {...baseProps} />);
    expect(textOf(withoutMissing)).not.toContain("Noch ohne Meldung");

    const withMissing = render(
      <HandoverPanel
        overview={overview({ current: view({ missing: [{ sessionId: "abcdef1234567890", cwd: "C:\\q", title: "Verwaist" }] }) })}
        {...baseProps}
      />,
    );
    const text = textOf(withMissing);
    expect(text).toContain("Noch ohne Meldung");
    expect(text).toContain("Verwaist");
    expect(text).toContain("abcdef12");
  });

  it("shows 'Frühere Wechsel' only when history is non-empty", () => {
    const withoutHistory = render(<HandoverPanel overview={overview()} {...baseProps} />);
    expect(textOf(withoutHistory)).not.toContain("Frühere Wechsel");

    const withHistory = render(
      <HandoverPanel
        overview={overview({ history: [view({ switchId: "sw0", note: "alter Wechsel", counts: counts({ nothing: 3 }) })] })}
        {...baseProps}
      />,
    );
    const text = textOf(withHistory);
    expect(text).toContain("Frühere Wechsel");
    expect(text).toContain("alter Wechsel");
    expect(text).toContain("3 nichts offen");
  });

  it("shows a status text and marks a 'Fehler:'-prefixed one as an error", () => {
    const okTree = render(<HandoverPanel overview={overview()} {...baseProps} statusText="2/2 Tabs geöffnet" />);
    const okSpan = findByType(okTree, "span").find((n) => textOf(n).includes("Tabs geöffnet"));
    expect(okSpan?.props.className).toBe("handover-status");

    const errTree = render(<HandoverPanel overview={overview()} {...baseProps} statusText="Fehler: Ein anderer Start läuft gerade." />);
    const errSpan = findByType(errTree, "span").find((n) => textOf(n).includes("Fehler:"));
    expect(errSpan?.props.className).toContain("handover-status-error");
  });

  it("disables every row button while busy", () => {
    const tree = render(<HandoverPanel overview={overview()} {...baseProps} busy />);
    expect(findByType(tree, "button").every((b) => b.props.disabled === true)).toBe(true);
  });

  it("warns that nobody has logged in to another account yet — only for a start on the logged-in account", () => {
    const stale = overview({ current: view({ loginUnchanged: true }) });
    expect(textOf(render(<HandoverPanel overview={stale} {...baseProps} />))).toContain("Angemeldet ist noch das Konto");
    expect(textOf(render(<HandoverPanel overview={stale} {...baseProps} account="auto" />))).not.toContain("Angemeldet ist noch das Konto");
    expect(textOf(render(<HandoverPanel overview={overview()} {...baseProps} />))).not.toContain("Angemeldet ist noch das Konto");
  });

  it("shows the instruction a session left and says what an unconfirmed tab means", () => {
    const tree = render(
      <HandoverPanel
        overview={overview({ current: view({ handovers: [h({ prompt: "Zuerst K7 einsammeln.", status: "spawned" }), h({ handoverId: "h2", status: "unknown" })] }) })}
        {...baseProps}
      />,
    );
    const text = textOf(tree);
    expect(text).toContain("Auftrag: Zuerst K7 einsammeln.");
    expect(text).toContain("die neue Session wurde noch nicht gesehen");
    expect(text).toContain("das Ergebnis fehlt im Protokoll");
  });

  it("keeps handovers an earlier switch still holds on the page, startable in their own switch", () => {
    const onStartOne = vi.fn();
    const earlier = view({ switchId: "sw0", counts: counts({ pending: 1, running: 1 }), handovers: [h({ handoverId: "h9", title: "Liegengeblieben" }), h({ handoverId: "h8", title: "Läuft schon", status: "running" })] });
    const tree = render(<HandoverPanel overview={overview({ history: [earlier] })} {...baseProps} onStartOne={onStartOne} />);
    const text = textOf(tree);
    expect(text).toContain("Noch offen aus dem Wechsel vom");
    expect(text).toContain("Liegengeblieben");
    const buttons = findByType(tree, "button").filter((b) => textOf(b) === "Neu starten");
    click(buttons[buttons.length - 1]);
    expect(onStartOne).toHaveBeenCalledWith("sw0", "h9", false);
  });

  it("shows no leftover section for an earlier switch that is settled", () => {
    const settled = view({ switchId: "sw0", counts: counts({ running: 1, nothing: 1 }), handovers: [h({ status: "running" }), h({ handoverId: "h2", status: "nothing" })] });
    expect(textOf(render(<HandoverPanel overview={overview({ history: [settled] })} {...baseProps} />))).not.toContain("Noch offen aus dem Wechsel");
  });
});
