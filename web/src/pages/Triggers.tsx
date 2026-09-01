// Trigger page (#/triggers): what fires on its own, how far it may go, and
// what it has cost today. A form, not a JSON editor — the whole point of the
// escalation/limits model is that a user can see and change it without knowing
// the file format (see src/triggers/registry.mjs).
//
// The three presentational pieces (TriggerRow, TriggerForm,
// ClipboardConsentPanel) are exported and hook-free on purpose: all state lives
// in the container below, so each renders as a plain function of its props.
import { useEffect, useState } from "react";
import {
  ESCALATIONS,
  FILE_WATCH_EVENTS,
  TRIGGER_TYPES,
  TriggerBusyError,
  TriggerValidationError,
  deleteTrigger,
  fetchApps,
  fetchTriggerRuns,
  fetchTriggers,
  fireTrigger,
  probeCondition,
  toggleTrigger,
  upsertTrigger,
  type AppSummary,
  type ConditionKind,
  type Escalation,
  type TriggerRun,
  type TriggerStatus,
  type TriggerType,
} from "../lib/api";
import {
  ESCALATION_HINTS,
  TRIGGER_TYPE_HINTS,
  TRIGGER_TYPE_LABELS,
  emptyTriggerForm,
  typeAcceptsCondition,
  formFieldForServerField,
  formToTrigger,
  triggerToForm,
  type TriggerFormValue,
} from "../lib/triggerForm";
import { decideDelete, decideToggle } from "../lib/triggerActions";
import { navigateToChats } from "../App";

/** How the escalation level translates into "who decides" (see server.mjs::handleTriggersList's approvalPath). */
function approvalPathLabel(path: "policy" | "ui" | "inbox"): string {
  if (path === "policy") return "automatically limited";
  // 'inbox' still means "asks you" — the difference is that the question
  // waits in #/approvals instead of needing you to be looking when it is
  // raised. Saying "asks you, waits" keeps the row honest about both halves.
  if (path === "inbox") return "asks you, waits";
  return "asks you";
}

/**
 * How one line of a trigger's run history reads. A P7 skip never became a
 * turn, so it says so in plain words instead of a stop reason nobody could
 * make sense of.
 */
export function triggerRunLabel(run: TriggerRun): string {
  if (run.skipped === "condition") return "übersprungen (Bedingung)";
  if (run.skipped === "condition-error") return `übersprungen (Bedingungsfehler: ${run.conditionError ?? "unbekannt"})`;
  if (run.stopReason === "error") return "fehlgeschlagen";
  return "gelaufen";
}

export function TriggerRunHistory({ runs }: { runs: TriggerRun[] | null }) {
  if (runs === null) return null;
  if (runs.length === 0) return null;
  return (
    <ul className="trigger-run-history">
      {[...runs].reverse().map((run, i) => (
        <li key={`${run.ts}-${i}`} className={run.skipped === "condition-error" ? "trigger-run-error" : undefined}>
          <span>{new Date(run.ts).toLocaleString()}</span>
          <span>{triggerRunLabel(run)}</span>
        </li>
      ))}
    </ul>
  );
}

export function TriggerRow({
  trigger,
  busy,
  note,
  runs = null,
  onToggleRequest,
  onFire,
  onEdit,
  onDelete,
}: {
  trigger: TriggerStatus;
  busy: boolean;
  note: string | null;
  /** The trigger's last runs (see fetchTriggerRuns), or null while loading. */
  runs?: TriggerRun[] | null;
  onToggleRequest: (trigger: TriggerStatus, enabled: boolean) => void;
  onFire: (trigger: TriggerStatus) => void;
  onEdit: (trigger: TriggerStatus) => void;
  onDelete: (trigger: TriggerStatus) => void;
}) {
  // A clipboard trigger has no condition the user can fire by hand — the
  // runner refuses it, so the button says why instead of failing on click.
  const manualFireAllowed = trigger.type !== "clipboard";

  return (
    <div className="trigger-row">
      <div className="trigger-row-top">
        <span className="trigger-row-title">{trigger.id}</span>
        <span className="badge badge-muted">{TRIGGER_TYPE_LABELS[trigger.type]}</span>
        <span className="badge">{trigger.escalation}</span>
        <span className="badge badge-muted">{approvalPathLabel(trigger.approvalPath)}</span>
        <label className="trigger-row-toggle">
          <input
            type="checkbox"
            checked={trigger.enabled}
            disabled={busy || !trigger.supported}
            onChange={(e) => onToggleRequest(trigger, e.target.checked)}
          />
          {trigger.enabled ? "Enabled" : "Disabled"}
        </label>
      </div>

      <div className="trigger-row-meta">
        <span>
          {trigger.runsToday}/{trigger.limits.maxRunsPerDay} runs
        </span>
        <span>
          ${trigger.costToday.toFixed(2)}/${trigger.limits.maxCostPerDay.toFixed(2)}
        </span>
      </div>

      <div className="trigger-row-prompt">{trigger.promptTemplate}</div>

      {trigger.degraded && (
        <div className="trigger-row-warning">
          Degraded: the skip-if condition failed {trigger.conditionErrorStreak}× in a row — check its path.
        </div>
      )}
      {trigger.condition && (
        <div className="trigger-form-hint">
          Condition: {trigger.condition.kind} <code>{trigger.condition.path}</code>
        </div>
      )}

      <TriggerRunHistory runs={runs} />

      {trigger.blocked && <div className="trigger-row-warning">Cannot run: {trigger.blocked}</div>}
      {!trigger.supported && trigger.unsupportedReason && (
        <div className="trigger-row-warning">Not supported here: {trigger.unsupportedReason}</div>
      )}
      {note && <div className="trigger-row-note">{note}</div>}

      <div className="trigger-row-actions">
        <button type="button" className="btn" disabled={busy || !manualFireAllowed} onClick={() => onFire(trigger)}>
          {manualFireAllowed ? "Run now" : "No manual run"}
        </button>
        <button type="button" className="btn btn-load-older" onClick={() => onEdit(trigger)}>
          Edit
        </button>
        <a
          className="trigger-row-link"
          href={`#/chats?triggerId=${encodeURIComponent(trigger.id)}&includeSilent=1`}
          onClick={(e) => {
            e.preventDefault();
            navigateToChats({ triggerId: trigger.id, includeSilent: true });
          }}
        >
          Runs
        </a>
        <button type="button" className="btn btn-danger" disabled={busy} onClick={() => onDelete(trigger)}>
          Delete
        </button>
      </div>
    </div>
  );
}

/**
 * The explicit second step before a clipboard trigger goes live. A toggle
 * alone is not enough consent for "kaprek watches everything you copy" — the
 * user has to read what it actually does and say yes.
 */
export function ClipboardConsentPanel({
  trigger,
  onConfirm,
  onCancel,
}: {
  trigger: TriggerStatus;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <div className="trigger-consent">
      <div className="trigger-consent-title">Enable clipboard trigger “{trigger.id}”?</div>
      <p className="trigger-consent-body">
        kaprek will read your clipboard while this trigger is enabled. Only entries matching the pattern{" "}
        <code>{trigger.config.matchPattern ?? "(none set — nothing will ever match)"}</code> are processed; everything else
        is discarded without being stored or sent anywhere.
      </p>
      <div className="trigger-consent-actions">
        <button type="button" className="btn" onClick={onConfirm}>
          I understand, enable it
        </button>
        <button type="button" className="btn btn-load-older" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </div>
  );
}

/** Same second-step mechanism as the clipboard consent, for the one other irreversible action on this page. */
export function DeleteConfirmPanel({
  trigger,
  onConfirm,
  onCancel,
}: {
  trigger: TriggerStatus;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <div className="trigger-consent">
      <div className="trigger-consent-title">Delete trigger “{trigger.id}”?</div>
      <p className="trigger-consent-body">
        Its prompt, schedule, escalation level and limits are removed. Past runs stay in the chat list. This cannot be
        undone — if you only want it to stop firing, disable it instead.
      </p>
      <div className="trigger-consent-actions">
        <button type="button" className="btn btn-danger" onClick={onConfirm}>
          Delete it
        </button>
        <button type="button" className="btn btn-load-older" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </div>
  );
}

function FieldError({ message }: { message: string | null }) {
  if (!message) return null;
  return <div className="trigger-field-error">{message}</div>;
}

/**
 * Which installed apps this trigger may use tools from. A multi-select over
 * GET /api/apps, never a text field: the registry rejects an app id that is not
 * installed, so free text would only let a user type something that is
 * guaranteed to come back as a 400.
 */
export function AppScopePicker({
  apps,
  selected,
  error,
  onChange,
}: {
  apps: AppSummary[] | null;
  selected: string[];
  error: string | null;
  onChange: (appScope: string[]) => void;
}) {
  return (
    <div className="trigger-form-field">
      <label>Apps this trigger may use</label>
      <div className="trigger-form-hint">A notify trigger may only use tools from the apps you select here.</div>
      {apps === null ? (
        <div className="trigger-form-hint">Loading installed apps…</div>
      ) : apps.length === 0 ? (
        <div className="trigger-form-hint">No apps installed, so there is nothing to grant. The trigger can still read and report.</div>
      ) : (
        <div className="trigger-form-appscope">
          {apps.map((app) => (
            <label key={app.id}>
              <input
                type="checkbox"
                name="appScope"
                value={app.id}
                checked={selected.includes(app.id)}
                onChange={(e) =>
                  onChange(e.target.checked ? [...selected, app.id] : selected.filter((id) => id !== app.id))
                }
              />
              <span>
                {app.icon ?? "🧩"} {app.name}
              </span>
              <span className="trigger-form-hint">{app.description}</span>
            </label>
          ))}
        </div>
      )}
      {selected.length === 0 && apps !== null && apps.length > 0 && (
        <div className="trigger-form-hint">Nothing selected: the trigger may read and report, but cannot use any app's tools.</div>
      )}
      <FieldError message={error} />
    </div>
  );
}

export function TriggerForm({
  value,
  apps,
  editing,
  saving,
  fieldError,
  formError,
  onChange,
  onSubmit,
  onCancel,
}: {
  value: TriggerFormValue;
  /** Installed apps for the scope picker, or null while they are still loading. */
  apps: AppSummary[] | null;
  editing: boolean;
  saving: boolean;
  /** The form field the server's 400 pointed at, with its message. */
  fieldError: { field: keyof TriggerFormValue; message: string } | null;
  /** A 400 that named no field the form owns, or any other save failure. */
  formError: string | null;
  onChange: (patch: Partial<TriggerFormValue>) => void;
  onSubmit: () => void;
  onCancel: () => void;
}) {
  const errorFor = (field: keyof TriggerFormValue): string | null =>
    fieldError && fieldError.field === field ? fieldError.message : null;

  return (
    <form
      className="trigger-form"
      onSubmit={(e) => {
        e.preventDefault();
        onSubmit();
      }}
    >
      <h2 className="trigger-form-title">{editing ? `Edit ${value.id}` : "New trigger"}</h2>

      {formError && <div className="error-box">{formError}</div>}

      <div className="trigger-form-field">
        <label htmlFor="trigger-id">Id</label>
        <input
          id="trigger-id"
          name="id"
          value={value.id}
          disabled={editing}
          placeholder="lowercase-with-dashes"
          onChange={(e) => onChange({ id: e.target.value })}
        />
        <FieldError message={errorFor("id")} />
      </div>

      <div className="trigger-form-field">
        <label htmlFor="trigger-type">Type</label>
        <select
          id="trigger-type"
          name="type"
          value={value.type}
          onChange={(e) => onChange({ type: e.target.value as TriggerType })}
        >
          {TRIGGER_TYPES.map((type) => (
            <option key={type} value={type}>
              {TRIGGER_TYPE_LABELS[type]}
            </option>
          ))}
        </select>
        <div className="trigger-form-hint">{TRIGGER_TYPE_HINTS[value.type]}</div>
        <FieldError message={errorFor("type")} />
      </div>

      {value.type === "heartbeat" && (
        <>
          <div className="trigger-form-field">
            <label htmlFor="trigger-interval">Interval (minutes)</label>
            <input
              id="trigger-interval"
              name="intervalMinutes"
              value={value.intervalMinutes}
              onChange={(e) => onChange({ intervalMinutes: e.target.value })}
            />
            <FieldError message={errorFor("intervalMinutes")} />
          </div>
          <div className="trigger-form-field">
            <label htmlFor="trigger-checklist">Checklist file (inside the workspace)</label>
            <input
              id="trigger-checklist"
              name="checklistPath"
              value={value.checklistPath}
              onChange={(e) => onChange({ checklistPath: e.target.value })}
            />
            <FieldError message={errorFor("checklistPath")} />
          </div>
        </>
      )}

      {value.type === "schedule" && (
        <div className="trigger-form-field">
          <label>When</label>
          <div className="trigger-form-radios">
            <label>
              <input
                type="radio"
                name="scheduleMode"
                checked={value.scheduleMode === "everyMinutes"}
                onChange={() => onChange({ scheduleMode: "everyMinutes" })}
              />
              Every N minutes
            </label>
            <label>
              <input
                type="radio"
                name="scheduleMode"
                checked={value.scheduleMode === "dailyAt"}
                onChange={() => onChange({ scheduleMode: "dailyAt" })}
              />
              Once a day at
            </label>
          </div>
          {value.scheduleMode === "everyMinutes" ? (
            <>
              <input name="everyMinutes" value={value.everyMinutes} onChange={(e) => onChange({ everyMinutes: e.target.value })} />
              <FieldError message={errorFor("everyMinutes")} />
            </>
          ) : (
            <>
              <input name="dailyAt" placeholder="HH:MM" value={value.dailyAt} onChange={(e) => onChange({ dailyAt: e.target.value })} />
              <FieldError message={errorFor("dailyAt")} />
            </>
          )}
          <FieldError message={errorFor("scheduleMode")} />
        </div>
      )}

      {value.type === "file-watch" && (
        <>
          <div className="trigger-form-field">
            <label htmlFor="trigger-watch-path">Path (relative to the workspace)</label>
            <input
              id="trigger-watch-path"
              name="watchPath"
              value={value.watchPath}
              onChange={(e) => onChange({ watchPath: e.target.value })}
            />
            <FieldError message={errorFor("watchPath")} />
          </div>
          <div className="trigger-form-field">
            <label>Events</label>
            <div className="trigger-form-radios">
              {FILE_WATCH_EVENTS.map((event) => (
                <label key={event}>
                  <input
                    type="checkbox"
                    name="watchEvents"
                    value={event}
                    checked={value.watchEvents.includes(event)}
                    onChange={(e) =>
                      onChange({
                        watchEvents: e.target.checked
                          ? [...value.watchEvents, event]
                          : value.watchEvents.filter((it) => it !== event),
                      })
                    }
                  />
                  {event}
                </label>
              ))}
            </div>
            <FieldError message={errorFor("watchEvents")} />
          </div>
          <div className="trigger-form-field">
            <label htmlFor="trigger-debounce">Debounce (ms)</label>
            <input
              id="trigger-debounce"
              name="debounceMs"
              value={value.debounceMs}
              onChange={(e) => onChange({ debounceMs: e.target.value })}
            />
            <FieldError message={errorFor("debounceMs")} />
          </div>
        </>
      )}

      {value.type === "clipboard" && (
        <>
          <div className="trigger-form-field">
            <label htmlFor="trigger-pattern">Pattern (regular expression)</label>
            <input
              id="trigger-pattern"
              name="matchPattern"
              value={value.matchPattern}
              onChange={(e) => onChange({ matchPattern: e.target.value })}
            />
            <div className="trigger-form-hint">
              Without a pattern this trigger never fires and never reads the clipboard at all.
            </div>
            <FieldError message={errorFor("matchPattern")} />
          </div>
          <div className="trigger-form-field">
            <label htmlFor="trigger-poll">Poll interval (ms)</label>
            <input id="trigger-poll" name="pollMs" value={value.pollMs} onChange={(e) => onChange({ pollMs: e.target.value })} />
            <FieldError message={errorFor("pollMs")} />
          </div>
        </>
      )}

      {typeAcceptsCondition(value.type) && (
        <div className="trigger-form-field">
          <label htmlFor="trigger-condition-kind">Skip-if condition</label>
          <select
            id="trigger-condition-kind"
            name="conditionKind"
            value={value.conditionKind}
            onChange={(e) => onChange({ conditionKind: e.target.value as "" | ConditionKind, conditionProbe: { status: "idle" } })}
          >
            <option value="">None — run every time</option>
            <option value="file-exists">File exists</option>
            <option value="file-newer-than-last-run">File newer than last run</option>
          </select>
          {value.conditionKind !== "" && (
            <>
              <label htmlFor="trigger-condition-path">Condition path (absolute, or relative to the workspace)</label>
              <input
                id="trigger-condition-path"
                name="conditionPath"
                value={value.conditionPath}
                onChange={(e) => onChange({ conditionPath: e.target.value, conditionProbe: { status: "idle" } })}
              />
              {value.conditionProbe.status === "running" && <div className="trigger-form-hint">Checking the condition…</div>}
              {value.conditionProbe.status === "stored" && (
                <div className="trigger-form-hint">
                  Stored as <code>{value.conditionProbe.resolvedPath}</code>.
                </div>
              )}
              {value.conditionProbe.status === "done" && value.conditionProbe.error !== null && (
                <div className="trigger-field-error">
                  Bedingungsfehler: {value.conditionProbe.error} — gespeichert als <code>{value.conditionProbe.resolvedPath}</code>
                </div>
              )}
              {value.conditionProbe.status === "done" && value.conditionProbe.error === null && (
                <div className="trigger-form-hint">
                  Bedingung ist <strong>{value.conditionProbe.met ? "wahr" : "falsch"}</strong> — gespeichert als{" "}
                  <code>{value.conditionProbe.resolvedPath}</code>.
                </div>
              )}
              <div className="trigger-form-radios">
                <label>
                  <input
                    type="radio"
                    name="onConditionError"
                    checked={value.onConditionError === "skip"}
                    onChange={() => onChange({ onConditionError: "skip" })}
                  />
                  On condition error: skip the run
                </label>
                <label>
                  <input
                    type="radio"
                    name="onConditionError"
                    checked={value.onConditionError === "run"}
                    onChange={() => onChange({ onConditionError: "run" })}
                  />
                  On condition error: run anyway
                </label>
              </div>
            </>
          )}
          <FieldError message={errorFor("conditionKind") ?? errorFor("conditionPath")} />
        </div>
      )}

      <div className="trigger-form-field">
        <label htmlFor="trigger-prompt">Prompt</label>
        <textarea
          id="trigger-prompt"
          name="promptTemplate"
          value={value.promptTemplate}
          onChange={(e) => onChange({ promptTemplate: e.target.value })}
        />
        <FieldError message={errorFor("promptTemplate")} />
      </div>

      <AppScopePicker
        apps={apps}
        selected={value.appScope}
        error={errorFor("appScope")}
        onChange={(appScope) => onChange({ appScope })}
      />

      <div className="trigger-form-field">
        <label>Escalation</label>
        <div className="trigger-form-escalations">
          {ESCALATIONS.map((level) => (
            <label key={level} className="trigger-form-escalation">
              <input
                type="radio"
                name="escalation"
                value={level}
                checked={value.escalation === level}
                onChange={() => onChange({ escalation: level as Escalation })}
              />
              <span className="trigger-form-escalation-name">{level}</span>
              <span className="trigger-form-hint">{ESCALATION_HINTS[level]}</span>
            </label>
          ))}
        </div>
        <FieldError message={errorFor("escalation")} />
      </div>

      <div className="trigger-form-field">
        <label htmlFor="trigger-max-runs">Max runs per day</label>
        <input
          id="trigger-max-runs"
          name="maxRunsPerDay"
          value={value.maxRunsPerDay}
          onChange={(e) => onChange({ maxRunsPerDay: e.target.value })}
        />
        <FieldError message={errorFor("maxRunsPerDay")} />
      </div>

      <div className="trigger-form-field">
        <label htmlFor="trigger-max-cost">Max cost per day (USD)</label>
        <input
          id="trigger-max-cost"
          name="maxCostPerDay"
          value={value.maxCostPerDay}
          onChange={(e) => onChange({ maxCostPerDay: e.target.value })}
        />
        <FieldError message={errorFor("maxCostPerDay")} />
      </div>

      <div className="trigger-form-actions">
        <button type="submit" className="btn" disabled={saving}>
          {saving ? "Saving…" : editing ? "Save changes" : "Create trigger"}
        </button>
        <button type="button" className="btn btn-load-older" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </form>
  );
}

export default function Triggers() {
  const [triggers, setTriggers] = useState<TriggerStatus[] | null>(null);
  // The app-scope picker's options. Loaded once — installing an app is a
  // filesystem action outside this page, and a stale list is visible as such
  // (a missing app simply cannot be selected) rather than silently wrong.
  const [apps, setApps] = useState<AppSummary[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [notes, setNotes] = useState<Record<string, string>>({});

  // The last runs per trigger id, for the rows' run history (P7 skip lines
  // included — a skip has no chat, so this is the only place it shows).
  const [runsByTrigger, setRunsByTrigger] = useState<Record<string, TriggerRun[] | null>>({});

  const [form, setForm] = useState<TriggerFormValue | null>(null);
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [fieldError, setFieldError] = useState<{ field: keyof TriggerFormValue; message: string } | null>(null);
  const [formError, setFormError] = useState<string | null>(null);

  // The action waiting for its explicit second step: enabling a clipboard
  // trigger, or deleting one. Both routed through the pure decideToggle() /
  // decideDelete() below rather than decided inline here.
  const [pending, setPending] = useState<{ action: "enable-clipboard" | "delete"; trigger: TriggerStatus } | null>(null);

  const reload = async () => {
    try {
      const list = await fetchTriggers();
      setTriggers(list);
      setLoadError(null);
      // Best-effort history: a failed fetch leaves the rows without history
      // rather than taking the page down.
      for (const trigger of list) {
        setRunsByTrigger((prev) => ({ ...prev, [trigger.id]: prev[trigger.id] ?? null }));
        fetchTriggerRuns(trigger.id)
          .then((runs) => setRunsByTrigger((prev) => ({ ...prev, [trigger.id]: runs })))
          .catch(() => {});
      }
    } catch (e) {
      setLoadError((e as Error).message);
    }
  };

  useEffect(() => {
    void reload();
    // A failed app list must not blank the trigger page: the picker then shows
    // "no apps installed", which is the fail-closed reading anyway.
    fetchApps()
      .then(({ apps: installed }) => setApps(installed))
      .catch(() => setApps([]));
  }, []);

  const setNote = (id: string, note: string | null) => {
    setNotes((prev) => {
      const next = { ...prev };
      if (note === null) delete next[id];
      else next[id] = note;
      return next;
    });
  };

  const applyToggle = async (trigger: TriggerStatus, enabled: boolean) => {
    setBusyId(trigger.id);
    setNote(trigger.id, null);
    try {
      await toggleTrigger(trigger.id, enabled);
      await reload();
    } catch (e) {
      setNote(trigger.id, (e as Error).message);
    } finally {
      setBusyId(null);
    }
  };

  /** Routes the switch through decideToggle() — see lib/triggerActions.ts for which case needs consent and why. */
  const handleToggleRequest = (trigger: TriggerStatus, enabled: boolean) => {
    if (decideToggle(trigger, enabled) === "needs-consent") {
      setPending({ action: "enable-clipboard", trigger });
      return;
    }
    void applyToggle(trigger, enabled);
  };

  const handleFire = async (trigger: TriggerStatus) => {
    setBusyId(trigger.id);
    setNote(trigger.id, "Running…");
    try {
      const result = await fireTrigger(trigger.id);
      if (result && result.fired === false) {
        setNote(trigger.id, `Not fired: ${result.reason ?? "no reason given"}`);
      } else {
        setNote(trigger.id, "Fired.");
      }
      await reload();
    } catch (e) {
      setNote(
        trigger.id,
        e instanceof TriggerBusyError ? "A trigger run is already in progress — try again in a moment." : (e as Error).message,
      );
    } finally {
      setBusyId(null);
    }
  };

  const applyDelete = async (trigger: TriggerStatus) => {
    setBusyId(trigger.id);
    try {
      await deleteTrigger(trigger.id);
      if (form && form.id === trigger.id) setForm(null);
      await reload();
    } catch (e) {
      setNote(trigger.id, (e as Error).message);
    } finally {
      setBusyId(null);
    }
  };

  /** Delete always takes the confirmation step — see decideDelete(). */
  const handleDeleteRequest = (trigger: TriggerStatus) => {
    if (decideDelete() === "needs-confirm") {
      setPending({ action: "delete", trigger });
      return;
    }
    void applyDelete(trigger);
  };

  const startNew = () => {
    setForm(emptyTriggerForm());
    setEditing(false);
    setFieldError(null);
    setFormError(null);
  };

  const startEdit = (trigger: TriggerStatus) => {
    setForm(triggerToForm(trigger));
    setEditing(true);
    setFieldError(null);
    setFormError(null);
  };

  /**
   * Edits the form, and clears the server's complaint about a field the moment
   * that field is touched — a stale "must be between 5 and 1440" under an input
   * the user has already fixed reads like the fix did not take.
   */
  const handleFormChange = (patch: Partial<TriggerFormValue>) => {
    setForm((prev) => (prev ? { ...prev, ...patch } : prev));
    if (fieldError && Object.prototype.hasOwnProperty.call(patch, fieldError.field)) setFieldError(null);
    // Changing the type swaps the whole set of visible fields, so a message
    // pinned to a field that no longer exists must go too.
    if (fieldError && patch.type !== undefined) setFieldError(null);
  };

  const handleSubmit = async () => {
    if (!form) return;
    setSaving(true);
    setFieldError(null);
    setFormError(null);
    // P7: a condition is probed ONCE before the trigger may be saved — the
    // result (true / false / error) is displayed, and the FIRST click only
    // shows it. The second click (with an unchanged condition) saves.
    const wire = formToTrigger(form);
    if (wire.condition !== undefined && form.conditionProbe.status !== "done" && form.conditionProbe.status !== "stored") {
      setForm((prev) => (prev ? { ...prev, conditionProbe: { status: "running" } } : prev));
      try {
        const kind = (wire.condition as { kind: ConditionKind }).kind;
        const path = (wire.condition as { path: string }).path;
        const result = await probeCondition(kind, path, editing ? form.id.trim() : undefined);
        setForm((prev) =>
          prev ? { ...prev, conditionProbe: { status: "done", met: result.met, error: result.error, resolvedPath: result.resolvedPath } } : prev,
        );
      } catch (e) {
        setForm((prev) => (prev ? { ...prev, conditionProbe: { status: "idle" } } : prev));
        setFormError((e as Error).message);
      }
      setSaving(false);
      return;
    }
    try {
      await upsertTrigger(formToTrigger(form));
      setForm(null);
      await reload();
    } catch (e) {
      if (e instanceof TriggerValidationError) {
        const field = formFieldForServerField(e.field);
        if (field) setFieldError({ field, message: e.message });
        else setFormError(e.message);
      } else {
        setFormError((e as Error).message);
      }
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="page triggers-page">
      <header className="page-header">
        <h1>Triggers</h1>
        <p className="page-subtitle">
          What kaprek does on its own, how far it may go without asking, and what it has spent today.
        </p>
      </header>

      {loadError && <div className="error-box">{loadError}</div>}

      {pending?.action === "enable-clipboard" && (
        <ClipboardConsentPanel
          trigger={pending.trigger}
          onConfirm={() => {
            const { trigger } = pending;
            setPending(null);
            void applyToggle(trigger, true);
          }}
          onCancel={() => setPending(null)}
        />
      )}

      {pending?.action === "delete" && (
        <DeleteConfirmPanel
          trigger={pending.trigger}
          onConfirm={() => {
            const { trigger } = pending;
            setPending(null);
            void applyDelete(trigger);
          }}
          onCancel={() => setPending(null)}
        />
      )}

      {form ? (
        <TriggerForm
          value={form}
          apps={apps}
          editing={editing}
          saving={saving}
          fieldError={fieldError}
          formError={formError}
          onChange={handleFormChange}
          onSubmit={handleSubmit}
          onCancel={() => setForm(null)}
        />
      ) : (
        <button type="button" className="btn triggers-new-button" onClick={startNew}>
          New trigger
        </button>
      )}

      {triggers === null ? (
        <div className="empty-box">Loading…</div>
      ) : triggers.length === 0 ? (
        <div className="empty-box">
            <p>
              A trigger is a prompt that runs on a schedule, without you. The agent works, and anything it wants to do
              that needs your say-so waits in the approval inbox until you answer — hours later is fine.
            </p>
            <p>Nothing runs on its own until you create one.</p>
          </div>
      ) : (
        <div className="trigger-list">
          {triggers.map((trigger) => (
            <TriggerRow
              key={trigger.id}
              trigger={trigger}
              busy={busyId === trigger.id}
              note={notes[trigger.id] ?? null}
              runs={runsByTrigger[trigger.id] ?? null}
              onToggleRequest={handleToggleRequest}
              onFire={handleFire}
              onEdit={startEdit}
              onDelete={handleDeleteRequest}
            />
          ))}
        </div>
      )}
    </div>
  );
}
