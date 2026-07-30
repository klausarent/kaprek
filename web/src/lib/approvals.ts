// The approval stack: pure state transitions plus the countdown arithmetic
// ApprovalDialog renders. Kept out of the component so both are testable on
// their own — the component is a pure function of these values.
import type { ApprovalFrame } from "./api";

/**
 * The server denies an unanswered approval after 10 minutes
 * (DEFAULT_APPROVAL_TIMEOUT_MS in src/server/server.mjs) and never tells the
 * client it did. The countdown below is therefore COSMETIC: it exists so the
 * user knows waiting has a deadline, and so a long-dead entry stops sitting in
 * the stack forever. The server's own timer is the authority — a client whose
 * clock or tab-throttling makes this number wrong changes nothing about what
 * actually happens to the tool call.
 */
export const APPROVAL_TIMEOUT_MS = 10 * 60 * 1000;

export type PendingApproval = ApprovalFrame & {
  /** Client-side receipt time, the countdown's zero point. */
  receivedAtMs: number;
};

/** Appends a newly received request. A duplicate id for the same chat is ignored (a re-delivered frame must not double the stack). */
export function addApproval(stack: PendingApproval[], frame: ApprovalFrame, nowMs: number): PendingApproval[] {
  if (stack.some((entry) => entry.id === frame.id && entry.chatId === frame.chatId)) return stack;
  return [...stack, { ...frame, receivedAtMs: nowMs }];
}

export function removeApproval(stack: PendingApproval[], id: string): PendingApproval[] {
  const next = stack.filter((entry) => entry.id !== id);
  return next.length === stack.length ? stack : next;
}

/** Drops every entry belonging to one chat — what a 'turn-complete' frame means for the stack (the server has cleaned its side up already, see cleanupApprovalsForChat). */
export function removeApprovalsForChat(stack: PendingApproval[], chatId: string): PendingApproval[] {
  const next = stack.filter((entry) => entry.chatId !== chatId);
  return next.length === stack.length ? stack : next;
}

/** Drops entries whose cosmetic countdown has run out — by then the server has denied them on its own. */
export function dropExpired(stack: PendingApproval[], nowMs: number): PendingApproval[] {
  const next = stack.filter((entry) => nowMs - entry.receivedAtMs < APPROVAL_TIMEOUT_MS);
  return next.length === stack.length ? stack : next;
}

/** The one visible question: the OLDEST open request, so a subagent's later question never jumps the queue. */
export function oldestApproval(stack: PendingApproval[]): PendingApproval | null {
  return stack.length === 0 ? null : stack[0];
}

/** Milliseconds left on the cosmetic countdown, clamped at 0. */
export function remainingMs(entry: PendingApproval, nowMs: number): number {
  return Math.max(0, entry.receivedAtMs + APPROVAL_TIMEOUT_MS - nowMs);
}

/** mm:ss, zero-padded. */
export function formatCountdown(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

/** Shortens an agentId for a label — a subagent id is a long uuid nobody reads in full. */
export function shortAgentId(agentId: string | null | undefined): string | null {
  if (!agentId) return null;
  return agentId.length <= 12 ? agentId : `${agentId.slice(0, 8)}…`;
}
