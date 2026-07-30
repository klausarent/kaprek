// The approval stack: pure state transitions plus the countdown arithmetic
// ApprovalDialog renders. Kept out of the component so both are testable on
// their own — the component is a pure function of these values.
import type { ApprovalFrame } from "./api";

/**
 * Fallback deadline for a frame that carries no `deadlineAt` of its own.
 *
 * The server tells the client when it will give up (see
 * server.mjs::makeApprovalHandler, which puts `deadlineAt` on every approval
 * frame), and deadline() below prefers that. This constant is only what a
 * frame from an older server, or one that somehow lost the field, falls back
 * to. It must NOT be treated as the deadline in general: a question raised by
 * an unattended trigger waits hours, not ten minutes
 * (APPROVAL_DEADLINE_UNATTENDED_MS in src/server/approval-store.mjs), and a
 * client that assumed ten minutes would drop a live question out of the stack
 * while the server was still waiting on it.
 *
 * Either way the countdown is COSMETIC: the server's own timer is the
 * authority, and a client whose clock or tab-throttling makes this number
 * wrong changes nothing about what happens to the tool call.
 */
export const APPROVAL_TIMEOUT_MS = 10 * 60 * 1000;

export type PendingApproval = ApprovalFrame & {
  /** Client-side receipt time, the countdown's zero point. */
  receivedAtMs: number;
};

/** When this entry lapses: the server's own `deadlineAt` when it sent one, otherwise the client-side fallback above. */
export function deadlineOf(entry: PendingApproval): number {
  return typeof entry.deadlineAt === "number" ? entry.deadlineAt : entry.receivedAtMs + APPROVAL_TIMEOUT_MS;
}

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

/** Drops entries whose countdown has run out — by then the server has denied them on its own. Keyed off the server's own deadline where it gave one (see deadlineOf), so an eight-hour trigger question is not swept out of the stack after ten minutes. */
export function dropExpired(stack: PendingApproval[], nowMs: number): PendingApproval[] {
  const next = stack.filter((entry) => nowMs < deadlineOf(entry));
  return next.length === stack.length ? stack : next;
}

/** The one visible question: the OLDEST open request, so a subagent's later question never jumps the queue. */
export function oldestApproval(stack: PendingApproval[]): PendingApproval | null {
  return stack.length === 0 ? null : stack[0];
}

/** Milliseconds left on the cosmetic countdown, clamped at 0. */
export function remainingMs(entry: PendingApproval, nowMs: number): number {
  return Math.max(0, deadlineOf(entry) - nowMs);
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
// Takes the two fields it actually reads rather than a whole PendingApproval:
// the same label is needed for an inbox entry (see pages/Approvals.tsx), which
// carries no client-side receivedAtMs because it was never pushed to a client.
export function approvalSourceLabel(
  entry: Pick<ApprovalFrame, "source" | "chatId">,
  currentChatId: string | undefined,
): string | null {
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
