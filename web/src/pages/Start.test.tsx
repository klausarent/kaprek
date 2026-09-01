// Tests for the Leitstand page (#/start), element-tree level like every other
// page test here: no DOM, no web test dependencies — the hook-free exported
// pieces are rendered with src/test/tree.tsx and inspected directly.
import { test, expect, vi } from "vitest";
import {
  PendingRow,
  RunningRow,
  OvernightRow,
  HistoryRow,
  costLabel,
  remainingLabel,
  tokensLabel,
  feedFrom,
  historyLine,
  type FeedEntry,
} from "./Start";
import type { LeitstandGroup, LeitstandHistory, LeitstandPending, LeitstandResponse, LeitstandRunning } from "../lib/api";
import { findByType, findOneByText, render, textOf, click } from "../test/tree";

const NOW = 1_700_000_000_000;

function pending(overrides: Partial<LeitstandPending> = {}): LeitstandPending {
  return {
    id: "ask-1",
    chatId: "11111111-2222-3333-4444-555555555555",
    toolName: "Bash",
    displayName: "Bash",
    inputPreview: "rm -rf build/",
    source: { kind: "trigger", triggerId: "nightly", title: "Nightly" },
    requestedAt: NOW - 2 * 60 * 60 * 1000,
    deadlineAt: NOW + 22 * 60 * 60 * 1000,
    remainingMs: 22 * 60 * 60 * 1000,
    mode: "deferred",
    kind: null,
    triggerId: "nightly",
    askedCount: 1,
    ...overrides,
  };
}

test("a pending row names the tool, the input, the source, and the remaining time against 24 h", () => {
  const text = textOf(render(<PendingRow pending={pending()} nowMs={NOW} busy={false} onDecide={() => {}} />));
  expect(text).toContain("Bash");
  expect(text).toContain("rm -rf build/");
  expect(text).toContain("From trigger: nightly");
  expect(text).toContain("22 h left");
});

test("Allow and Deny call the EXISTING answer path with their own behavior — no new write route", () => {
  const onDecide = vi.fn();
  const entry = pending();
  const tree = render(<PendingRow pending={entry} nowMs={NOW} busy={false} onDecide={onDecide} />);

  click(findOneByText(tree, "button", "Allow"));
  click(findOneByText(tree, "button", "Deny"));

  expect(onDecide.mock.calls.map(([, behavior]) => behavior)).toEqual(["allow", "deny"]);
  expect(onDecide.mock.calls[0][0]).toBe(entry);
});

test("a busy pending row cannot be clicked twice", () => {
  const tree = render(<PendingRow pending={pending()} nowMs={NOW} busy onDecide={() => {}} />);
  expect(findByType(tree, "button").every((button) => button.props.disabled === true)).toBe(true);
});

test("a pending row without a recorded deadline shows no invented countdown", () => {
  const tree = render(<PendingRow pending={pending({ remainingMs: null, deadlineAt: null })} nowMs={NOW} busy={false} onDecide={() => {}} />);
  expect(textOf(tree)).not.toContain("left");
});

test("costLabel sums only KNOWN costs and names the coverage — never 0 for unknown", () => {
  expect(costLabel({ costUsd: 1.12, costKnown: 1, costUnknown: 1 })).toBe("$1.12 + 1 unknown");
  expect(costLabel({ costUsd: 0, costKnown: 2, costUnknown: 0 })).toBe("$0.00");
  expect(costLabel({ costUsd: 0, costKnown: 0, costUnknown: 3 })).toBe("3 unknown");
});

test("tokensLabel stays honest the same way", () => {
  expect(tokensLabel({ tokens: 41000, tokensUnknown: 0 })).toBe("41k");
  expect(tokensLabel({ tokens: 500, tokensUnknown: 2 })).toBe("500 + 2 unknown");
});

test("remainingLabel stays coarse and admits a spent deadline", () => {
  expect(remainingLabel(22 * 60 * 60 * 1000)).toContain("22 h");
  expect(remainingLabel(4 * 60_000)).toContain("4 min");
  expect(remainingLabel(0)).toContain("aus");
  expect(remainingLabel(null)).toBeNull();
});

function group(overrides: Partial<LeitstandGroup> = {}): LeitstandGroup {
  return {
    missionId: "m-1",
    triggerId: null,
    title: "kaprek-gui redesign",
    ran: 1,
    skippedCondition: 0,
    skippedConditionError: 0,
    failed: 0,
    costUsd: 1.12,
    costKnown: 1,
    costUnknown: 0,
    tokens: 41000,
    tokensKnown: 1,
    tokensUnknown: 0,
    ...overrides,
  };
}

test("an overnight row reports ran/skipped/cost and links to the mission's digest view", () => {
  const tree = render(<OvernightRow group={group()} />);
  const text = textOf(tree);
  expect(text).toContain("kaprek-gui redesign");
  expect(text).toContain("1 ran");
  expect(text).toContain("$1.12");
  const links = findByType(tree, "a");
  expect(links).toHaveLength(1);
  expect(links[0].props.href).toBe("#/mission/m-1");
});

test("an overnight row without a mission shows the skipped runs and no digest link", () => {
  const tree = render(
    <OvernightRow group={group({ missionId: null, triggerId: "watch-builds", title: "watch-builds", ran: 0, skippedCondition: 2, costUsd: 0, costKnown: 0, costUnknown: 2, tokens: 0, tokensKnown: 0, tokensUnknown: 2 })} />,
  );
  const text = textOf(tree);
  expect(text).toContain("watch-builds");
  expect(text).toContain("2× skipped (condition)");
  expect(text).toContain("2 unknown");
  expect(findByType(tree, "a")).toHaveLength(0);
});

test("a history row names how the question ended — decided, lapsed, or expired", () => {
  const entry: LeitstandHistory = {
    id: "h-1",
    chatId: "c",
    toolName: "Bash",
    displayName: "Bash",
    inputPreview: "npm test",
    source: null,
    requestedAt: NOW - 60_000,
    status: "decided",
    decision: { behavior: "allow" },
    decidedAt: NOW,
    decidedVia: "web",
    waitMs: 120_000,
  };
  expect(historyLine(entry)).toBe("allowed");
  expect(historyLine({ ...entry, status: "lapsed", decision: null, decidedAt: null, decidedVia: null })).toContain("lapsed");
  const text = textOf(render(<HistoryRow entry={entry} />));
  expect(text).toContain("npm test");
  expect(text).toContain("via web");
});

test("an abortable running row wires Abort to the EXISTING cancel route's callback; a trigger run gets a chat link instead", () => {
  const run: LeitstandRunning = { chatId: "c-1", title: "refactor", engine: "claude", origin: "user", triggerId: null, missionId: null, abortable: true };
  const onAbort = vi.fn();
  const tree = render(<RunningRow run={run} busy={false} onAbort={onAbort} />);
  click(findOneByText(tree, "button", "Abort"));
  expect(onAbort).toHaveBeenCalledWith(run);

  const triggerRun: LeitstandRunning = { ...run, chatId: "c-2", title: null, origin: "trigger", triggerId: "nightly", abortable: false };
  const triggerTree = render(<RunningRow run={triggerRun} busy={false} onAbort={onAbort} />);
  expect(findByType(triggerTree, "button")).toHaveLength(0);
  const link = findOneByText(triggerTree, "a", "open chat →");
  expect(link.props.href).toBe("#/chat/c-2");
});

test("the feed is built ONLY from what the fetch carried — run completions and decisions, nothing synthetic", () => {
  const data: LeitstandResponse = {
    since: NOW,
    running: [],
    pending: [],
    overnight: {
      totals: group(),
      byMission: [
        group(),
        group({ missionId: null, triggerId: "watch-builds", title: "watch-builds", ran: 0, skippedCondition: 2, costUsd: 0, costKnown: 0, costUnknown: 0, tokens: 0, tokensKnown: 0, tokensUnknown: 0 }),
      ],
    },
    attention: { degradedTriggers: [], staleGrants: [], grantsActive: 0 },
    history: [
      {
        id: "h-1",
        chatId: "c",
        toolName: "Bash",
        displayName: "Bash",
        inputPreview: null,
        source: null,
        requestedAt: NOW,
        status: "decided",
        decision: { behavior: "deny" },
        decidedAt: NOW + 5,
        decidedVia: "web",
        waitMs: 5,
      },
    ],
    grants: [],
  };
  const feed: FeedEntry[] = feedFrom(data);
  expect(feed).toHaveLength(3);
  expect(feed[0].text).toBe("deny · Bash"); // newest first — the decision at NOW+5 leads
  expect(feed.some((entry) => entry.text.includes("skipped · watch-builds"))).toBe(true);
  expect(feed.every((entry) => Number.isFinite(entry.when))).toBe(true);
});

test("an empty fetch yields an empty feed — the page says its reason instead of inventing rows", () => {
  const data: LeitstandResponse = {
    since: NOW,
    running: [],
    pending: [],
    overnight: { totals: { ran: 0, skippedCondition: 0, skippedConditionError: 0, failed: 0, costUsd: 0, costKnown: 0, costUnknown: 0, tokens: 0, tokensKnown: 0, tokensUnknown: 0 }, byMission: [] },
    attention: { degradedTriggers: [], staleGrants: [], grantsActive: 0 },
    history: [],
    grants: [],
  };
  expect(feedFrom(data)).toEqual([]);
});
