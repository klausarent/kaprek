import { test, expect } from "vitest";
import { describeWork, toSimpleItems } from "./simple";
import type { DigestEvent } from "./api";

const ev = (kind: string, extra: Record<string, unknown> = {}): DigestEvent =>
  ({ kind, ts: "2026-08-01T00:00:00.000Z", msgId: null, ...extra }) as DigestEvent;

test("work between two answers folds into a single run, conversation events keep their order", () => {
  const items = toSimpleItems([
    ev("user", { text: "do it" }),
    ev("thinking", { text: "hmm" }),
    ev("tool", { name: "Read", input: "{}", result: "ok" }),
    ev("tool", { name: "Bash", input: "{}", result: "ok" }),
    ev("assistant", { text: "done" }),
  ]);
  expect(items.map((i) => i.kind)).toEqual(["event", "work", "event"]);
  expect(items[1].kind === "work" && items[1].events).toHaveLength(3);
  expect(items[1].kind === "work" && items[1].startIndex).toBe(1);
});

test("an approval is conversation, never buried inside a fold — the question a human answered stays visible", () => {
  const items = toSimpleItems([
    ev("tool", { name: "Read", input: "{}", result: "ok" }),
    ev("approval", { toolName: "Write", phase: "requested" }),
    ev("tool", { name: "Write", input: "{}", result: "ok" }),
  ]);
  expect(items.map((i) => i.kind)).toEqual(["work", "event", "work"]);
});

test("a chat with no work at all produces no empty fold", () => {
  const items = toSimpleItems([ev("user", { text: "hi" }), ev("assistant", { text: "hello" })]);
  expect(items.every((i) => i.kind === "event")).toBe(true);
});

test("the summary names the distinct tools and counts the steps", () => {
  expect(
    describeWork([
      ev("tool", { name: "Read" }),
      ev("tool", { name: "Read" }),
      ev("tool", { name: "Bash" }),
    ]),
  ).toBe("Worked · 3 steps · Read, Bash");
  expect(describeWork([ev("thinking", { text: "x" })])).toBe("Worked · 1 step · thinking");
});
