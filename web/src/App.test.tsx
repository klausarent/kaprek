// Guards the routing decision that keeps one chat's state from leaking into the
// next one. The component itself needs a DOM; the key that decides whether React
// keeps or discards its instance does not.
import { test, expect } from "vitest";
import { chatInstanceKey, type Route } from "./App";

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
