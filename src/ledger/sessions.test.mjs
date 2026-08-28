import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { appendSessionEvent, readSessionEvents } from './sessions.mjs';

describe('session ledger', () => {
  it('appends and reads back in order, tolerating a broken line', () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kaprek-ledger-'));
    appendSessionEvent(dataDir, { type: 'start', sessionId: 's1', cwd: 'C:\p', transcriptPath: 'C:\t\s1.jsonl', ts: '2026-08-28T06:00:00.000Z' });
    fs.appendFileSync(path.join(dataDir, 'ledger', 'sessions.jsonl'), '{not json\n');
    appendSessionEvent(dataDir, { type: 'stop', sessionId: 's1', cwd: 'C:\p', transcriptPath: 'C:\t\s1.jsonl', ts: '2026-08-28T06:05:00.000Z' });
    const events = readSessionEvents(dataDir);
    expect(events.map((e) => e.type)).toEqual(['start', 'stop']);
    expect(events[1]).toMatchObject({ sessionId: 's1', cwd: 'C:\p' });
  });

  it('refuses events without a session id', () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kaprek-ledger-'));
    expect(() => appendSessionEvent(dataDir, { type: 'stop' })).toThrow(/sessionId/);
    expect(readSessionEvents(dataDir)).toEqual([]);
  });
});
