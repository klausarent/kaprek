import { test, expect, vi } from "vitest";
import { ApprovalInboxItem, deadlineLabel, relativeTime } from "./Approvals";
import type { InboxApproval } from "../lib/api";
import { findByType, findOneByText, render, textOf, click } from "../test/tree";

const NOW = 1_700_000_000_000;

function approval(overrides: Partial<InboxApproval> = {}): InboxApproval {
  return {
    type: "approval",
    chatId: "11111111-2222-3333-4444-555555555555",
    source: { kind: "trigger", triggerId: "nightly-check", title: "Nightly check" },
    id: "night-1",
    toolName: "Bash",
    displayName: "Bash",
    input: { command: "git status" },
    description: null,
    reason: null,
    agentId: null,
    requestedAt: NOW - 3 * 60 * 60 * 1000,
    deadlineAt: NOW + 5 * 60 * 60 * 1000,
    ...overrides,
  };
}

test("an inbox entry names the tool, the trigger that asked, and the proposed input", () => {
  const text = textOf(render(<ApprovalInboxItem approval={approval()} nowMs={NOW} onDecide={() => {}} />));
  expect(text).toContain("Bash");
  expect(text).toContain("nightly-check");
  expect(text).toContain("git status");
});

test("an inbox entry says how long ago it was asked — an entry here is usually hours old, not seconds", () => {
  const text = textOf(render(<ApprovalInboxItem approval={approval()} nowMs={NOW} onDecide={() => {}} />));
  expect(text).toContain("asked 3 hours ago");
});

test("Allow and Deny each fire the decision with their own behavior", () => {
  const onDecide = vi.fn();
  const entry = approval();
  const tree = render(<ApprovalInboxItem approval={entry} nowMs={NOW} onDecide={onDecide} />);

  click(findOneByText(tree, "button", "Allow"));
  click(findOneByText(tree, "button", "Deny"));

  expect(onDecide.mock.calls.map(([, behavior]) => behavior)).toEqual(["allow", "deny"]);
  expect(onDecide.mock.calls[0][0]).toBe(entry);
});

test("a busy entry cannot be clicked twice — both buttons are disabled while its answer is in flight", () => {
  const tree = render(<ApprovalInboxItem approval={approval()} nowMs={NOW} busy onDecide={() => {}} />);
  expect(findByType(tree, "button").every((button) => button.props.disabled === true)).toBe(true);
});

test("an entry with no input renders a placeholder rather than an empty box on a security prompt", () => {
  const text = textOf(render(<ApprovalInboxItem approval={approval({ input: null })} nowMs={NOW} onDecide={() => {}} />));
  expect(text).toContain("(no input)");
});

test("relativeTime stays coarse and never invents precision", () => {
  expect(relativeTime(NOW - 5_000, NOW)).toBe("just now");
  expect(relativeTime(NOW - 60_000, NOW)).toBe("1 minute ago");
  expect(relativeTime(NOW - 25 * 60_000, NOW)).toBe("25 minutes ago");
  expect(relativeTime(NOW - 3 * 3_600_000, NOW)).toBe("3 hours ago");
  expect(relativeTime(NOW - 50 * 3_600_000, NOW)).toBe("2 days ago");
  // A clock skew that puts the entry in the future must not print "-3 hours".
  expect(relativeTime(NOW + 10_000, NOW)).toBe("just now");
});

test("deadlineLabel says when the server will deny on its own, and admits when that moment has passed", () => {
  expect(deadlineLabel(NOW + 20 * 60_000, NOW)).toContain("20 minutes");
  expect(deadlineLabel(NOW + 7 * 3_600_000, NOW)).toContain("7 hours");
  expect(deadlineLabel(NOW - 1, NOW)).toContain("by now");
  // No recorded deadline means no line — better than a made-up one.
  expect(deadlineLabel(null, NOW)).toBeNull();
});
