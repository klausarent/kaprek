// The M3 acceptance sentence, as tests: a child scope must see nothing of a
// tree it does not belong to, and a broken chain must fail towards nothing.
import { describe, test, expect } from 'vitest';
import { InvalidScopeError, canRead, parseScopeId, validateScope, visibleScopes } from './scopes.mjs';

/** A tree: klaus -> kaprek -> the M3 mission, plus a separate person. */
function tree() {
  const scopes = new Map();
  for (const scope of [
    { id: 'person:klaus', parent: null },
    { id: 'project:kaprek', parent: 'person:klaus' },
    { id: 'mission:m3', parent: 'project:kaprek' },
    { id: 'agent:codex', parent: 'project:kaprek' },
    { id: 'person:luca', parent: null },
    { id: 'project:spiel', parent: 'person:luca' },
  ]) {
    scopes.set(scope.id, validateScope(scope, scopes));
  }
  return scopes;
}

describe('parseScopeId', () => {
  test('splits kind from label', () => {
    expect(parseScopeId('project:kaprek')).toEqual({ id: 'project:kaprek', kind: 'project', label: 'kaprek' });
  });

  test('a label may contain further colons', () => {
    expect(parseScopeId('mission:build:the:thing').label).toBe('build:the:thing');
  });

  test('refuses a kind it does not know', () => {
    expect(() => parseScopeId('projekt:kaprek')).toThrow(/unknown scope kind/);
  });

  test('refuses a shape that is not kind:label', () => {
    for (const bad of ['kaprek', ':kaprek', 'project:', '', null]) {
      expect(() => parseScopeId(bad)).toThrow(InvalidScopeError);
    }
  });
});

describe('validateScope', () => {
  test('accepts a root', () => {
    expect(validateScope({ id: 'person:klaus' })).toEqual({ id: 'person:klaus', kind: 'person', label: 'klaus', parent: null });
  });

  test('refuses a parent that does not exist', () => {
    expect(() => validateScope({ id: 'project:x', parent: 'person:nobody' }, new Map())).toThrow(/parent that does not exist/);
  });

  test('refuses a scope that is its own parent', () => {
    expect(() => validateScope({ id: 'person:klaus', parent: 'person:klaus' })).toThrow(/cannot be its own parent/);
  });

  test('refuses a cycle further up the chain', () => {
    const scopes = tree();
    // Re-parenting klaus under his own project would close a loop that makes
    // visibleScopes() depend on where the walk started.
    expect(() => validateScope({ id: 'person:klaus', parent: 'mission:m3' }, scopes)).toThrow(/cycle/);
  });
});

describe('visibleScopes', () => {
  test('runs upwards, nearest first', () => {
    expect(visibleScopes('mission:m3', tree())).toEqual(['mission:m3', 'project:kaprek', 'person:klaus']);
  });

  test('a parent does not see into its children', () => {
    expect(visibleScopes('person:klaus', tree())).toEqual(['person:klaus']);
  });

  test('an agent scope reaches the project it belongs to', () => {
    // What Codex learned about kaprek is readable by anything under kaprek —
    // that is the "agent B uses what agent A learned" half of M3.
    expect(visibleScopes('agent:codex', tree())).toContain('project:kaprek');
  });

  test('an unknown scope sees nothing at all', () => {
    expect(visibleScopes('project:does-not-exist', tree())).toEqual([]);
  });

  test('a broken chain stops where it breaks instead of widening', () => {
    const scopes = new Map([['mission:orphan', { id: 'mission:orphan', kind: 'mission', label: 'orphan', parent: 'project:gone' }]]);
    expect(visibleScopes('mission:orphan', scopes)).toEqual(['mission:orphan']);
  });

  test('a cycle that got into the data does not hang the walk', () => {
    // validateScope refuses to create one; a hand-edited file could still
    // hold one, and an infinite loop in a read path is not an option.
    const scopes = new Map([
      ['project:a', { id: 'project:a', parent: 'project:b' }],
      ['project:b', { id: 'project:b', parent: 'project:a' }],
    ]);
    expect(visibleScopes('project:a', scopes)).toEqual(['project:a', 'project:b']);
  });
});

describe('canRead', () => {
  const scopes = tree();

  test('a mission reads its project', () => {
    expect(canRead('mission:m3', 'project:kaprek', scopes)).toBe(true);
  });

  test("a child's own tree is invisible to the other tree — the M3 acceptance", () => {
    expect(canRead('project:spiel', 'project:kaprek', scopes)).toBe(false);
    expect(canRead('project:spiel', 'person:klaus', scopes)).toBe(false);
    // And the other way round, which is the half people forget to check.
    expect(canRead('project:kaprek', 'project:spiel', scopes)).toBe(false);
  });

  test('a scope reads itself', () => {
    expect(canRead('person:luca', 'person:luca', scopes)).toBe(true);
  });
});
