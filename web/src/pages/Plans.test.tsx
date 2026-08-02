import { describe, expect, test } from "vitest";
import { render, textOf, findAll } from "../test/tree";
import { PlanList, PlanDetailView, progressOf, subtitleOf } from "./Plans";
import type { PlanDetail, PlanSummary } from "../lib/api";

const summary = (over: Partial<PlanSummary> = {}): PlanSummary => ({
  id: "p1",
  path: "C:\\work\\newsletter\\docs\\plans\\2026-08-02-newsletter.md",
  title: "Newsletter generator",
  kind: "plan",
  status: "draft",
  chatId: null,
  missionId: null,
  createdAt: "2026-08-02T01:00:00.000Z",
  updatedAt: "2026-08-02T01:00:00.000Z",
  exists: true,
  ...over,
});

const detail = (over: Partial<PlanDetail> = {}): PlanDetail => ({
  ...summary(),
  content: "# Newsletter generator\n\n- [x] First step\n- [ ] Second step\n",
  steps: [
    { index: 0, line: 2, text: "First step", done: true },
    { index: 1, line: 3, text: "Second step", done: false },
  ],
  truncated: false,
  ...over,
});

describe("the list", () => {
  test("an empty workspace explains how plans get here", () => {
    const text = textOf(render(<PlanList plans={[]} selectedId={null} onSelect={() => {}} />));
    expect(text).toContain("No plans yet");
    expect(text).toContain("quiz");
  });

  test("a deleted file is marked rather than quietly listed as fine", () => {
    const text = textOf(render(<PlanList plans={[summary({ exists: false })]} selectedId={null} onSelect={() => {}} />));
    expect(text).toContain("missing");
  });

  test("a design and a plan are told apart", () => {
    expect(subtitleOf(summary({ kind: "spec" }))).toBe("design");
    expect(subtitleOf(summary({ kind: "plan" }))).toBe("plan");
  });

  test("selecting reports the id", () => {
    const picked: string[] = [];
    const tree = render(<PlanList plans={[summary()]} selectedId={null} onSelect={(id) => picked.push(id)} />);
    findAll(tree, (node) => typeof node.props?.onClick === "function").forEach((n) => (n.props.onClick as () => void)());
    expect(picked).toEqual(["p1"]);
  });
});

describe("the detail", () => {
  test("shows the absolute path, because that is the whole point", () => {
    const text = textOf(render(<PlanDetailView plan={detail()} busyStep={null} onToggleStep={() => {}} onImplement={() => {}} onCopyPath={() => {}} />));
    expect(text).toContain("C:\\work\\newsletter\\docs\\plans\\2026-08-02-newsletter.md");
    expect(text).toContain("Copy path");
  });

  test("counts what is done", () => {
    expect(progressOf(detail())).toBe("1 of 2 done");
    expect(progressOf({ steps: [] })).toBe("0 of 0 done");
  });

  test("a ticked step reports its index and the new state", () => {
    const calls: [number, boolean][] = [];
    const tree = render(<PlanDetailView plan={detail()} busyStep={null} onToggleStep={(i, d) => calls.push([i, d])} onImplement={() => {}} onCopyPath={() => {}} />);
    const boxes = findAll(tree, (node) => node.props?.type === "checkbox");
    (boxes[1].props.onChange as (e: { target: { checked: boolean } }) => void)({ target: { checked: true } });
    expect(calls).toEqual([[1, true]]);
  });

  test("a plan without checkboxes offers no progress bar and says why", () => {
    const text = textOf(render(<PlanDetailView plan={detail({ steps: [] })} busyStep={null} onToggleStep={() => {}} onImplement={() => {}} onCopyPath={() => {}} />));
    expect(text).toContain("design document");
    expect(text).not.toContain("of 0 done");
  });

  test("a truncated file says so instead of looking complete", () => {
    const text = textOf(render(<PlanDetailView plan={detail({ truncated: true })} busyStep={null} onToggleStep={() => {}} onImplement={() => {}} onCopyPath={() => {}} />));
    expect(text).toContain("too large to show whole");
  });

  test("boxes are locked while one is being written", () => {
    const tree = render(<PlanDetailView plan={detail()} busyStep={0} onToggleStep={() => {}} onImplement={() => {}} onCopyPath={() => {}} />);
    expect(findAll(tree, (node) => node.props?.type === "checkbox").every((box) => box.props.disabled === true)).toBe(true);
  });
});
