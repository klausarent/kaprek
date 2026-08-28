import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runCouncilCommand } from './council.mjs';

function deps(overrides = {}) {
  const lines = [];
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kaprek-council-cli-'));
  return {
    lines,
    dataDir,
    deps: {
      dataDir,
      peersFor: () => ({ possible: true, peers: ['codex', 'grok'], reason: null }),
      snapshotFiles: (paths) => ({ snapshots: paths.map((p) => ({ path: p, content: 'x' })), refused: [] }),
      consultPeers: async ({ question, snapshots }) => ({
        consensus: false,
        empty: false,
        agreed: ['codex'],
        dissenting: [{ peerId: 'grok', verdict: 'concerns', summary: `zu ${question.slice(0, 5)} mit ${snapshots.length} Dateien`, risks: ['Risiko A'] }],
        unreachable: [],
      }),
      stdout: (l) => lines.push(l),
      stderr: (l) => lines.push(`ERR ${l}`),
      ...overrides,
    },
  };
}

describe('kaprek council', () => {
  it('prints verdicts per peer and writes a result file', async () => {
    const d = deps();
    const code = await runCouncilCommand(['Plan ok?', '--file', 'a.md'], d.deps);
    expect(code).toBe(0);
    const out = d.lines.join('\n');
    expect(out).toMatch(/codex.*agree/i);
    expect(out).toMatch(/grok.*concerns/i);
    expect(out).toMatch(/Risiko A/);
    const dir = path.join(d.dataDir, 'council', 'cli');
    const files = fs.readdirSync(dir);
    expect(files).toHaveLength(1);
    const saved = JSON.parse(fs.readFileSync(path.join(dir, files[0]), 'utf8'));
    expect(saved.question).toBe('Plan ok?');
    expect(saved.files).toEqual(['a.md']);
    expect(saved.result.dissenting[0].peerId).toBe('grok');
  });

  it('--json prints the raw result only', async () => {
    const d = deps();
    await runCouncilCommand(['Frage', '--json'], d.deps);
    expect(d.lines).toHaveLength(1);
    expect(JSON.parse(d.lines[0]).agreed).toEqual(['codex']);
  });

  it('exits 2 when no council is possible', async () => {
    const d = deps({ peersFor: () => ({ possible: false, peers: [], reason: 'only one engine installed' }) });
    expect(await runCouncilCommand(['Frage'], d.deps)).toBe(2);
    expect(d.lines.join('\n')).toMatch(/only one engine/);
  });

  it('exits 1 without a question', async () => {
    const d = deps();
    expect(await runCouncilCommand([], d.deps)).toBe(1);
  });
});
