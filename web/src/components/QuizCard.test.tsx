import { describe, expect, test } from "vitest";
import { render, textOf, findAll } from "../test/tree";
import { QuizForm, isAnswered, toggleOption } from "./QuizCard";
import { formatQuizAnswers } from "../lib/quiz";
import type { Quiz, QuizAnswer, QuizQuestion } from "../lib/api";

const question = (over: Partial<QuizQuestion> = {}): QuizQuestion => ({
  id: "scope",
  header: "Scope",
  question: "What should it do first?",
  options: [
    { label: "One flow", description: "A single path, no settings" },
    { label: "Everything", description: "Every screen roughed in" },
  ],
  multiSelect: false,
  allowOther: true,
  ...over,
});

const quiz = (over: Partial<Quiz> = {}): Quiz => ({ questions: [question()], done: false, ...over });

describe("picking answers", () => {
  test("single choice replaces, and clicking the same option again clears it", () => {
    const q = question();
    const first = toggleOption(q, undefined, "One flow");
    expect(first.selected).toEqual(["One flow"]);
    expect(toggleOption(q, first, "Everything").selected).toEqual(["Everything"]);
    // Mis-clicking a single-choice question must not be a one-way door.
    expect(toggleOption(q, first, "One flow").selected).toEqual([]);
  });

  test("multiple choice accumulates", () => {
    const q = question({ multiSelect: true });
    const first = toggleOption(q, undefined, "One flow");
    const both = toggleOption(q, first, "Everything");
    expect(both.selected).toEqual(["One flow", "Everything"]);
    expect(toggleOption(q, both, "One flow").selected).toEqual(["Everything"]);
  });

  test("free text alone counts as answered, and so does a picked option", () => {
    const q = quiz();
    expect(isAnswered(q, {})).toBe(false);
    expect(isAnswered(q, { scope: { other: "   " } })).toBe(false);
    expect(isAnswered(q, { scope: { other: "Something else entirely" } })).toBe(true);
    expect(isAnswered(q, { scope: { selected: ["One flow"] } })).toBe(true);
  });

  test("every question in the packet must be answered before sending", () => {
    const two = quiz({ questions: [question(), question({ id: "who", question: "Who is it for?" })] });
    expect(isAnswered(two, { scope: { selected: ["One flow"] } })).toBe(false);
    expect(isAnswered(two, { scope: { selected: ["One flow"] }, who: { other: "Existing customers" } })).toBe(true);
  });
});

describe("the rendered card", () => {
  test("shows the question, both options and their descriptions", () => {
    const tree = render(<QuizForm quiz={quiz()} answers={{}} onChange={() => {}} onSubmit={() => {}} onSkip={() => {}} />);
    const text = textOf(tree);
    expect(text).toContain("What should it do first?");
    expect(text).toContain("One flow");
    expect(text).toContain("A single path, no settings");
  });

  test("sending is refused until something is answered", () => {
    const empty = render(<QuizForm quiz={quiz()} answers={{}} onChange={() => {}} onSubmit={() => {}} onSkip={() => {}} />);
    const send = findAll(empty, (node) => node.props?.className === "btn")[0];
    expect(send.props.disabled).toBe(true);

    const filled = render(<QuizForm quiz={quiz()} answers={{ scope: { selected: ["One flow"] } }} onChange={() => {}} onSubmit={() => {}} onSkip={() => {}} />);
    expect(findAll(filled, (node) => node.props?.className === "btn")[0].props.disabled).toBe(false);
  });

  test("a picked option is marked for assistive tech, not just visually", () => {
    const tree = render(<QuizForm quiz={quiz()} answers={{ scope: { selected: ["Everything"] } }} onChange={() => {}} onSubmit={() => {}} onSkip={() => {}} />);
    const pressed = findAll(tree, (node) => node.props?.["aria-pressed"] === true);
    expect(pressed).toHaveLength(1);
    expect(textOf(pressed[0])).toContain("Everything");
  });

  test("a question with no options still offers a way to answer", () => {
    const open = quiz({ questions: [question({ options: [], allowOther: true })] });
    const tree = render(<QuizForm quiz={open} answers={{}} onChange={() => {}} onSubmit={() => {}} onSkip={() => {}} />);
    expect(findAll(tree, (node) => node.props?.className === "quiz-other")).toHaveLength(1);
  });

  test("everything is disabled while the answer is in flight", () => {
    const tree = render(<QuizForm quiz={quiz()} answers={{ scope: { selected: ["One flow"] } }} busy onChange={() => {}} onSubmit={() => {}} onSkip={() => {}} />);
    expect(findAll(tree, (node) => node.props?.disabled === true).length).toBeGreaterThan(2);
  });
});

describe("the prompt the answers become", () => {
  test("quotes the question next to the answer", () => {
    const prompt = formatQuizAnswers(quiz(), { scope: { selected: ["One flow"] } });
    expect(prompt).toContain("What should it do first?");
    expect(prompt).toContain("One flow");
  });

  test("free text and multiple picks survive, and a skipped question says so", () => {
    const two = quiz({ questions: [question({ multiSelect: true }), question({ id: "who", question: "Who is it for?" })] });
    const answers: Record<string, QuizAnswer> = { scope: { selected: ["One flow", "Everything"], other: "and a CLI" } };
    const prompt = formatQuizAnswers(two, answers);
    expect(prompt).toContain("One flow, Everything — and a CLI");
    expect(prompt).toContain("(skipped)");
  });
});
