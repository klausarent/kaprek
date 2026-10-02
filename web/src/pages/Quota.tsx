// Kontingent: where each subscription window stands and what used it.
//
// QuotaView and ProviderCard are hook-free so the tree walker in
// test/tree.tsx can render them; the default export only fetches
// /api/quota every 30 s and hands the report down.
import { useEffect, useState } from "react";
import { fetchQuota, type QuotaReport, type QuotaProvider } from "../lib/api";

const LABELS: Record<string, string> = { "5h": "5 Stunden", five_hour: "5 Stunden", "7d": "7 Tage", seven_day: "7 Tage" };
const SOURCES: Record<QuotaProvider["source"], string> = {
  proxy: "live über den Proxy",
  runs: "aus dem letzten kaprek-Lauf",
  rollouts: "aus den Codex-Logs",
  none: "",
};

export function windowLabel(name: string): string {
  return LABELS[name] ?? name;
}

export function resetLabel(iso: string | null, now: number = Date.now()): string {
  if (!iso) return "Reset unbekannt";
  const mins = Math.max(0, Math.round((Date.parse(iso) - now) / 60000));
  if (mins >= 48 * 60) return `Reset in ${Math.round(mins / 1440)} Tagen`;
  return `Reset in ${Math.floor(mins / 60)} h ${mins % 60} min`;
}

function barClass(pct: number | null): string {
  if (pct === null) return "quota-bar";
  return pct >= 90 ? "quota-bar quota-bar-red" : pct >= 70 ? "quota-bar quota-bar-amber" : "quota-bar quota-bar-green";
}

const fmt = new Intl.NumberFormat("de-DE");

function when(iso: string): string {
  return new Date(iso).toLocaleString("de-DE");
}

function emptyText(p: QuotaProvider): string {
  if (p.limitId) return `Codex meldet keine Fenster mehr (limit_id ${p.limitId}).`;
  if (p.credential === "missing") return "Kein Token hinterlegt. `claude setup-token` mit diesem Konto, dann in ~/.env eintragen.";
  if (p.account) return "Noch keine Daten. Die erste Session auf diesem Konto misst es.";
  return p.id === "claude" ? "Noch keine Daten. Eine Claude-Code-Session über den Proxy starten." : "Noch keine Daten. Einmal codex benutzen.";
}

export function ProviderCard({ p, now }: { p: QuotaProvider; now: number }) {
  return (
    <section className={`quota-card${p.next ? " quota-card-next" : ""}`}>
      <h2>
        {p.label}
        {p.next ? <span className="quota-next">Nächste Session</span> : null}
      </h2>
      {p.windows.length === 0 ? (
        <p className="setup-note">{emptyText(p)}</p>
      ) : (
        p.windows.map((w) => (
          <div key={w.name} className="quota-window">
            <div className="quota-window-head">
              <span>{windowLabel(w.name)}</span>
              <strong>{w.usedPercent === null ? "?" : `${w.usedPercent} %`}</strong>
            </div>
            <div className={barClass(w.usedPercent)}>
              <span style={{ width: `${Math.min(100, w.usedPercent ?? 0)}%` }} />
            </div>
            <div className="setup-note">{resetLabel(w.resetsAt, now)}</div>
          </div>
        ))
      )}
      {p.seenAt && (
        <p className="setup-note">
          {`Stand ${when(p.seenAt)}${SOURCES[p.source] ? `, ${SOURCES[p.source]}` : ""}${p.plan ? `, Plan ${p.plan}` : ""}`}
        </p>
      )}
    </section>
  );
}

export function QuotaView({ report, now }: { report: QuotaReport; now: number }) {
  const proxyLine = report.proxy.running
    ? `Proxy läuft auf Port ${report.proxy.port}.`
    : "Proxy läuft nicht. Claude-Werte stammen dann aus dem letzten kaprek-Lauf.";
  const lastLine = report.proxy.lastRequestAt ? ` Letzte Anfrage ${when(report.proxy.lastRequestAt)}.` : "";
  return (
    <div className="quota-page">
      <h1>Kontingent</h1>
      <p className="setup-note">{proxyLine + lastLine}</p>
      <div className="quota-cards">
        {report.providers.map((p) => (
          <ProviderCard key={`${p.id}:${p.account ?? ""}`} p={p} now={now} />
        ))}
      </div>
      <h2>Verbrauch je Projekt, letzte 7 Tage</h2>
      {report.projects.length === 0 ? (
        <p className="setup-note">Noch keine Anfragen über den Proxy.</p>
      ) : (
        <div className="quota-table-wrap">
          <table className="quota-table">
            <thead>
              <tr>
                <th>Projekt</th>
                <th>Sessions</th>
                <th>Anfragen</th>
                <th>Input</th>
                <th>Output</th>
                <th>Cache gelesen</th>
                <th>Cache geschrieben</th>
              </tr>
            </thead>
            <tbody>
              {report.projects.map((p) => (
                <tr key={p.project}>
                  <td>{p.project}</td>
                  <td>{p.sessions}</td>
                  <td>{fmt.format(p.requests)}</td>
                  <td>{fmt.format(p.inputTokens)}</td>
                  <td>{fmt.format(p.outputTokens)}</td>
                  <td>{fmt.format(p.cacheReadTokens)}</td>
                  <td>{fmt.format(p.cacheCreationTokens)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

export default function Quota() {
  const [report, setReport] = useState<QuotaReport | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const load = () =>
      fetchQuota()
        .then((r) => {
          setReport(r);
          setError(null);
        })
        .catch((e: Error) => setError(e.message));
    load();
    const t = window.setInterval(load, 30000);
    return () => window.clearInterval(t);
  }, []);

  if (error) return <p className="setup-note">Kontingent nicht lesbar: {error}</p>;
  if (!report) return <p className="setup-note">Lädt …</p>;
  return <QuotaView report={report} now={Date.now()} />;
}
