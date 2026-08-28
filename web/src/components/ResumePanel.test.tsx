// @testing-library/react is not part of this repo's web devDependencies (see
// src/test/tree.tsx for why) and this task adds no dependency, so this uses
// the element-tree walker every other component test here uses.
import { describe, it, expect, vi } from "vitest";
import { ResumePanel } from "./ResumePanel";
import { recentSessions, type ResumeSession } from "../lib/resume";
import { click, findByType, render, textOf } from "../test/tree";

const s = (over: Partial<ResumeSession>): ResumeSession => ({
  key: "claude:a",
  engine: "claude",
  id: "a",
  cwd: "C:\\p",
  title: "Aufgabe A",
  firstTs: "2026-08-28T06:00:00.000Z",
  lastTs: "2026-08-28T06:30:00.000Z",
  userMsgs: 2,
  hidden: false,
  crash: false,
  ...over,
});

describe("ResumePanel", () => {
  it("lists sessions grouped by engine with a resume button each", () => {
    const onResume = vi.fn();
    const tree = render(
      <ResumePanel
        sessions={[s({}), s({ key: "codex:b", engine: "codex", id: "b", title: "Aufgabe B" })]}
        onResume={onResume}
        onResumeAll={() => {}}
        busy={false}
        statusText=""
      />,
    );
    const text = textOf(tree);
    expect(text).toContain("Aufgabe A");
    expect(text).toContain("codex");

    const buttons = findByType(tree, "button");
    expect(buttons.length).toBeGreaterThanOrEqual(3); // "alle" + 2 rows
    click(buttons[1]);
    expect(onResume).toHaveBeenCalledWith("claude", "a");
  });

  it("marks crash-grouped sessions", () => {
    const tree = render(
      <ResumePanel sessions={[s({ crash: true })]} onResume={() => {}} onResumeAll={() => {}} busy={false} statusText="" />,
    );
    expect(textOf(tree)).toMatch(/absturz/i);
  });

  it("shows the status text and disables every button while busy", () => {
    const tree = render(
      <ResumePanel sessions={[s({})]} onResume={() => {}} onResumeAll={() => {}} busy statusText="1/1 Tabs geöffnet" />,
    );
    expect(textOf(tree)).toContain("1/1 Tabs geöffnet");
    expect(findByType(tree, "button").every((b) => b.props.disabled === true)).toBe(true);
  });

  it("recentSessions keeps only the last N hours", () => {
    const now = Date.parse("2026-08-28T08:00:00.000Z");
    const list = [s({}), s({ key: "claude:old", id: "old", lastTs: "2026-08-20T06:00:00.000Z" })];
    expect(recentSessions(list, 24, now).map((x) => x.id)).toEqual(["a"]);
  });
});
