// Tiny hash-based router — no react-router dependency. Routes:
//   #/                          → chat (a newcomer lands in the chat, not in
//                                 an empty list)
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
import { hasInstanceToken } from "./lib/api";
import { statusSummary, useAppStatus } from "./lib/status";

export type Route =
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
  | { name: "plans" };

function parseHash(hash: string): Route {
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
  if (parts[0] === "list") {
    return { name: "list", project: null };
  }
  // Empty hash (and anything unrecognized) is the chat.
  return { name: "chat", chatId: undefined, missionId: undefined };
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

/**
 * The current route plus how many hash changes have happened. The counter
 * exists for chatInstanceKey() below — see its doc comment.
 */
function useHashRoute(): { route: Route; navCount: number } {
  const [state, setState] = useState(() => ({ route: parseHash(window.location.hash), navCount: 0 }));
  useEffect(() => {
    const onChange = () =>
      setState((prev) => ({ route: parseHash(window.location.hash), navCount: prev.navCount + 1 }));
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

export default function App() {
  const { route, navCount } = useHashRoute();

  if (!hasInstanceToken()) return <MissingTokenScreen />;

  const advancedActive = route.name === "list" || route.name === "thread" || route.name === "search" || route.name === "board";

  return (
    <div className="app-shell">
      <header className="app-header">
        <a
          href="#/"
          className="app-title"
          onClick={(e) => {
            e.preventDefault();
            navigateToChat();
          }}
        >
          kaprek
        </a>
        <nav className="app-nav">
          <a
            href="#/chat"
            className={route.name === "chat" || route.name === "chats" ? "active" : ""}
            onClick={(e) => {
              e.preventDefault();
              navigateToChat();
            }}
          >
            Chat
          </a>
          <a
            href="#/missions"
            className={route.name === "missions" || route.name === "mission" ? "active" : ""}
            onClick={(e) => {
              e.preventDefault();
              navigateToMissions();
            }}
          >
            Missions
          </a>
          <a
            href="#/triggers"
            className={route.name === "triggers" ? "active" : ""}
            onClick={(e) => {
              e.preventDefault();
              navigateToTriggers();
            }}
          >
            Triggers
          </a>
          <a
            href="#/plans"
            className={route.name === "plans" ? "active" : ""}
            onClick={(e) => {
              e.preventDefault();
              navigateToPlans();
            }}
          >
            Plans
          </a>
          <a
            href="#/approvals"
            className={route.name === "approvals" ? "active" : ""}
            onClick={(e) => {
              e.preventDefault();
              navigateToApprovals();
            }}
          >
            Approvals
          </a>
          <a
            href="#/apps"
            className={route.name === "apps" ? "active" : ""}
            onClick={(e) => {
              e.preventDefault();
              navigateToApps();
            }}
          >
            Apps
          </a>
          <a
            href="#/list"
            className={advancedActive ? "active" : ""}
            onClick={(e) => {
              e.preventDefault();
              navigateToProjects();
            }}
          >
            Advanced
          </a>
          {advancedActive && (
            <a
              href="#/board"
              className={route.name === "board" ? "active" : ""}
              onClick={(e) => {
                e.preventDefault();
                navigateToBoard();
              }}
            >
              Board
            </a>
          )}
        </nav>
        <StatusDot />
        <HeaderSearch initialQuery={route.name === "search" ? route.query : ""} />
      </header>
      <main className="app-main">
        {route.name === "thread" ? (
          <Thread project={route.project} sessionId={route.sessionId} />
        ) : route.name === "search" ? (
          <Search query={route.query} />
        ) : route.name === "board" ? (
          <Board />
        ) : route.name === "triggers" ? (
          <Triggers />
        ) : route.name === "approvals" ? (
          <Approvals />
        ) : route.name === "plans" ? (
          <Plans />
        ) : route.name === "apps" ? (
          <Apps />
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
