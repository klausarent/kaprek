// The narrow, collapsible "what are the agents doing" strip above the chat
// composer. Presentational only — its whole state is derived from the live
// stream in lib/agents.ts, which the Chat page folds frame by frame.
import { activityLabel, agentRows, formatDuration, turnDurationMs, type AgentPanelState } from "../lib/agents";

export default function AgentPanel({
  state,
  nowMs,
  expanded,
  onToggle,
}: {
  state: AgentPanelState;
  nowMs: number;
  expanded: boolean;
  onToggle: () => void;
}) {
  if (!state.started) return null;

  const rows = agentRows(state);
  const duration = formatDuration(turnDurationMs(state, nowMs));

  return (
    <div className="agent-panel">
      <button type="button" className="agent-panel-head" onClick={onToggle} aria-expanded={expanded}>
        <span className="agent-panel-caret">{expanded ? "▾" : "▸"}</span>
        <span className="agent-panel-summary">
          {rows.length === 1 ? "1 agent" : `${rows.length} agents`} · {activityLabel(rows[0])}
        </span>
        <span className="agent-panel-duration">{duration}</span>
      </button>
      {expanded && (
        <ul className="agent-panel-rows">
          {rows.map((row) => (
            <li key={row.id} className="agent-panel-row">
              <span className="agent-panel-row-label">{row.label}</span>
              <span className="agent-panel-row-activity">{activityLabel(row)}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
