// Task board (#/board): five columns by status, a "new task" form, and a
// detail drawer with the 7-field completion doc required before a task can
// move to 'done'. Backed by src/board/store.mjs via /api/board/*.
import { useEffect, useMemo, useState, type FormEvent } from "react";
import {
  fetchTasks,
  createTask,
  updateTask,
  setTaskDoc,
  setTaskStatus,
  TaskDocIncompleteError,
  BOARD_STATUSES,
  DOC_FIELD_DEFS,
  DOC_FIELD_MIN_LENGTH,
  type Task,
  type BoardStatus,
  type TaskDoc,
} from "../lib/api";
import { navigateToThread } from "../App";

const COLUMN_LABELS: Record<BoardStatus, string> = {
  backlog: "Backlog",
  in_progress: "In Progress",
  in_review: "In Review",
  blocked: "Blocked",
  done: "Done",
};

/** True once every doc field is present and reaches DOC_FIELD_MIN_LENGTH after trimming. */
function isDocComplete(doc: TaskDoc | null): boolean {
  if (!doc) return false;
  return DOC_FIELD_DEFS.every((f) => (doc[f.key] ?? "").trim().length >= DOC_FIELD_MIN_LENGTH);
}

export default function Board() {
  const [tasks, setTasks] = useState<Task[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetchTasks()
      .then((data) => {
        if (!cancelled) setTasks(data);
      })
      .catch((e) => {
        if (!cancelled) setError((e as Error).message);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const grouped = useMemo(() => {
    const byStatus = new Map<BoardStatus, Task[]>(BOARD_STATUSES.map((s) => [s, []]));
    for (const task of tasks ?? []) {
      byStatus.get(task.status)?.push(task);
    }
    return byStatus;
  }, [tasks]);

  const selectedTask = useMemo(() => tasks?.find((t) => t.id === selectedTaskId) ?? null, [tasks, selectedTaskId]);

  function applyUpdatedTask(updated: Task) {
    setTasks((prev) => (prev ? prev.map((t) => (t.id === updated.id ? updated : t)) : prev));
  }

  return (
    <div className="page">
      <header className="page-header">
        <h1>Board</h1>
        <p className="page-subtitle">{tasks ? `${tasks.length} task${tasks.length === 1 ? "" : "s"}` : "Loading…"}</p>
      </header>

      <NewTaskForm
        onCreated={(task) => {
          setTasks((prev) => (prev ? [...prev, task] : [task]));
        }}
        onError={setError}
      />

      {error && <div className="error-box">{error}</div>}

      {!tasks && !error ? (
        <div className="empty-box">Loading tasks…</div>
      ) : (
        <div className="board-columns">
          {BOARD_STATUSES.map((status) => (
            <div key={status} className="board-column">
              <div className="board-column-title">
                <span>{COLUMN_LABELS[status]}</span>
                <span>{grouped.get(status)?.length ?? 0}</span>
              </div>
              <div className="board-column-body">
                {(grouped.get(status) ?? []).map((task) => (
                  <button key={task.id} type="button" className="board-card" onClick={() => setSelectedTaskId(task.id)}>
                    <div className="board-card-title">{task.title}</div>
                    <div className="board-card-meta">
                      {task.project && <span className="badge badge-muted">{task.project}</span>}
                      {task.tags.map((tag) => (
                        <span key={tag} className="badge">
                          {tag}
                        </span>
                      ))}
                      {task.sessions.length > 0 && (
                        <span className="badge badge-muted">
                          {task.sessions.length} session{task.sessions.length === 1 ? "" : "s"}
                        </span>
                      )}
                    </div>
                  </button>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}

      {selectedTask && (
        <TaskDrawer task={selectedTask} onClose={() => setSelectedTaskId(null)} onUpdated={applyUpdatedTask} />
      )}
    </div>
  );
}

function NewTaskForm({ onCreated, onError }: { onCreated: (task: Task) => void; onError: (message: string) => void }) {
  const [title, setTitle] = useState("");
  const [project, setProject] = useState("");
  const [creating, setCreating] = useState(false);

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (!title.trim() || creating) return;
    setCreating(true);
    try {
      const task = await createTask({ title: title.trim(), project: project.trim() || undefined });
      onCreated(task);
      setTitle("");
      setProject("");
    } catch (err) {
      onError((err as Error).message);
    } finally {
      setCreating(false);
    }
  };

  return (
    <form className="board-new-task" onSubmit={handleSubmit}>
      <input name="title" placeholder="New task title…" value={title} onChange={(e) => setTitle(e.target.value)} />
      <input name="project" placeholder="Project (optional)" value={project} onChange={(e) => setProject(e.target.value)} />
      <button type="submit" className="btn" disabled={!title.trim() || creating}>
        {creating ? "Adding…" : "Add task"}
      </button>
    </form>
  );
}

function TaskDrawer({ task, onClose, onUpdated }: { task: Task; onClose: () => void; onUpdated: (task: Task) => void }) {
  const [title, setTitle] = useState(task.title);
  const [project, setProject] = useState(task.project ?? "");
  const [tagsInput, setTagsInput] = useState(task.tags.join(", "));
  const [doc, setDoc] = useState<TaskDoc>(task.doc ?? {});
  const [savingFields, setSavingFields] = useState(false);
  const [savingDoc, setSavingDoc] = useState(false);
  const [statusPending, setStatusPending] = useState<BoardStatus | null>(null);
  const [missing, setMissing] = useState<string[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Reset local edit state whenever the drawer is opened for a different task.
  useEffect(() => {
    setTitle(task.title);
    setProject(task.project ?? "");
    setTagsInput(task.tags.join(", "));
    setDoc(task.doc ?? {});
    setMissing(null);
    setError(null);
  }, [task.id]);

  const docComplete = isDocComplete(doc);

  const handleSaveFields = async () => {
    setSavingFields(true);
    setError(null);
    try {
      const tags = tagsInput
        .split(",")
        .map((t) => t.trim())
        .filter(Boolean);
      const updated = await updateTask(task.id, { title: title.trim(), project: project.trim() || undefined, tags });
      onUpdated(updated);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSavingFields(false);
    }
  };

  const handleSaveDoc = async () => {
    setSavingDoc(true);
    setError(null);
    try {
      const updated = await setTaskDoc(task.id, doc);
      onUpdated(updated);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSavingDoc(false);
    }
  };

  const handleSetStatus = async (status: BoardStatus) => {
    if (status === task.status) return;
    setStatusPending(status);
    setError(null);
    setMissing(null);
    try {
      const updated = await setTaskStatus(task.id, status);
      onUpdated(updated);
    } catch (err) {
      if (err instanceof TaskDocIncompleteError) {
        setMissing(err.missing);
      } else {
        setError((err as Error).message);
      }
    } finally {
      setStatusPending(null);
    }
  };

  return (
    <div className="board-drawer-overlay" onClick={onClose}>
      <div className="board-drawer" onClick={(e) => e.stopPropagation()}>
        <div className="board-drawer-header">
          <h2>Task</h2>
          <button type="button" className="btn" onClick={onClose}>
            Close
          </button>
        </div>

        {error && <div className="error-box">{error}</div>}

        <div className="board-drawer-field">
          <label>Title</label>
          <input value={title} onChange={(e) => setTitle(e.target.value)} />
        </div>
        <div className="board-drawer-field">
          <label>Project</label>
          <input value={project} onChange={(e) => setProject(e.target.value)} />
        </div>
        <div className="board-drawer-field">
          <label>Tags (comma-separated)</label>
          <input value={tagsInput} onChange={(e) => setTagsInput(e.target.value)} />
        </div>
        <button type="button" className="btn" onClick={handleSaveFields} disabled={savingFields || !title.trim()}>
          {savingFields ? "Saving…" : "Save"}
        </button>

        <div className="board-drawer-field">
          <label>Status</label>
          <div className="board-status-buttons">
            {BOARD_STATUSES.map((status) => {
              const isCurrent = status === task.status;
              const isDoneAndIncomplete = status === "done" && !docComplete;
              return (
                <button
                  key={status}
                  type="button"
                  className={`board-status-btn${isCurrent ? " board-status-btn-active" : ""}`}
                  disabled={isCurrent || isDoneAndIncomplete || statusPending !== null}
                  onClick={() => handleSetStatus(status)}
                  title={isDoneAndIncomplete ? "All 7 doc fields need at least 20 characters first" : undefined}
                >
                  {statusPending === status ? "…" : COLUMN_LABELS[status]}
                </button>
              );
            })}
          </div>
          {missing && missing.length > 0 && (
            <div className="error-box">
              Missing or too short: {missing.map((key) => DOC_FIELD_DEFS.find((f) => f.key === key)?.label ?? key).join(", ")}
            </div>
          )}
        </div>

        <div className="board-drawer-field">
          <label>Documentation</label>
          {DOC_FIELD_DEFS.map((field) => {
            const value = doc[field.key] ?? "";
            const ok = value.trim().length >= DOC_FIELD_MIN_LENGTH;
            return (
              <div key={field.key} className="board-drawer-field">
                <label>{field.label}</label>
                <div className="board-doc-field-desc">{field.description}</div>
                <textarea
                  value={value}
                  onChange={(e) => setDoc((prev) => ({ ...prev, [field.key]: e.target.value }))}
                />
                <div className={`board-doc-field-count${ok ? " board-doc-field-count-ok" : ""}`}>
                  {value.trim().length} / {DOC_FIELD_MIN_LENGTH}
                </div>
              </div>
            );
          })}
          <button type="button" className="btn" onClick={handleSaveDoc} disabled={savingDoc}>
            {savingDoc ? "Saving…" : "Save documentation"}
          </button>
        </div>

        <div className="board-drawer-field">
          <label>Linked sessions</label>
          {task.sessions.length === 0 ? (
            <div className="board-doc-field-desc">No sessions linked yet.</div>
          ) : (
            <div className="board-session-links">
              {task.sessions.map((s) => (
                <a
                  key={`${s.projectSlug}/${s.sessionId}`}
                  href={`#/session/${encodeURIComponent(s.projectSlug)}/${encodeURIComponent(s.sessionId)}`}
                  className="board-session-link"
                  onClick={(e) => {
                    e.preventDefault();
                    navigateToThread(s.projectSlug, s.sessionId);
                  }}
                >
                  {s.projectSlug} / {s.sessionId}
                </a>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
