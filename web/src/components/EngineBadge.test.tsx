import { test, expect } from "vitest";
import EngineBadge from "./EngineBadge";
import type { Engine } from "../lib/api";
import { render, textOf } from "../test/tree";

const codex: Engine = {
  id: "codex",
  displayName: "Codex",
  supportsCostUsd: false,
  supportsUpdatedInput: false,
  supportsAllowedTools: false,
  supportsMcpConfig: false,
  supportsSettingsPath: false,
};

test("a non-default engine shows its display name", () => {
  expect(textOf(render(<EngineBadge engine="codex" engines={[codex]} />))).toBe("Codex");
});

test("without a capability list the raw id still shows", () => {
  expect(textOf(render(<EngineBadge engine="codex" />))).toBe("codex");
});

test("the default engine and an absent engine render nothing — the default stays unfurnished", () => {
  expect(textOf(render(<EngineBadge engine="claude-code" />))).toBe("");
  expect(textOf(render(<EngineBadge />))).toBe("");
});
