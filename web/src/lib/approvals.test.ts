import { test, expect } from "vitest";
import {
  APPROVAL_TIMEOUT_MS,
  addApproval,
  approvalSourceLabel,
  buildApprovalAnswer,
  deadlineOf,
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
  expect(removeApproval(stack, CHAT_A, "req-1")).toHaveLength(0);
  expect(removeApproval(stack, CHAT_A, "unknown")).toBe(stack);
});

test("removeApproval keys by chat AND id, so answering one chat never drops another chat's identically-named question", () => {
  // The server keys pending approvals by chatId:requestId because two CLI
  // subprocesses can hand out the same request_id — the client must match that.
  let stack = addApproval([], frame({ id: "req-1", chatId: CHAT_A }), 1_000);
  stack = addApproval(stack, frame({ id: "req-1", chatId: CHAT_B }), 2_000);
  expect(stack).toHaveLength(2);

  const left = removeApproval(stack, CHAT_A, "req-1");
  expect(left).toHaveLength(1);
  expect(left[0].chatId).toBe(CHAT_B);

  // The right id in the wrong chat removes nothing.
  expect(removeApproval(left, CHAT_A, "req-1")).toBe(left);
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

test("a server-sent deadline beats the client's ten-minute fallback — an eight-hour trigger question is not swept out after ten minutes", () => {
  // Before deadlineAt existed, the client assumed every approval lapsed after
  // APPROVAL_TIMEOUT_MS. With an unattended trigger's question waiting eight
  // hours (APPROVAL_DEADLINE_UNATTENDED_MS), that assumption would remove a
  // still-live question from the stack and stop showing the user the buttons
  // that would answer it.
  const eightHours = 8 * 60 * 60 * 1000;
  const stack = addApproval([], frame({ deadlineAt: eightHours }), 0);

  expect(dropExpired(stack, APPROVAL_TIMEOUT_MS + 1)).toBe(stack);
  expect(remainingMs(stack[0], APPROVAL_TIMEOUT_MS)).toBe(eightHours - APPROVAL_TIMEOUT_MS);
  expect(dropExpired(stack, eightHours)).toHaveLength(0);
});

test("deadlineOf falls back to the client clock only when the server sent no deadline", () => {
  const withNone = addApproval([], frame(), 5_000)[0];
  expect(deadlineOf(withNone)).toBe(5_000 + APPROVAL_TIMEOUT_MS);
  const withOne = addApproval([], frame({ deadlineAt: 99_000 }), 5_000)[0];
  expect(deadlineOf(withOne)).toBe(99_000);
});

test("formatCountdown renders zero-padded mm:ss", () => {
  expect(formatCountdown(APPROVAL_TIMEOUT_MS)).toBe("10:00");
  expect(formatCountdown(65_000)).toBe("01:05");
  expect(formatCountdown(9_000)).toBe("00:09");
  expect(formatCountdown(-1)).toBe("00:00");
});

test("a trigger's question always names the trigger, whatever chat is on screen", () => {
  // An unattended run's approval is delivered to whatever stream is open, so it
  // can appear in a chat the user is in the middle of, about work they never
  // started. Naming the trigger is what makes that answerable rather than
  // alarming.
  const entry = addApproval([], frame({ source: { kind: "trigger", triggerId: "nightly-check", title: "nightly run" } }), 0)[0];
  expect(approvalSourceLabel(entry, undefined)).toBe("From trigger: nightly-check");
  expect(approvalSourceLabel(entry, CHAT_A)).toBe("From trigger: nightly-check");
  expect(approvalSourceLabel(entry, CHAT_B)).toBe("From trigger: nightly-check");
});

test("a chat's question is labelled only when it belongs to a DIFFERENT chat", () => {
  const entry = addApproval([], frame({ chatId: CHAT_A, source: { kind: "chat", triggerId: null, title: "refactor the parser" } }), 0)[0];
  // Its own chat: labelling it would be noise on the common path.
  expect(approvalSourceLabel(entry, CHAT_A)).toBeNull();
  expect(approvalSourceLabel(entry, CHAT_B)).toBe("From chat: refactor the parser");
});

test("approvalSourceLabel degrades instead of showing 'undefined'", () => {
  const noSource = addApproval([], frame(), 0)[0];
  expect(approvalSourceLabel(noSource, CHAT_B)).toBeNull();

  const namelessTrigger = addApproval([], frame({ source: { kind: "trigger", triggerId: null, title: null } }), 0)[0];
  expect(approvalSourceLabel(namelessTrigger, CHAT_B)).toBe("From trigger: unknown");

  const namelessChat = addApproval([], frame({ chatId: CHAT_A, source: { kind: "chat", triggerId: null, title: null } }), 0)[0];
  expect(approvalSourceLabel(namelessChat, CHAT_B)).toBe("From chat: untitled");
});

test("buildApprovalAnswer carries the ENTRY's own chatId, not whichever chat is on screen", () => {
  // POST /api/approvals/<id> answers 404 for a chatId that does not own the
  // request, so an answer built from the wrong chat is silently lost.
  const stack = addApproval(addApproval([], frame({ id: "req-1", chatId: CHAT_A }), 0), frame({ id: "req-2", chatId: CHAT_B }), 0);

  expect(buildApprovalAnswer(stack[0], "allow")).toEqual({ id: "req-1", body: { chatId: CHAT_A, behavior: "allow" } });
  expect(buildApprovalAnswer(stack[1], "allow")).toEqual({ id: "req-2", body: { chatId: CHAT_B, behavior: "allow" } });
});

test("buildApprovalAnswer attaches the deny message only to a deny", () => {
  const entry = addApproval([], frame(), 0)[0];
  expect(buildApprovalAnswer(entry, "deny")).toEqual({
    id: "req-1",
    body: { chatId: CHAT_A, behavior: "deny", message: "denied by user" },
  });
  expect(buildApprovalAnswer(entry, "allow").body).not.toHaveProperty("message");
});

test("shortAgentId shortens a long id and leaves a short one alone", () => {
  expect(shortAgentId(null)).toBeNull();
  expect(shortAgentId("agent-1")).toBe("agent-1");
  expect(shortAgentId("0123456789abcdef")).toBe("01234567…");
});
