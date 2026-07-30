// Tests for the app loader. Run: npx vitest run src/apps/loader.test.mjs
import { test, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadApps } from './loader.mjs';

let root;
let bundledDir;
let dataDir;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'kaprek-loader-test-'));
  bundledDir = path.join(root, 'bundled-apps');
  dataDir = path.join(root, 'data');
  fs.mkdirSync(bundledDir, { recursive: true });
  fs.mkdirSync(path.join(dataDir, 'apps'), { recursive: true });
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

function writeApp(baseDir, dirName, manifest) {
  const appDir = path.join(baseDir, dirName);
  fs.mkdirSync(appDir, { recursive: true });
  fs.writeFileSync(path.join(appDir, 'app.json'), JSON.stringify(manifest), 'utf8');
  return appDir;
}

function manifestFor(id, overrides = {}) {
  return {
    id,
    version: '1.0.0',
    name: id,
    description: `${id} app`,
    tools: [],
    policy: { fsWrite: false, dataEgress: false, externalAction: 'never', sensitivity: 'low' },
    ...overrides,
  };
}

test('loadApps loads a bundled app and a user app with no errors', () => {
  writeApp(bundledDir, 'notes', manifestFor('notes'));
  writeApp(path.join(dataDir, 'apps'), 'weather', manifestFor('weather'));

  const { apps, errors } = loadApps({ bundledDir, dataDir });

  expect(errors).toEqual([]);
  expect(apps).toHaveLength(2);
  expect(apps.find((a) => a.manifest.id === 'notes').source).toBe('bundled');
  expect(apps.find((a) => a.manifest.id === 'weather').source).toBe('user');
});

test('loadApps returns [] apps and [] errors when neither directory exists', () => {
  const { apps, errors } = loadApps({ bundledDir: path.join(root, 'nope'), dataDir: path.join(root, 'also-nope') });
  expect(apps).toEqual([]);
  expect(errors).toEqual([]);
});

test('loadApps collects a broken manifest as an error instead of throwing, and still loads the other apps', () => {
  writeApp(bundledDir, 'notes', manifestFor('notes'));
  const brokenDir = path.join(bundledDir, 'broken');
  fs.mkdirSync(brokenDir, { recursive: true });
  fs.writeFileSync(path.join(brokenDir, 'app.json'), '{not valid json', 'utf8');

  const { apps, errors } = loadApps({ bundledDir, dataDir });

  expect(apps).toHaveLength(1);
  expect(apps[0].manifest.id).toBe('notes');
  expect(errors).toHaveLength(1);
  expect(errors[0].dir).toBe(brokenDir);
});

test('loadApps collects a schema-invalid manifest as an error', () => {
  writeApp(bundledDir, 'bad', manifestFor('Bad Id')); // invalid: not kebab-case
  const { apps, errors } = loadApps({ bundledDir, dataDir });
  expect(apps).toEqual([]);
  expect(errors).toHaveLength(1);
  expect(errors[0].message).toMatch(/invalid manifest/);
});

test('loadApps reports a missing app.json as an error without crashing', () => {
  fs.mkdirSync(path.join(bundledDir, 'empty-dir'), { recursive: true });
  const { apps, errors } = loadApps({ bundledDir, dataDir });
  expect(apps).toEqual([]);
  expect(errors).toHaveLength(1);
});

test('loadApps: a bundled app wins over a user app with the same id, and the user app is reported as an error', () => {
  writeApp(bundledDir, 'notes', manifestFor('notes', { name: 'Bundled Notes' }));
  writeApp(path.join(dataDir, 'apps'), 'notes-user', manifestFor('notes', { name: 'User Notes' }));

  const { apps, errors } = loadApps({ bundledDir, dataDir });

  expect(apps).toHaveLength(1);
  expect(apps[0].manifest.name).toBe('Bundled Notes');
  expect(apps[0].source).toBe('bundled');
  expect(errors).toHaveLength(1);
  expect(errors[0].message).toMatch(/duplicate app id "notes"/);
});

test('loadApps: two user apps sharing an id — first wins, second reported', () => {
  writeApp(path.join(dataDir, 'apps'), 'a-first', manifestFor('dup'));
  writeApp(path.join(dataDir, 'apps'), 'b-second', manifestFor('dup'));

  const { apps, errors } = loadApps({ bundledDir, dataDir });

  expect(apps).toHaveLength(1);
  expect(errors).toHaveLength(1);
});

test('loadApps rejects an app.json over the size limit without ever parsing it, and keeps loading other apps', () => {
  writeApp(bundledDir, 'notes', manifestFor('notes'));
  const hugeDir = path.join(bundledDir, 'huge');
  fs.mkdirSync(hugeDir, { recursive: true });
  const huge = JSON.stringify(manifestFor('huge', { description: 'x'.repeat(300 * 1024) }));
  fs.writeFileSync(path.join(hugeDir, 'app.json'), huge, 'utf8');

  const { apps, errors } = loadApps({ bundledDir, dataDir });

  expect(apps).toHaveLength(1);
  expect(apps[0].manifest.id).toBe('notes');
  expect(errors).toHaveLength(1);
  expect(errors[0].dir).toBe(hugeDir);
  expect(errors[0].message).toMatch(/exceeds .* byte limit/);
});
