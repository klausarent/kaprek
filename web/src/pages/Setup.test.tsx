import { describe, expect, test } from "vitest";
import { render, textOf } from "../test/tree";
import { CliRow, cliStatusLabel, usageLine } from "./Setup";
import type { UsageEntry } from "../lib/api";

describe("cliStatusLabel", () => {
  test("tells installed apart from signed in", () => {
    expect(cliStatusLabel({ installed: false, signedIn: false })).toBe("not installed");
    expect(cliStatusLabel({ installed: true, signedIn: false })).toBe("installed, not signed in");
    expect(cliStatusLabel({ installed: true, signedIn: true })).toBe("ready");
  });
});

describe("CliRow", () => {
  const cli = {
    id: "codex",
    label: "Codex",
    command: "codex",
    installed: true,
    commandPath: "C:\Users\someone\AppData\codex.cmd",
    configDirs: ["C:\Users\someone\.codex"],
    signedIn: true,
    mcpServers: ["github"],
  };

  test("shows the path so nobody has to go looking for it", () => {
    expect(textOf(render(<CliRow cli={cli} />))).toContain("codex.cmd");
  });

  test("names the MCP servers it found", () => {
    expect(textOf(render(<CliRow cli={cli} />))).toContain("github");
  });

  test("a missing CLI still gets a row, so its absence is visible", () => {
    const text = textOf(render(<CliRow cli={{ ...cli, installed: false, signedIn: false, commandPath: null, configDirs: [], mcpServers: [] }} />));
    expect(text).toContain("not installed");
  });
});

describe("usageLine", () => {
  const entry = (summary: Partial<UsageEntry["summary"]>, seenAt: string | null = "2026-08-27T10:01:00.000Z"): UsageEntry => ({
    harness: "claude-code",
    seenAt,
    chatId: null,
    summary: { usedPercent: null, resetsAt: null, window: null, status: null, plan: null, ...summary },
    info: {},
  });
  const NOW = Date.parse("2026-08-27T12:00:00.000Z");

  test("says how full, when it resets, which window, and as of when", () => {
    const line = usageLine(entry({ usedPercent: 62, resetsAt: "2026-08-27T14:30:00.000Z", window: "five_hour", status: "allowed_warning" }), NOW);
    expect(line).toContain("62 % used");
    expect(line).toContain("allowed warning");
    expect(line).toMatch(/resets \d{2}:\d{2} \(five_hour\)/);
    expect(line).toMatch(/as of \d{2}:\d{2}$/);
  });

  test("a reset in the past is said in the past tense; codex names its plan", () => {
    expect(usageLine(entry({ usedPercent: 9, resetsAt: "2026-08-27T09:00:00.000Z", plan: "plus" }), NOW)).toMatch(/reset at .* · plan plus/);
  });

  test("an unknown shape is named as such rather than rendered empty", () => {
    expect(usageLine(entry({}, null), NOW)).toContain("a signal without a shape kaprek knows");
  });
});
