import { test, expect } from "vitest";
import {
  APPROVAL_TIMEOUT_MS,
  addApproval,
  dropExpired,
  formatCountdown,
  oldestApproval,
  remainingMs,
  removeApproval,
  removeApprovalsForChat,
  shortAgentId,
  type PendingApproval,
} from "./approvals";
import type { ApprovalFrame } from "./api";

const CHAT_A = "11111111-1111-4111-8111-111111111111";
const CHAT_B = "22222222-2222-4222-8222-222222222222";

function frame(overrides: Partial<ApprovalFrame> = {}): ApprovalFrame {
  return {
    type: "approval",
    chatId: CHAT_A,
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

test("addApproval keeps arrival order and oldestApproval returns the first one", () => {
  let stack: PendingApproval[] = [];
  stack = addApproval(stack, frame({ id: "req-1" }), 1_000);
  stack = addApproval(stack, frame({ id: "req-2" }), 2_000);
  expect(stack.map((entry) => entry.id)).toEqual(["req-1", "req-2"]);
  expect(oldestApproval(stack)?.id).toBe("req-1");
});

test("addApproval ignores a re-delivered frame for the same chat and id", () => {
  const first = addApproval([], frame(), 1_000);
  const again = addApproval(first, frame(), 5_000);
  expect(again).toBe(first);
  expect(again).toHaveLength(1);
});

test("addApproval keeps the same request id apart when it comes from two different chats", () => {
  let stack = addApproval([], frame({ chatId: CHAT_A }), 1_000);
  stack = addApproval(stack, frame({ chatId: CHAT_B }), 1_000);
  expect(stack).toHaveLength(2);
});

test("removeApproval drops one entry and returns the same array when there was nothing to drop", () => {
  const stack = addApproval([], frame(), 1_000);
  expect(removeApproval(stack, "req-1")).toHaveLength(0);
  expect(removeApproval(stack, "unknown")).toBe(stack);
});

test("removeApprovalsForChat drops only that chat's entries", () => {
  let stack = addApproval([], frame({ id: "a", chatId: CHAT_A }), 1_000);
  stack = addApproval(stack, frame({ id: "b", chatId: CHAT_B }), 1_000);
  const left = removeApprovalsForChat(stack, CHAT_A);
  expect(left.map((entry) => entry.id)).toEqual(["b"]);
});

test("dropExpired removes an entry only once the full timeout has passed", () => {
  const stack = addApproval([], frame(), 0);
  expect(dropExpired(stack, APPROVAL_TIMEOUT_MS - 1)).toBe(stack);
  expect(dropExpired(stack, APPROVAL_TIMEOUT_MS)).toHaveLength(0);
});

test("remainingMs counts down from the timeout and clamps at zero", () => {
  const entry = addApproval([], frame(), 0)[0];
  expect(remainingMs(entry, 0)).toBe(APPROVAL_TIMEOUT_MS);
  expect(remainingMs(entry, 60_000)).toBe(APPROVAL_TIMEOUT_MS - 60_000);
  expect(remainingMs(entry, APPROVAL_TIMEOUT_MS + 5_000)).toBe(0);
});

test("formatCountdown renders zero-padded mm:ss", () => {
  expect(formatCountdown(APPROVAL_TIMEOUT_MS)).toBe("10:00");
  expect(formatCountdown(65_000)).toBe("01:05");
  expect(formatCountdown(9_000)).toBe("00:09");
  expect(formatCountdown(-1)).toBe("00:00");
});

test("shortAgentId shortens a long id and leaves a short one alone", () => {
  expect(shortAgentId(null)).toBeNull();
  expect(shortAgentId("agent-1")).toBe("agent-1");
  expect(shortAgentId("0123456789abcdef")).toBe("01234567…");
});
