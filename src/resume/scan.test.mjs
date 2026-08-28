import { describe, it, expect, beforeAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseClaudeFile, projectSlugToPath, markCrashGroups, publicSession, setCacheDir } from './scan.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const fixture = path.join(here, 'fixtures', 'claude', '-C--Users-demo-proj', '11111111-1111-4111-8111-111111111111.jsonl');

beforeAll(() => {
  setCacheDir(fs.mkdtempSync(path.join(os.tmpdir(), 'kaprek-scan-')));
});

describe('resume scanner', () => {
  it('reads first prompt and cwd from a Claude transcript', async () => {
    const meta = await parseClaudeFile(fixture);
    expect(meta.first).toBe('Bitte README kürzen');
    expect(meta.cwd).toBe('C:\\Users\\demo\\proj');
    expect(meta.userMsgs).toBe(1);
  });

  it('turns a project slug back into a path', () => {
    expect(projectSlugToPath('-C--Users-demo-proj')).toMatch(/Users[\\/]demo[\\/]proj$/);
  });

  it('marks sessions that all ended within one crash window', () => {
    const t = (min) => new Date(Date.UTC(2026, 7, 28, 6, min)).toISOString();
    const sessions = [
      { engine: 'claude', id: 'a', lastTs: t(0) },
      { engine: 'claude', id: 'b', lastTs: t(1) },
      { engine: 'codex', id: 'c', lastTs: t(30) },
    ];
    markCrashGroups(sessions, { windowMs: 120_000, minMembers: 2, gapMs: 5 * 60_000 });
    const pub = sessions.map(publicSession);
    expect(pub.filter((s) => s.crash).map((s) => s.id).sort()).toEqual(['a', 'b']);
    expect(pub.find((s) => s.id === 'c').crash).toBe(false);
  });

  it('publicSession exposes one shape and a stable key', () => {
    const s = publicSession({ engine: 'grok', id: 'x1', cwd: 'C:\\p', title: 'Hallo', lastTs: '2026-08-28T06:00:00.000Z' });
    expect(s).toMatchObject({ key: 'grok:x1', engine: 'grok', id: 'x1', cwd: 'C:\\p', title: 'Hallo', userMsgs: 0, hidden: false, crash: false });
    expect(s.firstTs).toBe(s.lastTs);
  });
});
