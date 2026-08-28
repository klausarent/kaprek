import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { harvestRemember, MAX_CHUNK_BYTES } from './harvest.mjs';
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

/** Enough harmless 'user' lines (no remember block) to reach roughly `targetBytes`. */
function fillerLines(targetBytes) {
  const chunkText = 'x'.repeat(970);
  let out = '';
  while (Buffer.byteLength(out, 'utf8') < targetBytes) out += line('user', chunkText);
  return out;
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

  it('on a brand-new session, starts at the transcript tail and reads only one chunk', () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kaprek-harvest-'));
    const cwd = 'C:\\Users\\demo\\meinprojekt';
    const transcriptPath = path.join(dataDir, 's-tail.jsonl');
    const prologue = fillerLines(MAX_CHUNK_BYTES + 512 * 1024); // history nobody ever harvests
    fs.writeFileSync(transcriptPath, prologue + line('assistant', block('Nur im letzten Chunk sichtbar')));
    const size = fs.statSync(transcriptPath).size;
    expect(size).toBeGreaterThan(MAX_CHUNK_BYTES);

    const r = harvestRemember({ dataDir, transcriptPath, sessionId: 's-tail', cwd });
    expect(r).toMatchObject({ written: 1, skipped: 0, scopeId: 'project:meinprojekt' });
    const state = JSON.parse(fs.readFileSync(path.join(dataDir, 'memory', 'harvest', 's-tail.json'), 'utf8'));
    expect(state.offset).toBe(size);
  });

  it('processes at most one chunk per call and finishes a two-chunk backlog over two calls', () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kaprek-harvest-'));
    const cwd = 'C:\\Users\\demo\\meinprojekt';
    const transcriptPath = path.join(dataDir, 's-two.jsonl');
    const early = fillerLines(MAX_CHUNK_BYTES - 200 * 1024); // leaves headroom in the first chunk for block 1
    const midFiller = fillerLines(MAX_CHUNK_BYTES / 2); // pushes block 2 past the first chunk boundary
    fs.writeFileSync(
      transcriptPath,
      early + line('assistant', block('Erster Block, noch im ersten Chunk')) + midFiller + line('assistant', block('Zweiter Block, jenseits des ersten Chunks'))
    );
    const size = fs.statSync(transcriptPath).size;
    expect(size).toBeGreaterThan(MAX_CHUNK_BYTES);

    // A pre-existing state file with offset 0 — not a brand-new session, so
    // the tail-seeding logic must not kick in; reading must start at 0 and
    // still be capped to one chunk per call.
    const stateFile = path.join(dataDir, 'memory', 'harvest', 's-two.json');
    fs.mkdirSync(path.dirname(stateFile), { recursive: true });
    fs.writeFileSync(stateFile, JSON.stringify({ offset: 0, hashes: [] }));

    const first = harvestRemember({ dataDir, transcriptPath, sessionId: 's-two', cwd });
    expect(first.written).toBe(1);
    const afterFirst = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    expect(afterFirst.offset).toBeGreaterThan(0);
    expect(afterFirst.offset).toBeLessThan(size);

    const second = harvestRemember({ dataDir, transcriptPath, sessionId: 's-two', cwd });
    expect(second.written).toBe(1);
    expect(openMemory(dataDir).list({ scopeId: 'project:meinprojekt' })).toHaveLength(2);
  });

  it('never throws when the transcript path is a directory', () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kaprek-harvest-'));
    const transcriptDir = path.join(dataDir, 'not-a-transcript.jsonl');
    fs.mkdirSync(transcriptDir);
    const r = harvestRemember({ dataDir, transcriptPath: transcriptDir, sessionId: 's-dir', cwd: 'C:\\x\\meinprojekt' });
    expect(r).toEqual({ written: 0, skipped: 0, scopeId: null });
  });

  it('never throws when the harvest state directory is blocked by a file', () => {
    const { dataDir, transcriptPath, cwd } = setup();
    fs.mkdirSync(path.join(dataDir, 'memory'), { recursive: true });
    fs.writeFileSync(path.join(dataDir, 'memory', 'harvest'), 'blocked — not a directory');
    const r = harvestRemember({ dataDir, transcriptPath, sessionId: 's1', cwd });
    expect(r).toEqual({ written: 0, skipped: 0, scopeId: null });
  });
});
