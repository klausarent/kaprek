// Turning clicked answers back into the next turn's prompt.
//
// The agent receives an ordinary user message with no idea a widget produced
// it, so each answer is quoted alongside its question: "Plain text" on its
// own answers nothing.
//
// This is a deliberate twin of src/plans/quiz.mjs::formatAnswers, which
// serves the same purpose server-side for a turn kaprek answers on its own
// (a trigger, a relay round). The alternative was posting the raw answers
// and letting the server format them, which adds a round trip and a wire
// format without removing the second implementation — the server would still
// need its own. Both are ten lines and both are tested against the same
// shape.
import type { Quiz, QuizAnswer } from "./api";

export function formatQuizAnswers(quiz: Quiz, answers: Record<string, QuizAnswer>): string {
  const lines = quiz.questions.map((question) => {
    const answer = answers[question.id] ?? {};
    const picked = (answer.selected ?? []).filter((s) => s.trim() !== "");
    const other = (answer.other ?? "").trim();
    const parts = [...(picked.length > 0 ? [picked.join(", ")] : []), ...(other !== "" ? [other] : [])];
    return `- ${question.question}\n  ${parts.length > 0 ? parts.join(" — ") : "(skipped)"}`;
  });
  return `My answers:\n\n${lines.join("\n")}`;
}
