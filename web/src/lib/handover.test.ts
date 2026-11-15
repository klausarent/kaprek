import { describe, it, expect } from "vitest";
import {
  handoverErrorText,
  handoverSummary,
  startableHandovers,
  startStatusText,
  statusLabel,
  type Handover,
  type SwitchView,
} from "./handover";

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
  cwd: "C:\\p",
  file: "status.md",
  section: null,
  prompt: null,
  title: "Aufgabe",
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
  counts: counts(),
  handovers: [],
  missing: [],
  ...over,
});

describe("handoverErrorText", () => {
  it("prefixes an Error's message with 'Fehler: '", () => {
    expect(handoverErrorText(new Error("server unreachable"))).toBe("Fehler: server unreachable");
  });

  it("stringifies a non-Error throw the same way", () => {
    expect(handoverErrorText("boom")).toBe("Fehler: boom");
  });
});

describe("statusLabel", () => {
  it("has a German label for every status", () => {
    expect(statusLabel("pending")).toBe("wartet");
    expect(statusLabel("nothing")).toBe("nichts offen");
    expect(statusLabel("failed")).toBe("Start fehlgeschlagen");
    expect(statusLabel("unknown")).toBe("Start unklar");
    expect(statusLabel("spawned")).toBe("Tab geöffnet");
    expect(statusLabel("running")).toBe("läuft");
  });
});

describe("startableHandovers", () => {
  it("keeps only pending and failed, in list order", () => {
    const list = [
      h({ handoverId: "a", status: "pending" }),
      h({ handoverId: "b", status: "running" }),
      h({ handoverId: "c", status: "failed" }),
      h({ handoverId: "d", status: "nothing" }),
      h({ handoverId: "e", status: "spawned" }),
      h({ handoverId: "f", status: "unknown" }),
    ];
    expect(startableHandovers(view({ handovers: list })).map((x) => x.handoverId)).toEqual(["a", "c"]);
  });

  it("is empty when nothing is pending or failed", () => {
    const list = [h({ status: "nothing" }), h({ status: "running" })];
    expect(startableHandovers(view({ handovers: list }))).toEqual([]);
  });
});

describe("handoverSummary", () => {
  it("joins only parts with a count > 0, in the fixed status order, plus missing last", () => {
    const v = view({
      counts: counts({ pending: 11, nothing: 2, running: 1 }),
      missing: [{ sessionId: "x", cwd: "C:\\p", title: "Y" }],
    });
    expect(handoverSummary(v)).toBe("11 warten · 2 nichts offen · 1 läuft · 1 fehlt");
  });

  it("omits every zero-count part and the missing suffix when there is none", () => {
    expect(handoverSummary(view({ counts: counts({ pending: 3 }) }))).toBe("3 warten");
  });

  it("is empty when everything is zero and nothing is missing", () => {
    expect(handoverSummary(view())).toBe("");
  });
});

describe("startStatusText", () => {
  const result = (ok: boolean, error?: string) => ({ handoverId: "h-aaaa0001", title: "Shop", ok, ...(error ? { error } : {}) });

  it("counts the tabs that opened", () => {
    expect(startStatusText({ status: 200, ok: true, results: [result(true), result(true)] })).toBe("2/2 Tabs geöffnet");
  });

  it("names the first handover that could not be started — a 200 with ok:false carries no top-level error", () => {
    const text = startStatusText({ status: 200, ok: false, results: [result(true), result(false, "working directory does not exist: C:\weg")] });
    expect(text).toBe("Fehler: 1/2 Tabs geöffnet. Shop: working directory does not exist: C:\weg");
  });

  it("says so when another start is running, when nothing was left to start, and on a refused request", () => {
    expect(startStatusText({ status: 409, ok: false, results: [], error: "another start is running" })).toBe("Fehler: Ein anderer Start läuft gerade.");
    expect(startStatusText({ status: 200, ok: true, results: [] })).toBe("Nichts zu starten.");
    expect(startStatusText({ status: 404, ok: false, results: [], error: "no such switch: w-1" })).toBe("Fehler: no such switch: w-1");
  });
});
