import { expect, test } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { openPlans, PLAN_STATUSES, PlanNotFoundError, PlanFileMissingError, InvalidPlanPathError, InvalidStatusError, PlanOutsideRootError, PlanNotConvergedError } from './store.mjs';

function tmpDataDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'kaprek-plans-'));
}

const PLAN_MD = ['# Newsletter generator', '', '- [ ] First step', '- [ ] Second step', ''].join('\n');

function writePlanFile(dir, name = 'plan.md', content = PLAN_MD) {
  const file = path.join(dir, name);
  fs.writeFileSync(file, content, 'utf8');
  return file;
}

test('registering a plan keeps its absolute path and reads its title from the file', () => {
  const dataDir = tmpDataDir();
  const file = writePlanFile(dataDir);
  const store = openPlans(dataDir);

  const plan = store.register({ path: file, chatId: 'chat-1' });
  expect(plan.path).toBe(path.resolve(file));
  expect(path.isAbsolute(plan.path)).toBe(true);
  expect(plan.title).toBe('Newsletter generator');
  expect(plan.kind).toBe('plan');
  expect(plan.status).toBe('draft');
  expect(plan.chatId).toBe('chat-1');
});

test('registering the same file twice returns the same plan instead of a duplicate', () => {
  const dataDir = tmpDataDir();
  const file = writePlanFile(dataDir);
  const store = openPlans(dataDir);

  const first = store.register({ path: file });
  const again = store.register({ path: file, title: 'Different title' });
  expect(again.id).toBe(first.id);
  expect(store.list()).toHaveLength(1);
});

test('a relative path or a file that is not there is refused', () => {
  const dataDir = tmpDataDir();
  const store = openPlans(dataDir);
  expect(() => store.register({ path: 'plan.md' })).toThrow(InvalidPlanPathError);
  expect(() => store.register({ path: path.join(dataDir, 'nope.md') })).toThrow(PlanFileMissingError);
});

test('the log survives a reopen, corrupt lines and all', () => {
  const dataDir = tmpDataDir();
  const file = writePlanFile(dataDir);
  const created = openPlans(dataDir).register({ path: file, missionId: 'm-1' });

  fs.appendFileSync(path.join(dataDir, 'plans', 'events.jsonl'), 'not json at all\n', 'utf8');
  fs.appendFileSync(path.join(dataDir, 'plans', 'events.jsonl'), `${JSON.stringify({ type: 'plan.fromTheFuture', planId: created.id, data: {} })}\n`, 'utf8');

  const reopened = openPlans(dataDir);
  expect(reopened.list()).toHaveLength(1);
  expect(reopened.get(created.id).missionId).toBe('m-1');
});

test('plans can be filtered by what they belong to', () => {
  const dataDir = tmpDataDir();
  const store = openPlans(dataDir);
  store.register({ path: writePlanFile(dataDir, 'a.md'), missionId: 'm-1' });
  store.register({ path: writePlanFile(dataDir, 'b.md'), missionId: 'm-2' });
  store.register({ path: writePlanFile(dataDir, 'c.md'), chatId: 'chat-9' });

  expect(store.list({ missionId: 'm-1' })).toHaveLength(1);
  expect(store.list({ chatId: 'chat-9' })).toHaveLength(1);
  expect(store.list()).toHaveLength(3);
});

test('status moves through the known values only', () => {
  const dataDir = tmpDataDir();
  const store = openPlans(dataDir);
  const plan = store.register({ path: writePlanFile(dataDir) });
  for (const status of PLAN_STATUSES) {
    // 'done' is gated (see the convergence tests below); here it passes with an override on record.
    expect(store.setStatus(plan.id, status, status === 'done' ? { override: { by: 'test' } } : {}).status).toBe(status);
  }
  expect(() => store.setStatus(plan.id, 'nearly')).toThrow(InvalidStatusError);
  expect(() => store.setStatus('no-such-plan', 'done')).toThrow(PlanNotFoundError);
});

test('reading a plan returns its content and its steps', () => {
  const dataDir = tmpDataDir();
  const store = openPlans(dataDir);
  const plan = store.register({ path: writePlanFile(dataDir) });

  const read = store.read(plan.id);
  expect(read.content).toBe(PLAN_MD);
  expect(read.steps.map((s) => s.text)).toEqual(['First step', 'Second step']);
  expect(read.truncated).toBe(false);
});

test('ticking a step writes the file, so the file stays the truth', () => {
  const dataDir = tmpDataDir();
  const file = writePlanFile(dataDir);
  const store = openPlans(dataDir);
  const plan = store.register({ path: file });

  const after = store.setStep(plan.id, 0, true);
  expect(after.steps[0].done).toBe(true);
  expect(fs.readFileSync(file, 'utf8')).toContain('- [x] First step');
  expect(fs.readFileSync(file, 'utf8')).toContain('- [ ] Second step');
});

test('a plan whose file was deleted says so instead of pretending', () => {
  const dataDir = tmpDataDir();
  const file = writePlanFile(dataDir);
  const store = openPlans(dataDir);
  const plan = store.register({ path: file });
  fs.rmSync(file);

  expect(store.list()[0].exists).toBe(false);
  expect(() => store.read(plan.id)).toThrow(PlanFileMissingError);
});

test('an oversized plan is capped rather than loaded whole, but its steps stay complete', () => {
  const dataDir = tmpDataDir();
  const tail = `${'x'.repeat(1024 * 1024)}\n- [ ] A step past the cap`;
  const file = writePlanFile(dataDir, 'big.md', `# Big\n\n- [ ] An early step\n${tail}`);
  const store = openPlans(dataDir);
  const plan = store.register({ path: file });

  const read = store.read(plan.id);
  expect(read.truncated).toBe(true);
  expect(read.content.length).toBeLessThan(2 * 1024 * 1024);
  // Grok's review: parsing steps out of the TRUNCATED text hides every step
  // past the cap, while setStep still writes against the full file — so the
  // indices would silently disagree. Steps come from the whole document.
  expect(read.steps.map((s) => s.text)).toEqual(['An early step', 'A step past the cap']);
});

test('a plan outside every allowed root is refused, at registration and afterwards', () => {
  const dataDir = tmpDataDir();
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'kaprek-elsewhere-'));
  const stranger = writePlanFile(outside, 'someone-elses.md');
  const store = openPlans(dataDir);

  expect(() => store.register({ path: stranger })).toThrow(PlanOutsideRootError);

  // And a log that already names an outside file (hand-edited, or written by
  // an older build) must not become a write permit either.
  const inside = writePlanFile(dataDir);
  const plan = store.register({ path: inside });
  const events = path.join(dataDir, 'plans', 'events.jsonl');
  fs.appendFileSync(events, `${JSON.stringify({ id: 'x', ts: new Date().toISOString(), type: 'plan.created', planId: 'forged', data: { path: stranger, title: 'Forged', kind: 'plan' } })}\n`, 'utf8');

  const reopened = openPlans(dataDir);
  expect(() => reopened.read('forged')).toThrow(PlanOutsideRootError);
  expect(() => reopened.setStep('forged', 0, true)).toThrow(PlanOutsideRootError);
  expect(reopened.get(plan.id).id).toBe(plan.id);
});

test('a second root can be opened deliberately — that is what a mission cwd is', () => {
  const dataDir = tmpDataDir();
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'kaprek-project-'));
  const file = writePlanFile(project, 'plan.md');
  const store = openPlans(dataDir, { allowedRoots: () => [dataDir, project] });
  expect(store.register({ path: file }).path).toBe(path.resolve(file));
});

test('a directory is not a plan, even though it exists', () => {
  const dataDir = tmpDataDir();
  const dir = path.join(dataDir, 'docs');
  fs.mkdirSync(dir, { recursive: true });
  const store = openPlans(dataDir);
  expect(() => store.register({ path: dir })).toThrow(PlanFileMissingError);
});

test('registering again fills in what the first registration did not know', () => {
  const dataDir = tmpDataDir();
  const file = writePlanFile(dataDir);
  const store = openPlans(dataDir);
  store.register({ path: file, chatId: 'chat-1' });
  const second = store.register({ path: file, missionId: 'm-2' });
  expect(second.chatId).toBe('chat-1');
  expect(second.missionId).toBe('m-2');
});

test('two instances that both registered the same file collapse to one plan on reopen', () => {
  // Grok's review: two kaprek processes on one dataDir each append their own
  // plan.created for the same path. Two entries pointing at one file means
  // two step-writers racing on it.
  const dataDir = tmpDataDir();
  const file = path.resolve(writePlanFile(dataDir));
  const events = path.join(dataDir, 'plans', 'events.jsonl');
  fs.mkdirSync(path.dirname(events), { recursive: true });
  for (const planId of ['from-instance-a', 'from-instance-b']) {
    fs.appendFileSync(events, `${JSON.stringify({ id: planId, ts: new Date().toISOString(), type: 'plan.created', planId, data: { path: file, title: 'Same file', kind: 'plan' } })}\n`, 'utf8');
  }
  const store = openPlans(dataDir);
  expect(store.list()).toHaveLength(1);
  expect(store.list()[0].id).toBe('from-instance-a');
});

// ------------------------------------------------------------- convergence gate

test('done is gated: without a clean convergence check it is refused, with one it goes through', () => {
  const dataDir = tmpDataDir();
  const store = openPlans(dataDir);
  const plan = store.register({ path: writePlanFile(dataDir) });

  expect(() => store.setStatus(plan.id, 'done')).toThrow(PlanNotConvergedError);
  expect(store.get(plan.id).status).toBe('draft');

  // A check that found gaps: the plan is active again, still not done.
  const afterGaps = store.recordConverge(plan.id, { chatId: 'chat-1', findings: 2, converged: false });
  expect(afterGaps.status).toBe('active');
  expect(afterGaps.converge).toMatchObject({ round: 1, chatId: 'chat-1', findings: 2, converged: false });
  expect(() => store.setStatus(plan.id, 'done')).toThrow(/found 2 gap/);

  // A clean check IS the gate being passed: done, round counted, no override on record.
  const clean = store.recordConverge(plan.id, { chatId: 'chat-2', findings: 0, converged: true });
  expect(clean.status).toBe('done');
  expect(clean.converge).toMatchObject({ round: 2, converged: true });
  expect(clean.override).toBeNull();
});

test('a converged claim with findings is not clean, and zero findings without the claim is not clean either', () => {
  const dataDir = tmpDataDir();
  const store = openPlans(dataDir);
  const plan = store.register({ path: writePlanFile(dataDir) });
  expect(store.recordConverge(plan.id, { findings: 1, converged: true }).converge.converged).toBe(false);
  expect(store.recordConverge(plan.id, { findings: 0, converged: false }).converge.converged).toBe(false);
  expect(store.get(plan.id).status).toBe('active');
});

test('an override passes the gate and is on record — and the record clears on the next status change', () => {
  const dataDir = tmpDataDir();
  const store = openPlans(dataDir);
  const plan = store.register({ path: writePlanFile(dataDir) });

  expect(() => store.setStatus(plan.id, 'done', { override: { by: '   ' } })).toThrow(PlanNotConvergedError);
  const done = store.setStatus(plan.id, 'done', { override: { by: 'Klaus' } });
  expect(done.status).toBe('done');
  expect(done.override).toMatchObject({ by: 'Klaus' });
  expect(typeof done.override.at).toBe('string');

  // Replay keeps it.
  expect(openPlans(dataDir).get(plan.id).override.by).toBe('Klaus');

  const reopened = store.setStatus(plan.id, 'active');
  expect(reopened.override).toBeNull();
});

test('other statuses are never gated', () => {
  const dataDir = tmpDataDir();
  const store = openPlans(dataDir);
  const plan = store.register({ path: writePlanFile(dataDir) });
  for (const status of ['active', 'archived', 'draft']) expect(store.setStatus(plan.id, status).status).toBe(status);
});

test('appendFindings adds one unchecked step per finding under its own heading and leaves the text above alone', () => {
  const dataDir = tmpDataDir();
  const store = openPlans(dataDir);
  const file = writePlanFile(dataDir);
  const plan = store.register({ path: file });

  const result = store.appendFindings(
    plan.id,
    [{ id: 'F1', sourceRef: 'Second step', gapType: 'partial', severity: 'high', evidence: 'no test', remainingWork: 'write the test' }],
    { round: 1, ts: '2026-08-27T09:00:00.000Z' },
  );
  const onDisk = fs.readFileSync(file, 'utf8');
  expect(onDisk.startsWith(PLAN_MD)).toBe(true);
  expect(onDisk).toContain('## Convergence round 1 (2026-08-27)');
  expect(result.steps).toHaveLength(3);
  expect(result.steps[2]).toMatchObject({ done: false, text: '**F1 (high, partial, Second step):** write the test — no test' });
  // The new step is a real step: ticking it works like any other.
  expect(store.setStep(plan.id, 2, true).steps[2].done).toBe(true);
});

test('appendFindings refuses a plan whose file is gone, like every other write', () => {
  const dataDir = tmpDataDir();
  const store = openPlans(dataDir);
  const file = writePlanFile(dataDir);
  const plan = store.register({ path: file });
  fs.rmSync(file);
  expect(() => store.appendFindings(plan.id, [{ id: 'F1', severity: 'low', gapType: 'missing', sourceRef: '', evidence: '', remainingWork: 'x' }])).toThrow(PlanFileMissingError);
});

// ------------------------------------------------------ edited outside kaprek

test('a plan remembers the file as kaprek last saw it, and says when it changed outside', () => {
  const dataDir = tmpDataDir();
  const store = openPlans(dataDir);
  const file = writePlanFile(dataDir);
  const plan = store.register({ path: file });
  expect(plan.seenAt).toBeTruthy();
  expect(plan.changedOutside).toBe(false);

  // An edit by hand (or by an agent in a terminal): the next read says so.
  fs.appendFileSync(file, '- [ ] Added by hand\n', 'utf8');
  expect(store.get(plan.id).changedOutside).toBe(true);
  expect(store.list()[0].changedOutside).toBe(true);

  // A tick through kaprek writes the file and brings the view up to date.
  const ticked = store.setStep(plan.id, 0, true);
  expect(ticked.changedOutside).toBe(false);
  expect(store.get(plan.id).seenAt >= plan.seenAt).toBe(true);

  // So does a converge round: it read the file to check it.
  fs.appendFileSync(file, '- [ ] Another one\n', 'utf8');
  expect(store.get(plan.id).changedOutside).toBe(true);
  expect(store.recordConverge(plan.id, { findings: 0, converged: true }).changedOutside).toBe(false);

  // Gone is gone, not "changed".
  fs.rmSync(file);
  expect(store.get(plan.id)).toMatchObject({ exists: false, changedOutside: null });

  // Replay keeps the fingerprint.
  fs.writeFileSync(file, 'something else', 'utf8');
  expect(openPlans(dataDir).get(plan.id).changedOutside).toBe(true);
});
