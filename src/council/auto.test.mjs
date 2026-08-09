import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createCouncilRunner, SKIP_REASONS, planQuestion } from './auto.mjs';
import { openConsultations } from './store.mjs';

let dir;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kaprek-auto-'));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

const AGREE = JSON.stringify({ verdict: 'agree', summary: 'sound enough', risks: [] });

/**
 * @param {object} options
 * @param {string} [options.level]
 * @param {(peerId: string) => Promise<string>} [options.answer]
 */
function runner({ level = 'plans', peers = ['codex', 'grok'], answer = async () => AGREE, maxConcurrent = 2 } = {}) {
  const asked = [];
  const store = openConsultations(dir);
  const instance = createCouncilRunner({
    getConsultations: () => store,
    readConfig: () => ({ level, configured: true, assignment: { lead: 'claude-code', thinker: 'codex', worker: 'codex', peer: peers } }),
    availablePeerIds: () => ['claude-code', ...peers],
    makeAskPeer: () => (peerId, prompt, opts) => {
      asked.push({ peerId, prompt, opts });
      return answer(peerId, prompt, opts);
    },
    maxConcurrent,
    timeoutMs: 5000,
  });
  return { runner: instance, store, asked };
}

describe('maybeConsult', () => {
  it('embeds the plan as a snapshot — the peer no longer reads the disk', async () => {
    const planPath = path.join(dir, 'plan.md');
    fs.writeFileSync(planPath, '# The plan\n- [ ] rename the store\n', 'utf8');
    const { runner: r, asked } = runner();
    const started = r.maybeConsult({ chatId: 'c1', moment: 'plan', question: 'sound?', cwd: dir, planPath });
    await r.waitFor(started.consultation.id);
    expect(asked[0].prompt).toContain('rename the store');
    expect(asked[0].prompt).toContain('NO file access');
  });

  it('a .env asked for by name arrives as a refusal, never as content', async () => {
    fs.writeFileSync(path.join(dir, '.env'), 'SOME_TOKEN=super-secret-value-1234567890\n', 'utf8');
    const { runner: r, asked } = runner();
    const started = r.maybeConsult({ chatId: 'c1', moment: 'plan', question: 'sound?', cwd: dir, files: ['.env'] });
    await r.waitFor(started.consultation.id);
    expect(asked[0].prompt).not.toContain('super-secret-value-1234567890');
    expect(asked[0].prompt).toContain('Asked for but not included');
  });

  it('asks every peer and records the verdicts', async () => {
    const { runner: r, store, asked } = runner();
    const started = r.maybeConsult({ chatId: 'c1', moment: 'plan', question: 'is this sound?', cwd: dir });
    expect(started.consultation.status).toBe('running');

    await r.waitFor(started.consultation.id);
    const done = store.get(started.consultation.id);
    expect(done.status).toBe('completed');
    expect(done.result.agreed).toEqual(['codex', 'grok']);
    expect(asked.map((a) => a.peerId).sort()).toEqual(['codex', 'grok']);
  });

  it('stays out of the way at a moment the level does not cover', () => {
    const { runner: r } = runner({ level: 'plans' });
    expect(r.maybeConsult({ chatId: 'c1', moment: 'turn', cwd: dir })).toEqual({ skipped: SKIP_REASONS.level });
  });

  it('never consults at level off', () => {
    const { runner: r } = runner({ level: 'off' });
    expect(r.maybeConsult({ chatId: 'c1', moment: 'plan', cwd: dir }).skipped).toBe(SKIP_REASONS.level);
  });

  it('says there is nobody to ask rather than asking one model about itself', () => {
    const { runner: r } = runner({ peers: [] });
    const result = r.maybeConsult({ chatId: 'c1', moment: 'plan', cwd: dir });
    expect(result.consultation).toBeUndefined();
    expect(result.skipped).toMatch(/one engine|second opinion/i);
  });

  it('runs one consultation per chat at a time', async () => {
    let release;
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    const { runner: r } = runner({ answer: async () => { await gate; return AGREE; } });

    const first = r.maybeConsult({ chatId: 'c1', moment: 'plan', cwd: dir });
    expect(first.consultation).toBeTruthy();
    expect(r.maybeConsult({ chatId: 'c1', moment: 'plan', cwd: dir })).toEqual({ skipped: SKIP_REASONS.inFlight });
    // A different chat is a different conversation and is not blocked by it.
    expect(r.maybeConsult({ chatId: 'c2', moment: 'plan', cwd: dir }).consultation).toBeTruthy();

    release();
    await r.waitFor(first.consultation.id);
  });

  it('refuses to exceed the concurrency ceiling', async () => {
    let release;
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    const { runner: r } = runner({ maxConcurrent: 1, answer: async () => { await gate; return AGREE; } });

    const first = r.maybeConsult({ chatId: 'c1', moment: 'plan', cwd: dir });
    expect(r.maybeConsult({ chatId: 'c2', moment: 'plan', cwd: dir })).toEqual({ skipped: SKIP_REASONS.busy });
    release();
    await r.waitFor(first.consultation.id);
  });

  it('points the peers at the plan file it is about', async () => {
    const planPath = path.join(dir, 'plan.md');
    fs.writeFileSync(planPath, '# Plan\n', 'utf8');
    const { runner: r, store, asked } = runner();

    const started = r.maybeConsult({ chatId: 'c1', moment: 'plan', question: planQuestion({ planPath, goal: 'a counter' }), planPath, cwd: dir });
    await r.waitFor(started.consultation.id);

    expect(asked[0].prompt).toContain(planPath);
    // Fingerprinted at hand-over, so an edit during the review is visible
    // afterwards rather than silently endorsed.
    expect(store.get(started.consultation.id).planSha256).toBeTruthy();
    expect(store.get(started.consultation.id).stale).toBe(false);
    fs.writeFileSync(planPath, '# Plan\n\nchanged\n', 'utf8');
    expect(store.get(started.consultation.id).stale).toBe(true);
  });

  it('ends in a terminal state even when the consultation blows up', async () => {
    const { runner: r, store } = runner({
      answer: () => {
        throw new Error('the whole round fell over');
      },
    });
    const started = r.maybeConsult({ chatId: 'c1', moment: 'plan', cwd: dir });
    await r.waitFor(started.consultation.id);
    // consultPeers absorbs a single peer failing, so this lands as an
    // unreachable peer rather than a failed consultation — either way it is
    // finished, which is the rule that matters.
    expect(store.get(started.consultation.id).status).not.toBe('running');
  });

  it('frees the chat again once a consultation finishes', async () => {
    const { runner: r } = runner();
    const first = r.maybeConsult({ chatId: 'c1', moment: 'plan', cwd: dir });
    await r.waitFor(first.consultation.id);
    expect(r.maybeConsult({ chatId: 'c1', moment: 'plan', cwd: dir }).consultation).toBeTruthy();
  });

  it('consults at more moments as the level rises', () => {
    // Separate chats: both runners share this dataDir, so reusing one chat id
    // would trip single-flight and hide what this test is about.
    expect(runner({ level: 'decisions' }).runner.maybeConsult({ chatId: 'c-decisions', moment: 'decision', cwd: dir }).consultation).toBeTruthy();
    expect(runner({ level: 'always' }).runner.maybeConsult({ chatId: 'c-always', moment: 'turn', cwd: dir }).consultation).toBeTruthy();
  });
});

describe('stopAll', () => {
  it('aborts what is in flight and leaves nothing running', async () => {
    const { runner: r, store } = runner({
      answer: (peerId, prompt, { signal }) =>
        new Promise((resolve, reject) => {
          signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
        }),
    });
    const started = r.maybeConsult({ chatId: 'c1', moment: 'plan', cwd: dir });
    expect(r.activeCount()).toBe(1);

    await r.stopAll('test shutdown');
    expect(r.activeCount()).toBe(0);
    expect(store.get(started.consultation.id).status).not.toBe('running');
  });
});
