import { test, expect, vi } from "vitest";
import ApprovalDialog from "./ApprovalDialog";
import { addApproval, type PendingApproval } from "../lib/approvals";
import type { ApprovalFrame } from "../lib/api";
import { click, findAll, findOneByText, render, textOf } from "../test/tree";

const CHAT_ID = "11111111-1111-4111-8111-111111111111";

function frame(overrides: Partial<ApprovalFrame> = {}): ApprovalFrame {
  return {
    type: "approval",
    chatId: CHAT_ID,
    id: "req-1",
    toolName: "Bash",
    displayName: "Bash",
    input: { command: "git status" },
    description: null,
    reason: null,
    agentId: null,
    ...overrides,
  };
}

function stack(...frames: ApprovalFrame[]): PendingApproval[] {
  return frames.reduce<PendingApproval[]>((acc, f, i) => addApproval(acc, f, i * 1_000), []);
}

test("renders nothing when there is no open approval", () => {
  const tree = render(<ApprovalDialog approvals={[]} nowMs={0} onDecide={() => {}} />);
  expect(tree.children).toHaveLength(0);
});

test("renders the tool name, the proposed input and the countdown", () => {
  const tree = render(
    <ApprovalDialog
      approvals={stack(frame({ description: "Runs a shell command.", reason: "not in the allowlist" }))}
      nowMs={60_000}
      onDecide={() => {}}
    />,
  );
  const text = textOf(tree);
  expect(text).toContain("The agent wants to run Bash.");
  expect(text).toContain("Runs a shell command.");
  expect(text).toContain("not in the allowlist");
  // 10 minutes minus the 60s that have passed since receipt at t=0.
  expect(text).toContain("Denied automatically in 09:00");

  const pre = render(
    <ApprovalDialog approvals={stack(frame())} nowMs={0} onDecide={() => {}} />,
  );
  expect(textOf(pre)).toContain('"command": "git status"');
});

test("Allow and Deny call onDecide with the visible entry and the right behavior", () => {
  const onDecide = vi.fn();
  const approvals = stack(frame({ id: "req-42" }));
  const tree = render(<ApprovalDialog approvals={approvals} nowMs={0} onDecide={onDecide} />);

  click(findOneByText(tree, "button", "Allow"));
  expect(onDecide).toHaveBeenCalledWith(approvals[0], "allow");

  click(findOneByText(tree, "button", "Deny"));
  expect(onDecide).toHaveBeenLastCalledWith(approvals[0], "deny");
  expect(onDecide).toHaveBeenCalledTimes(2);
});

test("two open approvals show the oldest one plus a counter for the rest", () => {
  const approvals = stack(
    frame({ id: "req-1", displayName: "Bash" }),
    frame({ id: "req-2", displayName: "Write", input: { file_path: "notes.md" } }),
  );
  const tree = render(<ApprovalDialog approvals={approvals} nowMs={0} onDecide={() => {}} />);
  const text = textOf(tree);

  expect(text).toContain("The agent wants to run Bash.");
  expect(text).not.toContain("Write");
  expect(text).toContain("+1 more waiting");
});

test("a single approval shows no counter", () => {
  const tree = render(<ApprovalDialog approvals={stack(frame())} nowMs={0} onDecide={() => {}} />);
  expect(textOf(tree)).not.toContain("more waiting");
});

test("a trigger's question names the trigger it came from", () => {
  const tree = render(
    <ApprovalDialog
      approvals={stack(frame({ source: { kind: "trigger", triggerId: "nightly-check", title: "nightly run" } }))}
      nowMs={0}
      currentChatId={CHAT_ID}
      onDecide={() => {}}
    />,
  );
  expect(textOf(tree)).toContain("From trigger: nightly-check");
});

test("the current chat's own question carries no origin line", () => {
  const tree = render(
    <ApprovalDialog
      approvals={stack(frame({ source: { kind: "chat", triggerId: null, title: "some chat" } }))}
      nowMs={0}
      currentChatId={CHAT_ID}
      onDecide={() => {}}
    />,
  );
  expect(textOf(tree)).not.toContain("From chat");
});

test("a subagent's approval shows its shortened agentId", () => {
  const tree = render(
    <ApprovalDialog approvals={stack(frame({ agentId: "0123456789abcdef" }))} nowMs={0} onDecide={() => {}} />,
  );
  expect(textOf(tree)).toContain("agent 01234567…");
});

test("both buttons are disabled while a decision is in flight, and a click cannot get through", () => {
  const onDecide = vi.fn();
  const tree = render(<ApprovalDialog approvals={stack(frame())} nowMs={0} busy onDecide={onDecide} />);
  expect(findOneByText(tree, "button", "Allow").props.disabled).toBe(true);
  expect(findOneByText(tree, "button", "Deny").props.disabled).toBe(true);
  expect(() => click(findOneByText(tree, "button", "Allow"))).toThrow(/disabled/);
  expect(onDecide).not.toHaveBeenCalled();
});

test("a failed answer is shown on the dialog, with the question and its buttons still there to retry", () => {
  // A 500 or a dropped connection must not take the question away — the entry
  // stays in the stack (see Chat.tsx::handleDecide) and this is where the user
  // finds out why nothing happened.
  const onDecide = vi.fn();
  const tree = render(
    <ApprovalDialog
      approvals={stack(frame())}
      nowMs={0}
      error="Could not send your answer (Request failed (HTTP 500)). Try again."
      onDecide={onDecide}
    />,
  );
  expect(textOf(tree)).toContain("Could not send your answer");
  expect(textOf(tree)).toContain("Try again");
  // Still answerable: the buttons are live, not disabled by the error.
  click(findOneByText(tree, "button", "Allow"));
  expect(onDecide).toHaveBeenCalledTimes(1);
});

test("no error line when there is no error", () => {
  const tree = render(<ApprovalDialog approvals={stack(frame())} nowMs={0} onDecide={() => {}} />);
  expect(findAll(tree, (node) => (node.props.className as string | undefined) === "error-box")).toHaveLength(0);
});

// ---------------------------------------------------------------------------
// P6b — the shape preview step: pattern sentence, mandatory examples
// (labelled hit/miss), and the confirm-gated save button.
// ---------------------------------------------------------------------------

const SHAPE_PREVIEW = {
  match: "shape" as const,
  toolName: "Bash",
  pattern: { v: 1, toolName: "Bash", type: "command-head" as const, keys: ["command"], head: "npm" },
  sentence: 'every Bash call whose command starts with "npm"',
  examples: [
    { input: { command: "npm --help" }, matches: true },
    { input: { command: "npm test" }, matches: true },
    { input: { command: "git status" }, matches: false },
  ],
  fingerprint: { posture: "ask", hardDenialsHash: "b".repeat(64), missionId: CHAT_ID, derivationVersion: 1 },
};

test("shape preview step: renders the pattern sentence and the examples, hit and miss labelled; save is disabled until confirmed", () => {
  const onSave = vi.fn();
  const tree = render(
    <ApprovalDialog
      approvals={stack(frame())}
      nowMs={0}
      onDecide={() => {}}
      shapePreview={SHAPE_PREVIEW}
      shapeConfirmed={false}
      onShapeConfirmToggle={() => {}}
      onShapeSave={onSave}
      onShapeSkip={() => {}}
    />,
  );
  const text = textOf(tree);
  expect(text).toContain("Would also allow:");
  expect(text).toContain('every Bash call whose command starts with "npm"');
  expect(text).toContain("would be allowed:");
  expect(text).toContain("would NOT be allowed:");
  expect(text).toContain('"command": "git status"');

  // The confirm gate: without the checkbox, Save cannot be pressed.
  const save = findOneByText(tree, "button", "Save standing grant");
  expect(() => click(save)).toThrow();
});

test("shape preview step: the labelled examples are TRUE — a miss example never says it would be allowed", () => {
  const tree = render(
    <ApprovalDialog
      approvals={stack(frame())}
      nowMs={0}
      onDecide={() => {}}
      shapePreview={SHAPE_PREVIEW}
      shapeConfirmed
      onShapeConfirmToggle={() => {}}
      onShapeSave={() => {}}
      onShapeSkip={() => {}}
    />,
  );
  const items = findAll(tree, (n) => n.type === "li");
  const hits = items.filter((n) => textOf(n).includes("would be allowed:"));
  const misses = items.filter((n) => textOf(n).includes("would NOT be allowed:"));
  expect(hits).toHaveLength(2);
  expect(misses).toHaveLength(1);
  expect(textOf(misses[0])).toContain("git status");
});
