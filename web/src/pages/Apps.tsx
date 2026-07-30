// Apps page (#/apps): which apps are installed and what each one is allowed to
// do. Read-only by design — there is no install, no enable/disable and no run
// button here, and GET /api/apps exposes nothing executable (see
// server.mjs::handleAppsList). Everything an app can actually do goes through
// the MCP server, gated by a trigger's appScope.
//
// AppCard is exported and hook-free so it can be tested without a DOM (see
// src/test/tree.tsx).
import { useEffect, useState } from "react";
import { fetchApps, type AppSummary, type AppsResponse, type BlockedApp } from "../lib/api";

/**
 * The plain-language permission lines for one app's policy. Phrased as what the
 * app MAY do, in the order that matters if you only read the first line —
 * leaving your machine first, changing files second.
 */
export function policyNotes(policy: AppSummary["policy"]): string[] {
  const notes: string[] = [];
  notes.push(policy.dataEgress ? "🌐 May send data off this machine" : "🔒 Stays on this machine");
  if (policy.fsWrite) notes.push("✏️ Writes files in your workspace");
  if (policy.externalAction === "auto") notes.push("⚠️ Acts on the outside world without asking");
  if (policy.externalAction === "approval") notes.push("🔐 Asks before acting on the outside world");
  if (policy.sensitivity !== "low") notes.push(`❗ ${policy.sensitivity} sensitivity`);
  return notes;
}

export function AppCard({ app }: { app: AppSummary }) {
  return (
    <div className="app-card">
      <div className="app-card-top">
        <span className="app-card-icon" aria-hidden="true">
          {app.icon ?? "🧩"}
        </span>
        <span className="app-card-name">{app.name}</span>
        <span className="badge badge-muted">{app.source}</span>
      </div>
      <div className="app-card-description">{app.description}</div>
      <div className="app-card-meta">
        <span>
          {app.toolCount} {app.toolCount === 1 ? "tool" : "tools"}
        </span>
        <span>v{app.version}</span>
        <span className="mono">{app.id}</span>
      </div>
      <ul className="app-card-policy">
        {policyNotes(app.policy).map((note) => (
          <li key={note}>{note}</li>
        ))}
      </ul>
    </div>
  );
}

/** One third-party app that exists on disk but is switched off, with the reason and the way to change it. */
export function BlockedAppCard({ app }: { app: BlockedApp }) {
  return (
    <div className="app-card app-card-blocked">
      <div className="app-card-top">
        <span className="app-card-icon" aria-hidden="true">
          ⛔
        </span>
        <span className="app-card-name">{app.id}</span>
        <span className="badge badge-muted">not loaded</span>
      </div>
      <div className="app-card-description">
        Third-party apps stay disabled until app handlers run isolated from one another. Today they share one process, so
        any one of them can read or change another's results.
      </div>
      <div className="app-card-meta">
        <span>
          Set <code>KAPREK_ALLOW_USER_APPS=1</code> to load it anyway.
        </span>
      </div>
    </div>
  );
}

export default function Apps() {
  const [state, setState] = useState<AppsResponse | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    fetchApps()
      .then(setState)
      .catch((e) => setLoadError((e as Error).message));
  }, []);

  return (
    <div className="page">
      <header className="page-header">
        <h1>Apps</h1>
        <p className="page-subtitle">
          What your agents can reach for, and what each app is allowed to do. Nothing here runs on its own — a trigger has
          to name an app before it can use it.
        </p>
      </header>

      {loadError && <div className="error-box">{loadError}</div>}

      {state?.errors.map((error) => (
        <div key={error.message} className="error-box">
          An app could not be loaded: {error.message}
        </div>
      ))}

      {state === null ? (
        <div className="empty-box">Loading…</div>
      ) : state.apps.length === 0 && state.blocked.length === 0 ? (
        <div className="empty-box">No apps installed.</div>
      ) : (
        <div className="card-grid">
          {state.apps.map((app) => (
            <AppCard key={app.id} app={app} />
          ))}
          {state.blocked.map((app) => (
            <BlockedAppCard key={`blocked-${app.id}`} app={app} />
          ))}
        </div>
      )}
    </div>
  );
}
