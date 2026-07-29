// Tiny hash-based router — no react-router dependency. Two routes:
//   #/                          → project + session list
//   #/session/<project>/<id>    → thread view
// Both segments are URI-encoded (session ids and project slugs can contain
// characters unsafe in a raw hash fragment).
import { useEffect, useState } from "react";
import SessionList from "./pages/SessionList";
import Thread from "./pages/Thread";

type Route =
  | { name: "list"; project: string | null }
  | { name: "thread"; project: string; sessionId: string };

function parseHash(hash: string): Route {
  const clean = hash.replace(/^#\/?/, "");
  let parts: string[];
  try {
    parts = clean.split("/").filter(Boolean).map(decodeURIComponent);
  } catch {
    // Malformed percent-encoding (raw '%', hand-edited/bookmarked URL) makes
    // decodeURIComponent throw a URIError — fall back to the list route
    // instead of a white screen with no error boundary to catch it.
    return { name: "list", project: null };
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

function useHashRoute(): Route {
  const [route, setRoute] = useState(() => parseHash(window.location.hash));
  useEffect(() => {
    const onChange = () => setRoute(parseHash(window.location.hash));
    window.addEventListener("hashchange", onChange);
    return () => window.removeEventListener("hashchange", onChange);
  }, []);
  return route;
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
      </header>
      <main className="app-main">
        {route.name === "thread" ? (
          <Thread project={route.project} sessionId={route.sessionId} />
        ) : (
          <SessionList project={route.project} />
        )}
      </main>
    </div>
  );
}
