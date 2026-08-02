// What the other engines said.
//
// Klaus' rule, and the reason this component refuses to be tidy: dissent is
// the valuable part. Agreement gets one line; disagreement gets the peer's
// own words and its named risks. A council that always renders as "all
// good" has checked nothing.
import type { Consultation } from "../lib/api";

/** The one-line headline. Ordered so the interesting answer is never buried. */
export function headline(consultation: Consultation): string {
  if (consultation.empty) return consultation.reason ?? "No peer answered.";
  if (consultation.dissenting.length > 0) {
    const disagreed = consultation.dissenting.filter((entry) => entry.verdict === "disagree").length;
    return disagreed > 0 ? `${disagreed} of your peers disagree` : `${consultation.dissenting.length} raised concerns`;
  }
  return `All ${consultation.agreed.length} agree`;
}

export default function CouncilPanel({ consultation, busy = false }: { consultation: Consultation | null; busy?: boolean }) {
  if (busy) return <div className="council-panel">Asking the other engines…</div>;
  if (!consultation) return null;

  return (
    <div className={consultation.dissenting.length > 0 ? "council-panel council-panel-dissent" : "council-panel"}>
      <div className="council-headline">{headline(consultation)}</div>

      {consultation.agreed.length > 0 && consultation.dissenting.length > 0 && (
        <div className="council-agreed">Agreed: {consultation.agreed.join(", ")}</div>
      )}

      {consultation.dissenting.map((entry) => (
        <div className="council-dissent" key={entry.peerId}>
          <span className="badge">{entry.peerId}</span>
          <span className="council-verdict">{entry.verdict}</span>
          <p>{entry.summary}</p>
          {entry.risks.length > 0 && (
            <ul className="council-risks">
              {entry.risks.map((risk) => (
                <li key={risk}>{risk}</li>
              ))}
            </ul>
          )}
        </div>
      ))}

      {consultation.unreachable.length > 0 && (
        <div className="council-unreachable">
          No answer from {consultation.unreachable.map((entry) => `${entry.peerId} (${entry.error ?? "unknown reason"})`).join(", ")}
        </div>
      )}
    </div>
  );
}
