// Renders a single digest event (src/parser/parse.mjs::digestSession shape)
// as one block in a thread. Reused for both the main thread and the nested
// subagent sub-threads.
//
// Note: `tool` events carry `input` already as a (possibly truncated) JSON
// string, not an object — truncateEvent() in parse.mjs serializes before
// truncating. `result` is a string or null (interrupted tool call).
import type { DigestEvent, SubagentThread, TextEvent, ToolEvent, SubagentEvent, CompactEvent } from "../lib/api";

function fmtTime(ts: string): string {
  const ms = Date.parse(ts);
  if (Number.isNaN(ms)) return "–";
  return new Date(ms).toLocaleTimeString("en-US", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

function fmtK(n: number | null): string {
  if (n === null || Number.isNaN(n)) return "?";
  if (n < 1000) return String(n);
  return `${Math.round(n / 1000)}k`;
}

function oneLine(input: string | null): string {
  if (!input) return "(no input)";
  const flat = input.replace(/\s+/g, " ").trim();
  return flat.length > 140 ? `${flat.slice(0, 140)}…` : flat;
}

export default function EventBlock({
  event,
  subagentThread,
}: {
  event: DigestEvent;
  subagentThread?: SubagentThread | null;
}) {
  switch (event.kind) {
    case "user":
      return <UserBlock event={event} />;
    case "assistant":
      return <AssistantBlock event={event} />;
    case "thinking":
      return <ThinkingBlock event={event} />;
    case "tool":
      return <ToolBlock event={event} />;
    case "subagent":
      return <SubagentBlock event={event} thread={subagentThread ?? null} />;
    case "compact":
      return <CompactBlock event={event} />;
    default:
      return <UnknownBlock event={event} />;
  }
}

function UnknownBlock({ event }: { event: { kind: string; ts?: string } }) {
  return (
    <div className="event-unknown">
      Unknown event type: {event.kind}
      {event.ts ? ` (${fmtTime(event.ts)})` : ""}
    </div>
  );
}

function UserBlock({ event }: { event: TextEvent }) {
  return (
    <div className="event-row event-row-end">
      <div className="event-bubble event-bubble-user">{event.text}</div>
      <span className="event-time">
        {fmtTime(event.ts)} · You
      </span>
    </div>
  );
}

function AssistantBlock({ event }: { event: TextEvent }) {
  return (
    <div className="event-row event-row-start">
      <div className="event-bubble event-bubble-assistant">{event.text}</div>
      <span className="event-time">
        {fmtTime(event.ts)} · Assistant
      </span>
    </div>
  );
}

function ThinkingBlock({ event }: { event: TextEvent }) {
  return (
    <details className="event-thinking">
      <summary>Thinking · {fmtTime(event.ts)}</summary>
      <div className="event-thinking-body">{event.text}</div>
    </details>
  );
}

function ToolBlock({ event }: { event: ToolEvent }) {
  const interrupted = event.result === null;
  return (
    <details className="event-tool">
      <summary className="event-tool-summary">
        <span className="event-tool-icon">{(event.name ?? "?").slice(0, 2).toUpperCase()}</span>
        <span className="event-tool-name">{event.name ?? "(unknown tool)"}</span>
        <span className="event-tool-preview">{oneLine(event.input)}</span>
        <span className="event-time event-tool-time">{fmtTime(event.ts)}</span>
      </summary>
      <div className="event-tool-body">
        <div>
          <div className="event-field-label">Input</div>
          <pre className="event-pre">{event.input ?? "(no input)"}</pre>
        </div>
        <div>
          <div className="event-field-label">Result</div>
          {interrupted ? (
            <div className="event-tool-interrupted">interrupted / no result</div>
          ) : (
            <pre className="event-pre">{event.result}</pre>
          )}
          {event.resultRef && (
            <div className="event-tool-ref">
              Full output saved at: <code>{event.resultRef}</code>
            </div>
          )}
        </div>
      </div>
    </details>
  );
}

function SubagentBlock({ event, thread }: { event: SubagentEvent; thread: SubagentThread | null }) {
  return (
    <details className="event-subagent">
      <summary className="event-subagent-summary">
        <span className="event-subagent-name">Subagent: {event.name ?? event.agentType ?? "(unnamed)"}</span>
        {event.agentType && event.agentType !== event.name && (
          <span className="event-subagent-meta">[{event.agentType}]</span>
        )}
        {event.model && <span className="event-subagent-meta">· {event.model}</span>}
        <span className="event-time event-tool-time">{fmtTime(event.ts)}</span>
      </summary>
      <div className="event-subagent-body">
        {event.description && <div className="event-subagent-description">{event.description}</div>}
        {thread ? (
          <div className="event-subagent-thread">
            {thread.events.length === 0 ? (
              <div className="event-subagent-empty">(empty sub-thread)</div>
            ) : (
              thread.events.map((subEvent, i) => (
                <EventBlock key={`${thread.agentId ?? "sub"}-${i}`} event={subEvent} />
              ))
            )}
          </div>
        ) : (
          <div className="event-subagent-empty">
            No matching sub-thread found in digest — see the &quot;Subagent threads&quot; section below.
          </div>
        )}
      </div>
    </details>
  );
}

function CompactBlock({ event }: { event: CompactEvent }) {
  return (
    <div className="event-compact">
      <div className="event-compact-line" />
      <span className="event-compact-label">
        Context compacted ({fmtK(event.preTokens)} → {fmtK(event.postTokens)} tokens)
      </span>
      <div className="event-compact-line" />
    </div>
  );
}
