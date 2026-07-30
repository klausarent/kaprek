// Full-text search results page (#/search?q=…). Backed by src/search/index.mjs
// via GET /api/search; offers a "Build index" action (POST /api/search/reindex)
// when the index hasn't been built yet or the query has no hits.
import { useEffect, useState } from "react";
import { fetchSearch, reindexSearch, type SearchHit } from "../lib/api";
import { navigateToProjects, navigateToThread } from "../App";

/**
 * Splits an FTS5 snippet (containing literal `<b>…</b>` markers from
 * snippet()) into plain-text and highlighted segments. Never renders the
 * string as HTML — dangerouslySetInnerHTML on FTS5 output would let indexed
 * session content (which can include text an attacker fully controls) inject
 * arbitrary markup into the page.
 */
function renderSnippet(snippet: string) {
  return snippet.split(/(<b>.*?<\/b>)/g).map((part, i) => {
    const match = part.match(/^<b>([\s\S]*)<\/b>$/);
    if (match) return <mark key={i}>{match[1]}</mark>;
    return <span key={i}>{part}</span>;
  });
}

type State =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "unavailable"; reason: string }
  | { status: "no-results" }
  | { status: "results"; results: SearchHit[] }
  | { status: "error"; message: string };

export default function Search({ query }: { query: string }) {
  const [state, setState] = useState<State>({ status: "idle" });
  const [reindexing, setReindexing] = useState(false);

  useEffect(() => {
    if (!query.trim()) {
      setState({ status: "idle" });
      return;
    }
    let cancelled = false;
    setState({ status: "loading" });
    fetchSearch(query)
      .then((res) => {
        if (cancelled) return;
        if (!res.available) {
          setState({ status: "unavailable", reason: res.reason });
        } else if (res.results.length === 0) {
          setState({ status: "no-results" });
        } else {
          setState({ status: "results", results: res.results });
        }
      })
      .catch((e) => {
        if (!cancelled) setState({ status: "error", message: (e as Error).message });
      });
    return () => {
      cancelled = true;
    };
  }, [query]);

  const handleReindex = async () => {
    setReindexing(true);
    try {
      await reindexSearch();
      const res = await fetchSearch(query);
      if (!res.available) {
        setState({ status: "unavailable", reason: res.reason });
      } else if (res.results.length === 0) {
        setState({ status: "no-results" });
      } else {
        setState({ status: "results", results: res.results });
      }
    } catch (e) {
      setState({ status: "error", message: (e as Error).message });
    } finally {
      setReindexing(false);
    }
  };

  return (
    <div className="page">
      <a
        href="#/list"
        className="back-link"
        onClick={(e) => {
          e.preventDefault();
          navigateToProjects();
        }}
      >
        ← All projects
      </a>

      <header className="page-header">
        <h1>Search{query ? `: "${query}"` : ""}</h1>
      </header>

      {state.status === "idle" && <div className="empty-box">Type a query and press Enter to search.</div>}

      {state.status === "loading" && <div className="empty-box">Searching…</div>}

      {state.status === "unavailable" && (
        <div className="empty-box">
          Search requires Node 22+ (built-in SQLite).
          <div className="page-subtitle">{state.reason}</div>
        </div>
      )}

      {state.status === "error" && <div className="error-box">{state.message}</div>}

      {state.status === "no-results" && (
        <div className="empty-box">
          <p>No results for this query.</p>
          <button className="btn" onClick={handleReindex} disabled={reindexing}>
            {reindexing ? "Building index…" : "Build index"}
          </button>
        </div>
      )}

      {state.status === "results" && (
        <div className="session-list">
          {state.results.map((r) => (
            <a
              key={`${r.projectSlug}/${r.sessionId}`}
              href={`#/session/${encodeURIComponent(r.projectSlug)}/${encodeURIComponent(r.sessionId)}`}
              className="session-row"
              onClick={(e) => {
                e.preventDefault();
                navigateToThread(r.projectSlug, r.sessionId);
              }}
            >
              <div className="session-row-top">
                <div className="session-row-title">{r.title || "(untitled)"}</div>
                <div className="session-row-badges">
                  <span className="badge badge-muted">{r.projectSlug}</span>
                </div>
              </div>
              <div className="session-row-meta search-snippet">{renderSnippet(r.snippet)}</div>
            </a>
          ))}
        </div>
      )}
    </div>
  );
}
