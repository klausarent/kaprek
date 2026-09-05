import { test, expect, vi } from "vitest";
import { MissionListItem } from "./Missions";
import { MissionHeader, MISSION_STATUS_OPTIONS } from "./MissionDetail";
import type { Mission } from "../lib/api";
import { render, textOf, click, findByType, findAll } from "../test/tree";

function mission(overrides: Partial<Mission> = {}): Mission {
  return {
    id: "m-1",
    title: "Ship the widget",
    goal: "A working widget with tests",
    cwd: "C:\\projects\\widget",
    posture: null,
    budgetUsd: null,
    preset: null,
    status: "active",
    createdAt: "2026-08-01T10:00:00.000Z",
    updatedAt: "2026-08-01T10:00:00.000Z",
    chats: [],
    tasks: [],
    ...overrides,
  };
}

test("a mission row names the mission, its status, where it runs, and what waits on a human", () => {
  const text = textOf(render(<MissionListItem mission={mission({ pendingApprovals: 2 })} onOpen={() => {}} />));
  expect(text).toContain("Ship the widget");
  expect(text).toContain("Active");
  expect(text).toContain("C:\\projects\\widget");
  expect(text).toContain("2 questions waiting");
});

test("a mission row without pending questions shows no waiting hint", () => {
  const text = textOf(render(<MissionListItem mission={mission()} onOpen={() => {}} />));
  expect(text).not.toContain("waiting");
});

test("clicking a mission row opens it", () => {
  const onOpen = vi.fn();
  const tree = render(<MissionListItem mission={mission()} onOpen={onOpen} />);
  click(findByType(tree, "button")[0]);
  expect(onOpen).toHaveBeenCalledWith("m-1");
});

test("the mission header offers the full status lifecycle and names the working directory", () => {
  const tree = render(<MissionHeader mission={mission()} onStatusChange={() => {}} />);
  const options = findByType(tree, "option");
  expect(options.map((o) => textOf(o))).toEqual(MISSION_STATUS_OPTIONS.map((o) => o.label));
  expect(textOf(tree)).toContain("C:\\projects\\widget");
});

test("a mission without a cwd says it runs in the workspace default", () => {
  const tree = render(<MissionHeader mission={mission({ cwd: null })} onStatusChange={() => {}} />);
  expect(textOf(tree)).toContain("kaprek workspace (default)");
});

test("posture: the header offers the select only when it can change it, defaulting to the global one", () => {
    const withoutHandler = render(<MissionHeader mission={mission()} onStatusChange={() => {}} />);
    expect(findAll(withoutHandler, (node) => node.props?.["aria-label"] === "Mission posture ceiling")).toHaveLength(0);
    const picked: (string | null)[] = [];
    const tree = render(<MissionHeader mission={mission({ posture: "edits" })} onStatusChange={() => {}} onPostureChange={(p) => picked.push(p)} />);
    const select = findAll(tree, (node) => node.props?.["aria-label"] === "Mission posture ceiling")[0];
    expect(select.props.value).toBe("edits");
    expect(textOf(tree)).toContain("only ever tightens");
    (select.props.onChange as (e: { target: { value: string } }) => void)({ target: { value: "" } });
    (select.props.onChange as (e: { target: { value: string } }) => void)({ target: { value: "ask" } });
    expect(picked).toEqual([null, "ask"]);
});
