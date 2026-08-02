import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { BUILTIN_RECIPES, DEFAULT_RECIPE_ID, InvalidRecipeError, loadRecipes, routeFromLegacy, validateRecipe, stepsOf } from './recipes.mjs';
import { RELAY_MAX_TURNS } from './dispatcher.mjs';

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'kaprek-recipes-'));
}

/** A recipe that passes every rule, as the starting point for the invalid cases. */
function validRecipe(overrides = {}) {
  return {
    id: 'draft-review',
    title: 'Draft, then review',
    steps: [
      { id: 'write', agent: 'grok' },
      { id: 'review', agent: 'claude' },
    ],
    edges: [
      { from: 'write', to: 'review' },
      { from: 'review', to: 'write' },
    ],
    ...overrides,
  };
}

describe('validateRecipe', () => {
  it('fills in every default so the dispatcher never has to guess', () => {
    const recipe = validateRecipe(validRecipe());
    expect(recipe.budgets).toEqual({ maxRounds: 2, hardMaxTurns: RELAY_MAX_TURNS, retriesPerDispatch: 0 });
    expect(recipe.escalation).toEqual({ onPeerFailure: 'stop', onBudget: 'question' });
    // An edge without the flag is an ordinary handoff, spelled out rather
    // than left undefined — a gate must never depend on a missing key.
    expect(recipe.edges.every((edge) => edge.requiresHuman === false)).toBe(true);
  });

  it('keeps values the caller did set', () => {
    const recipe = validateRecipe(
      validRecipe({
        budgets: { maxRounds: 5, hardMaxTurns: 20, retriesPerDispatch: 2 },
        escalation: { onPeerFailure: 'question', onBudget: 'notify' },
        edges: [
          { from: 'write', to: 'review', requiresHuman: true },
          { from: 'review', to: 'write' },
        ],
      }),
    );
    expect(recipe.budgets).toEqual({ maxRounds: 5, hardMaxTurns: 20, retriesPerDispatch: 2 });
    expect(recipe.escalation).toEqual({ onPeerFailure: 'question', onBudget: 'notify' });
    expect(recipe.edges[0].requiresHuman).toBe(true);
  });

  it('refuses a recipe without steps', () => {
    expect(() => validateRecipe(validRecipe({ steps: [] }))).toThrow(InvalidRecipeError);
    expect(() => validateRecipe(validRecipe({ steps: [] }))).toThrow(/steps/);
  });

  it('refuses an agent nobody can run', () => {
    const err = (() => {
      try {
        validateRecipe(validRecipe({ steps: [{ id: 'write', agent: 'gemini' }], edges: [] }));
        return null;
      } catch (e) {
        return e;
      }
    })();
    expect(err).toBeInstanceOf(InvalidRecipeError);
    // Naming the unknown agent matters: "invalid recipe" sends someone
    // hunting through their own file for which line is wrong.
    expect(err.message).toMatch(/gemini/);
    expect(err.field).toBe('steps[0].agent');
  });

  it('refuses two steps with the same id', () => {
    expect(() =>
      validateRecipe(
        validRecipe({
          steps: [
            { id: 'write', agent: 'grok' },
            { id: 'write', agent: 'claude' },
          ],
          edges: [],
        }),
      ),
    ).toThrow(/duplicate/i);
  });

  it('refuses an edge pointing at a step that does not exist', () => {
    expect(() => validateRecipe(validRecipe({ edges: [{ from: 'write', to: 'ship' }] }))).toThrow(/ship/);
  });

  it('refuses a step nothing can reach', () => {
    // 'ship' is defined but no edge leads to it: a run would never get there,
    // and silently never running a step is worse than refusing to start.
    expect(() =>
      validateRecipe(
        validRecipe({
          steps: [
            { id: 'write', agent: 'grok' },
            { id: 'review', agent: 'claude' },
            { id: 'ship', agent: 'codex' },
          ],
          edges: [
            { from: 'write', to: 'review' },
            { from: 'review', to: 'write' },
          ],
        }),
      ),
    ).toThrow(/ship/);
  });

  it('refuses budgets that are not positive whole numbers', () => {
    expect(() => validateRecipe(validRecipe({ budgets: { maxRounds: 0 } }))).toThrow(/maxRounds/);
    expect(() => validateRecipe(validRecipe({ budgets: { hardMaxTurns: 2.5 } }))).toThrow(/hardMaxTurns/);
    // Zero retries is the default and perfectly valid; negative is not.
    expect(() => validateRecipe(validRecipe({ budgets: { retriesPerDispatch: -1 } }))).toThrow(/retriesPerDispatch/);
    expect(validateRecipe(validRecipe({ budgets: { retriesPerDispatch: 0 } })).budgets.retriesPerDispatch).toBe(0);
  });

  it('refuses an escalation level it does not know', () => {
    expect(() => validateRecipe(validRecipe({ escalation: { onPeerFailure: 'retry-forever' } }))).toThrow(/onPeerFailure/);
    expect(() => validateRecipe(validRecipe({ escalation: { onBudget: 'shrug' } }))).toThrow(/onBudget/);
  });

  it('accepts a longer chain when every step is reachable', () => {
    const recipe = validateRecipe(
      validRecipe({
        steps: [
          { id: 'write', agent: 'grok' },
          { id: 'review', agent: 'claude' },
          { id: 'apply', agent: 'codex' },
        ],
        edges: [
          { from: 'write', to: 'review' },
          { from: 'review', to: 'apply', requiresHuman: true },
          { from: 'apply', to: 'write' },
        ],
      }),
    );
    expect(recipe.steps.map((s) => s.id)).toEqual(['write', 'review', 'apply']);
  });
});

describe('BUILTIN_RECIPES', () => {
  it('every builtin passes its own validation', () => {
    for (const recipe of BUILTIN_RECIPES) {
      expect(() => validateRecipe(recipe)).not.toThrow();
    }
  });

  it('ships the v1 pairing as the default', () => {
    const builtin = BUILTIN_RECIPES.find((r) => r.id === DEFAULT_RECIPE_ID);
    expect(builtin.steps.map((s) => s.agent)).toEqual(['grok', 'claude']);
  });
});

describe('loadRecipes', () => {
  let dir;

  beforeEach(() => {
    dir = tempDir();
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('returns the builtins when the user has no recipe files', () => {
    expect(loadRecipes(dir).map((r) => r.id)).toEqual(BUILTIN_RECIPES.map((r) => r.id));
  });

  it('adds a user recipe and marks it as not builtin', () => {
    fs.mkdirSync(path.join(dir, 'recipes'));
    fs.writeFileSync(path.join(dir, 'recipes', 'mine.json'), JSON.stringify(validRecipe({ id: 'mine' })), 'utf8');
    const mine = loadRecipes(dir).find((r) => r.id === 'mine');
    expect(mine.builtin).toBe(false);
    expect(mine.title).toBe('Draft, then review');
  });

  it('lets a user file replace a builtin of the same id', () => {
    fs.mkdirSync(path.join(dir, 'recipes'));
    fs.writeFileSync(path.join(dir, 'recipes', 'x.json'), JSON.stringify(validRecipe({ id: DEFAULT_RECIPE_ID, title: 'Mine now' })), 'utf8');
    const loaded = loadRecipes(dir);
    expect(loaded.filter((r) => r.id === DEFAULT_RECIPE_ID)).toHaveLength(1);
    expect(loaded.find((r) => r.id === DEFAULT_RECIPE_ID).title).toBe('Mine now');
  });

  it('skips an invalid file instead of taking the catalog down with it', () => {
    fs.mkdirSync(path.join(dir, 'recipes'));
    fs.writeFileSync(path.join(dir, 'recipes', 'broken.json'), '{not json', 'utf8');
    fs.writeFileSync(path.join(dir, 'recipes', 'nosteps.json'), JSON.stringify({ id: 'nope', title: 'x', steps: [] }), 'utf8');
    fs.writeFileSync(path.join(dir, 'recipes', 'good.json'), JSON.stringify(validRecipe({ id: 'good' })), 'utf8');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const loaded = loadRecipes(dir);
    expect(loaded.map((r) => r.id)).toContain('good');
    expect(loaded.map((r) => r.id)).not.toContain('nope');
    // Skipping quietly is how a user ends up wondering where their recipe
    // went; one warning naming the count is the contract presets.mjs set.
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });
});

describe('routeFromLegacy', () => {
  it('turns the v1 route into a ring so old callers keep working', () => {
    const recipe = routeFromLegacy({ route: ['grok', 'claude'], maxRounds: 3 });
    expect(recipe.steps.map((s) => s.agent)).toEqual(['grok', 'claude']);
    expect(recipe.edges).toEqual([
      { from: 'grok', to: 'claude', requiresHuman: false },
      { from: 'claude', to: 'grok', requiresHuman: false },
    ]);
    expect(recipe.budgets.maxRounds).toBe(3);
  });

  it('handles a single-peer route by looping it back to itself', () => {
    const recipe = routeFromLegacy({ route: ['grok'], maxRounds: 1 });
    expect(recipe.edges).toEqual([{ from: 'grok', to: 'grok', requiresHuman: false }]);
  });

  it('gives every legacy step a distinct id even when a peer repeats', () => {
    const recipe = routeFromLegacy({ route: ['grok', 'claude', 'grok'], maxRounds: 1 });
    expect(new Set(recipe.steps.map((s) => s.id)).size).toBe(3);
    expect(recipe.steps.map((s) => s.agent)).toEqual(['grok', 'claude', 'grok']);
  });
});

describe('stepsOf', () => {
  it('walks the graph from the first step, so the dispatcher can follow edges', () => {
    const recipe = validateRecipe(
      validRecipe({
        steps: [
          { id: 'write', agent: 'grok' },
          { id: 'review', agent: 'claude' },
        ],
        edges: [
          { from: 'write', to: 'review' },
          { from: 'review', to: 'write' },
        ],
      }),
    );
    const walk = stepsOf(recipe);
    expect(walk.first.id).toBe('write');
    expect(walk.next('write').to.id).toBe('review');
    expect(walk.next('review').to.id).toBe('write');
    expect(walk.next('review').edge.requiresHuman).toBe(false);
  });

  it('reports a dead end rather than inventing a next step', () => {
    const recipe = validateRecipe(
      validRecipe({
        steps: [
          { id: 'write', agent: 'grok' },
          { id: 'review', agent: 'claude' },
        ],
        edges: [{ from: 'write', to: 'review' }],
      }),
    );
    expect(stepsOf(recipe).next('review')).toBeNull();
  });
});
