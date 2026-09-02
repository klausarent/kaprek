// #/start — der Leitstand (Startbild „was läuft gerade", ALMANAC-PLAN §1.1).
//
// Die Seite Liest und aggregiert nur: EIN fetch von GET /api/leitstand beim
// Laden, danach ein Refresh nach jeder eigenen Aktion (Allow/Deny, Abort).
// Kein Polling — ein Stand, der sich unter den Händen ändert, ist auf einer
// lokalen Maschine einen Klick wert, nicht einen Request pro Sekunde.
//
// Schreibpfade sind genau zwei, und beide sind die BESTEHENDEN Routen:
//   - POST /api/approvals/<id>  (Allow/Deny, identisch zur Inbox)
//   - POST /api/chat/<id>/cancel (Abort, identisch zur Chat-Ansicht; der
//     Server meldet je Lauf, ob die Route ihn überhaupt erreicht — ein
//     Trigger-Lauf bekommt einen Link statt einem Button, der lügen würde)
//
// Der Live-Feed rechts ist kein SSE: keine Route des Servers streamt fremde
// Turns an Dritte, und nichts zu erfinden ist hier die Ehrenregel. Er zeigt
// die Ereignisse, die der Fetch ohnehin mitbringt — abgeschlossene Runs des
// Fensters und beantwortete Fragen — und sagt im Leerfall seinen Grund.
//
// Die darstellbaren Komponenten sind hook-frei exportiert, damit die Tests
// sie ohne DOM begehen können (siehe src/test/tree.tsx — dieses Repo hat
// keine Web-Test-Abhängigkeiten und soll auch keine bekommen).
import { useCallback, useEffect, useState } from "react";
import {
  answerApproval,
  cancelChatTurn,
  fetchLeitstand,
  type LeitstandCounts,
  type LeitstandGroup,
  type LeitstandHistory,
  type LeitstandPending,
  type LeitstandResponse,
  type LeitstandRunning,
} from "../lib/api";
import { approvalSourceLabel } from "../lib/approvals";
import { setStatus } from "../lib/status";

/** „22 h left" / „4 min left" — grob, wie eine Person liest; null bleibt null statt einer erfundenen Frist. */
export function remainingLabel(remainingMs: number | null): string | null {
  if (remainingMs === null || remainingMs === undefined || !Number.isFinite(remainingMs)) return null;
  if (remainingMs <= 0) return "läuft in den letzten Minuten aus";
  const minutes = Math.round(remainingMs / 60_000);
  if (minutes < 60) return `${minutes} min left`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} h left`;
  return `${Math.round(hours / 24)} d left`;
}

/** Kosten ehrlich: die Summe der BEKANNTEN Werte plus ein Abdeckungszähler — „$1.12 + 1 unknown", nie 0 für unbekannt. */
export function costLabel(counts: Pick<LeitstandCounts, "costUsd" | "costKnown" | "costUnknown">): string {
  // Not a single known figure? Then the sum stays silent — "$0.00" would be
  // a number nobody measured.
  if (counts.costKnown === 0) return counts.costUnknown === 0 ? "no cost reported" : `${counts.costUnknown} unknown`;
  const known = `$${counts.costUsd.toFixed(2)}`;
  if (counts.costUnknown === 0) return known;
  return `${known} + ${counts.costUnknown} unknown`;
}

/** Tokens ebenso: nur summiert, wo die Engine eine Zahl gemeldet hat. */
export function tokensLabel(counts: Pick<LeitstandCounts, "tokens" | "tokensUnknown">): string {
  const thousands = counts.tokens >= 1000 ? `${Math.round(counts.tokens / 100) / 10}k` : String(counts.tokens);
  if (counts.tokensUnknown === 0) return thousands;
  return `${thousands} + ${counts.tokensUnknown} unknown`;
}

/** Eine Zeile des Status-Streifens. */
function StripItem({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <span className="lk-strip-item">
      {label} <b>{children}</b>
    </span>
  );
}

export function PendingRow({
  pending,
  nowMs,
  busy,
  onDecide,
}: {
  pending: LeitstandPending;
  nowMs: number;
  busy: boolean;
  onDecide: (pending: LeitstandPending, behavior: "allow" | "deny") => void;
}) {
  const tool = pending.displayName ?? pending.toolName ?? "a tool";
  const source = approvalSourceLabel(pending, undefined);
  const remaining = remainingLabel(pending.remainingMs);
  return (
    <div className="lk-r">
      <span className="lk-t">
        <span className="lk-a lk-mono">
          {tool}
          {pending.inputPreview ? ` · ${pending.inputPreview}` : ""}
        </span>
        <span className="lk-b">
          {source ?? "from a chat"}
          {pending.mode === "deferred" ? " · filed to inbox" : ""}
          {` · asked ${Math.max(0, Math.round((nowMs - pending.requestedAt) / 60_000))} min ago`}
        </span>
      </span>
      {remaining && <span className="lk-bdg">{remaining}</span>}
      <button type="button" className="lk-pri" disabled={busy} onClick={() => onDecide(pending, "allow")}>
        Allow
      </button>
      <button type="button" className="lk-danger" disabled={busy} onClick={() => onDecide(pending, "deny")}>
        Deny
      </button>
    </div>
  );
}

export function OvernightRow({ group }: { group: LeitstandGroup }) {
  const label = group.title ?? group.triggerId ?? "unassigned";
  const skipBits: string[] = [];
  if (group.skippedCondition > 0) skipBits.push(`${group.skippedCondition}× skipped (condition)`);
  if (group.skippedConditionError > 0) skipBits.push(`${group.skippedConditionError}× skipped (condition-error)`);
  if (group.failed > 0) skipBits.push(`${group.failed}× failed`);
  return (
    <div className="lk-r">
      <span className="lk-t">
        <span className="lk-a">{label}</span>
        <span className="lk-b">
          {group.ran} ran
          {skipBits.length > 0 ? ` · ${skipBits.join(" · ")}` : ""} · {costLabel(group)} · {tokensLabel(group)} tok
        </span>
      </span>
      {group.missionId && (
        <a className="lk-link" href={`#/mission/${encodeURIComponent(group.missionId)}`}>
          digest →
        </a>
      )}
    </div>
  );
}

/** Eine beantwortete/abgelaufene Frage der Historie. */
export function historyLine(entry: LeitstandHistory): string {
  switch (entry.status) {
    case "decided":
      return entry.decision?.behavior === "allow" ? "allowed" : "denied";
    case "lapsed":
      return "lapsed (never answered)";
    case "cancelled":
      return "cancelled";
    case "expired":
      return "expired (process gone)";
    default:
      return entry.status;
  }
}

export function HistoryRow({ entry }: { entry: LeitstandHistory }) {
  const tool = entry.displayName ?? entry.toolName ?? "a tool";
  const wait = entry.waitMs !== null && Number.isFinite(entry.waitMs) ? `${Math.max(1, Math.round(entry.waitMs / 60_000))} min wait` : null;
  return (
    <div className="lk-r">
      <span className="lk-t">
        <span className="lk-a lk-mono">
          {tool}
          {entry.inputPreview ? ` · ${entry.inputPreview}` : ""}
        </span>
        <span className="lk-b">
          {historyLine(entry)}
          {entry.decidedVia ? ` · via ${entry.decidedVia}` : ""}
        </span>
      </span>
      {wait && <span className="lk-bdg">{wait}</span>}
    </div>
  );
}

export function RunningRow({
  run,
  busy,
  onAbort,
}: {
  run: LeitstandRunning;
  busy: boolean;
  onAbort: (run: LeitstandRunning) => void;
}) {
  const label = run.title ?? (run.triggerId ? `trigger ${run.triggerId}` : run.chatId);
  return (
    <div className="lk-r">
      <span className="lk-t">
        <span className="lk-a">
          <span className="lk-dot" aria-hidden="true" /> {label} {run.engine && <span className="lk-bdg">{run.engine}</span>}
        </span>
        <span className="lk-b lk-mono">{run.origin === "trigger" ? `trigger run${run.triggerId ? ` · ${run.triggerId}` : ""}` : "chat turn"}</span>
      </span>
      {run.abortable ? (
        <button type="button" className="lk-danger" disabled={busy} onClick={() => onAbort(run)}>
          Abort
        </button>
      ) : (
        <a className="lk-link" href={`#/chat/${encodeURIComponent(run.chatId)}`} title="Trigger-Läufe haben keinen Web-Abbruch — der Chat zeigt den Lauf">
          open chat →
        </a>
      )}
    </div>
  );
}

/**
 * Der rechte Feed: KEIN Stream, sondern die Ereignisse, die der eine Fetch
 * ohnehin mitbringt — Run-Abschlüsse des Fensters und beantwortete Fragen,
 * neueste zuerst. Was der Server heute nicht hergibt (Zeilen aus einem fremd
 * laufenden Turn), steht hier nicht, statt es zu synthetisieren.
 *
 * Die Feed-Spalte ist eine echte Spalte der Shell (drittes Grid-Feld neben
 * Rail und Arbeitsfläche), kein Kästchen im Seiteninhalt.
 */
export type FeedEntry = { when: number; text: string; detail: string; tone: "run" | "decision" };

export function feedFrom(data: LeitstandResponse): FeedEntry[] {
  const entries: FeedEntry[] = [];
  for (const group of data.overnight.byMission) {
    const label = group.title ?? group.triggerId ?? "unassigned";
    if (group.ran > 0) {
      entries.push({
        when: data.since,
        text: `runs finished · ${label}`,
        detail: `${group.ran} ran · ${costLabel(group)}`,
        tone: "run",
      });
    }
    if (group.skippedCondition > 0) {
      entries.push({ when: data.since, text: `skipped · ${label}`, detail: `${group.skippedCondition}× condition false — no cost`, tone: "run" });
    }
  }
  for (const entry of data.history) {
    if (entry.status !== "decided" || entry.decidedAt === null) continue;
    entries.push({
      when: entry.decidedAt,
      text: `${entry.decision?.behavior ?? "answered"} · ${entry.displayName ?? entry.toolName ?? "a tool"}`,
      detail: entry.decidedVia ? `via ${entry.decidedVia}` : "",
      tone: "decision",
    });
  }
  return entries.sort((a, b) => b.when - a.when).slice(0, 12);
}

export function Feed({ data }: { data: LeitstandResponse }) {
  const entries = feedFrom(data);
  return (
    <aside className="shell-feed">
      <h2>Letzte Ereignisse</h2>
      {entries.length === 0 && (
        <p className="lk-empty-note">Noch nichts gelogen: keine Run-Abschlüsse und keine Antworten im Fenster — der Feed folgt dem, was auf Platte liegt, kein Stream.</p>
      )}
      {entries.map((entry, i) => (
        <div key={i} className={`lk-evt${entry.tone === "decision" ? " lk-evt-live" : ""}`}>
          <b>{entry.text}</b>
          {entry.detail && (
            <>
              <br />
              {entry.detail}
            </>
          )}
          <br />
          <span className="lk-when">{new Date(entry.when).toLocaleTimeString()}</span>
        </div>
      ))}
    </aside>
  );
}

/**
 * Der Leitstand-Inhalt: Arbeitsfläche (Mitte) plus Feed-Spalte (rechts) als
 * Fragment — die Shell (App.tsx) legt links die Rail davor, so entsteht die
 * Dreispaltung aus wireframes/variant-b.html. Die Rail selbst wohnt in der
 * Shell und wird hier NICHT noch einmal gerendert (keine doppelte
 * Navigation). Hook-frei und exportiert, damit Render-Tests ohne DOM
 * begehen können, dass hier keine zweite Rail auftaucht.
 */
export function StartContent({
  data,
  error,
  busyId,
  nowMs,
  onDecide,
  onAbort,
}: {
  data: LeitstandResponse;
  error: string | null;
  busyId: string | null;
  nowMs: number;
  onDecide: (pending: LeitstandPending, behavior: "allow" | "deny") => void;
  onAbort: (run: LeitstandRunning) => void;
}) {
  const { totals, byMission } = data.overnight;
  const degradedNames = data.attention.degradedTriggers.map((t) => t.id);
  const grantsUsed = data.grants.reduce((sum, grant) => sum + (grant.useCount ?? 0), 0);

  return (
    <>
      <main className="shell-main">
        <h1 className="lk-title">
          Start {data.running.length > 0 && <span className="lk-bdg lk-live">{data.running.length} laufen</span>}
        </h1>
        <p className="lk-sub">
          overnight: {totals.ran} ran · {totals.skippedCondition} skipped (condition) · {data.pending.length} Fragen offen
          {degradedNames.length > 0 ? ` · degraded: ${degradedNames.join(", ")}` : ""}
        </p>

        {error && <div className="lk-empty-note lk-error">Letzte Aktion schlug fehl: {error}</div>}

        <div className="lk-strip">
          <StripItem label="overnight cost">{costLabel(totals)}</StripItem>
          <StripItem label="tokens">{tokensLabel(totals)}</StripItem>
          <StripItem label="skipped (condition)">{totals.skippedCondition}</StripItem>
          <StripItem label="skipped (condition-error)">{totals.skippedConditionError}</StripItem>
          <StripItem label="grants">{data.attention.grantsActive} aktiv · {grantsUsed}× genutzt</StripItem>
        </div>

        <div className="lk-cols">
          <div>
            <section className="lk-panel">
              <div className="lk-hd">
                Needs an answer <a className="lk-link" href="#/approvals">inbox →</a>
              </div>
              {data.pending.length === 0 && <div className="lk-empty-note">Nichts wartet auf eine Antwort — offene Fragen landen hier, bis sie beantwortet werden oder nach 24 h verfallen.</div>}
              {data.pending.map((pending) => (
                <PendingRow key={`${pending.chatId}:${pending.id}`} pending={pending} nowMs={nowMs} busy={busyId === pending.id} onDecide={onDecide} />
              ))}
            </section>

            <section className="lk-panel">
              <div className="lk-hd">
                Overnight by mission <a className="lk-link" href="#/missions">missions →</a>
              </div>
              {byMission.length === 0 && <div className="lk-empty-note">Kein Lauf seit Mitternacht lokal, der sich einer Mission oder einem Trigger zuordnen lässt.</div>}
              {byMission.map((group) => (
                <OvernightRow key={`${group.missionId ?? ""}:${group.triggerId ?? ""}`} group={group} />
              ))}
            </section>

            <section className="lk-panel">
              <div className="lk-hd">History — last answered</div>
              {data.history.length === 0 && <div className="lk-empty-note">Noch keine beantwortete Frage im Verlauf dieses Servers.</div>}
              {data.history.map((entry) => (
                <HistoryRow key={`${entry.chatId}:${entry.id}`} entry={entry} />
              ))}
            </section>
          </div>

          <div>
            <section className="lk-panel">
              <div className="lk-hd">Running</div>
              {data.running.length === 0 && <div className="lk-empty-note">Gerade läuft kein Turn — Chat und Trigger starten hier welche.</div>}
              {data.running.map((run) => (
                <RunningRow key={run.chatId} run={run} busy={busyId === run.chatId} onAbort={onAbort} />
              ))}
            </section>

            <section className="lk-panel">
              <div className="lk-hd">Attention</div>
              {data.attention.degradedTriggers.length === 0 && data.attention.staleGrants.length === 0 && !data.attention.searchReadOnly && (
                <div className="lk-empty-note">Alles unauffällig — keine degradierten Trigger, keine schläfenden Grants, Index beschreibbar.</div>
              )}
              {data.attention.degradedTriggers.map((trigger) => (
                <div key={trigger.id} className="lk-r">
                  <span className="lk-t">
                    <span className="lk-a">
                      {trigger.id} <span className="lk-bdg lk-warn">degraded</span>
                    </span>
                    <span className="lk-b">
                      {trigger.conditionErrorStreak}× condition-error
                      {trigger.condition ? ` · ${trigger.condition.kind} ${trigger.condition.path}` : ""}
                    </span>
                  </span>
                  <a className="lk-link" href="#/triggers">
                    inspect →
                  </a>
                </div>
              ))}
              {data.attention.staleGrants.map((grant) => (
                <div key={grant.id} className="lk-r">
                  <span className="lk-t">
                    <span className="lk-a lk-mono">
                      {grant.toolName ?? "a tool"} <span className="lk-bdg lk-warn">stale</span>
                    </span>
                    <span className="lk-b lk-mono">{grant.scope} — schläft, bis die nächste Nutzung neu bestätigt</span>
                  </span>
                </div>
              ))}
              {data.attention.searchReadOnly && (
                <div className="lk-r">
                  <span className="lk-t">
                    <span className="lk-a">Search-Index read-only</span>
                    <span className="lk-b">{data.attention.searchReadOnly.reason}</span>
                  </span>
                </div>
              )}
            </section>
          </div>
        </div>
      </main>
      <Feed data={data} />
    </>
  );
}

export default function Start() {
  const [data, setData] = useState<LeitstandResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [nowMs, setNowMs] = useState(() => Date.now());

  const load = useCallback(async () => {
    setError(null);
    try {
      const fresh = await fetchLeitstand();
      setData(fresh);
      setNowMs(Date.now());
      // Derselbe Zähler, den der Chat schreibt (lib/status.ts): die Rail
      // zeigt das Badge auf JEDER Seite, also muss der Leitstand seinen
      // Stand hier ebenfalls melden — und beim Verlassen wieder räumen.
      setStatus({ approvalsOpen: fresh.pending.length });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  useEffect(() => {
    void load();
    return () => setStatus({ approvalsOpen: 0 });
  }, [load]);

  const decide = async (pending: LeitstandPending, behavior: "allow" | "deny") => {
    setBusyId(pending.id);
    setError(null);
    try {
      // 'gone' ist keine Meldung wert: dass die Zeile nach dem Refresh weg
      // ist, IST die Antwort (Turn beendet, schon entschieden, Prozess weg).
      await answerApproval(pending.id, { chatId: pending.chatId, behavior });
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusyId(null);
    }
  };

  const abort = async (run: LeitstandRunning) => {
    setBusyId(run.chatId);
    setError(null);
    try {
      await cancelChatTurn(run.chatId);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusyId(null);
    }
  };

  if (data === null) {
    return (
      <main className="shell-main">
        {error ? <div className="lk-empty-note">Der Leitstand konnte nicht geladen werden: {error}</div> : <div className="lk-empty-note">Lädt…</div>}
      </main>
    );
  }

  return (
    <StartContent
      data={data}
      error={error}
      busyId={busyId}
      nowMs={nowMs}
      onDecide={(p, b) => void decide(p, b)}
      onAbort={(r) => void abort(r)}
    />
  );
}
