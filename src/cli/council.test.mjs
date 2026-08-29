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

  it('fails closed with exit 1 when a peer call rejects, and writes no result file', async () => {
    const d = deps({ consultPeers: async () => { throw new Error('peer timeout'); } });
    const code = await runCouncilCommand(['Frage'], d.deps);
    expect(code).toBe(1);
    expect(d.lines.join('\n')).toMatch(/ERR council failed: peer timeout/);
    const dir = path.join(d.dataDir, 'council', 'cli');
    expect(fs.existsSync(dir)).toBe(false);
  });

  it('exits 1 when --cwd is given without a value', async () => {
    const d = deps();
    expect(await runCouncilCommand(['Frage', '--cwd'], d.deps)).toBe(1);
  });
});

describe('kaprek council --diff', () => {
  function fakeExec({
    stat = ' 1 file changed, 2 insertions(+)\n',
    diff = 'diff --git a/f.mjs b/f.mjs\n@@ -1 +1 @@\n-a\n+b',
    untracked = '',
    fail = false,
  } = {}) {
    return (args) => {
      if (fail) throw new Error('fatal: not a git repository');
      if (args[0] === 'diff' && args.includes('--stat')) return stat;
      if (args[0] === 'diff') return diff;
      if (args[0] === 'ls-files') return untracked;
      throw new Error(`unexpected git args: ${args.join(' ')}`);
    };
  }

  it('adds the diff as one more snapshot named git-diff.patch', async () => {
    let captured;
    const d = deps({
      exec: fakeExec(),
      consultPeers: async ({ snapshots }) => {
        captured = snapshots;
        return { consensus: true, empty: false, agreed: ['codex'], dissenting: [], unreachable: [] };
      },
    });
    const code = await runCouncilCommand(['Plan ok?', '--diff'], d.deps);
    expect(code).toBe(0);
    expect(captured).toHaveLength(1);
    expect(captured[0].path).toBe('git-diff.patch');
  });

  it('redacts a secrets-file hunk in the diff before it reaches the peers', async () => {
    const secretDiff = 'diff --git a/.env b/.env\n@@ -1 +1 @@\n-A=1\n+A=2\ndiff --git a/ok.mjs b/ok.mjs\n@@ -1 +1 @@\n-x\n+y';
    let captured;
    const d = deps({
      exec: fakeExec({ diff: secretDiff }),
      consultPeers: async ({ snapshots }) => {
        captured = snapshots;
        return { consensus: true, empty: false, agreed: ['codex'], dissenting: [], unreachable: [] };
      },
    });
    await runCouncilCommand(['Plan ok?', '--diff'], d.deps);
    const diffSnapshot = captured.find((s) => s.path === 'git-diff.patch');
    expect(diffSnapshot.content).toMatch(/\[redacted: \.env\]/);
    expect(diffSnapshot.content).not.toContain('A=1');
    expect(diffSnapshot.content).toContain('ok.mjs');
  });

  it('caps the diff snapshot at 200,000 characters and notes the cut', async () => {
    const bigDiff = `diff --git a/big.mjs b/big.mjs\n@@ -1 +1 @@\n${'+x'.repeat(150000)}`;
    let captured;
    const d = deps({
      exec: fakeExec({ diff: bigDiff }),
      consultPeers: async ({ snapshots }) => {
        captured = snapshots;
        return { consensus: true, empty: false, agreed: ['codex'], dissenting: [], unreachable: [] };
      },
    });
    await runCouncilCommand(['Plan ok?', '--diff'], d.deps);
    const diffSnapshot = captured.find((s) => s.path === 'git-diff.patch');
    expect(diffSnapshot.truncated).toBe(true);
    expect(diffSnapshot.content.length).toBeLessThan(bigDiff.length);
    expect(diffSnapshot.content).toMatch(/truncated/);
  });

  it('exits 1 with a message when there is no git repository', async () => {
    const d = deps({ exec: fakeExec({ fail: true }) });
    const code = await runCouncilCommand(['Plan ok?', '--diff'], d.deps);
    expect(code).toBe(1);
    expect(d.lines.join('\n')).toMatch(/no git repository/);
  });

  it('exits 1 with a message when there is nothing to diff', async () => {
    const d = deps({ exec: fakeExec({ stat: '', diff: '', untracked: '' }) });
    const code = await runCouncilCommand(['Plan ok?', '--diff'], d.deps);
    expect(code).toBe(1);
    expect(d.lines.join('\n')).toMatch(/no changes to diff/);
  });

  it('passes an explicit ref given after --diff to git', async () => {
    const seen = [];
    const d = deps({
      exec: (args) => {
        seen.push(args);
        return fakeExec()(args);
      },
    });
    await runCouncilCommand(['Plan ok?', '--diff', 'main'], d.deps);
    // ls-files carries no ref (untracked files aren't tied to one) — only
    // the two `diff` calls do.
    expect(seen).toEqual([
      ['diff', '--stat', 'main'],
      ['diff', 'main'],
      ['ls-files', '--others', '--exclude-standard'],
    ]);
  });

  it('does not swallow a following flag as the ref', async () => {
    const d = deps({ exec: fakeExec() });
    const code = await runCouncilCommand(['Plan ok?', '--diff', '--json'], d.deps);
    expect(code).toBe(0);
    expect(JSON.parse(d.lines[0]).agreed).toEqual(['codex']);
  });

  it('combines --diff and --file into one snapshot list', async () => {
    let captured;
    const d = deps({
      exec: fakeExec(),
      consultPeers: async ({ snapshots }) => {
        captured = snapshots;
        return { consensus: true, empty: false, agreed: ['codex'], dissenting: [], unreachable: [] };
      },
    });
    await runCouncilCommand(['Plan ok?', '--file', 'a.md', '--diff'], d.deps);
    expect(captured).toHaveLength(2);
    expect(captured.some((s) => s.path === 'git-diff.patch')).toBe(true);
  });
});
