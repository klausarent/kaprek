import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openConsultations, ConsultationNotFoundError, sha256Of } from './store.mjs';

let dir;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kaprek-consult-'));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

function queued(store, overrides = {}) {
  return store.queue({ chatId: 'c1', moment: 'plan', question: 'Is this plan sound?', peers: ['codex', 'grok'], ...overrides });
}

describe('openConsultations', () => {
  it('records a queued consultation as running before any peer has answered', () => {
    const store = openConsultations(dir);
    const entry = queued(store);
    expect(entry.status).toBe('running');
    expect(entry.peers).toEqual(['codex', 'grok']);
    expect(store.get(entry.id).question).toBe('Is this plan sound?');
  });

  it('survives a reopen — the log is the truth, not the process', () => {
    const first = openConsultations(dir);
    const entry = queued(first);
    first.complete(entry.id, { consensus: true, agreed: ['codex', 'grok'], dissenting: [], unreachable: [], answers: [] });

    const second = openConsultations(dir);
    expect(second.get(entry.id).status).toBe('completed');
    expect(second.get(entry.id).result.agreed).toEqual(['codex', 'grok']);
  });

  it('keeps the failure reason instead of a bare failed status', () => {
    const store = openConsultations(dir);
    const entry = queued(store);
    store.fail(entry.id, 'every peer timed out');
    expect(store.get(entry.id)).toMatchObject({ status: 'failed', error: 'every peer timed out' });
  });

  it('refuses to finish a consultation it has never seen', () => {
    const store = openConsultations(dir);
    expect(() => store.complete('nope', {})).toThrow(ConsultationNotFoundError);
  });

  it('lists newest first and only for the chat that was asked about', () => {
    const store = openConsultations(dir);
    queued(store, { chatId: 'c1', question: 'first' });
    queued(store, { chatId: 'c2', question: 'other chat' });
    const third = queued(store, { chatId: 'c1', question: 'second' });

    const listed = store.list({ chatId: 'c1' });
    expect(listed.map((c) => c.question)).toEqual(['second', 'first']);
    expect(listed[0].id).toBe(third.id);
  });

  describe('single flight', () => {
    it('reports the running consultation for a chat', () => {
      const store = openConsultations(dir);
      const entry = queued(store);
      expect(store.runningFor('c1').id).toBe(entry.id);
      store.complete(entry.id, { consensus: true, agreed: [], dissenting: [], unreachable: [], answers: [] });
      // Once it is done it is no longer in flight: the next plan turn may ask
      // again. Without this, one consultation would silence the feature for
      // the rest of the chat's life.
      expect(store.runningFor('c1')).toBeNull();
    });

    it('does not confuse two chats', () => {
      const store = openConsultations(dir);
      queued(store, { chatId: 'c1' });
      expect(store.runningFor('c2')).toBeNull();
    });
  });

  describe('restart', () => {
    it('marks anything still running as interrupted and never replays it', () => {
      const first = openConsultations(dir);
      const entry = queued(first);

      const second = openConsultations(dir);
      const marked = second.interruptRunning('kaprek restarted');
      expect(marked).toEqual([entry.id]);
      expect(second.get(entry.id)).toMatchObject({ status: 'interrupted', error: 'kaprek restarted' });
      // Twice in a row must not produce a second interrupted event for the
      // same entry — a restart loop would otherwise grow the log forever.
      expect(second.interruptRunning('again')).toEqual([]);
    });
  });

  describe('freshness', () => {
    it('flags a consultation whose plan has changed since it was asked', () => {
      const planPath = path.join(dir, 'plan.md');
      fs.writeFileSync(planPath, '# Plan\n\n- [ ] step one\n', 'utf8');
      const store = openConsultations(dir);
      const entry = queued(store, { planPath, planSha256: sha256Of(fs.readFileSync(planPath, 'utf8')) });
      store.complete(entry.id, { consensus: true, agreed: ['codex'], dissenting: [], unreachable: [], answers: [] });

      expect(store.get(entry.id).stale).toBe(false);
      fs.writeFileSync(planPath, '# Plan\n\n- [ ] a different step\n', 'utf8');
      // The verdict was about a document that no longer exists in that form.
      // Saying so is the difference between advice and a stale rubber stamp.
      expect(store.get(entry.id).stale).toBe(true);
    });

    it('treats a deleted plan as stale rather than crashing', () => {
      const planPath = path.join(dir, 'gone.md');
      fs.writeFileSync(planPath, 'x', 'utf8');
      const store = openConsultations(dir);
      const entry = queued(store, { planPath, planSha256: sha256Of('x') });
      fs.rmSync(planPath);
      expect(store.get(entry.id).stale).toBe(true);
    });

    it('never calls a consultation without a plan stale', () => {
      const store = openConsultations(dir);
      const entry = queued(store, { planPath: null, planSha256: null });
      expect(store.get(entry.id).stale).toBe(false);
    });
  });
});
