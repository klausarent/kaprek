import { describe, expect, test } from "vitest";
import { render, textOf } from "../test/tree";
import { CliRow, cliStatusLabel } from "./Setup";

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
