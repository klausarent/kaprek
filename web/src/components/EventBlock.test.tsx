import { test, expect } from "vitest";
import EventBlock from "./EventBlock";
import type { ApprovalEvent } from "../lib/api";
import { render, textOf } from "../test/tree";

function approval(overrides: Partial<ApprovalEvent>): ApprovalEvent {
  return {
    kind: "approval",
    ts: "2026-07-30T10:00:00.000Z",
    phase: "requested",
    requestId: "req-1",
    toolName: "Bash",
    ...overrides,
  };
}

test("a persisted approval renders as a compact line, never as 'Unknown event type'", () => {
  const tree = render(<EventBlock event={approval({ phase: "requested" })} />);
  const text = textOf(tree);
  expect(text).toContain("🔐 Bash — asked");
  expect(text).not.toContain("Unknown event type");
});

test("a resolved approval renders the decision", () => {
  expect(textOf(render(<EventBlock event={approval({ phase: "resolved", behavior: "allow" })} />))).toContain(
    "🔐 Bash — allowed",
  );
  expect(
    textOf(render(<EventBlock event={approval({ phase: "resolved", behavior: "deny", message: "denied by user" })} />)),
  ).toContain("🔐 Bash — denied");
});

test("a resolved approval shows the deny message when there is one", () => {
  const tree = render(<EventBlock event={approval({ phase: "resolved", behavior: "deny", message: "denied by user" })} />);
  expect(textOf(tree)).toContain("denied by user");
});

test("a handler error is shown as failed, not as an allow or a deny", () => {
  const text = textOf(render(<EventBlock event={approval({ phase: "resolved", behavior: "error" })} />));
  expect(text).toContain("🔐 Bash — failed");
  expect(text).not.toContain("allowed");
  expect(text).not.toContain("denied");
});

test("a resolved approval with no behavior at all still renders a line", () => {
  expect(textOf(render(<EventBlock event={approval({ phase: "resolved", behavior: null })} />))).toContain(
    "🔐 Bash — no answer",
  );
});

test("an approval with no tool name falls back instead of rendering 'undefined'", () => {
  const text = textOf(render(<EventBlock event={approval({ toolName: null })} />));
  expect(text).toContain("🔐 (unknown tool) — asked");
});

test("a genuinely unknown event kind still reaches the unknown-event fallback", () => {
  // Guards against the approval case swallowing everything: the fallback must
  // still exist for a kind this build has never heard of.
  const tree = render(<EventBlock event={{ kind: "quantum", ts: "2026-07-30T10:00:00.000Z" } as never} />);
  expect(textOf(tree)).toContain("Unknown event type: quantum");
});
