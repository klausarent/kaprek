import { expect, test } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { openPlans, PLAN_STATUSES, PlanNotFoundError, PlanFileMissingError, InvalidPlanPathError, InvalidStatusError, PlanOutsideRootError } from './store.mjs';

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
    expect(store.setStatus(plan.id, status).status).toBe(status);
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
