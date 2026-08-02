// The quiz: an agent's brainstorming questions as cards you click.
//
// Klaus, after sitting through one as prose: "der Nutzer kann das mit einem
// visuellen Quiz machen statt alles in einem Text wie hier durchzugehen."
//
// Deliberately not a wizard. Every question in the packet is on screen at
// once, because a person deciding "what should this do first" wants to see
// the next question before answering this one. Free text sits beside the
// options rather than behind an "other" toggle — the option the agent didn't
// think of is the one worth making easy.
//
// QuizForm is exported hook-free so it can be tested without a DOM (see
// src/test/tree.tsx).
import { useState } from "react";
import type { Quiz, QuizAnswer, QuizQuestion } from "../lib/api";

/** Whether every question has something to send. */
export function isAnswered(quiz: Quiz, answers: Record<string, QuizAnswer>): boolean {
  return quiz.questions.every((question) => {
    const answer = answers[question.id];
    return (answer?.selected?.length ?? 0) > 0 || (answer?.other ?? "").trim() !== "";
  });
}

/** Selecting `label` on `question`, honouring single vs. multiple choice. */
export function toggleOption(question: QuizQuestion, answer: QuizAnswer | undefined, label: string): QuizAnswer {
  const selected = answer?.selected ?? [];
  if (!question.multiSelect) {
    // Clicking the chosen option again clears it: a single-choice question
    // with no way back is a trap when you mis-click.
    return { ...answer, selected: selected.includes(label) ? [] : [label] };
  }
  return { ...answer, selected: selected.includes(label) ? selected.filter((s) => s !== label) : [...selected, label] };
}

export function QuizForm({
  quiz,
  answers,
  busy = false,
  onChange,
  onSubmit,
  onSkip,
}: {
  quiz: Quiz;
  answers: Record<string, QuizAnswer>;
  busy?: boolean;
  onChange: (questionId: string, answer: QuizAnswer) => void;
  onSubmit: () => void;
  onSkip: () => void;
}) {
  return (
    <div className="quiz">
      {quiz.questions.map((question, position) => {
        const answer = answers[question.id];
        return (
          <fieldset className="quiz-question" key={question.id}>
            <legend>
              {question.header && <span className="badge">{question.header}</span>}
              <span className="quiz-question-text">{question.question}</span>
              {quiz.questions.length > 1 && (
                <span className="quiz-question-count">
                  {position + 1} of {quiz.questions.length}
                </span>
              )}
            </legend>

            {question.options.length > 0 && (
              <div className="quiz-options">
                {question.options.map((option) => {
                  const picked = (answer?.selected ?? []).includes(option.label);
                  return (
                    <button
                      key={option.label}
                      type="button"
                      className={picked ? "quiz-option quiz-option-picked" : "quiz-option"}
                      aria-pressed={picked}
                      disabled={busy}
                      onClick={() => onChange(question.id, toggleOption(question, answer, option.label))}
                    >
                      <span className="quiz-option-label">{option.label}</span>
                      {option.description && <span className="quiz-option-description">{option.description}</span>}
                    </button>
                  );
                })}
              </div>
            )}

            {question.allowOther && (
              <input
                type="text"
                className="quiz-other"
                placeholder={question.options.length > 0 ? "Or say it in your own words" : "Your answer"}
                value={answer?.other ?? ""}
                disabled={busy}
                onChange={(event) => onChange(question.id, { ...answer, other: event.target.value })}
              />
            )}
          </fieldset>
        );
      })}

      <div className="quiz-actions">
        <button type="button" className="btn" disabled={busy || !isAnswered(quiz, answers)} onClick={onSubmit}>
          Send answers
        </button>
        <button type="button" className="link-button" disabled={busy} onClick={onSkip}>
          Answer in my own words instead
        </button>
      </div>
    </div>
  );
}

export default function QuizCard({ quiz, busy = false, onSubmit, onSkip }: { quiz: Quiz; busy?: boolean; onSubmit: (answers: Record<string, QuizAnswer>) => void; onSkip: () => void }) {
  const [answers, setAnswers] = useState<Record<string, QuizAnswer>>({});
  return (
    <QuizForm
      quiz={quiz}
      answers={answers}
      busy={busy}
      onChange={(questionId, answer) => setAnswers((prev) => ({ ...prev, [questionId]: answer }))}
      onSubmit={() => onSubmit(answers)}
      onSkip={onSkip}
    />
  );
}
