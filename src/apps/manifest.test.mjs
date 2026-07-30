// Tests for the app manifest validator. Run: npx vitest run src/apps/manifest.test.mjs
import { test, expect } from 'vitest';
import { validateManifest, parseManifest, ManifestValidationError } from './manifest.mjs';

function validManifest(overrides = {}) {
  return {
    id: 'notes',
    version: '1.0.0',
    name: 'Notes',
    description: 'Write a note.',
    tools: [
      {
        id: 'notes.write',
        description: 'Writes a note.',
        inputSchema: { type: 'object', properties: { title: { type: 'string' } } },
        handler: 'handler.mjs',
      },
    ],
    policy: { fsWrite: true, dataEgress: false, externalAction: 'never', sensitivity: 'low' },
    ...overrides,
  };
}

// ------------------------------------------------------------- validateManifest

test('validateManifest accepts a minimal valid manifest', () => {
  expect(() => validateManifest(validManifest())).not.toThrow();
});

test('validateManifest accepts optional fields (icon, instructions, uiSlot)', () => {
  expect(() =>
    validateManifest(validManifest({ icon: '📝', instructions: 'do a thing', uiSlot: 'gallery' })),
  ).not.toThrow();
});

test('validateManifest rejects an unknown top-level field', () => {
  expect(() => validateManifest(validManifest({ bogus: true }))).toThrow(ManifestValidationError);
  try {
    validateManifest(validManifest({ bogus: true }));
  } catch (err) {
    expect(err.field).toBe('bogus');
  }
});

test.each(['id', 'version', 'name', 'description', 'tools', 'policy'])('validateManifest rejects a missing required field: %s', (field) => {
  const manifest = validManifest();
  delete manifest[field];
  expect(() => validateManifest(manifest)).toThrow(ManifestValidationError);
});

test('validateManifest rejects a non-kebab-case id', () => {
  expect(() => validateManifest(validManifest({ id: 'Notes_App' }))).toThrow(ManifestValidationError);
});

test('validateManifest rejects a non-semver version', () => {
  expect(() => validateManifest(validManifest({ version: 'v1' }))).toThrow(ManifestValidationError);
});

test('validateManifest rejects an invalid (non-namespaced) tool id', () => {
  const manifest = validManifest();
  manifest.tools[0].id = 'write';
  expect(() => validateManifest(manifest)).toThrow(ManifestValidationError);
});

test('validateManifest rejects an unknown field inside a tool entry', () => {
  const manifest = validManifest();
  manifest.tools[0].bogus = true;
  try {
    validateManifest(manifest);
    throw new Error('expected to throw');
  } catch (err) {
    expect(err).toBeInstanceOf(ManifestValidationError);
    expect(err.field).toBe('tools[0].bogus');
  }
});

test('validateManifest rejects a tool with an absolute handler path', () => {
  const manifest = validManifest();
  manifest.tools[0].handler = '/etc/passwd';
  expect(() => validateManifest(manifest)).toThrow(ManifestValidationError);
});

test('validateManifest rejects a tool handler containing ".." traversal', () => {
  const manifest = validManifest();
  manifest.tools[0].handler = '../../evil.mjs';
  expect(() => validateManifest(manifest)).toThrow(ManifestValidationError);
});

test('validateManifest rejects duplicate tool ids within one manifest', () => {
  const manifest = validManifest();
  manifest.tools.push({ ...manifest.tools[0] });
  expect(() => validateManifest(manifest)).toThrow(ManifestValidationError);
});

test.each([
  ['fsWrite', 'not-a-bool'],
  ['dataEgress', 'not-a-bool'],
  ['externalAction', 'sometimes'],
  ['sensitivity', 'extreme'],
])('validateManifest rejects invalid policy.%s value', (field, badValue) => {
  const manifest = validManifest();
  manifest.policy[field] = badValue;
  expect(() => validateManifest(manifest)).toThrow(ManifestValidationError);
});

test('validateManifest rejects an unknown field inside policy', () => {
  const manifest = validManifest();
  manifest.policy.bogus = true;
  try {
    validateManifest(manifest);
    throw new Error('expected to throw');
  } catch (err) {
    expect(err.field).toBe('policy.bogus');
  }
});

test('validateManifest rejects an invalid uiSlot', () => {
  expect(() => validateManifest(validManifest({ uiSlot: 'chart' }))).toThrow(ManifestValidationError);
});

// ------------------------------------------------------------------- limits

test('validateManifest rejects more than 64 tools', () => {
  const manifest = validManifest();
  manifest.tools = Array.from({ length: 65 }, (_, i) => ({
    id: `x.tool${i}`,
    description: 'desc',
    inputSchema: { type: 'object' },
    handler: 'handler.mjs',
  }));
  try {
    validateManifest(manifest);
    throw new Error('expected to throw');
  } catch (err) {
    expect(err).toBeInstanceOf(ManifestValidationError);
    expect(err.field).toBe('tools');
  }
});

test('validateManifest accepts exactly 64 tools', () => {
  const manifest = validManifest();
  manifest.tools = Array.from({ length: 64 }, (_, i) => ({
    id: `x.tool${i}`,
    description: 'desc',
    inputSchema: { type: 'object' },
    handler: 'handler.mjs',
  }));
  expect(() => validateManifest(manifest)).not.toThrow();
});

test('validateManifest rejects an overlong name', () => {
  try {
    validateManifest(validManifest({ name: 'x'.repeat(201) }));
    throw new Error('expected to throw');
  } catch (err) {
    expect(err).toBeInstanceOf(ManifestValidationError);
    expect(err.field).toBe('name');
  }
});

test('validateManifest rejects an overlong description', () => {
  expect(() => validateManifest(validManifest({ description: 'x'.repeat(2001) }))).toThrow(ManifestValidationError);
});

test('validateManifest rejects overlong instructions', () => {
  expect(() => validateManifest(validManifest({ instructions: 'x'.repeat(20001) }))).toThrow(ManifestValidationError);
});

// --------------------------------------------------------------- parseManifest

test('parseManifest parses a JSON string and normalizes optional fields', () => {
  const parsed = parseManifest(JSON.stringify(validManifest()));
  expect(parsed.icon).toBeNull();
  expect(parsed.instructions).toBe('');
  expect(parsed.uiSlot).toBe('none');
  expect(parsed.id).toBe('notes');
});

test('parseManifest accepts an already-parsed object', () => {
  expect(parseManifest(validManifest()).id).toBe('notes');
});

test('parseManifest throws ManifestValidationError on invalid JSON', () => {
  expect(() => parseManifest('{not json')).toThrow(ManifestValidationError);
});

test('parseManifest throws ManifestValidationError on a schema violation', () => {
  expect(() => parseManifest(JSON.stringify(validManifest({ id: 'Bad Id' })))).toThrow(ManifestValidationError);
});
