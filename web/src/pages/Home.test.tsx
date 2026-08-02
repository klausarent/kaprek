import { describe, expect, test } from "vitest";
import { render, textOf } from "../test/tree";
import { MissionCard, QuestionCard, isAnswered, progressLine } from "./Home";

const mission = {
  id: "game",
  title: "Build a small game",
  blurb: "A game that runs in a browser.",
  questions: [
    { id: "about", header: "The game", question: "What is the game about?", options: ["A maze to get through", "Catching things that fall"] },
    { id: "where", header: "Where", question: "Which city?", options: [], freeText: true },
  ],
  done: "One file you can double-click, and it plays.",
};

describe("progressLine", () => {
  test("counts in words, not in a bar", () => {
    expect(progressLine(0, 3)).toBe("Question 1 of 3");
    expect(progressLine(2, 3)).toBe("Question 3 of 3");
  });

  test("says when there is nothing left to ask", () => {
    expect(progressLine(3, 3)).toMatch(/ready when you are/);
  });
});

describe("isAnswered", () => {
  test("whitespace is not an answer", () => {
    expect(isAnswered("   ")).toBe(false);
    expect(isAnswered(undefined)).toBe(false);
    expect(isAnswered("A maze")).toBe(true);
  });
});

describe("MissionCard", () => {
  test("shows what it is in words a person would use", () => {
    const text = textOf(render(<MissionCard mission={mission} onPick={() => {}} />));
    expect(text).toContain("Build a small game");
    expect(text).toContain("runs in a browser");
    // The rule for this whole page.
    expect(text.toLowerCase()).not.toMatch(/\bmodel\b|\bagent\b|\bprompt\b|\btoken\b/);
  });
});

describe("QuestionCard", () => {
  test("offers the options as things to tap", () => {
    const text = textOf(render(<QuestionCard question={mission.questions[0]} value={undefined} onChange={() => {}} />));
    expect(text).toContain("What is the game about?");
    expect(text).toContain("Catching things that fall");
  });

  test("a question with no options asks for typing instead of showing an empty list", () => {
    const tree = render(<QuestionCard question={mission.questions[1]} value={undefined} onChange={() => {}} />);
    expect(textOf(tree)).toContain("Which city?");
  });
});
