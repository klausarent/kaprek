import { describe, test, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { redactSecretHunks, parseDiffStat, buildDiffSnapshot, DIFF_MAX_CHARS } from './diff.mjs';
import { gitExec } from '../lib/git-exec.mjs';

/** A real git repo (temp dir), for the tests that need real `git diff` output rather than a fake exec. */
function initGitRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kaprek-diff-git-'));
  const git = (args) => execFileSync('git', args, { cwd: dir, stdio: 'pipe', encoding: 'utf8' });
  git(['init', '-q']);
  git(['config', 'user.email', 'kaprek-test@example.com']);
  git(['config', 'user.name', 'kaprek test']);
  return { dir, git };
}

describe('redactSecretHunks', () => {
  test('replaces a secrets file hunk with a marker, leaves ordinary hunks intact', () => {
    const diff = [
      'diff --git a/.env b/.env',
      'index 111..222 100644',
      '--- a/.env',
      '+++ b/.env',
      '@@ -1 +1 @@',
      '-A=1',
      '+A=2',
      'diff --git a/ok.mjs b/ok.mjs',
      'index 333..444 100644',
      '--- a/ok.mjs',
      '+++ b/ok.mjs',
      '@@ -1 +1 @@',
      '-x',
      '+y',
    ].join('\n');
    const out = redactSecretHunks(diff);
    expect(out).toContain('[redacted: .env]');
    expect(out).not.toContain('A=1');
    expect(out).not.toContain('A=2');
    expect(out).toContain('diff --git a/ok.mjs b/ok.mjs');
    expect(out).toContain('+y');
  });

  test('judges a rename by its b-side (new) path', () => {
    const diff = ['diff --git a/notes.md b/.env', '@@ -1 +1 @@', '-old', '+SECRET=1'].join('\n');
    expect(redactSecretHunks(diff)).toBe('[redacted: .env]');
  });

  test('passes through text with no diff --git headers unchanged', () => {
    expect(redactSecretHunks('no headers here')).toBe('no headers here');
  });

  test('non-string / empty input is returned unchanged', () => {
    expect(redactSecretHunks('')).toBe('');
    expect(redactSecretHunks(undefined)).toBe(undefined);
  });

  test('does NOT redact a git-quoted (octal-escaped) header — this is exactly why gitExec always disables core.quotePath', () => {
    // What real git emits for a non-ASCII path when core.quotePath is left
    // at its default (true): the whole path in double quotes, each
    // non-ASCII byte as a C-style octal escape (here, \303\234 = UTF-8 for
    // 'Ü'). DIFF_HEADER_RE only matches the plain `diff --git a/... b/...`
    // form, so a hunk in this shape is never attributed to a file at all —
    // this test documents that failure mode rather than fixing it here; the
    // actual fix (src/lib/git-exec.mjs's `-c core.quotePath=false`) makes
    // sure this shape never reaches this function in the first place. See
    // the real-git regression test below for the end-to-end behavior.
    const diff = 'diff --git "a/\\303\\234bersicht/.env" "b/\\303\\234bersicht/.env"\n@@ -1 +1 @@\n-A=before\n+A=SECRET123';
    const out = redactSecretHunks(diff);
    expect(out).toContain('SECRET123');
  });
});

describe('buildDiffSnapshot against a real git repo (non-ASCII paths)', () => {
  test('a secrets file behind a non-ASCII directory is redacted, not leaked, via the real gitExec', () => {
    const { dir, git } = initGitRepo();
    try {
      const secretDir = path.join(dir, 'Übersicht');
      fs.mkdirSync(secretDir);
      const secretFile = path.join(secretDir, '.env');
      fs.writeFileSync(secretFile, 'A=before\n', 'utf8');
      git(['add', '.']);
      git(['commit', '-q', '-m', 'init']);
      fs.writeFileSync(secretFile, 'A=SECRET123\n', 'utf8');

      const result = buildDiffSnapshot({ cwd: dir, exec: gitExec });
      expect(result.error).toBeUndefined();
      expect(result.snapshot.content).not.toContain('SECRET123');
      // git always uses '/' inside diff headers, even on Windows.
      expect(result.snapshot.content).toContain('[redacted: Übersicht/.env]');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('a top-level *.env file with a non-ASCII name is redacted too (refusalReason now matches any .env suffix)', () => {
    const { dir, git } = initGitRepo();
    try {
      const secretFile = path.join(dir, 'Überschrift.env');
      fs.writeFileSync(secretFile, 'A=before\n', 'utf8');
      git(['add', '.']);
      git(['commit', '-q', '-m', 'init']);
      fs.writeFileSync(secretFile, 'A=SECRET123\n', 'utf8');

      const result = buildDiffSnapshot({ cwd: dir, exec: gitExec });
      expect(result.error).toBeUndefined();
      expect(result.snapshot.content).not.toContain('SECRET123');
      expect(result.snapshot.content).toContain('[redacted: Überschrift.env]');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('parseDiffStat', () => {
  test('reads a multi-file summary line', () => {
    const text = ' src/a.mjs | 10 +++++-----\n src/b.mjs |  4 ++--\n 2 files changed, 8 insertions(+), 6 deletions(-)\n';
    expect(parseDiffStat(text)).toEqual({ files: 2, lines: 14 });
  });

  test('reads a singular one-file, one-insertion summary', () => {
    expect(parseDiffStat(' f.txt | 1 +\n 1 file changed, 1 insertion(+)\n')).toEqual({ files: 1, lines: 1 });
  });

  test('reads a deletions-only summary', () => {
    expect(parseDiffStat(' f.txt | 3 ---\n 1 file changed, 3 deletions(-)\n')).toEqual({ files: 1, lines: 3 });
  });

  test('empty output means nothing changed', () => {
    expect(parseDiffStat('')).toEqual({ files: 0, lines: 0 });
    expect(parseDiffStat(undefined)).toEqual({ files: 0, lines: 0 });
  });
});

describe('buildDiffSnapshot', () => {
  function fakeExec({ stat = ' 1 file changed, 2 insertions(+)\n', diff = 'diff --git a/f.mjs b/f.mjs\n@@ -1 +1 @@\n-a\n+b', untracked = '', fail = false } = {}) {
    return (args) => {
      if (fail) throw new Error('fatal: not a git repository');
      if (args[0] === 'diff' && args.includes('--stat')) return stat;
      if (args[0] === 'diff') return diff;
      if (args[0] === 'ls-files') return untracked;
      throw new Error(`unexpected git args: ${args.join(' ')}`);
    };
  }

  test('errors when exec is not a function', () => {
    const result = buildDiffSnapshot({ cwd: 'C:/repo', exec: undefined });
    expect(result.error).toMatch(/git is not available/);
  });

  test('errors when git fails (no repository)', () => {
    const result = buildDiffSnapshot({ cwd: 'C:/repo', exec: fakeExec({ fail: true }) });
    expect(result.error).toMatch(/no git repository/);
  });

  test('errors when there is nothing to diff', () => {
    const result = buildDiffSnapshot({ cwd: 'C:/repo', exec: fakeExec({ stat: '', diff: '', untracked: '' }) });
    expect(result.error).toMatch(/no changes to diff/);
  });

  test('combines stat, diff, and untracked files into one git-diff.patch snapshot', () => {
    const result = buildDiffSnapshot({ cwd: 'C:/repo', exec: fakeExec({ untracked: 'new.txt\n' }) });
    expect(result.error).toBeUndefined();
    expect(result.snapshot.path).toBe('git-diff.patch');
    expect(result.snapshot.content).toContain('git diff --stat HEAD');
    expect(result.snapshot.content).toContain('git diff HEAD');
    expect(result.snapshot.content).toContain('?? new.txt');
    expect(result.stat).toEqual({ files: 2, lines: 2 });
    expect(result.untrackedCount).toBe(1);
  });

  test('an untracked-only change (no tracked diff) still produces a snapshot', () => {
    const result = buildDiffSnapshot({ cwd: 'C:/repo', exec: fakeExec({ stat: '', diff: '', untracked: 'new.txt\n' }) });
    expect(result.error).toBeUndefined();
    expect(result.stat).toEqual({ files: 1, lines: 0 });
    expect(result.snapshot.content).toContain('(no changes)');
  });

  test('uses the given ref instead of HEAD', () => {
    const seen = [];
    const exec = (args) => {
      seen.push(args);
      return fakeExec()(args);
    };
    buildDiffSnapshot({ cwd: 'C:/repo', ref: 'main', exec });
    expect(seen).toEqual([
      ['diff', '--stat', 'main'],
      ['diff', 'main'],
      ['ls-files', '--others', '--exclude-standard'],
    ]);
  });

  test('strips a secrets-file hunk from the diff before it reaches the snapshot', () => {
    const diff = 'diff --git a/.env b/.env\n@@ -1 +1 @@\n-A=1\n+A=2';
    const result = buildDiffSnapshot({ cwd: 'C:/repo', exec: fakeExec({ diff }) });
    expect(result.snapshot.content).toContain('[redacted: .env]');
    expect(result.snapshot.content).not.toContain('A=1');
  });

  test('caps at maxChars and marks the snapshot truncated', () => {
    const diff = `diff --git a/big.mjs b/big.mjs\n@@ -1 +1 @@\n${'+x'.repeat(150000)}`;
    const result = buildDiffSnapshot({ cwd: 'C:/repo', exec: fakeExec({ diff }) });
    expect(result.snapshot.truncated).toBe(true);
    expect(result.snapshot.content.length).toBeLessThan(diff.length);
  });

  test('the default cap is 200,000 characters', () => {
    expect(DIFF_MAX_CHARS).toBe(200_000);
  });
});
