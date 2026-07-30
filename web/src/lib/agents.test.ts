import { test, expect } from "vitest";
import {
  MAIN_AGENT,
  activityLabel,
  agentRows,
  applyAgentEvent,
  clearAwaitingApproval,
  formatDuration,
  initialAgentPanel,
  shouldAutoExpand,
  turnDurationMs,
  type AgentPanelState,
} from "./agents";
import type { ChatStreamEvent } from "./api";

const CHAT = "11111111-1111-4111-8111-111111111111";

function fold(events: ChatStreamEvent[], times?: number[]): AgentPanelState {
  return events.reduce((state, event, i) => applyAgentEvent(state, event, times?.[i] ?? 1_000 * (i + 1)), initialAgentPanel());
}

function approvalFrame(agentId: string | null, toolName = "Bash", id = "req-1"): ChatStreamEvent {
  return {
    type: "approval",
    chatId: CHAT,
    id,
    toolName,
    displayName: toolName,
    input: {},
    description: null,
    reason: null,
    agentId,
  };
}

test("a panel with no frames yet is not started and renders nothing", () => {
  const state = initialAgentPanel();
  expect(state.started).toBe(false);
  expect(turnDurationMs(state, 5_000)).toBe(0);
});

test("the main row is thinking after init and shows the running tool between tool-start and tool-end", () => {
  const thinking = fold([{ type: "init", sessionId: null, tools: [], model: null, permissionMode: null }]);
  expect(agentRows(thinking)).toEqual([{ id: MAIN_AGENT, label: "main", activity: "thinking", toolName: null }]);

  const running = applyAgentEvent(thinking, { type: "tool-start", id: "t1", name: "Bash", input: {} }, 2_000);
  expect(agentRows(running)[0]).toMatchObject({ activity: "tool", toolName: "Bash" });
  expect(activityLabel(agentRows(running)[0])).toBe("🔧 Bash");

  const finished = applyAgentEvent(running, { type: "tool-end", id: "t1", result: "ok", isError: false }, 3_000);
  expect(agentRows(finished)[0]).toMatchObject({ activity: "thinking", toolName: null });
});

test("an approval with an agentId adds a second row and marks it as waiting", () => {
  const state = fold([
    { type: "init", sessionId: null, tools: [], model: null, permissionMode: null },
    approvalFrame("sub-agent-0123456789"),
  ]);
  const rows = agentRows(state);
  expect(rows).toHaveLength(2);
  expect(rows[0].id).toBe(MAIN_AGENT);
  expect(rows[1]).toMatchObject({ id: "sub-agent-0123456789", activity: "awaiting-approval", toolName: "Bash" });
  expect(activityLabel(rows[1])).toBe("🔐 waiting for approval");
});

test("an approval without an agentId marks the main row as waiting instead of adding a row", () => {
  const state = fold([approvalFrame(null)]);
  const rows = agentRows(state);
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({ id: MAIN_AGENT, activity: "awaiting-approval" });

  const decided = clearAwaitingApproval(state, null);
  expect(agentRows(decided)[0].activity).toBe("thinking");
});

test("shouldAutoExpand stays false for a lone main agent and flips once a subagent appears", () => {
  const alone = fold([{ type: "init", sessionId: null, tools: [], model: null, permissionMode: null }]);
  expect(shouldAutoExpand(alone)).toBe(false);
  expect(shouldAutoExpand(applyAgentEvent(alone, approvalFrame("sub-1"), 2_000))).toBe(true);
});

test("turn-complete marks every row done, clears pending work, and freezes the duration", () => {
  let state = fold([{ type: "chat-id", chatId: CHAT }], [1_000]);
  state = applyAgentEvent(state, approvalFrame("sub-1"), 2_000);
  state = applyAgentEvent(state, { type: "tool-start", id: "t1", name: "Bash", input: {} }, 3_000);
  state = applyAgentEvent(
    state,
    { type: "turn-complete", chatId: CHAT, cliSessionId: null, costUsd: null, stopReason: "result", error: null },
    9_000,
  );

  expect(agentRows(state).map((row) => row.activity)).toEqual(["done", "done"]);
  expect(state.activeTools).toEqual([]);
  expect(state.awaitingApproval).toEqual({});
  expect(turnDurationMs(state, 60_000)).toBe(8_000);
});

test("formatDuration switches to minutes past 60 seconds", () => {
  expect(formatDuration(0)).toBe("0s");
  expect(formatDuration(42_000)).toBe("42s");
  expect(formatDuration(65_000)).toBe("1m 05s");
});
