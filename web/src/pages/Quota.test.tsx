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
    { project: "demo-app", sessions: 2, requests: 40, inputTokens: 1000, outputTokens: 5000, cacheReadTokens: 90000, cacheCreationTokens: 3000, lastAt: "2026-10-02T09:59:00Z" },
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
    expect(text).toContain("demo-app");
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

describe("QuotaView with several accounts", () => {
  test("one card per account, the next pick marked, a missing token said plainly", () => {
    const base = { id: "claude" as const, limitId: null, source: "proxy" as const, seenAt: "2026-10-02T09:59:00Z", status: "allowed", plan: null };
    const text = textOf(
      render(
        <QuotaView
          now={NOW}
          report={{
            ...report,
            providers: [
              { ...base, label: "Claude · Haupt", account: "konto1", credential: "login", next: false, windows: [{ name: "5h", usedPercent: 93, resetsAt: null }] },
              { ...base, label: "Claude · Konto 2", account: "konto2", credential: "token", next: true, windows: [{ name: "5h", usedPercent: 12, resetsAt: null }] },
              { ...base, label: "Claude · Konto 3", account: "konto3", credential: "missing", next: false, source: "none", seenAt: null, windows: [] },
            ],
          }}
        />,
      ),
    );
    expect(text).toContain("Claude · Haupt");
    expect(text).toContain("Claude · Konto 2");
    expect(text).toContain("Nächste Session");
    expect(text).toContain("Kein Token hinterlegt");
    expect(text).toContain("93 %");
  });
});
