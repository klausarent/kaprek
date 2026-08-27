// Mission detail (#/mission/<id>): the one place a mission's state is
// visible — goal, status, where it runs, the questions waiting on a human,
// the chats carrying the work, and the board tasks documenting it.
import { useEffect, useState } from "react";
import {
  fetchMission,
  setMissionStatus,
  setMissionPosture,
  POSTURES,
  type Mission,
  type MissionDetail as MissionDetailData,
  type MissionStatus,
  type Posture,
} from "../lib/api";
import { navigateToApprovals, navigateToBoard, navigateToChat, navigateToMissionChat, navigateToMissions } from "../App";

export const MISSION_STATUS_OPTIONS: { value: MissionStatus; label: string }[] = [
  { value: "active", label: "Active" },
  { value: "waiting", label: "Waiting" },
  { value: "done", label: "Done" },
  { value: "archived", label: "Archived" },
];

/** What each posture means, in the picker's own words. */
export const POSTURE_LABELS: Record<Posture, string> = {
  ask: "ask — everything write-shaped asks",
  edits: "edits — edits run free, the rest asks",
  auto: "auto — nothing asks",
};

/** Header block: title, goal, cwd, the status select and the posture ceiling. Pure — testable without fetch. */
export function MissionHeader({
  mission,
  onStatusChange,
  onPostureChange,
}: {
  mission: Mission;
  onStatusChange: (status: MissionStatus) => void;
  onPostureChange?: (posture: Posture | null) => void;
}) {
  return (
    <div className="mission-header">
      <h2>{mission.title}</h2>
      <select
        className="mission-status-select"
        value={mission.status}
        onChange={(e) => onStatusChange(e.target.value as MissionStatus)}
        aria-label="Mission status"
      >
        {MISSION_STATUS_OPTIONS.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
      {mission.goal && <p className="mission-goal">{mission.goal}</p>}
      <p className="mission-cwd">
        Runs in: <code>{mission.cwd ?? "kaprek workspace (default)"}</code>
      </p>
      {onPostureChange && (
        <p className="mission-posture">
          <label>
            Posture ceiling:{" "}
            <select
              className="mission-posture-select"
              value={mission.posture ?? ""}
              onChange={(e) => onPostureChange(e.target.value === "" ? null : (e.target.value as Posture))}
              aria-label="Mission posture ceiling"
            >
              <option value="">global (policy.json)</option>
              {POSTURES.map((p) => (
                <option key={p} value={p}>
                  {POSTURE_LABELS[p]}
                </option>
              ))}
            </select>
          </label>
          <span className="plan-note"> a mission only ever tightens the global ceiling; a turn asked for past it is refused, not clamped</span>
        </p>
      )}
    </div>
  );
}

export default function MissionDetail({ missionId }: { missionId: string }) {
  const [detail, setDetail] = useState<MissionDetailData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reloads, setReloads] = useState(0);

  useEffect(() => {
    let cancelled = false;
    fetchMission(missionId)
      .then((data) => {
        if (!cancelled) setDetail(data);
      })
      .catch((e) => {
        if (!cancelled) setError((e as Error).message);
      });
    return () => {
      cancelled = true;
    };
  }, [missionId, reloads]);

  async function handleStatusChange(status: MissionStatus) {
    try {
      await setMissionStatus(missionId, status);
      setReloads((n) => n + 1);
    } catch (e) {
      setError((e as Error).message);
    }
  }

  if (error) {
    return (
      <div className="mission-detail">
        <div className="error-box">{error}</div>
        <button type="button" onClick={() => navigateToMissions()}>
          Back to missions
        </button>
      </div>
    );
  }
  if (!detail) return <p>Loading…</p>;

  const { mission, chats, tasks, pendingApprovals } = detail;

  return (
    <div className="mission-detail">
      <MissionHeader
        mission={mission}
        onStatusChange={handleStatusChange}
        onPostureChange={(posture) => {
          setMissionPosture(missionId, posture)
            .then(() => setReloads((n) => n + 1))
            .catch((e) => setError((e as Error).message));
        }}
      />

      {pendingApprovals.length > 0 && (
        <section className="mission-section mission-pending">
          <h3>Waiting on you</h3>
          <p>
            {pendingApprovals.length} question{pendingApprovals.length === 1 ? "" : "s"} from this mission&apos;s agents.
          </p>
          <button type="button" onClick={() => navigateToApprovals()}>
            Open the inbox
          </button>
        </section>
      )}

      <section className="mission-section">
        <h3>Chats</h3>
        <button type="button" className="mission-new-turn" onClick={() => navigateToMissionChat(mission.id)}>
          New turn in this mission
        </button>
        {chats.length === 0 && <p>No chats yet — the first turn creates one.</p>}
        <ul className="mission-chat-list">
          {chats.map((chat) => (
            <li key={chat.id}>
              <button type="button" onClick={() => navigateToChat(chat.id)}>
                {chat.title ?? chat.id}
              </button>
              <span className="mission-chat-meta">{chat.eventCount} events</span>
            </li>
          ))}
        </ul>
      </section>

      <section className="mission-section">
        <h3>Board tasks</h3>
        {tasks.length === 0 && <p>No tasks linked yet.</p>}
        <ul className="mission-task-list">
          {tasks.map((task) => (
            <li key={task.id}>
              <button type="button" onClick={() => navigateToBoard()}>
                {task.title}
              </button>
              <span className={`mission-task-status mission-task-status-${task.status}`}>{task.status}</span>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
