// The open-questions store behind the floating question box.
//
// A deferred question is one an unattended turn filed and then walked away
// from (see src/server/approval-store.mjs). Nothing is blocked on it, so it
// can sit for a day, and the user may run into it on any page — hence a
// module-level store like lib/status.ts rather than page state: the writers
// (the initial fetch, a chat page's SSE stream) and the reader (a box rendered
// next to every route) live in different parts of the tree.
//
// Dismissing is deliberately NOT a decision. It hides a card in the box and
// nowhere else: the question stays in #/approvals, stays answerable, and comes
// back into the box the moment the trigger asks again (askedCount goes up).
// Anything else would make an X-button a silent deny, which is the one thing a
// dismiss must never be.
import { useSyncExternalStore } from "react";
import type { InboxApproval } from "./api";

/** Which cards the user waved away, and at what askedCount — asking again beats an earlier dismissal. */
const DISMISSED_KEY = "kaprek.questions.dismissed";
/** Whether the box is collapsed to its badge. */
const COLLAPSED_KEY = "kaprek.questions.collapsed";

export type OpenQuestion = InboxApproval & {
  mode?: "interactive" | "deferred";
  askedCount?: number;
  triggerId?: string | null;
};

type DismissedMap = Record<string, number>;

let questions: OpenQuestion[] = [];
const listeners = new Set<() => void>();

// sessionStorage is not a given: it does not exist outside a browser (these
// modules are unit-tested in plain Node), and a browser can have it disabled
// or full. The box must work either way; without it, it simply forgets what
// was dismissed when the page reloads.
const memory = new Map<string, string>();

function readJson<T>(key: string, fallback: T): T {
  try {
    const raw = typeof sessionStorage === "undefined" ? memory.get(key) ?? null : sessionStorage.getItem(key);
    return raw === null || raw === undefined ? fallback : (JSON.parse(raw) as T);
  } catch {
    return fallback;
  }
}

function writeJson(key: string, value: unknown): void {
  const serialized = JSON.stringify(value);
  try {
    if (typeof sessionStorage === "undefined") memory.set(key, serialized);
    else sessionStorage.setItem(key, serialized);
  } catch {
    memory.set(key, serialized);
  }
}

/** Forgets every dismissal. Exported for tests; the app never needs it (asking again is what un-dismisses a card). */
export function clearDismissed(): void {
  writeJson(DISMISSED_KEY, {});
}

/** A question's identity across askedCount changes: the entry, not the ask. */
export function questionKey(question: Pick<OpenQuestion, "chatId" | "id">): string {
  return `${question.chatId}:${question.id}`;
}

function notify(): void {
  for (const listener of listeners) listener();
}

/** Replaces the whole list — what a fresh GET /api/approvals produces. */
export function setQuestions(next: OpenQuestion[]): void {
  questions = next.filter((question) => (question.mode ?? "deferred") === "deferred");
  notify();
}

/**
 * Adds or updates one question, from a live SSE approval frame. An interactive
 * frame is ignored here: the live dialog IS the box for those, and showing
 * them twice would ask the same question in two places.
 */
export function upsertQuestion(question: OpenQuestion): void {
  if ((question.mode ?? "interactive") !== "deferred") return;
  const key = questionKey(question);
  const index = questions.findIndex((existing) => questionKey(existing) === key);
  questions = index === -1 ? [...questions, question] : questions.map((existing, i) => (i === index ? { ...existing, ...question } : existing));
  notify();
}

/** Drops one question for good — what an answer produces. */
export function removeQuestion(key: string): void {
  const next = questions.filter((question) => questionKey(question) !== key);
  if (next.length === questions.length) return;
  questions = next;
  notify();
}

export function getQuestions(): OpenQuestion[] {
  return questions;
}

export function subscribeQuestions(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/**
 * The cards the box should show: every open question except the ones dismissed
 * at their CURRENT ask count. A trigger that asks again pushes askedCount past
 * what was dismissed, and the card returns — new asking beats old dismissing.
 */
export function visibleQuestions(all: OpenQuestion[], dismissed: DismissedMap): OpenQuestion[] {
  return all.filter((question) => {
    const dismissedAt = dismissed[questionKey(question)];
    if (dismissedAt === undefined) return true;
    return (question.askedCount ?? 1) > dismissedAt;
  });
}

export function readDismissed(): DismissedMap {
  return readJson<DismissedMap>(DISMISSED_KEY, {});
}

/** Records a dismissal AT the ask count it was dismissed at, so a later ask can outrank it. */
export function dismissQuestion(question: OpenQuestion): DismissedMap {
  const next = { ...readDismissed(), [questionKey(question)]: question.askedCount ?? 1 };
  writeJson(DISMISSED_KEY, next);
  notify();
  return next;
}

export function isCollapsed(): boolean {
  return readJson<boolean>(COLLAPSED_KEY, false);
}

export function setCollapsed(collapsed: boolean): void {
  writeJson(COLLAPSED_KEY, collapsed);
  notify();
}

export function useOpenQuestions(): OpenQuestion[] {
  return useSyncExternalStore(subscribeQuestions, getQuestions, getQuestions);
}
