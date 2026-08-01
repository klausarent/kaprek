// Simple view: the work an agent did between two answers is collapsed into
// one summary line, so a chat reads like a conversation instead of a build
// log. The full view (every tool call, every thinking block) is one click
// away and stays the default for anyone who wants to watch each step.
import type { DigestEvent } from "./api";

/** Either one event rendered as-is, or a run of work events folded into one line. */
export type SimpleItem =
  | { kind: "event"; event: DigestEvent; index: number }
  | { kind: "work"; events: DigestEvent[]; startIndex: number };

/** Events that are the CONVERSATION — everything else is the work behind it. */
const CONVERSATION_KINDS = new Set(["user", "assistant", "approval", "relay"]);

/**
 * Folds consecutive work events (tool calls, thinking, subagents, compaction)
 * into one collapsible run. Conversation events pass through untouched and in
 * order, so the visible thread is: what you asked, what came back, and one
 * line for everything in between.
 *
 * Approvals deliberately count as conversation: a question that was put to a
 * human is not background work, and hiding it inside a fold is exactly the
 * kind of thing this tool exists not to do.
 */
export function toSimpleItems(events: DigestEvent[]): SimpleItem[] {
  const items: SimpleItem[] = [];
  let run: DigestEvent[] = [];
  let runStart = 0;

  const flush = () => {
    if (run.length === 0) return;
    items.push({ kind: "work", events: run, startIndex: runStart });
    run = [];
  };

  events.forEach((event, index) => {
    if (CONVERSATION_KINDS.has(event.kind)) {
      flush();
      items.push({ kind: "event", event, index });
      return;
    }
    if (run.length === 0) runStart = index;
    run.push(event);
  });
  flush();
  return items;
}

/** The one-line summary of a folded run: "Worked for 3 steps · Read, Bash". */
export function describeWork(events: DigestEvent[]): string {
  const toolNames: string[] = [];
  let thinking = 0;
  for (const event of events) {
    if (event.kind === "tool" && typeof event.name === "string") {
      if (!toolNames.includes(event.name)) toolNames.push(event.name);
    } else if (event.kind === "thinking") {
      thinking += 1;
    }
  }
  const steps = events.length;
  const parts = [`${steps} step${steps === 1 ? "" : "s"}`];
  if (toolNames.length > 0) parts.push(toolNames.slice(0, 4).join(", ") + (toolNames.length > 4 ? "…" : ""));
  else if (thinking > 0) parts.push("thinking");
  return `Worked · ${parts.join(" · ")}`;
}
