import { test, expect, vi } from "vitest";
import AgentPanel from "./AgentPanel";
import { applyAgentEvent, initialAgentPanel } from "../lib/agents";
import type { ChatStreamEvent } from "../lib/api";
import { click, findByType, render, textOf } from "../test/tree";

const CHAT = "11111111-1111-4111-8111-111111111111";
const INIT: ChatStreamEvent = { type: "init", sessionId: null, tools: [], model: null, permissionMode: null };

function panel(...events: ChatStreamEvent[]) {
  return events.reduce((state, event, i) => applyAgentEvent(state, event, 1_000 * (i + 1)), initialAgentPanel());
}

test("renders nothing before the first frame of a turn", () => {
  const tree = render(<AgentPanel state={initialAgentPanel()} nowMs={0} expanded={false} onToggle={() => {}} />);
  expect(tree.children).toHaveLength(0);
});

test("collapsed, it summarizes the main agent's state and the turn duration", () => {
  const tree = render(<AgentPanel state={panel(INIT)} nowMs={6_000} expanded={false} onToggle={() => {}} />);
  const text = textOf(tree);
  expect(text).toContain("1 agent");
  expect(text).toContain("💭 thinking");
  expect(text).toContain("5s");
  // Collapsed means no per-agent list.
  expect(findByType(tree, "li")).toHaveLength(0);
});

test("expanded, it lists one row per agent", () => {
  const state = panel(INIT, {
    type: "approval",
    chatId: CHAT,
    id: "req-1",
    toolName: "Bash",
    displayName: "Bash",
    input: {},
    description: null,
    reason: null,
    agentId: "0123456789abcdef",
  });
  const tree = render(<AgentPanel state={state} nowMs={3_000} expanded onToggle={() => {}} />);
  const rows = findByType(tree, "li").map(textOf);
  expect(rows).toHaveLength(2);
  expect(rows[0]).toContain("main");
  expect(rows[0]).toContain("💭 thinking");
  expect(rows[1]).toContain("01234567…");
  expect(rows[1]).toContain("🔐 waiting for approval");
  expect(textOf(tree)).toContain("2 agents");
});

test("the header button toggles the panel", () => {
  const onToggle = vi.fn();
  const tree = render(<AgentPanel state={panel(INIT)} nowMs={1_000} expanded={false} onToggle={onToggle} />);
  click(findByType(tree, "button")[0]);
  expect(onToggle).toHaveBeenCalledTimes(1);
});

test("a running tool is shown by name in the summary", () => {
  const state = panel(INIT, { type: "tool-start", id: "t1", name: "Write", input: {} });
  expect(textOf(render(<AgentPanel state={state} nowMs={5_000} expanded onToggle={() => {}} />))).toContain("🔧 Write");
});
