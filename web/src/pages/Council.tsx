// #/council — who holds which role, and how eagerly kaprek asks them.
//
// No model names are wired into kaprek. This page is where that shows: the
// roles are jobs, the engines filling them are whatever is installed, and
// running Codex as the lead with Claude as a peer is a dropdown away.
import { useCallback, useEffect, useState } from "react";
import { fetchCouncil, saveCouncil, type Council, type CouncilAssignment, type CouncilLevel } from "../lib/api";

const ROLE_TEXT: Record<string, { title: string; detail: string }> = {
  lead: { title: "Lead", detail: "Splits the work and puts the answers back together." },
  thinker: { title: "Thinker", detail: "Architecture, algorithms, the analysis worth paying for." },
  worker: { title: "Worker", detail: "Boilerplate, tests, mechanical edits." },
};

const LEVEL_TEXT: Record<CouncilLevel, string> = {
  off: "Never on its own — the button still works.",
  plans: "Before and after a plan is written.",
  decisions: "Also at architecture and data-model decisions.",
  always: "Every round.",
};

export function RoleRow({
  role,
  value,
  available,
  onChange,
}: {
  role: string;
  value: string | null;
  available: string[];
  onChange: (id: string) => void;
}) {
  const text = ROLE_TEXT[role];
  return (
    <div className="council-role">
      <div>
        <div className="council-role-title">{text.title}</div>
        <div className="council-role-detail">{text.detail}</div>
      </div>
      <select value={value ?? ""} onChange={(event) => onChange(event.target.value)} aria-label={text.title}>
        {available.map((id) => (
          <option key={id} value={id}>
            {id}
          </option>
        ))}
      </select>
    </div>
  );
}

export function PeerPicker({ available, lead, peer, onToggle }: { available: string[]; lead: string | null; peer: string[]; onToggle: (id: string) => void }) {
  return (
    <div className="council-peers">
      <div className="council-role-title">Peers</div>
      <div className="council-role-detail">
        Independent second opinions. Several are fine — two peers that contradict each other is the point. The lead cannot be its own peer.
      </div>
      {available.map((id) => (
        <label key={id} className={id === lead ? "council-peer council-peer-disabled" : "council-peer"}>
          <input type="checkbox" checked={peer.includes(id)} disabled={id === lead} onChange={() => onToggle(id)} />
          <span>{id}</span>
          {id === lead && <span className="council-role-detail">already the lead</span>}
        </label>
      ))}
    </div>
  );
}

export default function CouncilPage() {
  const [setup, setSetup] = useState<{ council: Council; available: string[]; levels: CouncilLevel[] } | null>(null);
  const [assignment, setAssignment] = useState<CouncilAssignment | null>(null);
  const [level, setLevel] = useState<CouncilLevel>("plans");
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const next = await fetchCouncil();
      setSetup(next);
      setAssignment(next.council.assignment);
      setLevel(next.council.level);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  if (!setup || !assignment) {
    return (
      <div className="page">
        <h1>Council</h1>
        {error && <div className="error-box">{error}</div>}
      </div>
    );
  }

  const setRole = (role: "lead" | "thinker" | "worker", id: string) => {
    setSaved(false);
    setAssignment((prev) => {
      if (!prev) return prev;
      // Promoting an engine to lead takes it off the peer bench, because the
      // server would refuse the combination anyway — better to show why here
      // than to fail on save.
      const peer = role === "lead" ? prev.peer.filter((p) => p !== id) : prev.peer;
      return { ...prev, [role]: id, peer };
    });
  };

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      const council = await saveCouncil(level, assignment);
      setSetup((prev) => (prev ? { ...prev, council } : prev));
      setSaved(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="page">
      <h1>Council</h1>
      <p className="council-intro">
        Four jobs, and whichever engines you have doing them. kaprek has no favourite — the engine you put in the lead is the one that runs your work.
      </p>

      {setup.council.suggested && <div className="council-note">This is a suggestion from what is installed. Save it to keep it.</div>}
      {setup.council.problem && <div className="error-box">{setup.council.problem}</div>}
      {!setup.council.status.possible && <div className="council-note">{setup.council.status.reason}</div>}

      {(["lead", "thinker", "worker"] as const).map((role) => (
        <RoleRow key={role} role={role} value={assignment[role]} available={setup.available} onChange={(id) => setRole(role, id)} />
      ))}

      <PeerPicker
        available={setup.available}
        lead={assignment.lead}
        peer={assignment.peer}
        onToggle={(id) => {
          setSaved(false);
          setAssignment((prev) => (prev ? { ...prev, peer: prev.peer.includes(id) ? prev.peer.filter((p) => p !== id) : [...prev.peer, id] } : prev));
        }}
      />

      <div className="council-level">
        <div className="council-role-title">When to ask them</div>
        {setup.levels.map((option) => (
          <label key={option} className="council-peer">
            <input
              type="radio"
              name="council-level"
              checked={level === option}
              onChange={() => {
                setLevel(option);
                setSaved(false);
              }}
            />
            <span>{option}</span>
            <span className="council-role-detail">{LEVEL_TEXT[option]}</span>
          </label>
        ))}
      </div>

      {error && <div className="error-box">{error}</div>}
      <div className="council-actions">
        <button type="button" className="btn" disabled={saving} onClick={() => void save()}>
          {saving ? "Saving…" : "Save"}
        </button>
        {saved && <span className="council-role-detail">Saved.</span>}
      </div>
    </div>
  );
}
