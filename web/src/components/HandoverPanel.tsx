// The "Kontowechsel" panel (#/handover): every handover of the current
// account switch, grouped under a summary line, plus previous switches
// folded into a <details>. Hook-free and exported so it can be tested
// without a DOM (see src/test/tree.tsx) — same split as ResumePanel.tsx: the
// state and the fetch/start calls live in pages/Handover.tsx, which owns
// this panel.
import {
  handoverSummary,
  startableHandovers,
  statusLabel,
  unresolvedHandovers,
  type Handover,
  type HandoverOverview,
} from "../lib/handover";

const RESTARTABLE: Handover["status"][] = ["pending", "failed"];
const AGAIN_RESTARTABLE: Handover["status"][] = ["unknown", "spawned", "running"];

type StartOne = (switchId: string, handoverId: string, again: boolean) => void;

function HandoverRow({ h, switchId, busy, onStartOne }: { h: Handover; switchId: string; busy: boolean; onStartOne: StartOne }) {
  return (
    <div className="handover-row">
      <div className="handover-row-main">
        <div className="handover-title-row">
          <span className="handover-title">{h.title}</span>
          <span className="badge badge-muted">{statusLabel(h.status)}</span>
        </div>
        <span className="handover-meta">
          {h.cwd}
          {h.file ? ` · ${h.file}${h.section ? ` (${h.section})` : ""}` : ""}
        </span>
        {h.prompt && <span className="handover-note">Auftrag: {h.prompt}</span>}
        {h.note && <span className="handover-note">{h.note}</span>}
        {h.status === "spawned" && (
          <span className="handover-meta">Tab ist offen, die neue Session wurde noch nicht gesehen.</span>
        )}
        {h.status === "unknown" && (
          <span className="handover-meta">
            Start wurde angefordert, das Ergebnis fehlt im Protokoll. Erst nachsehen, ob der Tab offen ist.
          </span>
        )}
        {h.status === "failed" && h.lastError && <span className="handover-error">{h.lastError}</span>}
        {h.status === "running" && h.newSessionId && (
          <span className="handover-meta">neue Session {h.newSessionId.slice(0, 8)}</span>
        )}
      </div>
      {RESTARTABLE.includes(h.status) && (
        <button type="button" className="btn" disabled={busy} onClick={() => onStartOne(switchId, h.handoverId, false)}>
          Neu starten
        </button>
      )}
      {AGAIN_RESTARTABLE.includes(h.status) && (
        <button type="button" className="btn" disabled={busy} onClick={() => onStartOne(switchId, h.handoverId, true)}>
          Nochmal starten
        </button>
      )}
    </div>
  );
}

export function HandoverPanel({
  overview,
  account,
  onAccountChange,
  skip,
  onSkipChange,
  onStartAll,
  onStartOne,
  busy,
  statusText,
}: {
  overview: HandoverOverview;
  account: "login" | "auto";
  onAccountChange: (account: "login" | "auto") => void;
  skip: boolean;
  onSkipChange: (skip: boolean) => void;
  onStartAll: () => void;
  onStartOne: StartOne;
  busy: boolean;
  statusText: string;
}) {
  const { current, history } = overview;

  if (current === null) {
    return (
      <section className="handover-panel" aria-label="Kontowechsel">
        <h2 className="handover-panel-title">Kontowechsel</h2>
        <div className="empty-box">Noch kein Kontowechsel protokolliert. In einer Session „/kontowechsel“ aufrufen.</div>
      </section>
    );
  }

  const startableCount = startableHandovers(current).length;
  // An earlier switch that still holds handovers nobody started must not sink
  // into a folded summary: those stay on the page, with their buttons.
  const leftBehind = history.filter((v) => unresolvedHandovers(v).length > 0);

  return (
    <section className="handover-panel" aria-label="Kontowechsel">
      <div className="handover-panel-header">
        <h2 className="handover-panel-title">Kontowechsel</h2>
        <span className="handover-summary">{handoverSummary(current)}</span>
      </div>

      <div className="handover-controls">
        <label className="handover-field">
          Konto
          <select value={account} onChange={(e) => onAccountChange(e.target.value as "login" | "auto")}>
            <option value="login">Aktuelles Login</option>
            <option value="auto">Freiestes Konto (kaprek claude)</option>
          </select>
        </label>
        <label className="handover-field">
          <input type="checkbox" checked={skip} onChange={(e) => onSkipChange(e.target.checked)} />
          Ohne Rückfragen starten (--dangerously-skip-permissions)
        </label>
        <button type="button" className="btn" disabled={busy || startableCount === 0} onClick={onStartAll}>
          Alle neu starten ({startableCount})
        </button>
        {statusText && (
          <span className={statusText.startsWith("Fehler:") ? "handover-status handover-status-error" : "handover-status"}>
            {statusText}
          </span>
        )}
      </div>

      <p className="handover-hint">
        Erst das Konto wechseln (/login), dann starten. Jede Übergabe öffnet einen neuen Terminal-Tab mit einer frischen
        Session; das alte Transkript wird nicht gelesen.
      </p>

      {current.loginUnchanged && account === "login" && (
        <p className="handover-warning">
          Angemeldet ist noch das Konto, unter dem dieser Wechsel geöffnet wurde. Ein Start jetzt bringt die neuen
          Sessions auf dasselbe Konto.
        </p>
      )}

      <div className="handover-rows">
        {current.handovers.map((h) => (
          <HandoverRow key={h.handoverId} h={h} switchId={current.switchId} busy={busy} onStartOne={onStartOne} />
        ))}
      </div>

      {current.missing.length > 0 && (
        <div className="handover-missing">
          <h3 className="handover-missing-title">Noch ohne Meldung</h3>
          <div className="handover-rows">
            {current.missing.map((m) => (
              <div key={m.sessionId} className="handover-row">
                <div className="handover-row-main">
                  <span className="handover-title">{m.title}</span>
                  <span className="handover-meta">
                    {m.cwd} · {m.sessionId.slice(0, 8)}
                  </span>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {leftBehind.map((v) => (
        <div key={v.switchId} className="handover-missing">
          <h3 className="handover-missing-title">
            Noch offen aus dem Wechsel vom {v.openedAt ? new Date(v.openedAt).toLocaleString("de-DE") : "–"}
          </h3>
          <div className="handover-rows">
            {unresolvedHandovers(v).map((h) => (
              <HandoverRow key={h.handoverId} h={h} switchId={v.switchId} busy={busy} onStartOne={onStartOne} />
            ))}
          </div>
        </div>
      ))}

      {history.length > 0 && (
        <details className="handover-history">
          <summary>Frühere Wechsel</summary>
          {history.map((v) => (
            <div key={v.switchId} className="handover-history-row">
              <span className="handover-history-date">{v.openedAt ? new Date(v.openedAt).toLocaleString("de-DE") : "–"}</span>
              <span className="handover-meta">{[v.note, handoverSummary(v)].filter(Boolean).join(" · ")}</span>
            </div>
          ))}
        </details>
      )}
    </section>
  );
}
