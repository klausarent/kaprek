// Tagesbudget (ALMANAC-PLAN §2.5 + BRIDGE-PLAN I2). Alle Fenster-Tests
// laufen gegen eine INJIZIERTE feste Zeitzonen-Zerlegung (Europe/Berlin, auf
// Intl gebaut) — dieselbe Technik wie der Digest-Test, damit das Ergebnis
// nicht von der Maschinen-Uhr abhängt. localDayBounds kommt WIEDERVERWENDET
// aus dem Digest (nicht neu gebaut); die Geld- und Gnaden-Helfer aus
// budget.mjs.
import { describe, expect, test } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { localDayBounds } from '../missions/digest.mjs';
import {
  BUDGET_QUESTION_KIND,
  GLOBAL_BUDGET_KEY,
  budgetStandText,
  dayKeyOf,
  effectiveDailyBudget,
  hasGrace,
  readGraces,
  recordGrace,
  spendOfRuns,
} from './budget.mjs';

const TZ = 'Europe/Berlin';

function tzParts(ms) {
  const dtf = new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  });
  const parts = {};
  for (const { type, value } of dtf.formatToParts(new Date(ms))) parts[type] = value;
  return { y: +parts.year, m: +parts.month - 1, d: +parts.day, h: +parts.hour, min: +parts.minute, s: +parts.second };
}

const asUTC = ({ y, m, d, h = 0, min = 0, s = 0 }) => Date.UTC(y, m, d, h, min, s);

const decomposeBerlin = (ms) => {
  const { y, m, d } = tzParts(ms);
  return { y, m, d };
};
const composeBerlin = ({ y, m, d }) => {
  let ms = asUTC({ y, m, d, h: 12 });
  const offset = asUTC(tzParts(ms)) - ms;
  ms = asUTC({ y, m, d }) - offset;
  const refine = asUTC(tzParts(ms)) - ms;
  return asUTC({ y, m, d }) - refine;
};

const ctx = { decompose: decomposeBerlin, compose: composeBerlin };
const H = 60 * 60_000;

function run(overrides = {}) {
  return {
    ts: new Date(asUTC({ y: 2026, m: 2, d: 31, h: 10 })).toISOString(), // 2026-03-31 lokaler Vormittag
    chatId: 'chat-m1',
    origin: 'user',
    triggerId: null,
    costUsd: 1.0,
    tokens: 1000,
    durationMs: 42_000,
    stopReason: 'end_turn',
    skipped: null,
    conditionKind: null,
    conditionError: null,
    ...overrides,
  };
}

// ------------------------------------------------------------ min-Semantik

describe('effectiveDailyBudget — die Posture-Semantik des Geldes', () => {
  test('beide gesetzt: das KLEINERE gewinnt (die Mission darf die policy-Decke nur verschärfen)', () => {
    expect(effectiveDailyBudget({ missionBudgetUsd: 5, policyDefaultUsd: 10 })).toBe(5);
    expect(effectiveDailyBudget({ missionBudgetUsd: 20, policyDefaultUsd: 10 })).toBe(10);
  });

  test('nur eines gesetzt: das gesetzte gilt', () => {
    expect(effectiveDailyBudget({ missionBudgetUsd: 3, policyDefaultUsd: null })).toBe(3);
    expect(effectiveDailyBudget({ missionBudgetUsd: null, policyDefaultUsd: 7 })).toBe(7);
  });

  test('nichts gesetzt (oder nur Unsinn): null — kein Limit, kein Fake-Wert', () => {
    expect(effectiveDailyBudget({})).toBe(null);
    expect(effectiveDailyBudget({ missionBudgetUsd: null, policyDefaultUsd: null })).toBe(null);
    expect(effectiveDailyBudget({ missionBudgetUsd: Number.NaN, policyDefaultUsd: '10' })).toBe(null);
    expect(effectiveDailyBudget({ missionBudgetUsd: -1, policyDefaultUsd: Number.POSITIVE_INFINITY })).toBe(null);
  });

  test('0 ist ein gesetztes Budget (hartes Sperren für heute), nicht "nicht gesetzt"', () => {
    expect(effectiveDailyBudget({ missionBudgetUsd: 0, policyDefaultUsd: 10 })).toBe(0);
    expect(effectiveDailyBudget({ missionBudgetUsd: 5, policyDefaultUsd: 0 })).toBe(0);
  });
});

// ------------------------------------------------------------- Verbrauch

describe('spendOfRuns — bekanntes Geld, ehrlicher unknown-Zähler', () => {
  // Ein lokaler Fenster-Tag um den Standard-Run herum (2026-03-31).
  const bounds = { startMs: asUTC({ y: 2026, m: 2, d: 31 }), endMs: asUTC({ y: 2026, m: 2, d: 31 }) + 24 * H };

  test('nur BEKANNTE costUsd zählen als Geld; unbekannte zählen als Zahl, nie als Dollar', () => {
    const spend = spendOfRuns({
      runs: [run({ costUsd: 1.5 }), run({ costUsd: null }), run({ costUsd: undefined }), run({ costUsd: 0.25 })],
      bounds,
    });
    expect(spend.knownUsd).toBeCloseTo(1.75);
    expect(spend.unknownRuns).toBe(2);
    expect(spend.runs).toBe(4);
  });

  test('Runs außerhalb des Fensters zählen nicht', () => {
    const spend = spendOfRuns({
      runs: [
        run({ ts: new Date(bounds.startMs - 1).toISOString() }),
        run({ ts: new Date(bounds.endMs).toISOString() }),
        run(),
      ],
      bounds,
    });
    expect(spend.runs).toBe(1);
    expect(spend.knownUsd).toBeCloseTo(1.0);
  });

  test('ein skipped-Run ist weder Kosten noch unknown — er wurde nie ein Turn', () => {
    const spend = spendOfRuns({ runs: [run({ skipped: 'budget', durationMs: 0 }), run({ skipped: 'condition' })], bounds });
    expect(spend).toEqual({ knownUsd: 0, unknownRuns: 0, runs: 0 });
  });

  test('Mission-Bucket: nur Runs der Missions-Chats', () => {
    const spend = spendOfRuns({
      runs: [run(), run({ chatId: 'chat-other', costUsd: 99 }), run({ chatId: null, costUsd: 99 })],
      bounds,
      chatIds: new Set(['chat-m1']),
    });
    expect(spend.knownUsd).toBeCloseTo(1.0);
  });

  test('Global-Bucket: alles, was keiner Mission gehört; ein Run ohne Chat gilt als missionslos', () => {
    const spend = spendOfRuns({
      runs: [run({ chatId: 'chat-m1', costUsd: 50 }), run({ chatId: 'chat-free', costUsd: 2 }), run({ chatId: null, costUsd: 3 })],
      bounds,
      excludeChatIds: new Set(['chat-m1']),
    });
    expect(spend.knownUsd).toBeCloseTo(5.0);
  });
});

// ------------------------------------------------- lokale Tagesgrenze (DST)

describe('lokale Tagesgrenze — dieselbe DST-feste Zerlegung wie der Digest', () => {
  test('Frühjahrstag 2026-03-29: 23 h, ein lokaler Tag, Mitternachtsgrenze stimmt', () => {
    const bounds = localDayBounds(asUTC({ y: 2026, m: 2, d: 29, h: 12 }), ctx); // lokaler Mittag
    expect((bounds.endMs - bounds.startMs) / H).toBe(23);
    expect(bounds.startMs).toBe(asUTC({ y: 2026, m: 2, d: 29 }) - 1 * H); // Berlin ist UTC+1 im Winter
    expect(bounds.endMs).toBe(asUTC({ y: 2026, m: 2, d: 30 }) - 2 * H); // schon UTC+2
    expect(dayKeyOf(bounds.startMs, decomposeBerlin)).toBe('2026-03-29');
    expect(dayKeyOf(bounds.endMs - 1, decomposeBerlin)).toBe('2026-03-29');
  });

  test('Herbsttag 2026-10-25: 25 h — der Budget-Tag ist an diesem Tag ehrlich eine Stunde länger', () => {
    const bounds = localDayBounds(asUTC({ y: 2026, m: 9, d: 25, h: 12 }), ctx);
    expect((bounds.endMs - bounds.startMs) / H).toBe(25);
    expect(dayKeyOf(bounds.endMs - 1, decomposeBerlin)).toBe('2026-10-25');
  });

  test('spendOfRuns über einem localDayBounds-Fenster: der Nachbartag zählt nicht', () => {
    const bounds = localDayBounds(asUTC({ y: 2026, m: 2, d: 29, h: 12 }), ctx);
    const inside = new Date(bounds.startMs + H).toISOString();
    const before = new Date(bounds.startMs - 1).toISOString();
    const after = new Date(bounds.endMs + H).toISOString();
    const spend = spendOfRuns({
      runs: [run({ ts: inside, costUsd: 2 }), run({ ts: before, costUsd: 50 }), run({ ts: after, costUsd: 50 })],
      bounds,
    });
    expect(spend.knownUsd).toBeCloseTo(2.0);
  });

  test('dayKeyOf ist das LOKALE Kalenderdatum, nicht der UTC-Tag', () => {
    // 2026-03-31T23:00Z ist in Berlin schon der 1. April.
    expect(dayKeyOf(asUTC({ y: 2026, m: 2, d: 31, h: 23 }), decomposeBerlin)).toBe('2026-04-01');
  });
});

// ------------------------------------------------------------- Gnaden-Tag

describe('Gnaden-Tag — Reset über die lokale Tagesgrenze, ohne Cron', () => {
  let dataDir;
  test.beforeEach(() => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kaprek-budget-test-'));
  });
  test.afterEach(() => {
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  test('ein Allow gilt genau für seinen Tag-Schlüssel; am nächsten lokalen Tag fragt die Mission wieder', () => {
    const now = asUTC({ y: 2026, m: 2, d: 31, h: 12 }); // lokaler Nachmittag, 2026-03-31 (CEST)
    recordGrace(dataDir, 'mission-1', { dayKey: dayKeyOf(now, decomposeBerlin), decidedAt: now });
    expect(readGraces(dataDir)['mission-1'].dayKey).toBe('2026-03-31');
    expect(hasGrace(readGraces(dataDir), 'mission-1', '2026-03-31')).toBe(true);
    // Über die Grenze: 2026-04-01T00:01 Berlin (= 2026-03-31T22:01Z).
    const tomorrowLocal = asUTC({ y: 2026, m: 3, d: 1 }) - 2 * H + 60_000;
    expect(dayKeyOf(tomorrowLocal, decomposeBerlin)).toBe('2026-04-01');
    expect(hasGrace(readGraces(dataDir), 'mission-1', dayKeyOf(tomorrowLocal, decomposeBerlin))).toBe(false);
  });

  test('der Global-Bucket führt seinen eigenen Gnaden-Schlüssel', () => {
    recordGrace(dataDir, GLOBAL_BUDGET_KEY, { dayKey: '2026-03-31', decidedAt: 0 });
    expect(hasGrace(readGraces(dataDir), GLOBAL_BUDGET_KEY, '2026-03-31')).toBe(true);
    expect(hasGrace(readGraces(dataDir), 'mission-1', '2026-03-31')).toBe(false);
  });

  test('eine korrupte Gnaden-Datei ist eine Gnade, die niemand hat (fail closed)', () => {
    fs.writeFileSync(path.join(dataDir, 'budget-grace.json'), '{ kaputt', 'utf8');
    expect(readGraces(dataDir)).toEqual({});
    expect(hasGrace(readGraces(dataDir), 'mission-1', '2026-03-31')).toBe(false);
  });

  test('die Budget-Frage ist als solche erkennbar (feste kind in der Inbox)', () => {
    expect(BUDGET_QUESTION_KIND).toBe('budget.day');
  });
});

// ------------------------------------------------------------- Anzeigetext

describe('budgetStandText — die eine Zeile, die überall steht, wo Budget steht', () => {
  test('bekannt von Kappe, unknown-Zähler hängt hinten dran', () => {
    expect(budgetStandText({ spentKnownUsd: 3.4, budgetUsd: 10, unknownRuns: 2 })).toBe('$3.40 von $10.00 · 2 Läufe ohne Kostendaten');
  });

  test('ohne unknown: schlicht bekannt von Kappe', () => {
    expect(budgetStandText({ spentKnownUsd: 0, budgetUsd: 10, unknownRuns: 0 })).toBe('$0.00 von $10.00');
  });

  test('ein Tag NUR unbekannter Kosten: die Anzeige sagt, dass das Budget nicht ausgereizt sein kann — statt 0 zu behaupten', () => {
    const text = budgetStandText({ spentKnownUsd: 0, budgetUsd: 10, unknownRuns: 3 });
    expect(text).toContain('3 Läufe ohne Kostendaten');
    expect(text).toContain('$10.00');
    expect(text).not.toBe('$0.00 von $10.00');
  });
});
