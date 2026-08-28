import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { harvestRemember } from './harvest.mjs';
import { openMemory } from './store.mjs';

function line(role, text) {
  const content = role === 'assistant' ? [{ type: 'text', text }] : text;
  return `${JSON.stringify({ type: role, message: { role, content }, timestamp: '2026-08-28T06:00:00.000Z' })}\n`;
}
const block = (text) => '```kaprek-remember\n' + JSON.stringify({ text, kind: 'fact', confidence: 0.9 }) + '\n```';

function setup() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kaprek-harvest-'));
  const transcriptPath = path.join(dataDir, 's1.jsonl');
  fs.writeFileSync(transcriptPath, line('user', 'hallo') + line('assistant', `Gelernt.\n${block('Deploy nur über deploy.ps1')}`));
  return { dataDir, transcriptPath, cwd: 'C:\\Users\\demo\\meinprojekt' };
}

describe('harvestRemember', () => {
  it('writes a remember block from a terminal transcript into the project scope', () => {
    const { dataDir, transcriptPath, cwd } = setup();
    const r = harvestRemember({ dataDir, transcriptPath, sessionId: 's1', cwd });
    expect(r).toMatchObject({ written: 1, skipped: 0, scopeId: 'project:meinprojekt' });
    const facts = openMemory(dataDir).list({ scopeId: 'project:meinprojekt' });
    expect(facts.map((f) => f.text)).toEqual(['Deploy nur über deploy.ps1']);
    expect(facts[0].origin).toBe('terminal:s1');
  });

  it('is idempotent across turns and only reads new bytes', () => {
    const { dataDir, transcriptPath, cwd } = setup();
    harvestRemember({ dataDir, transcriptPath, sessionId: 's1', cwd });
    expect(harvestRemember({ dataDir, transcriptPath, sessionId: 's1', cwd })).toMatchObject({ written: 0, skipped: 0 });
    fs.appendFileSync(transcriptPath, line('assistant', block('Tests laufen mit vitest')));
    expect(harvestRemember({ dataDir, transcriptPath, sessionId: 's1', cwd })).toMatchObject({ written: 1 });
    fs.appendFileSync(transcriptPath, line('assistant', block('Tests laufen mit vitest')));
    expect(harvestRemember({ dataDir, transcriptPath, sessionId: 's1', cwd })).toMatchObject({ written: 0, skipped: 1 });
    expect(openMemory(dataDir).list({ scopeId: 'project:meinprojekt' })).toHaveLength(2);
  });

  it('does nothing without cwd or transcript, and never throws', () => {
    const { dataDir, transcriptPath } = setup();
    expect(harvestRemember({ dataDir, transcriptPath, sessionId: 's1', cwd: null })).toMatchObject({ written: 0, scopeId: null });
    expect(harvestRemember({ dataDir, transcriptPath: path.join(dataDir, 'missing.jsonl'), sessionId: 's2', cwd: 'C:\\x' })).toMatchObject({ written: 0 });
  });

  it('stops at the deadline and resumes from the saved offset next time', () => {
    const { dataDir, transcriptPath, cwd } = setup();
    let t = 0;
    const now = () => (t += 1000); // every call costs a "second" → deadline hit after first line
    const first = harvestRemember({ dataDir, transcriptPath, sessionId: 's1', cwd, deadlineMs: 1500, now });
    const second = harvestRemember({ dataDir, transcriptPath, sessionId: 's1', cwd });
    expect(first.written + second.written).toBe(1);
  });
});
