// Tiny hash-based router — no react-router dependency. Routes:
//   #/                          → start (the Leitstand; a FIRST-time visitor
//                                 comes from #/home, the guided assistant)
//   #/chat/<id>                 → one chat
//   #/chats                     → chat list (?triggerId=, ?includeSilent=1)
//   #/triggers                  → trigger page
//   #/approvals                 → the durable approval inbox
//   #/apps                      → installed apps (read-only)
//   #/list, #/project/<slug>    → session list (the transcript viewer core)
//   #/session/<project>/<id>    → thread view
//   #/search?q=, #/board        → search / board
// All segments are URI-encoded (session ids and project slugs can contain
// characters unsafe in a raw hash fragment).
import { useEffect, useState } from "react";
import SessionList from "./pages/SessionList";
import Thread from "./pages/Thread";
import Search from "./pages/Search";
import Board from "./pages/Board";
import Chat from "./pages/Chat";
import ChatList from "./pages/ChatList";
import Missions from "./pages/Missions";
import MissionDetail from "./pages/MissionDetail";
import Triggers from "./pages/Triggers";
import Approvals from "./pages/Approvals";
import QuestionBox from "./components/QuestionBox";
import Apps from "./pages/Apps";
import Plans from "./pages/Plans";
import CouncilPage from "./pages/Council";
import Setup from "./pages/Setup";
import Memory from "./pages/Memory";
import Home from "./pages/Home";
import Start from "./pages/Start";
import { Experiments } from "./pages/Experiments";
import { hasInstanceToken } from "./lib/api";
import { statusSummary, useAppStatus } from "./lib/status";

export type Route =
  | { name: "start" }
  | { name: "list"; project: string | null }
  | { name: "thread"; project: string; sessionId: string }
  | { name: "search"; query: string }
  | { name: "board" }
  | { name: "chat"; chatId: string | undefined; missionId?: string }
  | { name: "chats"; triggerId: string | undefined; includeSilent: boolean }
  | { name: "missions" }
  | { name: "mission"; missionId: string }
  | { name: "triggers" }
  | { name: "approvals" }
  | { name: "apps" }
  | { name: "plans" }
  | { name: "council" }
  | { name: "setup" }
  | { name: "memory"; scopeId?: string }
  | { name: "home" }
  | { name: "experiments" };

export function parseRoute(hash: string): Route {
  const raw = hash.replace(/^#\/?/, "");
  // The query string (if any) lives after '?' and is parsed separately from
  // the path segments — a raw '/' inside a query value must not be mistaken
  // for a path separator.
  const [pathPart, queryPart] = raw.split(/\?(.*)/s);
  let parts: string[];
  try {
    parts = pathPart.split("/").filter(Boolean).map(decodeURIComponent);
  } catch {
    // Malformed percent-encoding (raw '%', hand-edited/bookmarked URL) makes
    // decodeURIComponent throw a URIError — fall back to the chat route
    // instead of a white screen with no error boundary to catch it.
    return { name: "chat", chatId: undefined, missionId: undefined };
  }
  if (parts[0] === "search") {
    const params = new URLSearchParams(queryPart ?? "");
    return { name: "search", query: params.get("q") ?? "" };
  }
  if (parts[0] === "board") {
    return { name: "board" };
  }
  if (parts[0] === "triggers") {
    return { name: "triggers" };
  }
  if (parts[0] === "approvals") {
    return { name: "approvals" };
  }
  if (parts[0] === "plans") {
    return { name: "plans" };
  }
  if (parts[0] === "home") {
    return { name: "home" };
  }
  if (parts[0] === "memory") {
    // A mission's memory card deep-links in with the scope filter preset,
    // the same way #/search carries its query.
    const params = new URLSearchParams(queryPart ?? "");
    return { name: "memory", scopeId: params.get("scope") ?? undefined };
  }
  if (parts[0] === "setup") {
    return { name: "setup" };
  }
  if (parts[0] === "council") {
    return { name: "council" };
  }
  if (parts[0] === "apps") {
    return { name: "apps" };
  }
  if (parts[0] === "chats") {
    const params = new URLSearchParams(queryPart ?? "");
    return { name: "chats", triggerId: params.get("triggerId") ?? undefined, includeSilent: params.get("includeSilent") === "1" };
  }
  if (parts[0] === "chat") {
    const params = new URLSearchParams(queryPart ?? "");
    return { name: "chat", chatId: parts[1], missionId: params.get("missionId") ?? undefined };
  }
  if (parts[0] === "missions") {
    return { name: "missions" };
  }
  if (parts[0] === "mission" && parts[1]) {
    return { name: "mission", missionId: parts[1] };
  }
  if (parts[0] === "session" && parts[1] && parts[2]) {
    return { name: "thread", project: parts[1], sessionId: parts[2] };
  }
  if (parts[0] === "project" && parts[1]) {
    return { name: "list", project: parts[1] };
  }
  if (parts[0] === "experiments") {
    return { name: "experiments" };
  }
  if (parts[0] === "start") {
    return { name: "start" };
  }
  if (parts[0] === "list") {
    return { name: "list", project: null };
  }
  // Empty hash (and anything unrecognized) is the Leitstand: the landing
  // page for RETURNING users — "what is running right now", not a menu (see
  // ALMANAC-PLAN §1.1). A first-time visitor comes from #/home, the guided
  // assistant, which stays reachable from "more".
  return { name: "start" };
}

export function navigateToStart() {
  window.location.hash = "#/start";
}

export function navigateToProjects() {
  window.location.hash = "#/list";
}

export function navigateToSessions(project: string) {
  window.location.hash = `#/project/${encodeURIComponent(project)}`;
}

export function navigateToThread(project: string, sessionId: string) {
  window.location.hash = `#/session/${encodeURIComponent(project)}/${encodeURIComponent(sessionId)}`;
}

export function navigateToSearch(query: string) {
  window.location.hash = `#/search?q=${encodeURIComponent(query)}`;
}

export function navigateToBoard() {
  window.location.hash = "#/board";
}

export function navigateToChat(chatId?: string) {
  window.location.hash = chatId ? `#/chat/${encodeURIComponent(chatId)}` : "#/chat";
}

export function navigateToChats({ triggerId, includeSilent }: { triggerId?: string; includeSilent?: boolean } = {}) {
  const params = new URLSearchParams();
  if (triggerId) params.set("triggerId", triggerId);
  if (includeSilent) params.set("includeSilent", "1");
  const qs = params.toString();
  window.location.hash = `#/chats${qs ? `?${qs}` : ""}`;
}

export function navigateToMissions() {
  window.location.hash = "#/missions";
}

export function navigateToMission(missionId: string) {
  window.location.hash = `#/mission/${encodeURIComponent(missionId)}`;
}

/** Opens a fresh chat whose first turn will run inside the given mission. */
export function navigateToMissionChat(missionId: string) {
  window.location.hash = `#/chat?missionId=${encodeURIComponent(missionId)}`;
}

export function navigateToTriggers() {
  window.location.hash = "#/triggers";
}

export function navigateToApprovals() {
  window.location.hash = "#/approvals";
}

export function navigateToApps() {
  window.location.hash = "#/apps";
}

export function navigateToPlans() {
  window.location.hash = "#/plans";
}

export function navigateToCouncil() {
  window.location.hash = "#/council";
}

export function navigateToHome() {
  window.location.hash = "#/home";
}

export function navigateToMemory() {
  window.location.hash = "#/memory";
}

/** Memory with the scope filter already set — the mission card's way in. */
export function navigateToMemoryWithScope(scopeId: string) {
  window.location.hash = `#/memory?scope=${encodeURIComponent(scopeId)}`;
}

export function navigateToSetup() {
  window.location.hash = "#/setup";
}

export function navigateToExperiments() {
  window.location.hash = "#/experiments";
}

/**
 * The current route plus how many hash changes have happened. The counter
 * exists for chatInstanceKey() below — see its doc comment.
 */
function useHashRoute(): { route: Route; navCount: number } {
  const [state, setState] = useState(() => ({ route: parseRoute(window.location.hash), navCount: 0 }));
  useEffect(() => {
    const onChange = () =>
      setState((prev) => ({ route: parseRoute(window.location.hash), navCount: prev.navCount + 1 }));
    window.addEventListener("hashchange", onChange);
    return () => window.removeEventListener("hashchange", onChange);
  }, []);
  return state;
}

/**
 * React `key` for the <Chat> element, so that navigating to a NEW chat throws
 * the old component instance (transcript, chatId, approval stack, agent panel)
 * away instead of carrying it over.
 *
 * A key of just `chatId ?? 'new'` is not enough, and this is the whole bug:
 * the Chat page rewrites the hash to `#/chat/<id>` with history.replaceState
 * once a new chat gets its id, and replaceState fires NO hashchange — so the
 * router still believes it is on `#/chat` with no id. Clicking "Chat" in the nav
 * then lands on `#/chat`, which parses to the same `chatId: undefined` the
 * router already held: same key, no remount, and the next message would be
 * appended to the chat the user just tried to leave.
 *
 * Including navCount for the id-less case makes every navigation to `#/chat` a
 * distinct instance. A deep link `#/chat/<id>` keys by the id itself, so
 * re-rendering for an unrelated state change never remounts it — and
 * replaceState, which fires no event, never bumps the counter mid-turn.
 */
export function chatInstanceKey(route: Route, navCount: number): string {
  if (route.name !== "chat") return "chat";
  return route.chatId ? `chat-${route.chatId}` : `chat-new-${navCount}`;
}

function HeaderSearch({ initialQuery }: { initialQuery: string }) {
  const [value, setValue] = useState(initialQuery);

  // Reset the field's contents when the route's query changes from outside
  // (e.g. browser back/forward), so it doesn't show a stale draft.
  useEffect(() => {
    setValue(initialQuery);
  }, [initialQuery]);

  return (
    <input
      className="header-search-input"
      type="search"
      placeholder="Search all sessions…"
      value={value}
      onChange={(e) => setValue(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === "Enter" && value.trim()) {
          navigateToSearch(value.trim());
        }
      }}
    />
  );
}

/** The one-glance server/turn/approval indicator. Reads state the app already has — no polling (see lib/status.ts). */
function StatusDot() {
  const status = useAppStatus();
  const { tone, label } = statusSummary(status);
  return (
    <span className={`status-dot status-dot-${tone}`} title={label}>
      <span className="status-dot-mark" aria-hidden="true" />
      <span className="status-dot-label">{label}</span>
    </span>
  );
}

/**
 * Shown instead of the app when index.html carried no instance-token meta tag
 * (see lib/api.ts). Every /api/* call would be a 401, so there is nothing
 * useful to render — and no way for the page to recover on its own.
 */
function MissingTokenScreen() {
  return (
    <div className="app-shell">
      <div className="error-box">
        <strong>This page has no instance token.</strong>
        <p>
          Restart the kaprek server and open the address it prints. A page loaded from a stale cache, a saved copy, or a
          separate dev server cannot talk to the API.
        </p>
      </div>
    </div>
  );
}

/**
 * The main nav, cut down to the reading surface (see #/experiments for
 * everything else). Kept as data — not inline JSX — so the order and labels
 * are directly assertable in a test without a DOM (this repo has none, see
 * vitest.config.ts): App.test.tsx checks `NAV_ITEMS.map(i => i.label)`.
 */
export const NAV_ITEMS: { href: string; label: string; navigate: () => void; isActive: (route: Route) => boolean }[] = [
  { href: "#/start", label: "Start", navigate: navigateToStart, isActive: (r) => r.name === "start" },
  { href: "#/chat", label: "Chat", navigate: () => navigateToChat(), isActive: (r) => r.name === "chat" || r.name === "chats" },
  { href: "#/approvals", label: "Inbox", navigate: navigateToApprovals, isActive: (r) => r.name === "approvals" },
  { href: "#/missions", label: "Missions", navigate: navigateToMissions, isActive: (r) => r.name === "missions" || r.name === "mission" },
  { href: "#/list", label: "Sessions", navigate: navigateToProjects, isActive: (r) => r.name === "list" || r.name === "thread" },
];

/**
 * The rest of the surface, one click behind "more" — every one an existing
 * page, none needed to answer "what is the machine doing right now" (see
 * ALMANAC-PLAN §1.1). Data, not inline JSX, for the same testability reason
 * as NAV_ITEMS above.
 */
export const MORE_ITEMS: { href: string; label: string; navigate: () => void }[] = [
  { href: "#/triggers", label: "Triggers", navigate: navigateToTriggers },
  { href: "#/plans", label: "Plans", navigate: navigateToPlans },
  { href: "#/council", label: "Council", navigate: navigateToCouncil },
  { href: "#/memory", label: "Memory", navigate: navigateToMemory },
  { href: "#/apps", label: "Apps", navigate: navigateToApps },
  { href: "#/board", label: "Board", navigate: navigateToBoard },
  {
    href: "#/search",
    label: "Suche",
    navigate: () => {
      window.location.hash = "#/search";
    },
  },
  { href: "#/setup", label: "Setup", navigate: navigateToSetup },
  { href: "#/experiments", label: "Experimente", navigate: navigateToExperiments },
  { href: "#/home", label: "Home-Assistent", navigate: navigateToHome },
];

export default function App() {
  const { route, navCount } = useHashRoute();

  if (!hasInstanceToken()) return <MissingTokenScreen />;

  return (
    <div className="app-shell">
      <header className="app-header">
        <a
          href="#/start"
          className="app-title"
          onClick={(e) => {
            e.preventDefault();
            navigateToStart();
          }}
        >
          kaprek
        </a>
        <nav className="app-nav">
          {NAV_ITEMS.map((item) => (
            <a
              key={item.href}
              href={item.href}
              className={item.isActive(route) ? "active" : ""}
              onClick={(e) => {
                e.preventDefault();
                item.navigate();
              }}
            >
              {item.label}
            </a>
          ))}
          {/* Plain <details>, not a menu component: no dependency, and a
              keyboard user gets the browser's own toggle for free. */}
          <details className="nav-more">
            <summary>more</summary>
            <div className="nav-more-menu">
              {MORE_ITEMS.map((item) => (
                <a
                  key={item.href}
                  href={item.href}
                  onClick={(e) => {
                    e.preventDefault();
                    item.navigate();
                  }}
                >
                  {item.label}
                </a>
              ))}
            </div>
          </details>
        </nav>
        <StatusDot />
        <HeaderSearch initialQuery={route.name === "search" ? route.query : ""} />
      </header>
      <main className="app-main">
        {route.name === "start" ? (
          <Start />
        ) : route.name === "thread" ? (
          <Thread project={route.project} sessionId={route.sessionId} />
        ) : route.name === "search" ? (
          <Search query={route.query} />
        ) : route.name === "board" ? (
          <Board />
        ) : route.name === "triggers" ? (
          <Triggers />
        ) : route.name === "approvals" ? (
          <Approvals />
        ) : route.name === "home" ? (
          <Home />
        ) : route.name === "memory" ? (
          <Memory initialScopeId={route.scopeId} />
        ) : route.name === "setup" ? (
          <Setup />
        ) : route.name === "council" ? (
          <CouncilPage />
        ) : route.name === "plans" ? (
          <Plans />
        ) : route.name === "apps" ? (
          <Apps />
        ) : route.name === "experiments" ? (
          <Experiments />
        ) : route.name === "chats" ? (
          <ChatList triggerId={route.triggerId} includeSilent={route.includeSilent} />
        ) : route.name === "missions" ? (
          <Missions />
        ) : route.name === "mission" ? (
          <MissionDetail missionId={route.missionId} />
        ) : route.name === "list" ? (
          <SessionList project={route.project} />
        ) : (
          <Chat key={chatInstanceKey(route, navCount)} chatId={route.chatId} missionId={route.missionId} />
        )}
      </main>
      {/* Global on purpose: a question an unattended agent filed at 3am has to
          be visible on whatever page you open at 9am, not only on #/approvals
          (which you would have to think to visit). */}
      <QuestionBox />
    </div>
  );
}
