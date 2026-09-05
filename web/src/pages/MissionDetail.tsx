// Mission detail (#/mission/<id>): the one place a mission's state is
// visible — goal, status, where it runs, the questions waiting on a human,
// the chats carrying the work, the board tasks documenting it, and (P4a)
// what kaprek remembers that this mission can read.
import { useEffect, useState } from "react";
import {
  fetchMission,
  fetchMissionDigest,
  fetchMissionDigests,
  fetchMissionMemory,
  forgetMemory,
  setMissionBudget,
  setMissionStatus,
  setMissionPosture,
  POSTURES,
  type Mission,
  type MissionDetail as MissionDetailData,
  type MissionDigestFile,
  type MissionMemory as MissionMemoryData,
  type MissionMemoryEntry,
  type MissionStatus,
  type Posture,
} from "../lib/api";
import { navigateToApprovals, navigateToBoard, navigateToChat, navigateToMemoryWithScope, navigateToMissionChat, navigateToMissions } from "../App";

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

/** Scope-kind label in the card's counter line, in the order the chain reads. */
const SCOPE_KIND_ORDER = ["mission", "project", "person", "agent"];

/** The project scope of the chain, for the deep link's preset filter. */
export function projectScopeOf(memory: MissionMemoryData): string {
  return memory.visibleScopes.find((id) => id.startsWith("project:")) ?? memory.scopeId;
}

/**
 * The forget warning, stated where the click happens. A project- or
 * person-scope entry is SHARED: mission A's card can withdraw a fact that
 * mission B in the same codebase still relies on. This has to be on screen
 * before any Forget button does anything — hence a permanent line in the
 * card, not a tooltip behind the click.
 */
export const FORGET_REACH_WARNING =
  "Forgetting reaches upwards: an entry in the project or person scope also disappears for the other missions of the same chain.";

/**
 * One entry of the card, with its own two-step forget. The first click only
 * names what will be lost; the second one does it. Pure — the actual
 * deletion arrives via onConfirm.
 */
export function MissionMemoryRow({
  entry,
  confirmOpen,
  canWrite = true,
  onRequestForget,
  onConfirmForget,
  onCancelForget,
}: {
  entry: MissionMemoryEntry;
  confirmOpen: boolean;
  /** P0.5 read-only store: no write is offered, not even the first click. */
  canWrite?: boolean;
  onRequestForget: () => void;
  onConfirmForget: () => void;
  onCancelForget: () => void;
}) {
  return (
    <li className="mission-memory-entry">
      <div className="memory-row-head">
        <span className="badge badge-muted">{entry.scope}</span>
        <span className="memory-age">{entry.stale ? `stale — unverified for ${Math.floor(entry.ageMs / (24 * 60 * 60 * 1000))} days` : `verified ${Math.floor(entry.ageMs / (24 * 60 * 60 * 1000))}d ago`}</span>
      </div>
      <p className="memory-text">{entry.text}</p>
      {canWrite &&
        (confirmOpen ? (
          <div className="mission-memory-confirm">
            <span className="mission-memory-warning">
              {FORGET_REACH_WARNING} {entry.scopeKind === "mission" ? "" : "This entry lives outside this mission, so it is shared."}
            </span>
            <button type="button" className="link-button mission-memory-forget-confirm" onClick={onConfirmForget}>
              Really forget
            </button>
            <button type="button" className="link-button" onClick={onCancelForget}>
              Keep it
            </button>
          </div>
        ) : (
          <button type="button" className="link-button mission-memory-forget" onClick={onRequestForget}>
            Forget
          </button>
        ))}
    </li>
  );
}
/**
 * What this mission can read, as a card: the five most recently written
 * entries, a count per scope kind, and the way to the full view with the
 * scope filter preset. Read-only store (P0.5): shown, labelled, no Forget.
 *
 * The rendering lives in the hook-free MissionMemoryCardBody so it stays
 * testable on the element-tree level; this wrapper only owns the two-step
 * forget's confirm state.
 */
export function MissionMemoryCard({
  memory,
  onForget,
}: {
  memory: MissionMemoryData;
  onForget: (entry: MissionMemoryEntry) => void;
}) {
  const [confirmId, setConfirmId] = useState<string | null>(null);
  return (
    <MissionMemoryCardBody
      memory={memory}
      confirmId={confirmId}
      onRequestForget={(id) => setConfirmId(id)}
      onCancelForget={() => setConfirmId(null)}
      onConfirmForget={(id) => {
        setConfirmId(null);
        const entry = memory.recent.find((candidate) => candidate.id === id);
        if (entry) onForget(entry);
      }}
    />
  );
}

export function MissionMemoryCardBody({
  memory,
  confirmId,
  onRequestForget,
  onCancelForget,
  onConfirmForget,
}: {
  memory: MissionMemoryData;
  confirmId: string | null;
  onRequestForget: (id: string) => void;
  onCancelForget: () => void;
  onConfirmForget: (id: string) => void;
}) {
  const counts = SCOPE_KIND_ORDER.filter((kind) => memory.counts[kind]).map((kind) => `${kind}: ${memory.counts[kind]}`);
  return (
    <section className="mission-section mission-memory" aria-label="Mission memory">
      <h3>What kaprek remembers here</h3>
      {memory.readOnly && <p className="plan-note mission-memory-readonly">written by a newer kaprek version — read-only here</p>}
      <p className="muted mission-memory-warning">{FORGET_REACH_WARNING}</p>
      <p className="muted">
        {counts.length > 0 ? counts.join(" · ") : "nothing yet"} ·{" "}
        <button type="button" className="link-button" onClick={() => navigateToMemoryWithScope(projectScopeOf(memory))}>
          All memory
        </button>
      </p>
      {memory.recent.length === 0 ? (
        <p className="muted">Nothing readable yet — memory fills up while an agent works inside this mission.</p>
      ) : (
        <ul className="mission-memory-list">
          {memory.recent.map((entry) => (
            <MissionMemoryRow
              key={entry.id}
              entry={entry}
              confirmOpen={confirmId === entry.id}
              canWrite={!memory.readOnly}
              onRequestForget={() => onRequestForget(entry.id)}
              onCancelForget={onCancelForget}
              onConfirmForget={() => onConfirmForget(entry.id)}
            />
          ))}
        </ul>
      )}
    </section>
  );
}

/**
 * The P8 morning digest, as a card: numbers only, built on click (the
 * default window is yesterday's local day), previewed as plain text in a
 * pre-block — no Markdown renderer, the document IS numbers and states.
 * The same build writes `digests/<datum>.md`; the file list link shows
 * what is already on disk.
 *
 * Hook-free body like MissionMemoryCardBody, so it renders on the
 * element-tree level in tests; the wrapper owns the fetch state.
 */
export const DIGEST_WINDOW_NOTE = "Default window: yesterday's local day — DST days are 23 or 25 hours, the header states the real span.";

export function MissionDigestCardBody({
  markdown,
  files,
  windowNote = DIGEST_WINDOW_NOTE,
  loading,
  onBuild,
  onListFiles,
}: {
  markdown: string | null;
  files: MissionDigestFile[];
  windowNote?: string;
  loading: boolean;
  onBuild: () => void;
  onListFiles: () => void;
}) {
  return (
    <section className="mission-section mission-digest" aria-label="Morning digest">
      <h3>Morning digest</h3>
      <p className="muted mission-digest-note">{windowNote}</p>
      <p>
        <button type="button" className="mission-digest-build" onClick={onBuild} disabled={loading}>
          {loading ? "Building…" : "Digest erzeugen/aktualisieren"}
        </button>{" "}
        <button type="button" className="link-button mission-digest-files" onClick={onListFiles}>
          Digest-Dateien ({files.length})
        </button>
      </p>
      {files.length > 0 && (
        <ul className="mission-digest-file-list">
          {files.map((file) => (
            <li key={file.name}>
              {file.name} <span className="mission-digest-file-bytes">({file.bytes} bytes)</span>
            </li>
          ))}
        </ul>
      )}
      {markdown === null ? (
        <p className="muted mission-digest-empty">No digest built yet — the button builds yesterday's numbers.</p>
      ) : (
        <pre className="mission-digest-preview">{markdown}</pre>
      )}
    </section>
  );
}

/**
 * Der Tagesbudget-Block (ALM 2.5) unter dem Header: das Feld für das
 * Mission-Budget (leer = kein Missions-Budget), der heutige Stand und der
 * Gnaden-Status. Ehrlich in beide Richtungen: ohne Budget steht da, dass
 * KEINS gilt — nie ein Fake-Limit — und ohne bekannte Kosten behauptet die
 * Anzeige keine $0.00, sondern lässt den unknown-Zähler sprechen. Rein
 * (hook-frei), damit Tests auf dem Element-Tree rendern können; das
 * Speichern hält die Seite.
 */
export function budgetDetailLine(budget: NonNullable<MissionDetailData["budget"]>): string {
  if (budget.effectiveUsd === null || budget.effectiveUsd === undefined) return "Kein Tagesbudget gesetzt — heute gilt keine Grenze.";
  if (budget.spentKnownUsd === 0 && (budget.unknownRuns ?? 0) > 0) {
    return `${budget.unknownRuns} Läufe ohne Kostendaten — bekannt ist nichts von $${budget.effectiveUsd.toFixed(2)}, das Budget kann dadurch nicht ausgereizt sein`;
  }
  const stand = `$${(budget.spentKnownUsd ?? 0).toFixed(2)} von $${budget.effectiveUsd.toFixed(2)}`;
  return (budget.unknownRuns ?? 0) > 0 ? `${stand} · ${budget.unknownRuns} Läufe ohne Kostendaten` : stand;
}

export function MissionBudgetCardBody({
  budget,
  saving,
  onSave,
}: {
  budget: NonNullable<MissionDetailData["budget"]>;
  saving: boolean;
  onSave: (budgetUsd: number | null) => void;
}) {
  const [input, setInput] = useState<string>("");
  const hasBudget = budget.effectiveUsd !== null && budget.effectiveUsd !== undefined;
  const source = budget.missionBudgetUsd !== null && budget.policyDefaultUsd !== null && budget.missionBudgetUsd < budget.policyDefaultUsd
    ? "eigenes Mission-Budget unter der policy-Decke"
    : budget.missionBudgetUsd !== null
      ? "eigenes Mission-Budget"
      : "Decke aus policy.json (budget.defaultDailyUsd)";
  return (
    <section className="mission-section mission-budget" aria-label="Daily budget">
      <h3>Daily budget</h3>
      <p className="muted mission-budget-stand">{budgetDetailLine(budget)}</p>
      {hasBudget && (
        <p className="muted mission-budget-grace">
          {budget.graceToday ? "Budget überschritten, heute freigegeben (Gnaden-Tag bis Mitternacht)" : "keine Freigabe heute"}
        </p>
      )}
      <p className="mission-budget-form">
        <label>
          Eigenes Tagesbudget ($, leer = keins):{" "}
          <input
            className="mission-budget-input"
            type="number"
            min="0"
            step="0.01"
            aria-label="Mission daily budget in dollars"
            value={input}
            onChange={(e) => setInput(e.target.value)}
          />
        </label>{" "}
        <button
          type="button"
          className="mission-budget-save"
          disabled={saving}
          onClick={() => {
            const trimmed = input.trim();
            onSave(trimmed === "" ? null : Number(trimmed));
          }}
        >
          {saving ? "Speichern…" : "Budget setzen"}
        </button>
        <span className="plan-note mission-budget-note">
          {hasBudget ? `wirksam: ${source} — ein eigenes Budget darf die policy-Decke nur verschärfen (Minimum)` : "eine Decke aus policy.json (budget.defaultDailyUsd) gilt auch ohne eigenes Feld"}
        </span>
      </p>
    </section>
  );
}

/** The card wrapper: fetch on demand, never take the page down on error. */
export function MissionDigestCard({ missionId, onError }: { missionId: string; onError: (message: string) => void }) {
  const [markdown, setMarkdown] = useState<string | null>(null);
  const [files, setFiles] = useState<MissionDigestFile[]>([]);
  const [loading, setLoading] = useState(false);

  function build() {
    setLoading(true);
    // No since/until: the server's default — yesterday's local day.
    fetchMissionDigest(missionId)
      .then(setMarkdown)
      .catch((e) => onError((e as Error).message))
      .finally(() => setLoading(false));
  }

  function listFiles() {
    fetchMissionDigests(missionId)
      .then((r) => setFiles(r.digests))
      .catch((e) => onError((e as Error).message));
  }

  return <MissionDigestCardBody markdown={markdown} files={files} loading={loading} onBuild={build} onListFiles={listFiles} />;
}

export default function MissionDetail({ missionId }: { missionId: string }) {
  const [detail, setDetail] = useState<MissionDetailData | null>(null);
  const [memory, setMemory] = useState<MissionMemoryData | null>(null);
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
    // The memory view must never take the page down: a failed read leaves
    // the card out, the mission stays on screen.
    fetchMissionMemory(missionId)
      .then((data) => {
        if (!cancelled) setMemory(data);
      })
      .catch(() => {
        if (!cancelled) setMemory(null);
      });
    return () => {
      cancelled = true;
    };
  }, [missionId, reloads]);

  function handleForget(entry: MissionMemoryEntry) {
    // The existing route, the only write path: DELETE /api/memory/<id>.
    forgetMemory(entry.id, "forgotten from the mission view")
      .then(() => setReloads((n) => n + 1))
      .catch((e) => setError((e as Error).message));
  }

  async function handleStatusChange(status: MissionStatus) {
    try {
      await setMissionStatus(missionId, status);
      setReloads((n) => n + 1);
    } catch (e) {
      setError((e as Error).message);
    }
  }

  async function handleBudgetChange(budgetUsd: number | null) {
    try {
      await setMissionBudget(missionId, budgetUsd);
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

      {memory && <MissionMemoryCard memory={memory} onForget={handleForget} />}

      {detail.budget && (
        <MissionBudgetCardBody key={`${missionId}:${reloads}`} budget={detail.budget} saving={false} onSave={handleBudgetChange} />
      )}

      <MissionDigestCard missionId={missionId} onError={(message) => setError(message)} />

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
