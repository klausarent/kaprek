// Tiny hash-based router — no react-router dependency. Two routes:
//   #/                          → project + session list
//   #/session/<project>/<id>    → thread view
// Both segments are URI-encoded (session ids and project slugs can contain
// characters unsafe in a raw hash fragment).
import { useEffect, useState } from "react";
import SessionList from "./pages/SessionList";
import Thread from "./pages/Thread";
import Search from "./pages/Search";

type Route =
  | { name: "list"; project: string | null }
  | { name: "thread"; project: string; sessionId: string }
  | { name: "search"; query: string };

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
    // decodeURIComponent throw a URIError — fall back to the list route
    // instead of a white screen with no error boundary to catch it.
    return { name: "list", project: null };
  }
  if (parts[0] === "search") {
    const params = new URLSearchParams(queryPart ?? "");
    return { name: "search", query: params.get("q") ?? "" };
  }
  if (parts[0] === "session" && parts[1] && parts[2]) {
    return { name: "thread", project: parts[1], sessionId: parts[2] };
  }
  if (parts[0] === "project" && parts[1]) {
    return { name: "list", project: parts[1] };
  }
  return { name: "list", project: null };
}

export function navigateToProjects() {
  window.location.hash = "#/";
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

export default function App() {
  const route = useHashRoute();

  return (
    <div className="app-shell">
      <header className="app-header">
        <a
          href="#/"
          className="app-title"
          onClick={(e) => {
            e.preventDefault();
            navigateToProjects();
          }}
        >
          loryme
        </a>
        <span className="app-subtitle">local Claude Code session viewer</span>
        <HeaderSearch initialQuery={route.name === "search" ? route.query : ""} />
      </header>
      <main className="app-main">
        {route.name === "thread" ? (
          <Thread project={route.project} sessionId={route.sessionId} />
        ) : route.name === "search" ? (
          <Search query={route.query} />
        ) : (
          <SessionList project={route.project} />
        )}
      </main>
    </div>
  );
}
