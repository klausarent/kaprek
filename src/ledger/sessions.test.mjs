import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { appendSessionEvent, readSessionEvents, readLedgerIndex } from './sessions.mjs';

describe('session ledger', () => {
  it('appends and reads back in order, tolerating a broken line', () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kaprek-ledger-'));
    appendSessionEvent(dataDir, { type: 'start', sessionId: 's1', cwd: 'C:\\p', transcriptPath: 'C:\\t\\s1.jsonl', ts: '2026-08-28T06:00:00.000Z' });
    fs.appendFileSync(path.join(dataDir, 'ledger', 'sessions.jsonl'), '{not json\n');
    appendSessionEvent(dataDir, { type: 'stop', sessionId: 's1', cwd: 'C:\\p', transcriptPath: 'C:\\t\\s1.jsonl', ts: '2026-08-28T06:05:00.000Z' });
    const events = readSessionEvents(dataDir);
    expect(events.map((e) => e.type)).toEqual(['start', 'stop']);
    expect(events[1]).toMatchObject({ sessionId: 's1', cwd: 'C:\\p' });
  });

  it('refuses events without a session id', () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kaprek-ledger-'));
    expect(() => appendSessionEvent(dataDir, { type: 'stop' })).toThrow(/sessionId/);
    expect(readSessionEvents(dataDir)).toEqual([]);
  });

  it('accepts an "end" event and records its reason', () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kaprek-ledger-'));
    appendSessionEvent(dataDir, { type: 'end', sessionId: 's1', cwd: 'C:\\p', transcriptPath: 'C:\\t\\s1.jsonl', reason: 'clear', ts: '2026-08-28T06:10:00.000Z' });
    const events = readSessionEvents(dataDir);
    expect(events).toEqual([{ ts: '2026-08-28T06:10:00.000Z', type: 'end', sessionId: 's1', cwd: 'C:\\p', transcriptPath: 'C:\\t\\s1.jsonl', reason: 'clear' }]);
  });
});

describe('readLedgerIndex', () => {
  it('returns an empty map when the ledger file does not exist', () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kaprek-ledger-index-'));
    const index = readLedgerIndex(dataDir);
    expect(index).toBeInstanceOf(Map);
    expect(index.size).toBe(0);
  });

  it('folds start/stop/end into one entry, keeping the first start and the last event', () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kaprek-ledger-index-'));
    appendSessionEvent(dataDir, { type: 'start', sessionId: 's1', cwd: 'C:\\p', transcriptPath: 'C:\\t\\s1.jsonl', ts: '2026-08-28T06:00:00.000Z' });
    appendSessionEvent(dataDir, { type: 'stop', sessionId: 's1', cwd: 'C:\\p', transcriptPath: 'C:\\t\\s1.jsonl', ts: '2026-08-28T06:05:00.000Z' });
    appendSessionEvent(dataDir, { type: 'end', sessionId: 's1', cwd: 'C:\\p', transcriptPath: 'C:\\t\\s1.jsonl', reason: 'clear', ts: '2026-08-28T06:10:00.000Z' });
    const index = readLedgerIndex(dataDir);
    expect(index.get('s1')).toEqual({
      firstStartTs: '2026-08-28T06:00:00.000Z',
      lastTs: '2026-08-28T06:10:00.000Z',
      lastType: 'end',
      cwd: 'C:\\p',
      transcriptPath: 'C:\\t\\s1.jsonl',
      endReason: 'clear',
    });
  });

  it('a session with only a start event is "open" (lastType stays "start")', () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kaprek-ledger-index-'));
    appendSessionEvent(dataDir, { type: 'start', sessionId: 's2', cwd: 'C:\\p', ts: '2026-08-28T06:00:00.000Z' });
    const index = readLedgerIndex(dataDir);
    expect(index.get('s2')).toMatchObject({ lastType: 'start', endReason: null });
  });

  it('keeps separate sessions apart and skips a torn line', () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kaprek-ledger-index-'));
    appendSessionEvent(dataDir, { type: 'start', sessionId: 's1', ts: '2026-08-28T06:00:00.000Z' });
    fs.appendFileSync(path.join(dataDir, 'ledger', 'sessions.jsonl'), '{not json\n');
    appendSessionEvent(dataDir, { type: 'start', sessionId: 's2', ts: '2026-08-28T06:01:00.000Z' });
    const index = readLedgerIndex(dataDir);
    expect([...index.keys()].sort()).toEqual(['s1', 's2']);
  });
});
