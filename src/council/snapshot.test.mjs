import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { snapshotFiles, refusalReason, SNAPSHOT_LIMITS } from './snapshot.mjs';

let root;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'kaprek-snap-test-'));
});
afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

const write = (rel, content) => {
  const full = path.join(root, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content, 'utf8');
  return full;
};

describe('refusalReason', () => {
  test.each(['.env', '.env.production', 'id_rsa', 'id_ed25519.pub', 'server.pem', 'signing.key', 'store.p12', 'terraform.tfstate', '.npmrc', '.git-credentials'])(
    '%s is refused by name alone',
    (name) => {
      expect(refusalReason(path.join('C:', 'anywhere', name))).toBeTruthy();
    },
  );

  test('ordinary source files pass', () => {
    expect(refusalReason('src/council/consult.mjs')).toBeNull();
    // "envelope.mjs" starts with env but is not a .env
    expect(refusalReason('src/envelope.mjs')).toBeNull();
  });
});

describe('snapshotFiles', () => {
  test('reads a file inside a root and returns its content', () => {
    write('plan.md', '# The plan\n- [ ] step one\n');
    const { snapshots, refused } = snapshotFiles(['plan.md'], { cwd: root, roots: [root] });
    expect(refused).toEqual([]);
    expect(snapshots).toHaveLength(1);
    expect(snapshots[0].content).toContain('step one');
    expect(snapshots[0].truncated).toBe(false);
  });

  test('a .env inside an allowed root is still refused — the deny list beats containment', () => {
    write('.env', 'ANTHROPIC_API_KEY=sk-ant-api03-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n');
    const { snapshots, refused } = snapshotFiles(['.env'], { cwd: root, roots: [root] });
    expect(snapshots).toEqual([]);
    expect(refused).toHaveLength(1);
    expect(refused[0].reason).toContain('credentials');
  });

  test('a path outside every root is refused, and the refusal names the rule', () => {
    const outside = path.join(os.tmpdir(), `kaprek-snap-outside-${process.pid}.txt`);
    fs.writeFileSync(outside, 'not yours', 'utf8');
    try {
      const { snapshots, refused } = snapshotFiles([outside], { cwd: root, roots: [root] });
      expect(snapshots).toEqual([]);
      expect(refused[0].reason).toContain('outside');
    } finally {
      fs.rmSync(outside, { force: true });
    }
  });

  test('no roots means nothing is readable — fail closed, not open', () => {
    write('a.txt', 'hello');
    const { snapshots, refused } = snapshotFiles(['a.txt'], { cwd: root, roots: [] });
    expect(snapshots).toEqual([]);
    expect(refused).toHaveLength(1);
  });

  test('secrets in file content are redacted before they reach the package', () => {
    write('notes.md', 'the key is sk-ant-api03-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa and it works');
    const { snapshots } = snapshotFiles(['notes.md'], { cwd: root, roots: [root] });
    expect(snapshots[0].content).not.toContain('sk-ant-api03-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
    expect(snapshots[0].content).toContain('[REDACTED]');
  });

  test('a file above maxFileBytes is truncated and says so', () => {
    write('big.txt', 'x'.repeat(SNAPSHOT_LIMITS.maxFileBytes + 100));
    const { snapshots } = snapshotFiles(['big.txt'], { cwd: root, roots: [root] });
    expect(snapshots[0].truncated).toBe(true);
    expect(Buffer.byteLength(snapshots[0].content, 'utf8')).toBeLessThanOrEqual(SNAPSHOT_LIMITS.maxFileBytes);
  });

  test('files past the total budget are refused, earlier ones survive', () => {
    write('a.txt', 'a'.repeat(100));
    write('b.txt', 'b'.repeat(100));
    const limits = { maxFiles: 12, maxFileBytes: 48 * 1024, maxTotalBytes: 150 };
    const { snapshots, refused } = snapshotFiles(['a.txt', 'b.txt'], { cwd: root, roots: [root], limits });
    expect(snapshots.map((s) => s.path)).toEqual(['a.txt']);
    expect(refused[0].path).toBe('b.txt');
    expect(refused[0].reason).toContain('budget');
  });

  test('binary files are refused', () => {
    const full = path.join(root, 'blob.bin');
    fs.writeFileSync(full, Buffer.from([0x89, 0x50, 0x00, 0x47]));
    const { snapshots, refused } = snapshotFiles(['blob.bin'], { cwd: root, roots: [root] });
    expect(snapshots).toEqual([]);
    expect(refused[0].reason).toContain('binary');
  });

  test('a directory is refused as not a regular file', () => {
    fs.mkdirSync(path.join(root, 'src'));
    const { refused } = snapshotFiles(['src'], { cwd: root, roots: [root] });
    expect(refused[0].reason).toContain('not a regular file');
  });

  test('a missing file is reported, not thrown', () => {
    const { snapshots, refused } = snapshotFiles(['gone.md'], { cwd: root, roots: [root] });
    expect(snapshots).toEqual([]);
    expect(refused[0].reason).toContain('could not be read');
  });

  test('more files than maxFiles: the rest are refused with the ceiling named', () => {
    const limits = { maxFiles: 2, maxFileBytes: 48 * 1024, maxTotalBytes: 192 * 1024 };
    for (const name of ['a.txt', 'b.txt', 'c.txt']) write(name, name);
    const { snapshots, refused } = snapshotFiles(['a.txt', 'b.txt', 'c.txt'], { cwd: root, roots: [root], limits });
    expect(snapshots).toHaveLength(2);
    expect(refused[0].path).toBe('c.txt');
  });
});
