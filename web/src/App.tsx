// Tiny hash-based router — no react-router dependency. Routes:
//   #/                          → chat (a newcomer lands in the chat, not in
//                                 an empty list)
//   #/chat/<id>                 → one chat
//   #/chats                     → chat list (?triggerId=, ?includeSilent=1)
//   #/triggers                  → trigger page
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
import Triggers from "./pages/Triggers";
import { hasInstanceToken } from "./lib/api";
import { statusSummary, useAppStatus } from "./lib/status";

type Route =
  | { name: "list"; project: string | null }
  | { name: "thread"; project: string; sessionId: string }
  | { name: "search"; query: string }
  | { name: "board" }
  | { name: "chat"; chatId: string | undefined }
  | { name: "chats"; triggerId: string | undefined; includeSilent: boolean }
  | { name: "triggers" };

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
    return { name: "chat", chatId: undefined };
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
  if (parts[0] === "chats") {
    const params = new URLSearchParams(queryPart ?? "");
    return { name: "chats", triggerId: params.get("triggerId") ?? undefined, includeSilent: params.get("includeSilent") === "1" };
  }
  if (parts[0] === "chat") {
    return { name: "chat", chatId: parts[1] };
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
  return { name: "chat", chatId: undefined };
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

export function navigateToTriggers() {
  window.location.hash = "#/triggers";
}

function useHashRoute(): Route {
  const [route, setRoute] = useState(() => parseHash(window.location.hash));
  useEffect(() => {
    const onChange = () => setRoute(parseHash(window.location.hash));
    window.addEventListener("hashchange", onChange);
    return () => window.removeEventListener("hashchange", onChange);
  }, []);
  return route;
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
  const route = useHashRoute();

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
        ) : route.name === "chats" ? (
          <ChatList triggerId={route.triggerId} includeSilent={route.includeSilent} />
        ) : route.name === "list" ? (
          <SessionList project={route.project} />
        ) : (
          <Chat chatId={route.chatId} />
        )}
      </main>
    </div>
  );
}
