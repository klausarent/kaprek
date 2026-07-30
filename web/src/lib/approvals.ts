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

/**
 * An entry's real identity. The server keys pending approvals by
 * `chatId:requestId` (see src/server/server.mjs::approvalKey) because two
 * different CLI subprocesses can hand out colliding request_ids — so the
 * client must key by both too, or answering one chat's question would silently
 * drop the identically-named, still-open question of another chat.
 */
function sameApproval(entry: PendingApproval, chatId: string, id: string): boolean {
  return entry.chatId === chatId && entry.id === id;
}

/** Appends a newly received request. A duplicate id for the same chat is ignored (a re-delivered frame must not double the stack). */
export function addApproval(stack: PendingApproval[], frame: ApprovalFrame, nowMs: number): PendingApproval[] {
  if (stack.some((entry) => sameApproval(entry, frame.chatId, frame.id))) return stack;
  return [...stack, { ...frame, receivedAtMs: nowMs }];
}

/** Drops one entry, keyed by chat AND request id — see sameApproval(). */
export function removeApproval(stack: PendingApproval[], chatId: string, id: string): PendingApproval[] {
  const next = stack.filter((entry) => !sameApproval(entry, chatId, id));
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

/**
 * The "From trigger: nightly-check" line, or null when there is nothing worth
 * saying.
 *
 * A question raised by a trigger ALWAYS names it: those arrive unannounced —
 * an unattended run's approval is delivered to whatever stream happens to be
 * open (see server.mjs's approvalStreams), so it can appear in a chat the user
 * is in the middle of, about work they did not start. Granting a right without
 * knowing what asked for it is the thing to avoid.
 *
 * A question from a CHAT is only labelled when it belongs to a different chat
 * than the one on screen. Labelling the current chat's own question would be
 * noise on the common path.
 */
export function approvalSourceLabel(entry: PendingApproval, currentChatId: string | undefined): string | null {
  const source = entry.source;
  if (!source) return null;
  if (source.kind === "trigger") {
    return `From trigger: ${source.triggerId ?? "unknown"}`;
  }
  if (entry.chatId === currentChatId) return null;
  return `From chat: ${source.title ?? "untitled"}`;
}

/**
 * The exact request an answer turns into: which approval, and which chat it
 * belongs to. Pulled out of the Chat page so the one thing that must never be
 * wrong — the entry's OWN chatId in the body, not "the chat the page happens to
 * be showing" — is checkable without rendering anything. POST
 * /api/approvals/<id> answers 404 for a chatId that does not own the request
 * (see server.mjs::handleApprovalDecision), so a mix-up here silently loses the
 * answer.
 *
 * `message` is only set for a deny; an allow never carries one (the server
 * ignores it there anyway, and sending one would suggest it mattered).
 */
export function buildApprovalAnswer(
  entry: PendingApproval,
  behavior: "allow" | "deny",
): { id: string; body: { chatId: string; behavior: "allow" | "deny"; message?: string } } {
  return {
    id: entry.id,
    body: behavior === "deny" ? { chatId: entry.chatId, behavior, message: "denied by user" } : { chatId: entry.chatId, behavior },
  };
}
