// Session detail page: full digest as a chat thread with tool accordions and
// nested subagent sub-threads.
import { useCallback, useEffect, useMemo, useState } from "react";
import { fetchDigest, type Digest, type DigestEvent, type SubagentThread } from "../lib/api";
import EventBlock from "../components/EventBlock";

const PAGE_SIZE = 500;

function absDate(iso: string | null): string {
  if (!iso) return "–";
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return iso;
  return new Date(ms).toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" });
}

function fmtBytes(n: number): string {
  if (!n || Number.isNaN(n)) return "–";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

// Matches each spawn event (kind:'subagent') in the main thread to its
// sub-thread in digest.subagents. agentId is always null at spawn time (see
// parse.mjs), so matching goes via meta.name / meta.agentType, with a
// positional fallback (FIFO over the remaining threads).
function matchSubagentThreads(events: DigestEvent[], subagents: SubagentThread[]) {
  const usedIdx = new Set<number>();
  const matchByEvent = new Map<DigestEvent, SubagentThread>();

  for (const ev of events) {
    if (ev.kind !== "subagent") continue;
    let matchIdx = -1;

    if (ev.name) {
      matchIdx = subagents.findIndex(
        (s, i) => !usedIdx.has(i) && typeof s.meta?.name === "string" && s.meta.name === ev.name,
      );
    }
    if (matchIdx === -1 && ev.agentType) {
      matchIdx = subagents.findIndex(
        (s, i) => !usedIdx.has(i) && typeof s.meta?.agentType === "string" && s.meta.agentType === ev.agentType,
      );
    }
    if (matchIdx === -1) {
      matchIdx = subagents.findIndex((_, i) => !usedIdx.has(i));
    }

    if (matchIdx !== -1) {
      usedIdx.add(matchIdx);
      matchByEvent.set(ev, subagents[matchIdx]);
    }
  }

  const unmatched = subagents.filter((_, i) => !usedIdx.has(i));
  return { matchByEvent, unmatched };
}

export default function Thread({ project, sessionId }: { project: string; sessionId: string }) {
  const [digest, setDigest] = useState<Digest | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [retryTick, setRetryTick] = useState(0);
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await fetchDigest(project, sessionId);
      setDigest(data);
    } catch (e) {
      setError((e as Error).message || "Unknown error while loading");
    } finally {
      setLoading(false);
    }
  }, [project, sessionId]);

  useEffect(() => {
    setDigest(null);
    setVisibleCount(PAGE_SIZE);
    load();
    // retryTick forces a re-fetch when the user clicks "Retry".
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [load, retryTick]);

  const { matchByEvent, unmatched } = useMemo(() => {
    if (!digest) return { matchByEvent: new Map<DigestEvent, SubagentThread>(), unmatched: [] as SubagentThread[] };
    return matchSubagentThreads(digest.events, digest.subagents ?? []);
  }, [digest]);

  const totalEvents = digest?.events.length ?? 0;
  // startIndex = absolute position of the first visible event in
  // digest.events — also used as the base for React keys, otherwise keys
  // collide when loading older events ("load older" shifts start backwards,
  // local indices 0..n stay the same → wrongly re-associated DOM nodes).
  const startIndex = Math.max(0, totalEvents - visibleCount);
  const visibleEvents = useMemo(() => {
    if (!digest) return [];
    return digest.events.slice(startIndex);
  }, [digest, startIndex]);
  const hasOlder = visibleCount < totalEvents;

  return (
    <div className="page">
      <a
        href={`#/project/${encodeURIComponent(project)}`}
        className="back-link"
        onClick={(e) => {
          e.preventDefault();
          window.location.hash = `#/project/${encodeURIComponent(project)}`;
        }}
      >
        ← Back to list
      </a>

      {loading && !digest && <Skeleton />}

      {error && (
        <div className="error-box error-box-actions">
          <div>{error}</div>
          <button className="btn" onClick={() => setRetryTick((t) => t + 1)}>
            Retry
          </button>
        </div>
      )}

      {digest && (
        <>
          <header className="thread-header">
            <h1 className="thread-title">{digest.meta.title || "(untitled)"}</h1>
            <div className="thread-meta">
              <span>{digest.meta.projectSlug || "(unknown project)"}</span>
              <span>· {digest.meta.machine}</span>
              <span>
                · {absDate(digest.meta.startedAt)} – {absDate(digest.meta.endedAt)}
              </span>
              <span>· {(digest.meta.models ?? []).join(", ") || "(no models)"}</span>
              <span>· {digest.meta.turns} turns</span>
              <span>· {digest.meta.toolCalls} tool calls</span>
              {digest.meta.gitCommits > 0 && <span>· {digest.meta.gitCommits} commits</span>}
              <span>· {fmtBytes(digest.meta.rawBytes)}</span>
              {digest.meta.hasSubagents && <span>· subagents present</span>}
            </div>
          </header>

          {hasOlder && (
            <button
              className="btn btn-load-older"
              onClick={() => setVisibleCount((c) => Math.min(totalEvents, c + PAGE_SIZE))}
            >
              Load older events ({totalEvents - visibleCount} more)
            </button>
          )}

          <div className="thread-events">
            {visibleEvents.length === 0 ? (
              <div className="empty-box">No events in this digest.</div>
            ) : (
              visibleEvents.map((ev, i) => (
                <EventBlock
                  key={`${digest.meta.sessionId}-${startIndex + i}`}
                  event={ev}
                  subagentThread={ev.kind === "subagent" ? matchByEvent.get(ev) ?? null : undefined}
                />
              ))
            )}
          </div>

          {unmatched.length > 0 && (
            <section className="thread-unmatched">
              <h2>
                Additional subagent threads ({unmatched.length}, no spawn event found in the main thread)
              </h2>
              {unmatched.map((thread, i) => (
                <details key={thread.agentId ?? i} className="event-subagent">
                  <summary className="event-subagent-summary">
                    {(typeof thread.meta?.name === "string" && thread.meta.name) ||
                      (typeof thread.meta?.agentType === "string" && thread.meta.agentType) ||
                      thread.agentId ||
                      "(unnamed subagent)"}
                  </summary>
                  <div className="event-subagent-body">
                    {thread.events.map((subEvent, j) => (
                      <EventBlock key={`${thread.agentId ?? i}-${j}`} event={subEvent} />
                    ))}
                  </div>
                </details>
              ))}
            </section>
          )}
        </>
      )}
    </div>
  );
}

function Skeleton() {
  return (
    <div className="skeleton-list">
      {Array.from({ length: 6 }).map((_, i) => (
        <div key={i} className="skeleton-row" />
      ))}
      <div className="empty-box">Loading session digest…</div>
    </div>
  );
}
