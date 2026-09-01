// Guards the routing decision that keeps one chat's state from leaking into the
// next one. The component itself needs a DOM; the key that decides whether React
// keeps or discards its instance does not.
import { test, expect } from "vitest";
import { chatInstanceKey, parseRoute, NAV_ITEMS, MORE_ITEMS, type Route } from "./App";

const CHAT_A = "11111111-1111-4111-8111-111111111111";
const CHAT_B = "22222222-2222-4222-8222-222222222222";

const newChat: Route = { name: "chat", chatId: undefined };

test("a deep-linked chat keys by its id, so unrelated re-renders never remount it mid-turn", () => {
  const route: Route = { name: "chat", chatId: CHAT_A };
  expect(chatInstanceKey(route, 0)).toBe(chatInstanceKey(route, 0));
  // history.replaceState fires no hashchange, so navCount cannot move while a
  // turn is running — but even if it did, an id-keyed chat stays mounted.
  expect(chatInstanceKey(route, 7)).toBe(chatInstanceKey(route, 0));
});

test("two different chats get two different keys", () => {
  expect(chatInstanceKey({ name: "chat", chatId: CHAT_A }, 1)).not.toBe(chatInstanceKey({ name: "chat", chatId: CHAT_B }, 1));
});

test("clicking 'Chat' while a chat is open yields a NEW key, so its transcript and approvals are discarded", () => {
  // The bug this exists for: the Chat page rewrites the hash to #/chat/<id> via
  // replaceState, which fires no hashchange — so the router still holds
  // `chatId: undefined`. Navigating to #/chat then parses to the same undefined,
  // and a key of `chatId ?? 'new'` would not change. Including the navigation
  // counter is what makes it a fresh instance.
  const before = chatInstanceKey(newChat, 3);
  const afterNavClick = chatInstanceKey(newChat, 4);
  expect(afterNavClick).not.toBe(before);
});

test("every further click on 'Chat' starts yet another fresh instance", () => {
  const keys = [4, 5, 6].map((navCount) => chatInstanceKey(newChat, navCount));
  expect(new Set(keys).size).toBe(3);
});

test("a non-chat route has one stable key, so the counter cannot churn other pages", () => {
  expect(chatInstanceKey({ name: "triggers" }, 1)).toBe(chatInstanceKey({ name: "triggers" }, 9));
  expect(chatInstanceKey({ name: "apps" }, 1)).toBe(chatInstanceKey({ name: "list", project: null }, 9));
});

test("parses #/experiments", () => {
  expect(parseRoute("#/experiments")).toEqual({ name: "experiments" });
});

test("#/chat still parses to the chat route — the Leitstand landing does not remove the route", () => {
  expect(parseRoute("#/chat")).toEqual({ name: "chat", chatId: undefined, missionId: undefined });
});

// The landing page for returning users is the Leitstand (ALMANAC-PLAN §1.1);
// a first-time visitor comes from #/home, the guided assistant.
test("an empty (or unrecognized) hash lands on the Leitstand, not a menu and not a bare chat", () => {
  expect(parseRoute("#/")).toEqual({ name: "start" });
  expect(parseRoute("#/start")).toEqual({ name: "start" });
  expect(parseRoute("#/nonsense")).toEqual({ name: "start" });
});

// The nav is data (App.tsx's NAV_ITEMS), not inline JSX, precisely so this
// assertion does not need a DOM: this repo has none (see vitest.config.ts —
// environment 'node', no jsdom/happy-dom/@testing-library dependency).
test("the primary nav is the five-entry surface; everything else sits behind \"more\"", () => {
  expect(NAV_ITEMS.map((item) => item.label)).toEqual(["Start", "Chat", "Inbox", "Missions", "Sessions"]);
  expect(MORE_ITEMS.map((item) => item.label)).toEqual([
    "Triggers",
    "Plans",
    "Council",
    "Memory",
    "Apps",
    "Board",
    "Suche",
    "Setup",
    "Experimente",
    "Home-Assistent",
  ]);
});

test("Sessions is active for both the list and the thread route; every other item is single-route", () => {
  const sessions = NAV_ITEMS.find((item) => item.label === "Sessions")!;
  expect(sessions.isActive({ name: "list", project: null })).toBe(true);
  expect(sessions.isActive({ name: "thread", project: "p", sessionId: "s" })).toBe(true);
  expect(sessions.isActive({ name: "board" })).toBe(false);

  const missions = NAV_ITEMS.find((item) => item.label === "Missions")!;
  expect(missions.isActive({ name: "missions" })).toBe(true);
  expect(missions.isActive({ name: "mission", missionId: "m" })).toBe(true);
  expect(missions.isActive({ name: "start" })).toBe(false);

  const start = NAV_ITEMS.find((item) => item.label === "Start")!;
  expect(start.isActive({ name: "start" })).toBe(true);
  expect(start.isActive({ name: "board" })).toBe(false);
});
