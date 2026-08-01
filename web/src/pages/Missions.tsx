// Missions (#/missions): the list of what you're trying to get done, and the
// form that starts a new one. A mission bundles a goal, an optional project
// directory its turns run in, and the chats/tasks carrying the work — one
// interface for everyone, no separate "home" or "work" modes.
import { useEffect, useState, type FormEvent } from "react";
import {
  fetchMissions,
  fetchPresets,
  createMission,
  type Mission,
  type Preset,
} from "../lib/api";
import { navigateToMission, navigateToMissionChat } from "../App";

const STATUS_LABELS: Record<Mission["status"], string> = {
  active: "Active",
  waiting: "Waiting",
  done: "Done",
  archived: "Archived",
};

/** One mission row: title, status, where it runs, and how many questions wait. */
export function MissionListItem({ mission, onOpen }: { mission: Mission; onOpen: (id: string) => void }) {
  return (
    <button type="button" className="mission-item" onClick={() => onOpen(mission.id)}>
      <span className="mission-item-title">{mission.title}</span>
      <span className={`mission-status mission-status-${mission.status}`}>{STATUS_LABELS[mission.status]}</span>
      {mission.cwd && <span className="mission-item-cwd">{mission.cwd}</span>}
      {(mission.pendingApprovals ?? 0) > 0 && (
        <span className="mission-item-pending">
          {mission.pendingApprovals} question{mission.pendingApprovals === 1 ? "" : "s"} waiting
        </span>
      )}
    </button>
  );
}

/**
 * The "new mission" form. Picking a preset pre-fills the goal from its
 * template; the preset's first prompt is returned alongside the input so the
 * caller can drop the user straight into a prepared chat.
 */
export function MissionCreateForm({
  presets,
  onCreate,
}: {
  presets: Preset[];
  onCreate: (input: { title: string; goal?: string; cwd?: string; preset?: string }, firstPrompt: string) => void;
}) {
  const [title, setTitle] = useState("");
  const [goal, setGoal] = useState("");
  const [cwd, setCwd] = useState("");
  const [presetId, setPresetId] = useState("blank");

  const selected = presets.find((p) => p.id === presetId);

  function submit(e: FormEvent) {
    e.preventDefault();
    if (!title.trim()) return;
    onCreate(
      {
        title: title.trim(),
        ...(goal.trim() ? { goal: goal.trim() } : {}),
        ...(cwd.trim() ? { cwd: cwd.trim() } : {}),
        ...(presetId !== "blank" ? { preset: presetId } : {}),
      },
      selected?.firstPrompt ?? "",
    );
  }

  return (
    <form className="mission-create" onSubmit={submit}>
      <h3>New mission</h3>
      <label>
        Preset
        <select
          value={presetId}
          onChange={(e) => {
            setPresetId(e.target.value);
            const preset = presets.find((p) => p.id === e.target.value);
            if (preset && preset.goalTemplate && !goal.trim()) setGoal(preset.goalTemplate);
          }}
        >
          {presets.map((p) => (
            <option key={p.id} value={p.id}>
              {p.title}
            </option>
          ))}
        </select>
      </label>
      {selected && selected.description && <p className="mission-preset-hint">{selected.description}</p>}
      <label>
        Title
        <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="What is this mission called?" />
      </label>
      <label>
        Goal
        <textarea value={goal} onChange={(e) => setGoal(e.target.value)} placeholder="What does done look like?" rows={2} />
      </label>
      <label>
        Project directory (optional)
        <input
          value={cwd}
          onChange={(e) => setCwd(e.target.value)}
          placeholder="Absolute path — the mission's turns run here"
        />
      </label>
      <button type="submit" disabled={!title.trim()}>
        Create mission
      </button>
    </form>
  );
}

export default function Missions() {
  const [missions, setMissions] = useState<Mission[] | null>(null);
  const [presets, setPresets] = useState<Preset[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    Promise.all([fetchMissions(), fetchPresets()])
      .then(([missionList, presetList]) => {
        if (cancelled) return;
        setMissions(missionList);
        setPresets(presetList);
      })
      .catch((e) => {
        if (!cancelled) setError((e as Error).message);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  async function handleCreate(input: { title: string; goal?: string; cwd?: string; preset?: string }, firstPrompt: string) {
    setError(null);
    try {
      const mission = await createMission(input);
      // A preset's first prompt is the whole point of picking a preset — hand
      // it to the chat that is about to open instead of making the person
      // copy it out of the preset by hand (the gap M0 left open). Session
      // storage rather than the URL: a first prompt can be a page long.
      if (firstPrompt.trim()) {
        try {
          window.sessionStorage.setItem(`kaprek-first-prompt-${mission.id}`, firstPrompt);
        } catch {
          // storage blocked — the mission still opens, just without the draft
        }
        navigateToMissionChat(mission.id);
        return;
      }
      navigateToMission(mission.id);
    } catch (e) {
      setError((e as Error).message);
    }
  }

  const active = (missions ?? []).filter((m) => m.status === "active" || m.status === "waiting");
  const rest = (missions ?? []).filter((m) => m.status === "done" || m.status === "archived");

  return (
    <div className="missions-page">
      <div className="missions-list">
        <h2>Missions</h2>
        {error && <div className="error-box">{error}</div>}
        {missions === null && !error && <p>Loading…</p>}
        {missions !== null && missions.length === 0 && (
          <div className="missions-empty">
            <p>
              A mission is one piece of work you want done: a goal, and the project directory it lives in. Every chat,
              task and open question of that work then hangs together in one place — and every turn runs in that
              directory instead of the sandbox.
            </p>
            <p>Name one on the right. Pick a preset if you want the first instruction written for you.</p>
          </div>
        )}
        {active.map((m) => (
          <MissionListItem key={m.id} mission={m} onOpen={navigateToMission} />
        ))}
        {rest.length > 0 && <h3 className="missions-rest-heading">Finished</h3>}
        {rest.map((m) => (
          <MissionListItem key={m.id} mission={m} onOpen={navigateToMission} />
        ))}
      </div>
      <MissionCreateForm presets={presets} onCreate={handleCreate} />
    </div>
  );
}
