// Project + session list. With no project selected, shows all scanned
// projects as cards; with a project selected (via the URL), shows that
// project's sessions with client-side search over title/session id.
import { useEffect, useMemo, useState } from "react";
import { fetchProjects, fetchSessions, type ProjectSummary, type SessionMeta } from "../lib/api";
import { navigateToProjects, navigateToSessions, navigateToThread } from "../App";
import { ResumePanel } from "../components/ResumePanel";
import { fetchResumeSessions, resumableSessions, resumeErrorText, resumeMany, resumeOne, type ResumeSession } from "../lib/resume";

function useDebounced<T>(value: T, delayMs: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setDebounced(value), delayMs);
    return () => clearTimeout(t);
  }, [value, delayMs]);
  return debounced;
}

function isSameCalendarDay(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

function timeAgo(iso: string | null): string {
  if (!iso) return "–";
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return "–";
  const diff = Date.now() - ms;
  // Negative/future diffs (clock drift, etc.) are surfaced explicitly rather
  // than silently printing "in -3 min".
  if (diff < 0) return "just now";
  const min = Math.floor(diff / 60_000);
  if (min < 1) return "just now";
  if (min < 360) {
    if (min < 60) return `${min} min ago`;
    const h = Math.floor(min / 60);
    return `${h}h ago`;
  }
  const now = new Date();
  const target = new Date(ms);
  if (isSameCalendarDay(target, now)) return "today";
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (isSameCalendarDay(target, yesterday)) return "yesterday";
  const h = Math.floor(min / 60);
  const d = Math.floor(h / 24);
  if (d < 30) return `${d} day${d === 1 ? "" : "s"} ago`;
  const mo = Math.floor(d / 30);
  if (mo < 12) return `${mo} month${mo === 1 ? "" : "s"} ago`;
  const y = Math.floor(mo / 12);
  return `${y} year${y === 1 ? "" : "s"} ago`;
}

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

function fmtDuration(startedAt: string | null, endedAt: string | null): string {
  const start = startedAt ? Date.parse(startedAt) : NaN;
  const end = endedAt ? Date.parse(endedAt) : NaN;
  if (Number.isNaN(start) || Number.isNaN(end)) return "–";
  const ms = Math.max(0, end - start);
  const min = Math.round(ms / 60_000);
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  const restMin = min % 60;
  return restMin > 0 ? `${h}h ${restMin}min` : `${h}h`;
}

export default function SessionList({ project }: { project: string | null }) {
  if (project) return <ProjectSessions project={project} />;
  return <ProjectGrid />;
}

function ProjectGrid() {
  const [projects, setProjects] = useState<ProjectSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState("");

  const [resumeList, setResumeList] = useState<ResumeSession[]>([]);
  const [resumeBusy, setResumeBusy] = useState(false);
  const [resumeStatus, setResumeStatus] = useState("");

  useEffect(() => {
    let cancelled = false;
    fetchProjects()
      .then((data) => {
        if (!cancelled) setProjects(data);
      })
      .catch((e) => {
        if (!cancelled) setError((e as Error).message);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    fetchResumeSessions(7)
      .then((sessions) => {
        if (!cancelled) setResumeList(sessions);
      })
      .catch((e) => {
        if (!cancelled) setResumeStatus(resumeErrorText(e));
      });
    return () => {
      cancelled = true;
    };
  }, []);

  async function handleResume(engine: string, id: string) {
    setResumeBusy(true);
    setResumeStatus("");
    try {
      const r = await resumeOne(engine, id);
      setResumeStatus(r.ok ? `Tab geöffnet (${r.method})` : `Fehler: ${r.error}`);
    } catch (err) {
      // apiFetch throws on a real network failure or a missing instance
      // token (see api.ts) — resumeOne/resumeMany never see a Response to
      // check .ok on in that case, so the status would otherwise stay blank.
      setResumeStatus(resumeErrorText(err));
    } finally {
      setResumeBusy(false);
    }
  }

  async function handleResumeAll() {
    setResumeBusy(true);
    setResumeStatus("");
    try {
      const items = resumableSessions(resumeList, 24).map((s) => ({ engine: s.engine, id: s.id }));
      const r = await resumeMany(items);
      setResumeStatus(`${r.results.filter((x) => x.ok).length}/${r.results.length} Tabs geöffnet`);
    } catch (err) {
      setResumeStatus(resumeErrorText(err));
    } finally {
      setResumeBusy(false);
    }
  }

  const filtered = useMemo(() => {
    if (!projects) return [];
    const q = search.trim().toLowerCase();
    if (!q) return projects;
    return projects.filter((p) => p.projectSlug.toLowerCase().includes(q) || (p.displayName ?? "").toLowerCase().includes(q));
  }, [projects, search]);

  return (
    <div className="page">
      <ResumePanel
        sessions={resumeList}
        onResume={(engine, id) => void handleResume(engine, id)}
        onResumeAll={() => void handleResumeAll()}
        busy={resumeBusy}
        statusText={resumeStatus}
      />

      <header className="page-header">
        <h1>Projects</h1>
        <p className="page-subtitle">
          {projects ? `${projects.length} project${projects.length === 1 ? "" : "s"}` : "Loading…"}
        </p>
      </header>

      <input
        className="search-input"
        placeholder="Filter projects…"
        value={search}
        onChange={(e) => setSearch(e.target.value)}
      />

      {error && <div className="error-box">{error}</div>}

      {!projects && !error ? (
        <Skeleton rows={6} />
      ) : projects && projects.length === 0 ? (
        <div className="empty-box">
          No sessions found. Scanned directory is shown in the terminal — pass --dir to change it.
        </div>
      ) : filtered.length === 0 ? (
        <div className="empty-box">No projects match this search.</div>
      ) : (
        <div className="card-grid">
          {filtered.map((p) => (
            <a
              key={p.projectSlug}
              href={`#/project/${encodeURIComponent(p.projectSlug)}`}
              className="card"
              onClick={(e) => {
                e.preventDefault();
                navigateToSessions(p.projectSlug);
              }}
            >
              <div className="card-title">{p.displayName ?? p.projectSlug}</div>
              <div className="card-meta">
                {p.sessionCount} session{p.sessionCount === 1 ? "" : "s"}
              </div>
            </a>
          ))}
        </div>
      )}
    </div>
  );
}

function ProjectSessions({ project }: { project: string }) {
  const [sessions, setSessions] = useState<SessionMeta[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [searchInput, setSearchInput] = useState("");
  const search = useDebounced(searchInput, 300);

  useEffect(() => {
    let cancelled = false;
    setSessions(null);
    setError(null);
    fetchSessions(project)
      .then((data) => {
        if (!cancelled) setSessions(data);
      })
      .catch((e) => {
        if (!cancelled) setError((e as Error).message);
      });
    return () => {
      cancelled = true;
    };
  }, [project]);

  const filtered = useMemo(() => {
    if (!sessions) return [];
    const q = search.trim().toLowerCase();
    if (!q) return sessions;
    return sessions.filter(
      (s) => (s.title ?? "").toLowerCase().includes(q) || s.sessionId.toLowerCase().includes(q),
    );
  }, [sessions, search]);

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
        <h1>{project}</h1>
        <p className="page-subtitle">
          {sessions ? `${sessions.length} session${sessions.length === 1 ? "" : "s"}` : "Loading…"}
        </p>
      </header>

      <input
        className="search-input"
        placeholder="Search title or session id…"
        value={searchInput}
        onChange={(e) => setSearchInput(e.target.value)}
      />

      {error && <div className="error-box">{error}</div>}

      {!sessions && !error ? (
        <Skeleton rows={8} />
      ) : filtered.length === 0 ? (
        <div className="empty-box">No sessions match this search.</div>
      ) : (
        <div className="session-list">
          {filtered.map((s) => (
            <a
              key={s.sessionId}
              href={`#/session/${encodeURIComponent(project)}/${encodeURIComponent(s.sessionId)}`}
              className="session-row"
              onClick={(e) => {
                e.preventDefault();
                navigateToThread(project, s.sessionId);
              }}
            >
              <div className="session-row-top">
                <div className="session-row-title">{s.title || "(untitled)"}</div>
                <div className="session-row-badges">
                  <span className="badge">
                    {s.turns} turn{s.turns === 1 ? "" : "s"}
                  </span>
                  {s.machineHint && <span className="badge badge-muted">{s.machineHint}</span>}
                </div>
              </div>
              <div className="session-row-meta">
                <span title={absDate(s.startedAt)}>{timeAgo(s.startedAt)}</span>
                <span>· {fmtDuration(s.startedAt, s.endedAt)}</span>
                <span>· {fmtBytes(s.sizeBytes)}</span>
              </div>
            </a>
          ))}
        </div>
      )}
    </div>
  );
}

function Skeleton({ rows }: { rows: number }) {
  return (
    <div className="skeleton-list">
      {Array.from({ length: rows }).map((_, i) => (
        <div key={i} className="skeleton-row" />
      ))}
    </div>
  );
}
