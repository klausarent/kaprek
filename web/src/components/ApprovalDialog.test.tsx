import { test, expect, vi } from "vitest";
import ApprovalDialog from "./ApprovalDialog";
import { addApproval, type PendingApproval } from "../lib/approvals";
import type { ApprovalFrame } from "../lib/api";
import { click, findOneByText, render, textOf } from "../test/tree";

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

test("a subagent's approval shows its shortened agentId", () => {
  const tree = render(
    <ApprovalDialog approvals={stack(frame({ agentId: "0123456789abcdef" }))} nowMs={0} onDecide={() => {}} />,
  );
  expect(textOf(tree)).toContain("agent 01234567…");
});

test("both buttons are disabled while a decision is in flight", () => {
  const tree = render(<ApprovalDialog approvals={stack(frame())} nowMs={0} busy onDecide={() => {}} />);
  expect(findOneByText(tree, "button", "Allow").props.disabled).toBe(true);
  expect(findOneByText(tree, "button", "Deny").props.disabled).toBe(true);
});
