// P8: the morning digest. All window tests run against an INJECTED fixed
// timezone decomposition (Europe/Berlin, built on Intl) so the results do
// not depend on the machine's clock — that injection exists exactly for
// this (see digest.mjs, "Injected local-day decomposition").
import { describe, expect, test } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  buildDigest,
  fmtDuration,
  listDigests,
  localDayBounds,
  renderDigest,
  resolveWindow,
  selectRuns,
} from './digest.mjs';
import { appendRun } from '../orchestrator/runs.mjs';

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

/** Injected decompose/compose pinned to Europe/Berlin. */
const decomposeBerlin = (ms) => {
  const { y, m, d } = tzParts(ms);
  return { y, m, d };
};
const composeBerlin = ({ y, m, d }) => {
  // Offset at local noon equals the offset at midnight for this zone, and
  // one refinement pass makes that assumption's failure harmless.
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
    ts: new Date(asUTC({ y: 2026, m: 7, d: 31, h: 3 })).toISOString(),
    chatId: 'chat-1',
    origin: 'user',
    triggerId: null,
    costUsd: 0.01,
    tokens: 1000,
    durationMs: 42_000,
    stopReason: 'end_turn',
    skipped: null,
    conditionKind: null,
    conditionError: null,
    ...overrides,
  };
}

const WINDOW = {
  kind: 'day',
  startMs: asUTC({ y: 2026, m: 7, d: 31 }) + 2 * H, // Berlin is UTC+2 in summer; 2026-08-31 local midnight
  endMs: asUTC({ y: 2026, m: 8, d: 1 }) + 2 * H,
  spanMs: 24 * H,
  spanHours: '24',
  label: '31.08.2026',
  name: '01.09.2026',
};

describe('window bounds (injected Europe/Berlin)', () => {
  test('an ordinary day is a 24 h interval between two real local midnights', () => {
    const noon = new Date('2026-08-31T10:00:00+02:00').getTime();
    const bounds = localDayBounds(noon, ctx);
    expect(bounds.startMs).toBe(new Date('2026-08-31T00:00:00+02:00').getTime());
    expect(bounds.endMs).toBe(new Date('2026-09-01T00:00:00+02:00').getTime());
    expect(bounds.spanMs).toBe(24 * H);
  });

  test('the spring-forward day (29.03.2026) is a 23 h window', () => {
    const noon = new Date('2026-03-29T12:00:00+02:00').getTime();
    const bounds = localDayBounds(noon, ctx);
    expect(bounds.spanMs).toBe(23 * H);
    expect(bounds.startMs).toBe(new Date('2026-03-29T00:00:00+01:00').getTime());
    expect(bounds.endMs).toBe(new Date('2026-03-30T00:00:00+02:00').getTime());
  });

  test('the fall-back day (25.10.2026) is a 25 h window', () => {
    const noon = new Date('2026-10-25T12:00:00+01:00').getTime();
    const bounds = localDayBounds(noon, ctx);
    expect(bounds.spanMs).toBe(25 * H);
    expect(bounds.startMs).toBe(new Date('2026-10-25T00:00:00+02:00').getTime());
    expect(bounds.endMs).toBe(new Date('2026-10-26T00:00:00+01:00').getTime());
  });

  test("resolveWindow defaults to yesterday's local day, named by the local date of its end", () => {
    // 2026-09-01 06:00 Berlin — the morning the digest is read.
    const now = new Date('2026-09-01T06:00:00+02:00').getTime();
    const w = resolveWindow({ now, ...ctx });
    expect(w.startMs).toBe(new Date('2026-08-31T00:00:00+02:00').getTime());
    expect(w.endMs).toBe(new Date('2026-09-01T00:00:00+02:00').getTime());
    expect(w.name).toBe('01.09.2026');
    expect(w.kind).toBe('day');
  });

  test('resolveWindow accepts an arbitrary explicit window and rejects an empty one', () => {
    const since = '2026-08-30T00:00:00+02:00';
    const until = '2026-09-01T00:00:00+02:00';
    const w = resolveWindow({ since, until, ...ctx });
    expect(w.kind).toBe('explicit');
    expect(w.spanMs).toBe(48 * H);
    expect(() => resolveWindow({ since: until, until: since, ...ctx })).toThrow(/until must be after since/);
  });
});

describe('renderDigest', () => {
  const mission = { id: 'm1', title: 'Zaehler-Service' };

  test('unknown costs: coverage counter in the header, per-run unknown, NOT in the sum', () => {
    const runs = [run(), run({ costUsd: null, tokens: 500 })];
    const md = renderDigest({ mission, window: WINDOW, runs, openQuestions: [], nowMs: 0 });
    expect(md).toContain('Kosten bekannt für 1 von 2 Läufen.');
    expect(md).toContain('(bekannter Teil; 1 Läufe unknown)');
    // Only the KNOWN $0.01 is summed — the null run contributes nothing.
    expect(md).toContain('- Kosten: $0.0100');
    expect(md).toContain('1500');
  });

  test('fully unknown costs never render a fake zero total', () => {
    const runs = [run({ costUsd: null }), run({ costUsd: null })];
    const md = renderDigest({ mission, window: WINDOW, runs, openQuestions: [] });
    expect(md).toContain('Kosten bekannt für 0 von 2 Läufen.');
    expect(md).toContain('weder 0 noch in einer Summe');
  });

  test('skipped (condition), skipped (condition-error, short cause), and failed runs get their own states', () => {
    const runs = [
      run({ origin: 'trigger', triggerId: 't-nightly', skipped: 'condition', conditionKind: 'file-exists', costUsd: null }),
      run({
        origin: 'trigger',
        triggerId: 't-nightly',
        skipped: 'condition-error',
        conditionKind: 'file-newer-than-last-run',
        conditionError: 'ENOENT: no such file or directory, stat Somewhere/State',
        costUsd: null,
      }),
      run({ origin: 'trigger', triggerId: 't-nightly', stopReason: 'error', error: 'boom', costUsd: null }),
      run({ origin: 'trigger', triggerId: 't-nightly', durationMs: 12_300 }),
    ];
    const md = renderDigest({ mission, window: WINDOW, runs, openQuestions: [] });
    expect(md).toContain('### t-nightly');
    expect(md).toContain('übersprungen (condition false) — Bedingung file-exists');
    expect(md).toContain('übersprungen (condition-error) — Bedingung file-newer-than-last-run konnte nicht geprüft werden: ENOENT: no such file or directory, stat Somewhere/State');
    expect(md).toContain('fehlgeschlagen (stopReason: error)');
    expect(md).toContain('gelaufen — $0.0100, 1000 Tokens, Dauer 12,3 s');
  });

  test('open questions show their remaining time against the 24 h deadline', () => {
    const now = new Date('2026-09-01T00:00:00+02:00').getTime();
    const deadline = now + 5 * H;
    const md = renderDigest({
      mission,
      window: WINDOW,
      runs: [],
      openQuestions: [{ id: 'a1', question: 'Soll ich den Deploy freigeben?', deadlineAt: deadline }],
      nowMs: now,
    });
    expect(md).toContain('Soll ich den Deploy freigeben? — Restlaufzeit: 5 h von 24 h');
  });

  test('an empty mission still produces a digest with its 0-line', () => {
    const md = renderDigest({ mission, window: WINDOW, runs: [], openQuestions: [] });
    expect(md).toContain('# Morning digest — Zaehler-Service');
    expect(md).toContain('0 Läufe im Fenster');
    expect(md).toContain('0 offene Fragen.');
    expect(md).toContain('Kosten bekannt für 0 von 0 Läufen.');
  });

  test('files appear only when the run records themselves name them', () => {
    const withFiles = renderDigest({
      mission,
      window: WINDOW,
      runs: [run({ files: ['src/a.mjs', 'src/b.mjs'] }), run({ files: ['src/a.mjs'] })],
      openQuestions: [],
    });
    expect(withFiles).toContain('- src/a.mjs');
    expect(withFiles).toContain('- src/b.mjs');
    const without = renderDigest({ mission, window: WINDOW, runs: [run()], openQuestions: [] });
    expect(without).toContain('Aus den Runs nicht ersichtlich');
  });

  test('same inputs render byte-identical markdown (idempotency precondition)', () => {
    const args = {
      mission,
      window: WINDOW,
      runs: [run(), run({ costUsd: null })],
      openQuestions: [{ id: 'a1', question: 'q', deadlineAt: 12345 }],
      nowMs: 999,
    };
    expect(renderDigest(args)).toBe(renderDigest(args));
  });
});

describe('selectRuns', () => {
  test("keeps runs of the mission's chats inside the window, boundary-exclusive at the end", () => {
    const inside = run();
    const otherChat = run({ chatId: 'chat-other' });
    const outside = run({ ts: new Date(WINDOW.startMs - 1).toISOString() });
    const atEnd = run({ ts: new Date(WINDOW.endMs).toISOString() });
    const picked = selectRuns([inside, otherChat, outside, atEnd], WINDOW, new Set(['chat-1']));
    expect(picked).toEqual([inside]);
  });
});

describe('buildDigest storage', () => {
  function tmpDataDir() {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'digest-store-'));
  }

  test("writes <datum>.md under the mission's digests dir and overwrites byte-identically", () => {
    const dataDir = tmpDataDir();
    const now = new Date('2026-09-01T06:00:00+02:00').getTime();
    const mission = { id: 'm1', title: 'Zaehler-Service' };
    appendRun(dataDir, run({ ts: new Date('2026-08-31T08:00:00+02:00').toISOString() }));
    appendRun(dataDir, run({ ts: new Date('2026-08-31T09:00:00+02:00').toISOString(), costUsd: null }));

    const first = buildDigest({ dataDir, mission, chatIds: new Set(['chat-1']), now, ...ctx });
    expect(first.window.name).toBe('01.09.2026');
    expect(first.path).toBe(path.join(dataDir, 'missions', 'm1', 'digests', '01.09.2026.md'));
    expect(first.wrote).toBe(true);
    const bytes = fs.readFileSync(first.path, 'utf8');

    // Second build, same data: same file, byte-equal, no revision file.
    const second = buildDigest({ dataDir, mission, chatIds: new Set(['chat-1']), now, ...ctx });
    expect(second.wrote).toBe(false);
    expect(fs.readFileSync(second.path, 'utf8')).toBe(bytes);
    expect(fs.readdirSync(path.join(dataDir, 'missions', 'm1', 'digests'))).toEqual(['01.09.2026.md']);
    expect(listDigests(dataDir, 'm1')).toHaveLength(1);
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  test('window crossing midnight picks up runs from both calendar days', () => {
    const dataDir = tmpDataDir();
    const now = new Date('2026-09-01T18:00:00+02:00').getTime();
    const mission = { id: 'm1', title: 'Zaehler-Service' };
    // Explicit window 31.08 12:00 → 01.09 12:00 local: it spans midnight and
    // contains runs from two calendar dates.
    const since = '2026-08-31T12:00:00+02:00';
    const until = '2026-09-01T12:00:00+02:00';
    appendRun(dataDir, run({ ts: new Date('2026-08-31T23:50:00+02:00').toISOString(), costUsd: 0.02 }));
    appendRun(dataDir, run({ ts: new Date('2026-09-01T00:10:00+02:00').toISOString(), costUsd: 0.03 }));
    // Outside the window on both sides.
    appendRun(dataDir, run({ ts: new Date('2026-08-31T11:00:00+02:00').toISOString(), costUsd: 9.99 }));
    appendRun(dataDir, run({ ts: new Date('2026-09-01T13:00:00+02:00').toISOString(), costUsd: 9.99 }));

    const { markdown } = buildDigest({ dataDir, mission, chatIds: new Set(['chat-1']), since, until, now, ...ctx });
    expect(markdown).toContain('Kosten bekannt für 2 von 2 Läufen.');
    expect(markdown).toContain('$0.0500');
    fs.rmSync(dataDir, { recursive: true, force: true });
  });
});

describe('fmtDuration', () => {
  test('formats the ranges run records actually carry', () => {
    expect(fmtDuration(450)).toBe('450 ms');
    expect(fmtDuration(12_300)).toBe('12,3 s');
    expect(fmtDuration(5 * H)).toBe('5 h');
    expect(fmtDuration(null)).toBe('unknown');
  });
});
