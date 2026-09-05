// Tagesbudget (ALMANAC-PLAN §2.5 + BRIDGE-PLAN I2-Pause-Reihenfolge).
//
// Ein Budget ist eine GELD-Dimension neben den Stück-Z limits der Trigger
// (src/triggers/limits.mjs), nicht deren Erweiterung: gezählt wird die Summe
// der BEKANNTEN costUsd der heutigen Runs, nicht die Anzahl der Läufe. Das
// Fenster ist der LOKALE Tag — dieselbe DST-feste Zerlegung wie der Digest
// (localDayBounds aus src/missions/digest.mjs, wiederverwendet, nicht neu
// gebaut): ein Frühjahrstag ist ehrlich 23 h, ein Herbsttag 25 h.
//
// POSTURE-SEMANTIK: der policy-Default (budget.defaultDailyUsd in
// policy.json) ist eine DECKE, die Mission darf nur verschärfen — genau wie
// die Posture-Decke (src/policy/guards.mjs). Das effektive Budget ist darum
// das MINIMUM der gesetzten Werte; ein gesetztes Mission-Budget unter dem
// policy-Default gewinnt, eines darüber ändert nichts. Kein Wert gesetzt =
// kein Limit — und die Anzeige sagt das auch so, statt ein Fake-Limit zu
// behaupten.
//
// EHRlichkeit (dieselbe Regel wie der Digest, binding): unbekannte Kosten
// (costUsd null — Engines ohne Kostendaten) zählen NICHT als Geld. Sie
// werden als ZAHL mitgeführt und überall angezeigt, wo Budget steht
// („$3.40 von $10.00 · 2 Läufe ohne Kostendaten"). Ein Tag mit NUR
// unbekannten Kosten kann das Budget nicht ausreizen — genau das sagt die
// Anzeige auch, statt 0 zu behaupten.
//
// ZUORDNUNG: ein Run gehört zu einer Mission, wenn sein Chat der Mission
// gehört (chat.missionId oder mission.chats — dieselbe Vereinigung wie die
// Detail- und Digest-Route). Trigger haben KEINE Mission-Bindung im
// Datenmodell (registry.mjs kennt kein missionId; Trigger-Chats werden ohne
// missionId angelegt) — ihre Runs zählen aufs GLOBALE Default-Budget, wenn
// policy.json eines setzt, sonst nirgends.
import fs from 'node:fs';
import path from 'node:path';
import { defaultDecompose } from '../missions/digest.mjs';

/** The grace key for runs no mission owns (missionless chats, trigger turns). */
export const GLOBAL_BUDGET_KEY = '_global';

/** `kind` of the deferred budget question in the approval inbox (see approval-store.mjs). */
export const BUDGET_QUESTION_KIND = 'budget.day';

/** The grace record's file. One small JSON per data dir; one kaprek process per data dir writes it (see instance-lock.mjs). */
const GRACE_FILE = 'budget-grace.json';

/**
 * The effective daily budget: the MINIMUM of the set values (posture
 * semantics — see the module doc comment). A value that is not a finite
 * number >= 0 counts as "not set"; null when nothing is set.
 */
export function effectiveDailyBudget({ missionBudgetUsd = null, policyDefaultUsd = null } = {}) {
  const set = [missionBudgetUsd, policyDefaultUsd].filter(
    (value) => typeof value === 'number' && Number.isFinite(value) && value >= 0,
  );
  if (set.length === 0) return null;
  return Math.min(...set);
}

/** "YYYY-MM-DD" of the LOCAL calendar day containing `ms` — the grace record's day key. Decompose injectable (tests pin a timezone; see digest.test.mjs). */
export function dayKeyOf(ms, decompose = defaultDecompose) {
  const { y, m, d } = decompose(ms);
  return `${String(y).padStart(4, '0')}-${String(m + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

/**
 * The spend of one day window over a run list: the sum of KNOWN costUsd,
 * plus the count of runs whose cost is unknown (and stays out of the sum —
 * the honesty rule above). A `skipped` line never became a turn (P7 and the
 * budget skip alike): it has no cost and no unknown cost either — it counts
 * on neither side.
 *
 * `bounds` is `{startMs, endMs}` (localDayBounds). Attribution, one of:
 * - `chatIds`: only runs whose chatId is in the set (a mission's chat union);
 * - `excludeChatIds`: only runs whose chatId is NOT in the set (the global
 *   bucket — every chat no mission owns; a run with a null chatId counts as
 *   missionless).
 */
export function spendOfRuns({ runs, bounds, chatIds = null, excludeChatIds = null }) {
  let knownUsd = 0;
  let unknownRuns = 0;
  let runCount = 0;
  for (const run of runs) {
    const ts = Date.parse(run.ts);
    if (!Number.isFinite(ts) || ts < bounds.startMs || ts >= bounds.endMs) continue;
    if (run.skipped) continue;
    if (chatIds !== null && (run.chatId == null || !chatIds.has(run.chatId))) continue;
    if (excludeChatIds !== null && run.chatId != null && excludeChatIds.has(run.chatId)) continue;
    runCount += 1;
    if (typeof run.costUsd === 'number' && Number.isFinite(run.costUsd) && run.costUsd >= 0) knownUsd += run.costUsd;
    else unknownRuns += 1;
  }
  return { knownUsd, unknownRuns, runs: runCount };
}

/**
 * Whether today is a GRACE DAY for `key` (a mission id, or GLOBAL_BUDGET_KEY):
 * the recorded day key equals today's. Reset over the local day boundary —
 * no cron, no timer; the next check simply compares keys (DST-safe, because
 * both keys are local calendar dates).
 */
export function hasGrace(graces, key, todayKey) {
  return graces?.[key]?.dayKey === todayKey;
}

/** Reads `<dataDir>/budget-grace.json`. Missing or corrupt → empty (a grace that cannot be read is a grace nobody has — fail closed). */
export function readGraces(dataDir) {
  const filePath = path.join(dataDir, GRACE_FILE);
  let raw;
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch {
    return {};
  }
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) && parsed.graces
      ? parsed.graces
      : {};
  } catch {
    return {};
  }
}

/** Records today's grace decision for `key`. Overwrites the key's previous record — one grace day at a time is all the model has. */
export function recordGrace(dataDir, key, { dayKey, decidedAt, decision = 'allow' }) {
  const filePath = path.join(dataDir, GRACE_FILE);
  const graces = readGraces(dataDir);
  graces[key] = { dayKey, decidedAt, decision };
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify({ version: 1, graces }, null, 2)}\n`, 'utf8');
  return graces[key];
}

/**
 * The one-line stand the UI shows wherever a budget is shown (task wording):
 * „$3.40 von $10.00 · 2 Läufe ohne Kostendaten" — and, when NOTHING is
 * known, the sentence that says a day of unknown costs cannot exhaust the
 * budget, instead of a 0 nobody measured.
 */
export function budgetStandText({ spentKnownUsd, budgetUsd, unknownRuns }) {
  const known = `$${spentKnownUsd.toFixed(2)}`;
  const cap = `$${budgetUsd.toFixed(2)}`;
  const unknown = unknownRuns > 0 ? ` · ${unknownRuns} Läufe ohne Kostendaten` : '';
  if (unknownRuns > 0 && spentKnownUsd === 0) {
    return `${unknownRuns} Läufe ohne Kostendaten — bekannt ist nichts von ${cap}, das Budget kann dadurch nicht ausgereizt sein`;
  }
  return `${known} von ${cap}${unknown}`;
}
