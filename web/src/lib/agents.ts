// Derives the agent panel's contents from the SSE frames a turn is already
// streaming. No endpoint, no persistence: this is a live view of one turn and
// it resets with the next one.
//
// LIMIT OF THE DATA, not of the panel: `agentId` only exists on 'approval'
// frames (see src/harness/adapter.mjs's NormalizedEvent list — 'tool-start'/
// 'tool-end' carry id/name/input and nothing about which agent made the call).
// So a subagent becomes visible here the moment it asks for something, and its
// tool calls are attributed to the main row until then. Inventing an
// attribution the wire does not carry would be worse than showing one row.
import type { ChatStreamEvent } from "./api";
import { shortAgentId } from "./approvals";
import type { TriggerStreamEvent } from "./api";

export type AgentActivity = "thinking" | "tool" | "awaiting-approval" | "done";

export type AgentRow = {
  /** 'main' for the turn itself, otherwise the raw agentId. */
  id: string;
  label: string;
  activity: AgentActivity;
  /** The tool being run, when activity is 'tool' — or the tool an approval is waiting on. */
  toolName: string | null;
};

export type AgentPanelState = {
  turnStartedAtMs: number | null;
  turnEndedAtMs: number | null;
  /** In-flight tool calls of the main turn, id -> name, in arrival order. */
  activeTools: { id: string; name: string }[];
  /** agentId (or MAIN_AGENT for the main turn) -> the tool its approval is waiting on. */
  awaitingApproval: Record<string, string>;
  /** Every non-null agentId seen this turn, in first-seen order. */
  seenAgentIds: string[];
  started: boolean;
};

export const MAIN_AGENT = "main";

export function initialAgentPanel(): AgentPanelState {
  return { turnStartedAtMs: null, turnEndedAtMs: null, activeTools: [], awaitingApproval: {}, seenAgentIds: [], started: false };
}

/**
 * Folds one stream frame into the panel state. Unknown/irrelevant frame types
 * return the state unchanged (identity), so a caller can hand it every frame
 * without filtering first.
 */
export function applyAgentEvent(state: AgentPanelState, event: ChatStreamEvent | TriggerStreamEvent, nowMs: number): AgentPanelState {
  const begin = (s: AgentPanelState): AgentPanelState =>
    s.started ? s : { ...s, started: true, turnStartedAtMs: s.turnStartedAtMs ?? nowMs, turnEndedAtMs: null };

  switch (event.type) {
    case "chat-id":
    case "init":
    case "text":
    case "thinking":
      return begin(state);
    case "tool-start": {
      const next = begin(state);
      return { ...next, activeTools: [...next.activeTools, { id: event.id, name: event.name }] };
    }
    case "tool-end": {
      const activeTools = state.activeTools.filter((tool) => tool.id !== event.id);
      return activeTools.length === state.activeTools.length ? state : { ...state, activeTools };
    }
    case "approval": {
      const next = begin(state);
      const key = event.agentId ?? MAIN_AGENT;
      const seenAgentIds =
        event.agentId && !next.seenAgentIds.includes(event.agentId) ? [...next.seenAgentIds, event.agentId] : next.seenAgentIds;
      return {
        ...next,
        seenAgentIds,
        awaitingApproval: { ...next.awaitingApproval, [key]: event.toolName ?? event.displayName ?? "a tool" },
      };
    }
    case "turn-complete":
    case "trigger-complete":
      return { ...state, turnEndedAtMs: nowMs, activeTools: [], awaitingApproval: {} };
    default:
      return state;
  }
}

/** Clears one agent's waiting-for-approval marker — called once its decision is in. */
export function clearAwaitingApproval(state: AgentPanelState, agentId: string | null): AgentPanelState {
  const key = agentId ?? MAIN_AGENT;
  if (!(key in state.awaitingApproval)) return state;
  const awaitingApproval = { ...state.awaitingApproval };
  delete awaitingApproval[key];
  return { ...state, awaitingApproval };
}

/** One row per agent, main first. */
export function agentRows(state: AgentPanelState): AgentRow[] {
  const done = state.turnEndedAtMs !== null;
  const mainWaiting = state.awaitingApproval[MAIN_AGENT];
  const lastTool = state.activeTools[state.activeTools.length - 1] ?? null;

  const main: AgentRow = mainWaiting
    ? { id: MAIN_AGENT, label: "main", activity: "awaiting-approval", toolName: mainWaiting }
    : done
      ? { id: MAIN_AGENT, label: "main", activity: "done", toolName: null }
      : lastTool
        ? { id: MAIN_AGENT, label: "main", activity: "tool", toolName: lastTool.name }
        : { id: MAIN_AGENT, label: "main", activity: "thinking", toolName: null };

  const subagents: AgentRow[] = state.seenAgentIds.map((agentId) => {
    const waiting = state.awaitingApproval[agentId];
    if (waiting) return { id: agentId, label: shortAgentId(agentId) ?? agentId, activity: "awaiting-approval", toolName: waiting };
    return { id: agentId, label: shortAgentId(agentId) ?? agentId, activity: done ? "done" : "thinking", toolName: null };
  });

  return [main, ...subagents];
}

const ACTIVITY_ICONS: Record<AgentActivity, string> = {
  thinking: "💭",
  tool: "🔧",
  "awaiting-approval": "🔐",
  done: "✅",
};

export function activityLabel(row: AgentRow): string {
  switch (row.activity) {
    case "tool":
      return `${ACTIVITY_ICONS.tool} ${row.toolName ?? "tool"}`;
    case "awaiting-approval":
      return `${ACTIVITY_ICONS["awaiting-approval"]} waiting for approval`;
    case "done":
      return `${ACTIVITY_ICONS.done} done`;
    default:
      return `${ACTIVITY_ICONS.thinking} thinking`;
  }
}

/** Elapsed turn time, frozen once the turn ended. 0 before the first frame. */
export function turnDurationMs(state: AgentPanelState, nowMs: number): number {
  if (state.turnStartedAtMs === null) return 0;
  return Math.max(0, (state.turnEndedAtMs ?? nowMs) - state.turnStartedAtMs);
}

export function formatDuration(ms: number): string {
  const total = Math.floor(ms / 1000);
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return minutes === 0 ? `${seconds}s` : `${minutes}m ${String(seconds).padStart(2, "0")}s`;
}

/** Collapsed for a lone main agent, expanded the moment a second one shows up. */
export function shouldAutoExpand(state: AgentPanelState): boolean {
  return state.seenAgentIds.length > 0;
}
