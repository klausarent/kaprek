// The trigger form's own model: every field a string/boolean the way an
// <input> holds it, plus the two conversions to and from the wire shape
// src/triggers/registry.mjs validates.
//
// Deliberately NO client-side validation beyond "omit what the user left
// blank": the registry is the single authority on what a valid trigger is
// (ranges, ceilings, the everyMinutes-XOR-dailyAt rule, regex compilability),
// and a second copy of those rules here would drift. A 400 comes back with the
// offending `field`, which FORM_FIELD_FOR_SERVER_FIELD maps onto the input that
// caused it.
import type { ConditionKind, Escalation, Trigger, TriggerType } from "./api";

export type ScheduleMode = "everyMinutes" | "dailyAt";

export type TriggerFormValue = {
  id: string;
  type: TriggerType;
  escalation: Escalation;
  promptTemplate: string;
  enabled: boolean;
  /**
   * App ids this trigger may use tools from. Only ever set by picking from the
   * installed apps (GET /api/apps) — never typed. The registry rejects an id
   * that names no installed app with a 400, and a free-text field would make
   * that the user's problem instead of an impossible input.
   */
  appScope: string[];
  maxRunsPerDay: string;
  maxCostPerDay: string;
  // heartbeat
  intervalMinutes: string;
  checklistPath: string;
  // schedule
  scheduleMode: ScheduleMode;
  everyMinutes: string;
  dailyAt: string;
  // file-watch
  watchPath: string;
  watchEvents: string[];
  debounceMs: string;
  // clipboard
  pollMs: string;
  matchPattern: string;
  // skip-if precondition (P7). conditionKind "" means "no condition". Only
  // heartbeat/schedule triggers accept one (see registry.mjs); the path is
  // typed as the user entered it — the STORED form is the resolved absolute
  // path the server answers for probeCondition(...).resolvedPath.
  conditionKind: "" | ConditionKind;
  conditionPath: string;
  onConditionError: "skip" | "run";
  /** The result of the one probe execution the form runs before saving. */
  conditionProbe: ConditionProbeState;
};

export type ConditionProbeState =
  | { status: "idle" }
  | { status: "running" }
  /** A condition loaded from the registry was already resolved (and probed) when it was saved. */
  | { status: "stored"; resolvedPath: string }
  | { status: "done"; met: boolean; error: string | null; resolvedPath: string };

export const TRIGGER_TYPE_LABELS: Record<TriggerType, string> = {
  heartbeat: "Heartbeat",
  schedule: "Schedule",
  "file-watch": "File watch",
  clipboard: "Clipboard",
  "saved-prompt": "Saved prompt",
};

export const TRIGGER_TYPE_HINTS: Record<TriggerType, string> = {
  heartbeat: "Wakes up on a fixed interval and works through a checklist file in the workspace.",
  schedule: "Runs every N minutes, or once a day at a fixed time.",
  "file-watch": "Runs when a file or folder inside the workspace changes.",
  clipboard: "Runs when something you copy matches a pattern. Windows only.",
  "saved-prompt": "Never fires on its own — only when you press Run now.",
};

export const ESCALATION_HINTS: Record<Escalation, string> = {
  notify: "Reports what it found and takes no action you have not approved separately.",
  question: "Asks you before it does anything that changes something.",
  review: "Prepares the work and hands it to you to approve.",
};

/**
 * Maps a server-side `field` (see src/triggers/registry.mjs's fail() calls)
 * onto a form field name. Anything unmapped (`<root>`, an unknown field name)
 * has no input to attach to and is shown as a form-level error instead.
 */
export const FORM_FIELD_FOR_SERVER_FIELD: Record<string, keyof TriggerFormValue> = {
  id: "id",
  type: "type",
  promptTemplate: "promptTemplate",
  escalation: "escalation",
  enabled: "enabled",
  appScope: "appScope",
  "config.intervalMinutes": "intervalMinutes",
  "config.checklistPath": "checklistPath",
  "config.everyMinutes": "everyMinutes",
  "config.dailyAt": "dailyAt",
  "config.path": "watchPath",
  "config.events": "watchEvents",
  "config.debounceMs": "debounceMs",
  "config.pollMs": "pollMs",
  "config.matchPattern": "matchPattern",
  "limits.maxRunsPerDay": "maxRunsPerDay",
  "limits.maxCostPerDay": "maxCostPerDay",
  "condition.kind": "conditionKind",
  "condition.path": "conditionPath",
  onConditionError: "onConditionError",
};

/**
 * Which form field a server error belongs to, or null when it belongs to the
 * form as a whole. `config` on its own is the schedule XOR rule, which is
 * about the mode radio rather than either number field.
 */
export function formFieldForServerField(field: string | null): keyof TriggerFormValue | null {
  if (!field) return null;
  if (field === "config") return "scheduleMode";
  return FORM_FIELD_FOR_SERVER_FIELD[field] ?? null;
}

/** A blank form. Defaults mirror src/triggers/registry.mjs's own defaults so a hands-off submit is already valid. */
export function emptyTriggerForm(): TriggerFormValue {
  return {
    id: "",
    type: "schedule",
    escalation: "notify",
    promptTemplate: "",
    enabled: false,
    appScope: [],
    maxRunsPerDay: "24",
    maxCostPerDay: "1.00",
    intervalMinutes: "60",
    checklistPath: "CHECKLIST.md",
    scheduleMode: "everyMinutes",
    everyMinutes: "60",
    dailyAt: "09:00",
    watchPath: "",
    watchEvents: ["add", "change", "unlink"],
    debounceMs: "500",
    pollMs: "2000",
    matchPattern: "",
    conditionKind: "",
    conditionPath: "",
    onConditionError: "skip",
    conditionProbe: { status: "idle" },
  };
}

export function triggerToForm(trigger: Trigger): TriggerFormValue {
  const blank = emptyTriggerForm();
  const config = trigger.config ?? {};
  return {
    ...blank,
    id: trigger.id,
    type: trigger.type,
    escalation: trigger.escalation,
    promptTemplate: trigger.promptTemplate,
    enabled: trigger.enabled,
    appScope: [...trigger.appScope],
    maxRunsPerDay: String(trigger.limits.maxRunsPerDay),
    maxCostPerDay: String(trigger.limits.maxCostPerDay),
    intervalMinutes: config.intervalMinutes === undefined ? blank.intervalMinutes : String(config.intervalMinutes),
    checklistPath: config.checklistPath ?? blank.checklistPath,
    scheduleMode: config.dailyAt === undefined ? "everyMinutes" : "dailyAt",
    everyMinutes: config.everyMinutes === undefined ? blank.everyMinutes : String(config.everyMinutes),
    dailyAt: config.dailyAt ?? blank.dailyAt,
    watchPath: config.path ?? "",
    watchEvents: config.events ?? blank.watchEvents,
    debounceMs: config.debounceMs === undefined ? blank.debounceMs : String(config.debounceMs),
    pollMs: config.pollMs === undefined ? blank.pollMs : String(config.pollMs),
    matchPattern: config.matchPattern ?? "",
    conditionKind: trigger.condition?.kind ?? "",
    conditionPath: trigger.condition?.path ?? "",
    onConditionError: trigger.onConditionError ?? "skip",
    // A stored condition was already resolved (and probed) when it was
    // saved — show that verdict instead of asking for a fresh probe.
    conditionProbe:
      trigger.condition === undefined
        ? { status: "idle" }
        : { status: "stored", resolvedPath: trigger.condition.path },
  };
}

/**
 * A blank numeric input must reach the server as an OMITTED field, not as NaN
 * or 0: omitted means "use the registry's default", while 0 is a validation
 * error the user never asked for.
 */
function num(raw: string): number | undefined {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return undefined;
  const parsed = Number(trimmed);
  return Number.isNaN(parsed) ? undefined : parsed;
}

function str(raw: string): string | undefined {
  const trimmed = raw.trim();
  return trimmed.length === 0 ? undefined : trimmed;
}

/** Whether this trigger type accepts a skip-if condition at all (see registry.mjs's CONDITION_TYPES). */
export function typeAcceptsCondition(type: TriggerType): boolean {
  return type === "heartbeat" || type === "schedule";
}

/** Drops undefined values so an omitted field never reaches the server as `null`, which the registry would reject. */
function compact<T extends Record<string, unknown>>(obj: T): Partial<T> {
  return Object.fromEntries(Object.entries(obj).filter(([, value]) => value !== undefined)) as Partial<T>;
}

function configFor(form: TriggerFormValue): Record<string, unknown> {
  switch (form.type) {
    case "heartbeat":
      return compact({ intervalMinutes: num(form.intervalMinutes), checklistPath: str(form.checklistPath) });
    case "schedule":
      // Exactly one of the two — the registry rejects both and neither.
      return form.scheduleMode === "dailyAt" ? compact({ dailyAt: str(form.dailyAt) }) : compact({ everyMinutes: num(form.everyMinutes) });
    case "file-watch":
      return compact({
        path: str(form.watchPath),
        events: form.watchEvents.length > 0 ? form.watchEvents : undefined,
        debounceMs: num(form.debounceMs),
      });
    case "clipboard":
      return compact({ pollMs: num(form.pollMs), matchPattern: str(form.matchPattern) });
    default:
      return {};
  }
}

/**
 * The POST /api/triggers body for this form. An empty `appScope` is a normal,
 * useful state — the trigger can then still read and report, it just cannot
 * use any app's tools (see runner.mjs::notifyPolicyHandler).
 */
export function formToTrigger(form: TriggerFormValue): Record<string, unknown> {
  const kind = typeAcceptsCondition(form.type) ? form.conditionKind : "";
  const path = kind === "" ? "" : form.conditionPath.trim();
  return {
    id: form.id.trim(),
    type: form.type,
    config: configFor(form),
    promptTemplate: form.promptTemplate,
    escalation: form.escalation,
    appScope: [...form.appScope],
    enabled: form.enabled,
    limits: compact({ maxRunsPerDay: num(form.maxRunsPerDay), maxCostPerDay: num(form.maxCostPerDay) }),
    // The RELATIVE path goes up as typed; the registry resolves it against
    // the base dir and stores the absolute form.
    ...(kind === "" || path === "" ? {} : { condition: { kind, path } }),
    // Only meaningful together with a condition (the registry rejects it alone).
    ...(kind === "" || path === "" ? {} : { onConditionError: form.onConditionError }),
  };
}
