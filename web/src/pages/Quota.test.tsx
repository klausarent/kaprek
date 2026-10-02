import { describe, expect, test } from "vitest";
import { render, textOf } from "../test/tree";
import { QuotaView, windowLabel, resetLabel } from "./Quota";
import type { QuotaReport } from "../lib/api";

const NOW = Date.parse("2026-10-02T10:00:00Z");

const report: QuotaReport = {
  generatedAt: "2026-10-02T10:00:00Z",
  proxy: { running: true, port: 4911, lastRequestAt: "2026-10-02T09:59:00Z" },
  providers: [
    {
      id: "claude",
      label: "Claude",
      limitId: null,
      source: "proxy",
      seenAt: "2026-10-02T09:59:00Z",
      status: "allowed",
      plan: null,
      windows: [
        { name: "5h", usedPercent: 5, resetsAt: "2026-10-02T12:20:00Z" },
        { name: "7d", usedPercent: 69, resetsAt: "2026-10-07T23:00:00Z" },
      ],
    },
    { id: "codex", label: "Codex", limitId: null, source: "none", seenAt: null, status: null, plan: null, windows: [] },
  ],
  projects: [
    { project: "meoluna", sessions: 2, requests: 40, inputTokens: 1000, outputTokens: 5000, cacheReadTokens: 90000, cacheCreationTokens: 3000, lastAt: "2026-10-02T09:59:00Z" },
  ],
};

describe("windowLabel", () => {
  test("names the two plan windows in German and keeps unknown ones", () => {
    expect(windowLabel("5h")).toBe("5 Stunden");
    expect(windowLabel("seven_day")).toBe("7 Tage");
    expect(windowLabel("overage")).toBe("overage");
  });
});

describe("resetLabel", () => {
  test("formats the reset relative to now", () => {
    expect(resetLabel("2026-10-02T13:30:00Z", NOW)).toBe("Reset in 3 h 30 min");
    expect(resetLabel("2026-10-05T10:00:00Z", NOW)).toBe("Reset in 3 Tagen");
    expect(resetLabel(null, NOW)).toBe("Reset unbekannt");
  });
});

describe("QuotaView", () => {
  test("shows each window's percentage, the proxy state and the project table", () => {
    const text = textOf(render(<QuotaView report={report} now={NOW} />));
    expect(text).toContain("Claude");
    expect(text).toContain("69 %");
    expect(text).toContain("Reset in 2 h 20 min");
    expect(text).toContain("live über den Proxy");
    expect(text).toContain("Proxy läuft auf Port 4911");
    expect(text).toContain("meoluna");
    expect(text).toContain("90.000");
  });

  test("a provider without data says what to do", () => {
    const text = textOf(render(<QuotaView report={report} now={NOW} />));
    expect(text).toContain("Noch keine Daten");
  });

  test("says when codex reports a limit without windows", () => {
    const text = textOf(
      render(
        <QuotaView
          now={NOW}
          report={{
            ...report,
            proxy: { running: false, port: null, lastRequestAt: null },
            providers: [{ id: "codex", label: "Codex", limitId: "premium", source: "rollouts", seenAt: "2026-10-02T09:00:00Z", status: null, plan: null, windows: [] }],
            projects: [],
          }}
        />,
      ),
    );
    expect(text).toContain("meldet keine Fenster");
    expect(text).toContain("premium");
    expect(text).toContain("Proxy läuft nicht");
    expect(text).toContain("Noch keine Anfragen über den Proxy");
  });
});
