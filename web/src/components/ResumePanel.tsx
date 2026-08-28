// The "Fortsetzen" panel on #/list: every engine's sessions from the last few
// days, grouped by engine, one button per session to reopen it as a terminal
// tab, one button to reopen everything from the last 24 hours at once — the
// way back after a Windows crash, without leaving the browser.
//
// Hook-free and exported so it can be tested without a DOM (see
// src/test/tree.tsx). The state and the fetch/resume calls live in
// SessionList.tsx, which owns this panel — same split as
// Approvals.tsx/ApprovalInboxItem.
import type { ResumeSession } from "../lib/resume";

const ENGINE_ORDER = ["claude", "codex", "grok", "kimi"] as const;

function ago(iso: string): string {
  const ms = Date.now() - Date.parse(iso);
  const min = Math.round(ms / 60000);
  if (min < 60) return `vor ${min} min`;
  const h = Math.round(min / 60);
  if (h < 48) return `vor ${h} h`;
  return `vor ${Math.round(h / 24)} Tagen`;
}

export function ResumePanel({
  sessions,
  onResume,
  onResumeAll,
  busy,
  statusText,
}: {
  sessions: ResumeSession[];
  onResume: (engine: string, id: string) => void;
  onResumeAll: () => void;
  busy: boolean;
  statusText: string;
}) {
  const groups = ENGINE_ORDER.map((engine) => ({ engine, items: sessions.filter((s) => s.engine === engine) })).filter(
    (g) => g.items.length > 0,
  );

  return (
    <section className="resume-panel" aria-label="Sessions fortsetzen">
      <div className="resume-panel-header">
        <h2 className="resume-panel-title">Fortsetzen</h2>
        <button type="button" className="btn" disabled={busy || sessions.length === 0} onClick={onResumeAll}>
          Alle der letzten 24 h fortsetzen
        </button>
        {statusText && <span className="resume-status">{statusText}</span>}
      </div>

      {groups.length === 0 && <div className="empty-box">Keine Sessions in den letzten Tagen.</div>}

      {groups.map((g) => (
        <div key={g.engine} className="resume-group">
          <div className="resume-group-head">
            <span className="badge badge-muted">{g.engine}</span>
          </div>
          <div className="resume-rows">
            {g.items.map((s) => (
              <div key={s.key} className={s.crash ? "resume-row resume-row-crash" : "resume-row"}>
                <div className="resume-row-main">
                  <span className="resume-title">{s.title}</span>
                  <span className="resume-meta">
                    {s.cwd} · {ago(s.lastTs)} · {s.userMsgs} Nachricht{s.userMsgs === 1 ? "" : "en"}
                    {s.crash ? " · Absturz-Gruppe" : ""}
                  </span>
                </div>
                <button type="button" className="btn" disabled={busy} onClick={() => onResume(s.engine, s.id)}>
                  Fortsetzen
                </button>
              </div>
            ))}
          </div>
        </div>
      ))}
    </section>
  );
}
