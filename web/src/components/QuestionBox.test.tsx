import { test, expect, vi, beforeEach } from "vitest";
import { QuestionCard } from "./QuestionBox";
import {
  clearDismissed,
  dismissQuestion,
  questionKey,
  readDismissed,
  setQuestions,
  upsertQuestion,
  visibleQuestions,
  getQuestions,
  type OpenQuestion,
} from "../lib/questions";
import { findByType, findOneByText, render, textOf, click } from "../test/tree";

const NOW = 1_700_000_000_000;

function question(overrides: Partial<OpenQuestion> = {}): OpenQuestion {
  return {
    type: "approval",
    chatId: "11111111-2222-3333-4444-555555555555",
    id: "q-1",
    source: null,
    toolName: "Bash",
    displayName: "Bash",
    input: { command: "git push" },
    inputPreview: '{"command":"git push"}',
    description: null,
    reason: null,
    agentId: null,
    requestedAt: NOW - 2 * 60 * 60 * 1000,
    deadlineAt: NOW + 22 * 60 * 60 * 1000,
    mode: "deferred",
    askedCount: 1,
    triggerId: "nightly-check",
    ...overrides,
  };
}

beforeEach(() => {
  clearDismissed();
  setQuestions([]);
});

test("a card names the tool, the trigger, how old the question is, and what was proposed", () => {
  const text = textOf(render(<QuestionCard question={question()} nowMs={NOW} onDecide={() => {}} onDismiss={() => {}} />));
  expect(text).toContain("Bash");
  expect(text).toContain("nightly-check");
  expect(text).toContain("2 hours ago");
  expect(text).toContain("git push");
});

test("a card offers approve, deny and dismiss, and dismiss is not one of the decisions", () => {
  const onDecide = vi.fn();
  const onDismiss = vi.fn();
  const entry = question();
  const tree = render(<QuestionCard question={entry} nowMs={NOW} onDecide={onDecide} onDismiss={onDismiss} />);

  click(findOneByText(tree, "button", "Approve & run now"));
  click(findOneByText(tree, "button", "Deny"));
  click(findOneByText(tree, "button", "×"));

  expect(onDecide.mock.calls.map(([, behavior]) => behavior)).toEqual(["allow", "deny"]);
  // The X reports a dismissal and NOTHING else: no decision, no third call
  // into onDecide. A dismiss that quietly denied would be the worst possible
  // reading of that button.
  expect(onDismiss).toHaveBeenCalledTimes(1);
  expect(onDecide).toHaveBeenCalledTimes(2);
});

test("a card that was asked more than once says so", () => {
  const text = textOf(render(<QuestionCard question={question({ askedCount: 4 })} nowMs={NOW} onDecide={() => {}} onDismiss={() => {}} />));
  expect(text).toContain("asked 4 times");
  expect(textOf(render(<QuestionCard question={question()} nowMs={NOW} onDecide={() => {}} onDismiss={() => {}} />))).not.toContain("asked 1");
});

test("a card whose stored input was truncated warns that the agent will ask again", () => {
  const text = textOf(
    render(
      <QuestionCard
        question={question({ input: { _truncated: true, preview: "…" } as unknown as Record<string, unknown> })}
        nowMs={NOW}
        onDecide={() => {}}
        onDismiss={() => {}}
      />,
    ),
  );
  expect(text).toContain("ask again");
});

test("busy disables both decisions but leaves dismiss usable", () => {
  const tree = render(<QuestionCard question={question()} nowMs={NOW} busy onDecide={() => {}} onDismiss={() => {}} />);
  expect(findOneByText(tree, "button", "Approve & run now").props.disabled).toBe(true);
  expect(findOneByText(tree, "button", "Deny").props.disabled).toBe(true);
  expect(findOneByText(tree, "button", "×").props.disabled).toBeUndefined();
});

test("dismissing hides the card without answering it, and asking again brings it back", () => {
  // The rule that makes an X-button safe: it is a "not now", not a decision,
  // and a trigger that asks again outranks it.
  const entry = question({ askedCount: 1 });
  setQuestions([entry]);

  const afterDismiss = dismissQuestion(entry);
  expect(visibleQuestions(getQuestions(), afterDismiss)).toEqual([]);
  // Still in the store, so #/approvals still lists it and it is still
  // answerable — hiding is local to the box.
  expect(getQuestions()).toHaveLength(1);

  upsertQuestion({ ...entry, askedCount: 2 });
  expect(visibleQuestions(getQuestions(), readDismissed()).map((q) => q.id)).toEqual(["q-1"]);
});

test("only deferred questions reach the box — a live dialog's question is not shown twice", () => {
  setQuestions([question(), question({ id: "live-1", mode: "interactive" })]);
  expect(getQuestions().map((q) => q.id)).toEqual(["q-1"]);

  upsertQuestion(question({ id: "live-2", mode: "interactive" }));
  expect(getQuestions().map((q) => q.id)).toEqual(["q-1"]);
});

test("upsertQuestion updates an existing card rather than stacking a duplicate", () => {
  const entry = question();
  setQuestions([entry]);
  upsertQuestion({ ...entry, askedCount: 3 });

  expect(getQuestions()).toHaveLength(1);
  expect(getQuestions()[0].askedCount).toBe(3);
  expect(questionKey(getQuestions()[0])).toBe(questionKey(entry));
});

test("a card with no preview still renders something rather than an empty box", () => {
  const text = textOf(
    render(<QuestionCard question={question({ inputPreview: null, input: { a: 1 } })} nowMs={NOW} onDecide={() => {}} onDismiss={() => {}} />),
  );
  expect(text).toContain('{"a":1}');
});

test("the expand toggle is the only thing that changes the input's own presentation", () => {
  const collapsed = render(<QuestionCard question={question()} nowMs={NOW} onToggleExpand={() => {}} onDecide={() => {}} onDismiss={() => {}} />);
  const expanded = render(
    <QuestionCard question={question()} nowMs={NOW} expanded onToggleExpand={() => {}} onDecide={() => {}} onDismiss={() => {}} />,
  );
  expect(findByType(collapsed, "pre")[0].props.className).not.toContain("open");
  expect(findByType(expanded, "pre")[0].props.className).toContain("open");
  expect(textOf(collapsed)).toContain("Show more");
  expect(textOf(expanded)).toContain("Show less");
});
