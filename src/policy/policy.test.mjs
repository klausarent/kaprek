// Tests for the policy engine. Run: npx vitest run src/policy/policy.test.mjs
import { test, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openBoard } from '../board/store.mjs';
import { loadPolicy, loadPolicyFailOpen, policyVersion, evaluateStop, DEFAULT_POLICY, PolicyValidationError } from './policy.mjs';

let dataDir;

beforeEach(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kaprek-policy-test-'));
});

afterEach(() => {
  fs.rmSync(dataDir, { recursive: true, force: true });
});

function writePolicy(policy) {
  fs.writeFileSync(path.join(dataDir, 'policy.json'), JSON.stringify(policy), 'utf8');
}

/** Writes a minimal transcript JSONL with one line, optionally containing a Bash "git commit" tool_use block. */
function writeTranscript(sessionId, { withGitCommit = false } = {}) {
  const transcriptPath = path.join(dataDir, `${sessionId}.jsonl`);
  const lines = [];
  lines.push(JSON.stringify({ type: 'user', message: { role: 'user', content: 'hi' }, sessionId }));
  if (withGitCommit) {
    lines.push(
      JSON.stringify({
        type: 'assistant',
        sessionId,
        message: {
          role: 'assistant',
          content: [{ type: 'tool_use', name: 'Bash', input: { command: 'git commit -m "wip"' } }],
        },
      }),
    );
  } else {
    lines.push(
      JSON.stringify({
        type: 'assistant',
        sessionId,
        message: { role: 'assistant', content: [{ type: 'tool_use', name: 'Bash', input: { command: 'ls' } }] },
      }),
    );
  }
  fs.writeFileSync(transcriptPath, `${lines.join('\n')}\n`, 'utf8');
  return transcriptPath;
}

// ---------------------------------------------------------------- loadPolicy

test('loadPolicy returns DEFAULT_POLICY when policy.json does not exist', () => {
  expect(loadPolicy(dataDir)).toEqual(DEFAULT_POLICY);
});

test('loadPolicy returns the parsed policy for a well-formed file', () => {
  writePolicy({ version: 1, mode: 'block', rules: { requireTaskDoc: false, requireCommitTask: true } });
  expect(loadPolicy(dataDir)).toEqual({
    version: 1,
    mode: 'block',
    rules: { requireTaskDoc: false, requireCommitTask: true },
    posture: 'auto',
    hardDenials: [],
  });
});

test('loadPolicy fills in missing fields with DEFAULT_POLICY values', () => {
  writePolicy({ mode: 'warn' });
  expect(loadPolicy(dataDir)).toEqual({
    version: 1,
    mode: 'warn',
    rules: DEFAULT_POLICY.rules,
    posture: 'auto',
    hardDenials: [],
  });
});

test('loadPolicy strips a leading BOM before parsing', () => {
  const bom = '﻿';
  fs.writeFileSync(path.join(dataDir, 'policy.json'), `${bom}${JSON.stringify({ mode: 'warn' })}`, 'utf8');
  expect(loadPolicy(dataDir)).toEqual({ version: 1, mode: 'warn', rules: DEFAULT_POLICY.rules, posture: 'auto', hardDenials: [] });
});

test('loadPolicy falls back to observe (with a reason) for corrupt JSON, without throwing', () => {
  fs.writeFileSync(path.join(dataDir, 'policy.json'), '{ not valid json', 'utf8');
  const policy = loadPolicy(dataDir);
  expect(policy.mode).toBe('observe');
  expect(policy.rules).toEqual(DEFAULT_POLICY.rules);
  expect(typeof policy.reason).toBe('string');
  expect(policy.reason.length).toBeGreaterThan(0);
});

test('loadPolicy throws PolicyValidationError for an unknown top-level field', () => {
  writePolicy({ mode: 'warn', bogus: true });
  expect(() => loadPolicy(dataDir)).toThrow(PolicyValidationError);
});

test('loadPolicy throws PolicyValidationError for an unknown rules field', () => {
  writePolicy({ rules: { requireTaskDoc: true, bogus: true } });
  expect(() => loadPolicy(dataDir)).toThrow(PolicyValidationError);
});

test('loadPolicy throws PolicyValidationError for an invalid mode value', () => {
  writePolicy({ mode: 'destroy' });
  expect(() => loadPolicy(dataDir)).toThrow(PolicyValidationError);
});

test('loadPolicy throws PolicyValidationError for a non-boolean rule value', () => {
  writePolicy({ rules: { requireTaskDoc: 'yes' } });
  expect(() => loadPolicy(dataDir)).toThrow(PolicyValidationError);
});

// -------------------------------------------------------------- evaluateStop

test('observe mode always allows, but still fully evaluates and surfaces violations in reasons + policy.log', async () => {
  writePolicy({ mode: 'observe' });
  const transcriptPath = writeTranscript('s-observe', { withGitCommit: true });
  const result = await evaluateStop({ dataDir, transcriptPath, sessionId: 's-observe' });
  expect(result.decision).toBe('allow');
  expect(result.reasons.length).toBeGreaterThan(0);
  expect(result.reasons[0]).toMatch(/git commit/);

  const logPath = path.join(dataDir, 'policy.log');
  const lines = fs.readFileSync(logPath, 'utf8').trim().split('\n');
  const entry = JSON.parse(lines[lines.length - 1]);
  expect(entry.sessionId).toBe('s-observe');
  expect(entry.decision).toBe('allow');
  expect(entry.mode).toBe('observe');
  expect(entry.reasons.length).toBeGreaterThan(0);
});

test('observe mode allows and logs no violations when nothing is actually wrong', async () => {
  writePolicy({ mode: 'observe' });
  const transcriptPath = writeTranscript('s-observe-clean', { withGitCommit: false });
  const result = await evaluateStop({ dataDir, transcriptPath, sessionId: 's-observe-clean' });
  expect(result).toEqual({ decision: 'allow', reasons: [] });
});

test('block mode blocks when a commit was made but no task is linked to the session', async () => {
  writePolicy({ mode: 'block' });
  const transcriptPath = writeTranscript('s-block', { withGitCommit: true });
  const result = await evaluateStop({ dataDir, transcriptPath, sessionId: 's-block' });
  expect(result.decision).toBe('block');
  expect(result.reasons.length).toBeGreaterThan(0);
  expect(result.reasons[0]).toMatch(/git commit/);
});

test('warn mode warns (does not block) under the same condition', async () => {
  writePolicy({ mode: 'warn' });
  const transcriptPath = writeTranscript('s-warn', { withGitCommit: true });
  const result = await evaluateStop({ dataDir, transcriptPath, sessionId: 's-warn' });
  expect(result.decision).toBe('warn');
  expect(result.reasons.length).toBeGreaterThan(0);
});

test('block mode allows when the commit session is linked to a board task', async () => {
  writePolicy({ mode: 'block' });
  const board = openBoard(dataDir);
  const task = board.create({ title: 'Do the thing' });
  board.linkSession(task.id, { machine: 'm1', projectSlug: 'proj', sessionId: 's-linked' });

  const transcriptPath = writeTranscript('s-linked', { withGitCommit: true });
  const result = await evaluateStop({ dataDir, transcriptPath, sessionId: 's-linked' });
  expect(result).toEqual({ decision: 'allow', reasons: [] });
});

test('block mode allows when there is no commit in the transcript', async () => {
  writePolicy({ mode: 'block' });
  const transcriptPath = writeTranscript('s-nocommit', { withGitCommit: false });
  const result = await evaluateStop({ dataDir, transcriptPath, sessionId: 's-nocommit' });
  expect(result).toEqual({ decision: 'allow', reasons: [] });
});

test('commit detection is scoped to a Bash tool_use, not any tool input mentioning "git commit"', async () => {
  writePolicy({ mode: 'block' });
  const transcriptPath = path.join(dataDir, 's-non-bash.jsonl');
  fs.writeFileSync(
    transcriptPath,
    `${JSON.stringify({
      type: 'assistant',
      sessionId: 's-non-bash',
      message: {
        role: 'assistant',
        content: [{ type: 'tool_use', name: 'Read', input: { file_path: 'docs/how-to-git-commit.md' } }],
      },
    })}\n`,
    'utf8',
  );
  const result = await evaluateStop({ dataDir, transcriptPath, sessionId: 's-non-bash' });
  expect(result).toEqual({ decision: 'allow', reasons: [] });
});

test('a missing/corrupt transcript path fails open to allow', async () => {
  writePolicy({ mode: 'block' });
  const result = await evaluateStop({
    dataDir,
    transcriptPath: path.join(dataDir, 'does-not-exist.jsonl'),
    sessionId: 's-missing',
  });
  expect(result).toEqual({ decision: 'allow', reasons: [] });
});

test('requireCommitTask: false disables the commit check even with no linked task', async () => {
  writePolicy({ mode: 'block', rules: { requireCommitTask: false, requireTaskDoc: true } });
  const transcriptPath = writeTranscript('s-disabled', { withGitCommit: true });
  const result = await evaluateStop({ dataDir, transcriptPath, sessionId: 's-disabled' });
  expect(result).toEqual({ decision: 'allow', reasons: [] });
});

test('requireTaskDoc warns (never blocks) when the linked in_progress task has an empty doc', async () => {
  writePolicy({ mode: 'block' });
  const board = openBoard(dataDir);
  const task = board.create({ title: 'Do the thing' });
  board.linkSession(task.id, { machine: 'm1', projectSlug: 'proj', sessionId: 's-doc' });
  board.setStatus(task.id, 'in_progress');

  const transcriptPath = writeTranscript('s-doc', { withGitCommit: false });
  const result = await evaluateStop({ dataDir, transcriptPath, sessionId: 's-doc' });
  expect(result.decision).toBe('warn');
  expect(result.reasons[0]).toMatch(/completion doc/);
});

test('once-marker: a second Stop event for the same session after a block resolves to allow', async () => {
  writePolicy({ mode: 'block' });
  const transcriptPath = writeTranscript('s-once', { withGitCommit: true });

  const first = await evaluateStop({ dataDir, transcriptPath, sessionId: 's-once' });
  expect(first.decision).toBe('block');

  const second = await evaluateStop({ dataDir, transcriptPath, sessionId: 's-once' });
  expect(second).toEqual({ decision: 'allow', reasons: [] });
});

test('once-marker is per-session: a different session in the same dataDir still blocks', async () => {
  writePolicy({ mode: 'block' });
  const t1 = writeTranscript('s-a', { withGitCommit: true });
  const t2 = writeTranscript('s-b', { withGitCommit: true });

  const first = await evaluateStop({ dataDir, transcriptPath: t1, sessionId: 's-a' });
  expect(first.decision).toBe('block');

  const other = await evaluateStop({ dataDir, transcriptPath: t2, sessionId: 's-b' });
  expect(other.decision).toBe('block');
});

test('evaluateStop never throws, even with a corrupt policy.json (schema error inside)', async () => {
  // P0.5: the fail-open loader degrades FAIL-CLOSED for a readable policy it
  // does not understand — posture drops to 'ask', but the valid mode dial
  // ('block') is kept, so the violation is still enforced, not silenced.
  writePolicy({ mode: 'block', bogus: true });
  const transcriptPath = writeTranscript('s-badpolicy', { withGitCommit: true });
  const result = await evaluateStop({ dataDir, transcriptPath, sessionId: 's-badpolicy' });
  expect(result.decision).toBe('block');
  expect(result.reasons.length).toBeGreaterThan(0);
});

test('evaluateStop writes a JSONL entry to policy.log', async () => {
  writePolicy({ mode: 'block' });
  const transcriptPath = writeTranscript('s-log', { withGitCommit: true });
  await evaluateStop({ dataDir, transcriptPath, sessionId: 's-log' });

  const logPath = path.join(dataDir, 'policy.log');
  expect(fs.existsSync(logPath)).toBe(true);
  const lines = fs.readFileSync(logPath, 'utf8').trim().split('\n');
  const entry = JSON.parse(lines[lines.length - 1]);
  expect(entry.sessionId).toBe('s-log');
  expect(entry.decision).toBe('block');
  expect(Array.isArray(entry.reasons)).toBe(true);
  expect(typeof entry.ts).toBe('string');
});

// -------------------------------------------------------- posture + hard denials

test('loadPolicy defaults posture to auto and hardDenials to none, and reads both when set', () => {
  expect(loadPolicy(dataDir)).toMatchObject({ posture: 'auto', hardDenials: [] });
  writePolicy({ posture: 'edits', hardDenials: [{ id: 'no-prod', tools: ['Bash'], command: 'prod' }] });
  const policy = loadPolicy(dataDir);
  expect(policy.posture).toBe('edits');
  expect(policy.hardDenials).toEqual([{ id: 'no-prod', why: 'denied by policy.json', tools: ['Bash'], command: 'prod' }]);
});

test('loadPolicy refuses an unknown posture and a malformed hard denial, as schema errors', () => {
  writePolicy({ posture: 'yolo' });
  expect(() => loadPolicy(dataDir)).toThrow(PolicyValidationError);
  writePolicy({ hardDenials: [{ id: 'x', tools: ['Bash'] }] });
  expect(() => loadPolicy(dataDir)).toThrow(PolicyValidationError);
  writePolicy({ hardDenials: 'nope' });
  expect(() => loadPolicy(dataDir)).toThrow(PolicyValidationError);
});

test('policyVersion is stable for the same policy and changes with a posture or a denial', () => {
  const base = policyVersion(loadPolicy(dataDir));
  expect(base).toMatch(/^[0-9a-f]{16}$/);
  expect(policyVersion(loadPolicy(dataDir))).toBe(base);
  writePolicy({ posture: 'ask' });
  const withPosture = policyVersion(loadPolicy(dataDir));
  expect(withPosture).not.toBe(base);
  writePolicy({ posture: 'ask', hardDenials: [{ id: 'x', tools: ['Bash'], command: 'y' }] });
  expect(policyVersion(loadPolicy(dataDir))).not.toBe(withPosture);
});

// ------------------------------------------------ P0.5: fail-closed loader

test('loadPolicyFailOpen: an unknown field loads fail-closed to posture ask, never auto', () => {
  writePolicy({ version: 1, mode: 'block', posture: 'auto', hardDenials: [{ id: 'no-prod', tools: ['Bash'], command: 'prod' }], futureField: true });
  const policy = loadPolicyFailOpen(dataDir);
  // The ceiling drops — a field from a newer kaprek must not silently lift
  // the ceiling or strip the denials.
  expect(policy.posture).toBe('ask');
  expect(policy.posture).not.toBe('auto');
  // Hard denials "soweit erkennbar": the denial itself still validates, so
  // it survives the fail-closed load.
  expect(policy.hardDenials).toEqual([{ id: 'no-prod', why: 'denied by policy.json', tools: ['Bash'], command: 'prod' }]);
  // The reason is carried and names the schema problem.
  expect(policy.reason).toContain('futureField');
});

test('loadPolicyFailOpen: a malformed hard denial degrades to none, a valid one next to it is kept', () => {
  writePolicy({ posture: 'edits', hardDenials: [{ id: 'good', tools: ['Bash'], command: 'prod' }, { id: 'bad', tools: 'nope' }], newDenialKind: [] });
  const policy = loadPolicyFailOpen(dataDir);
  expect(policy.posture).toBe('ask');
  expect(policy.hardDenials).toEqual([{ id: 'good', why: 'denied by policy.json', tools: ['Bash'], command: 'prod' }]);
});

test('loadPolicyFailOpen: an unknown version loads fail-closed to posture ask and logs the reason to policy.log', () => {
  writePolicy({ version: 2, mode: 'block' });
  const policy = loadPolicyFailOpen(dataDir);
  expect(policy.posture).toBe('ask');
  expect(policy.posture).not.toBe('auto');
  expect(policy.hardDenials).toEqual([]);
  expect(policy.reason).toContain('version');
  // The ground is on the record: policy.log names the fail-closed fallback.
  const logPath = path.join(dataDir, 'policy.log');
  const entry = JSON.parse(fs.readFileSync(logPath, 'utf8').trim().split('\n').pop());
  expect(entry.event).toBe('policy-load');
  expect(entry.outcome).toBe('fail-closed');
  expect(entry.reason).toContain('schema');
});

test('loadPolicyFailOpen: a missing policy file keeps the old fail-open DEFAULT behavior (posture auto)', () => {
  const policy = loadPolicyFailOpen(dataDir);
  expect(policy).toEqual(DEFAULT_POLICY);
  expect(fs.existsSync(path.join(dataDir, 'policy.log'))).toBe(false);
});

test('loadPolicyFailOpen: an empty policy file is DEFAULT (fail-open), not fail-closed', () => {
  fs.writeFileSync(path.join(dataDir, 'policy.json'), '{}', 'utf8');
  const policy = loadPolicyFailOpen(dataDir);
  expect(policy.posture).toBe('auto');
  expect(policy.mode).toBe('observe');
});

test('loadPolicyFailOpen: a valid policy is loaded unchanged, no fail-closed marking', () => {
  writePolicy({ version: 1, mode: 'warn', posture: 'edits', hardDenials: [{ id: 'x', tools: ['Bash'], command: 'y' }] });
  const policy = loadPolicyFailOpen(dataDir);
  expect(policy).toEqual(loadPolicy(dataDir));
  expect(policy.posture).toBe('edits');
  expect(policy).not.toHaveProperty('reason');
});

test('loadPolicy still throws PolicyValidationError for an unsupported version (the throw survives, P0.5)', () => {
  writePolicy({ version: 2 });
  expect(() => loadPolicy(dataDir)).toThrow(PolicyValidationError);
});

test('loadPolicyFailOpen keeps the built-in guards reachable even when policy.json is broken', () => {
  writePolicy({ posture: 'yolo' });
  const policy = loadPolicyFailOpen(dataDir);
  // P0.5: fail-CLOSED now — the ceiling drops to 'ask' instead of opening.
  expect(policy.posture).toBe('ask');
  expect(policy.reason).toContain("posture 'ask'");
  // Corrupt JSON stays on the old fail-open path (an unreadable file says
  // nothing, so there is nothing newer to defer to).
  fs.writeFileSync(path.join(dataDir, 'policy.json'), '{ not json', 'utf8');
  expect(loadPolicyFailOpen(dataDir).posture).toBe('auto');
});
