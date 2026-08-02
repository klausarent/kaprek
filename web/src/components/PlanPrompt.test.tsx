import { describe, expect, test } from "vitest";
import { render, textOf, findAll } from "../test/tree";
import PlanPrompt, { looksLikePlanning } from "./PlanPrompt";

describe("noticing that someone is planning", () => {
  test("naming the activity is enough, in either language", () => {
    expect(looksLikePlanning("Lass uns das mal brainstormen")).toBe(true);
    expect(looksLikePlanning("I want to brainstorm the onboarding flow")).toBe(true);
    expect(looksLikePlanning("Kannst du ein Konzept für den Newsletter machen?")).toBe(true);
    expect(looksLikePlanning("Let's plan the migration")).toBe(true);
    expect(looksLikePlanning("We are planning the release, help me structure it")).toBe(true);
  });

  test("an opener plus a building verb counts, the verb alone does not", () => {
    expect(looksLikePlanning("Lass uns einen Newsletter-Generator bauen")).toBe(true);
    expect(looksLikePlanning("Ich möchte eine Auswertung für die Kurse entwickeln")).toBe(true);
    // A plain instruction is work, not planning — no popup.
    expect(looksLikePlanning("Bau das Login-Formular nach dem Muster von oben")).toBe(false);
    expect(looksLikePlanning("Build the login form like the one above")).toBe(false);
  });

  test("asking about an existing plan is not asking for a new one", () => {
    expect(looksLikePlanning("Zeig mir den Plan von gestern")).toBe(false);
    expect(looksLikePlanning("Was steht im Plan?")).toBe(false);
    expect(looksLikePlanning("Show me the plan")).toBe(false);
    expect(looksLikePlanning("Dann eben Plan B")).toBe(false);
  });

  test("a negated signal is the opposite of a signal", () => {
    expect(looksLikePlanning("Bitte keine Planung starten, einfach umsetzen")).toBe(false);
    expect(looksLikePlanning("Nicht brainstormen bitte, direkt bauen")).toBe(false);
    expect(looksLikePlanning("Don't plan this, just do it")).toBe(false);
    expect(looksLikePlanning("Review the spec please")).toBe(false);
  });

  test("a word that merely contains a signal never triggers it", () => {
    expect(looksLikePlanning("Die Flugzeugplanung interessiert mich nicht, fix den Test")).toBe(false);
    expect(looksLikePlanning("Der Bauplan liegt im Ordner, lies ihn")).toBe(false);
  });

  test("steering turns and junk are never planning", () => {
    for (const text of ["ja", "weiter", "ok mach", "", null, undefined, 42]) {
      expect(looksLikePlanning(text)).toBe(false);
    }
  });
});

describe("the offer itself", () => {
  test("offers both modes and a way out", () => {
    const tree = render(<PlanPrompt onPick={() => {}} onDismiss={() => {}} />);
    const text = textOf(tree);
    expect(text).toContain("Start the quiz");
    expect(text).toContain("Straight to a plan");
    expect(text).toContain("Just chat");
  });

  test("each button reports which mode was chosen", () => {
    const picked: string[] = [];
    const tree = render(<PlanPrompt onPick={(mode) => picked.push(mode)} onDismiss={() => picked.push("dismissed")} />);
    for (const button of findAll(tree, (node) => typeof node.props?.onClick === "function")) {
      (button.props.onClick as () => void)();
    }
    expect(picked).toEqual(["brainstorm", "plan", "dismissed"]);
  });
});
