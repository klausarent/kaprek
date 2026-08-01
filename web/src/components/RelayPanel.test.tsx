import { test, expect, vi } from "vitest";
import { RelayControls, relayStatusLine } from "./RelayPanel";
import { RelayBlock } from "./EventBlock";
import type { RelayEvent, RelayRun } from "../lib/api";
import { findByType, findOneByText, render, textOf, click } from "../test/tree";

function run(overrides: Partial<RelayRun> = {}): RelayRun {
  return {
    runId: "run-1",
    status: "active",
    route: ["grok", "claude"],
    goal: "write the batch",
    maxRounds: 2,
    hardMaxTurns: 12,
    rounds: 1,
    turns: 2,
    ...overrides,
  };
}

const noop = () => {};

test("the panel says the feature is experimental, because it is", () => {
  const text = textOf(render(<RelayControls relay={null} goal="" onGoalChange={noop} onStart={noop} onStop={noop} />));
  expect(text).toContain("Experimental");
});

test("with no run there is a goal field and a start button; with one there is a stop button", () => {
  const idle = render(<RelayControls relay={null} goal="do the thing" onGoalChange={noop} onStart={noop} onStop={noop} />);
  expect(findByType(idle, "input")).toHaveLength(1);
  expect(findOneByText(idle, "button", "Start a relay run")).toBeTruthy();

  const active = render(<RelayControls relay={run()} goal="" onGoalChange={noop} onStart={noop} onStop={noop} />);
  expect(findByType(active, "input")).toHaveLength(0);
  expect(findOneByText(active, "button", "Stop the run")).toBeTruthy();
  // The route is visible: who is talking to whom is the first thing to know.
  expect(textOf(active)).toContain("grok → claude");
});

test("a run cannot be started without a goal", () => {
  const empty = render(<RelayControls relay={null} goal="   " onGoalChange={noop} onStart={noop} onStop={noop} />);
  expect(findOneByText(empty, "button", "Start a relay run").props.disabled).toBe(true);
});

test("start and stop fire their own actions", () => {
  const onStart = vi.fn();
  const onStop = vi.fn();
  click(findOneByText(render(<RelayControls relay={null} goal="go" onGoalChange={noop} onStart={onStart} onStop={onStop} />), "button", "Start a relay run"));
  click(findOneByText(render(<RelayControls relay={run()} goal="" onGoalChange={noop} onStart={onStart} onStop={onStop} />), "button", "Stop the run"));
  expect(onStart).toHaveBeenCalledTimes(1);
  expect(onStop).toHaveBeenCalledTimes(1);
});

test("the status line says what the state means, not just what it is called", () => {
  expect(relayStatusLine(run({ status: "active" }))).toContain("Handing off");
  expect(relayStatusLine(run({ status: "waiting_gate" }))).toContain("Waiting for you");
  // The one state that needs explaining: nothing was repeated, and the
  // operator has to decide what happens next.
  expect(relayStatusLine(run({ status: "interrupted" }))).toContain("Nothing was repeated automatically");
  expect(relayStatusLine(run({ status: "completed" }))).toContain("Finished");
});

function relayEvent(overrides: Partial<RelayEvent> = {}): RelayEvent {
  return { kind: "relay", ts: "2026-07-31T09:00:00.000Z", eventType: "message", runId: "run-1", ...overrides } as RelayEvent;
}

test("a relay message renders who produced it, its status and a preview", () => {
  const text = textOf(
    render(
      <RelayBlock
        event={relayEvent({ from: "grok", status: "handoff", round: 1, textPreview: "here is the draft", bodyRef: "relay/run-1/001-grok.md" })}
      />,
    ),
  );
  expect(text).toContain("grok");
  expect(text).toContain("handoff");
  expect(text).toContain("here is the draft");
  // The whole text is a file, and the thread says where.
  expect(text).toContain("relay/run-1/001-grok.md");
});

test("a peer cost is shown as an estimate or not at all", () => {
  const withCost = textOf(render(<RelayBlock event={relayEvent({ from: "grok", costUsd: 0.0237, costEstimated: true })} />));
  // Never a bare figure: a subscription is billed per plan, not per turn.
  expect(withCost).toContain("est.");
  expect(textOf(render(<RelayBlock event={relayEvent({ from: "grok", costUsd: null })} />))).not.toContain("est.");
});

test("run-level events read as plain sentences", () => {
  expect(textOf(render(<RelayBlock event={relayEvent({ eventType: "run.created", goal: "write the batch" })} />))).toContain("write the batch");
  expect(textOf(render(<RelayBlock event={relayEvent({ eventType: "gate.requested", round: 2 })} />))).toContain("one more round");
  expect(textOf(render(<RelayBlock event={relayEvent({ eventType: "run.stopped", reason: "the run hit its wall clock" })} />))).toContain(
    "wall clock",
  );
  expect(
    textOf(render(<RelayBlock event={relayEvent({ eventType: "run.interrupted", reason: "kaprek stopped while a handoff was in flight" })} />)),
  ).toContain("in flight");
});
