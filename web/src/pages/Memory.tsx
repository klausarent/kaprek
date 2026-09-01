// #/memory — what kaprek remembers, and who can see it.
//
// One scope at a time, on purpose. There is no "everything" view, because a
// list that ignored scopes would show a viewer exactly what the scope tree
// exists to keep apart — and it would do it from the outside, where no check
// applies.
import { useEffect, useState } from "react";
import { decideProposal, fetchMemories, fetchMemoryScopes, fetchProposals, forgetMemory, verifyMemory, type MemoryEntry, type MemoryScope, type RuleProposal } from "../lib/api";

/** Days, as a person would say it. */
export function ageLabel(entry: { ageMs: number; stale: boolean }): string {
  const days = Math.floor(entry.ageMs / (24 * 60 * 60 * 1000));
  if (entry.stale) return `unverified for ${days} days`;
  if (days === 0) return "verified today";
  return `verified ${days} day${days === 1 ? "" : "s"} ago`;
}

/** The scope tree as a flat list, children under their parent. */
export function orderScopes(scopes: MemoryScope[]): MemoryScope[] {
  const byParent = new Map<string | null, MemoryScope[]>();
  for (const scope of scopes) {
    const key = scope.parent ?? null;
    byParent.set(key, [...(byParent.get(key) ?? []), scope]);
  }
  const out: MemoryScope[] = [];
  const walk = (parent: string | null, depth: number) => {
    for (const scope of byParent.get(parent) ?? []) {
      out.push({ ...scope, label: `${"— ".repeat(depth)}${scope.label}` });
      walk(scope.id, depth + 1);
    }
  };
  walk(null, 0);
  return out;
}

export function MemoryRow({ entry, onVerify, onForget }: { entry: MemoryEntry; onVerify: () => void; onForget: () => void }) {
  return (
    <div className={entry.stale ? "memory-row memory-row-stale" : "memory-row"}>
      <div className="memory-row-head">
        <span className="badge badge-muted">{entry.kind}</span>
        <span className="memory-age">{ageLabel(entry)}</span>
        <span className="memory-origin">from {entry.origin}</span>
        {(entry.confirmations ?? 1) > 1 && (
          <span className="badge badge-muted" title={(entry.origins ?? []).join(", ")}>
            confirmed {entry.confirmations}× by {(entry.origins ?? [entry.origin]).length} source{(entry.origins ?? [entry.origin]).length === 1 ? "" : "s"}
          </span>
        )}
      </div>
      <p className="memory-text">{entry.text}</p>
      <div className="memory-actions">
        <button type="button" className="link-button" onClick={onVerify}>
          Still true
        </button>
        <button type="button" className="link-button" onClick={onForget}>
          Forget
        </button>
      </div>
    </div>
  );
}

/**
 * A rule kaprek is asking about. Deliberately loud: this is the one place
 * where a machine proposes changing how it is told to behave, and it must
 * never look like something that already happened.
 */
export function ProposalCard({ proposal, onDecide }: { proposal: RuleProposal; onDecide: (status: "accepted" | "rejected") => void }) {
  return (
    <div className="memory-proposal">
      <div className="memory-row-head">
        <span className="badge">proposed rule</span>
        <span className="memory-age">seen {proposal.seenIn.length} times</span>
      </div>
      <p className="memory-text">{proposal.rule}</p>
      <div className="setup-note">Because this kept happening: {proposal.pattern}</div>
      <div className="memory-actions">
        <button type="button" className="btn" onClick={() => onDecide("accepted")}>
          Make it a rule
        </button>
        <button type="button" className="link-button" onClick={() => onDecide("rejected")}>
          No
        </button>
      </div>
    </div>
  );
}

export default function Memory({ initialScopeId }: { initialScopeId?: string } = {}) {
  const [scopes, setScopes] = useState<MemoryScope[]>([]);
  // A deep link (mission card → "All memory") arrives with its scope set;
  // the picker falls back to the first scope only when no preset was given.
  const [scopeId, setScopeId] = useState(initialScopeId ?? "");
  const [entries, setEntries] = useState<MemoryEntry[]>([]);
  const [query, setQuery] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [reloads, setReloads] = useState(0);
  const [proposals, setProposals] = useState<RuleProposal[]>([]);

  useEffect(() => {
    fetchProposals("proposed")
      .then(setProposals)
      .catch(() => {
        // No proposals yet is the normal state, not an error worth showing.
      });
  }, [reloads]);

  useEffect(() => {
    fetchMemoryScopes()
      .then((loaded) => {
        setScopes(loaded);
        setScopeId((current) => current || (loaded[0]?.id ?? ""));
      })
      .catch((err) => setError(err instanceof Error ? err.message : String(err)));
  }, []);

  useEffect(() => {
    if (!scopeId) return;
    fetchMemories(scopeId, query)
      .then(setEntries)
      .catch((err) => setError(err instanceof Error ? err.message : String(err)));
  }, [scopeId, query, reloads]);

  return (
    <div className="memory-page">
      <h2>Memory</h2>
      <p className="muted">
        What was learned while working, kept per scope. A scope sees itself and everything above it — never sideways, never down.
      </p>

      {error && <div className="error-box">{error}</div>}

      {proposals.map((proposal) => (
        <ProposalCard
          key={proposal.id}
          proposal={proposal}
          onDecide={(status) => void decideProposal(proposal.id, status).then(() => setReloads((n) => n + 1))}
        />
      ))}

      <div className="memory-controls">
        <select className="select" value={scopeId} onChange={(e) => setScopeId(e.target.value)} aria-label="Scope">
          {orderScopes(scopes).map((scope) => (
            <option key={scope.id} value={scope.id}>
              {scope.label} ({scope.kind})
            </option>
          ))}
        </select>
        <input className="search-input" type="search" placeholder="Filter" value={query} onChange={(e) => setQuery(e.target.value)} />
      </div>

      {scopes.length === 0 ? (
        <p className="muted">Nothing yet. Memory fills up while an agent works inside a mission.</p>
      ) : entries.length === 0 ? (
        <p className="muted">This scope has nothing to say yet.</p>
      ) : (
        entries.map((entry) => (
          <MemoryRow
            key={entry.id}
            entry={entry}
            onVerify={() => void verifyMemory(entry.id).then(() => setReloads((n) => n + 1))}
            onForget={() => void forgetMemory(entry.id, "withdrawn by hand").then(() => setReloads((n) => n + 1))}
          />
        ))
      )}
    </div>
  );
}
