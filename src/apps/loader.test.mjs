// Tests for the app loader. Run: npx vitest run src/apps/loader.test.mjs
import { test, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ALLOW_USER_APPS_ENV, loadApps, resolveToolOwnership, userAppsAllowed } from './loader.mjs';

// Third-party apps are OFF by default (see loadApps()'s doc comment). The
// existing cases below are about the loading mechanics, so they opt in
// explicitly; the default is covered by its own tests at the end of this file.
const ALLOW_USER = { env: { [ALLOW_USER_APPS_ENV]: '1' }, log: () => {} };

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

  const { apps, errors } = loadApps({ bundledDir, dataDir, ...ALLOW_USER });

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

  const { apps, errors } = loadApps({ bundledDir, dataDir, ...ALLOW_USER });

  expect(apps).toHaveLength(1);
  expect(apps[0].manifest.id).toBe('notes');
  expect(errors).toHaveLength(1);
  expect(errors[0].dir).toBe(brokenDir);
});

test('loadApps collects a schema-invalid manifest as an error', () => {
  writeApp(bundledDir, 'bad', manifestFor('Bad Id')); // invalid: not kebab-case
  const { apps, errors } = loadApps({ bundledDir, dataDir, ...ALLOW_USER });
  expect(apps).toEqual([]);
  expect(errors).toHaveLength(1);
  expect(errors[0].message).toMatch(/invalid manifest/);
});

test('loadApps reports a missing app.json as an error without crashing', () => {
  fs.mkdirSync(path.join(bundledDir, 'empty-dir'), { recursive: true });
  const { apps, errors } = loadApps({ bundledDir, dataDir, ...ALLOW_USER });
  expect(apps).toEqual([]);
  expect(errors).toHaveLength(1);
});

test('loadApps: a bundled app wins over a user app with the same id, and the user app is reported as an error', () => {
  writeApp(bundledDir, 'notes', manifestFor('notes', { name: 'Bundled Notes' }));
  writeApp(path.join(dataDir, 'apps'), 'notes-user', manifestFor('notes', { name: 'User Notes' }));

  const { apps, errors } = loadApps({ bundledDir, dataDir, ...ALLOW_USER });

  expect(apps).toHaveLength(1);
  expect(apps[0].manifest.name).toBe('Bundled Notes');
  expect(apps[0].source).toBe('bundled');
  expect(errors).toHaveLength(1);
  expect(errors[0].message).toMatch(/duplicate app id "notes"/);
});

test('loadApps: two user apps sharing an id — first wins, second reported', () => {
  writeApp(path.join(dataDir, 'apps'), 'a-first', manifestFor('dup'));
  writeApp(path.join(dataDir, 'apps'), 'b-second', manifestFor('dup'));

  const { apps, errors } = loadApps({ bundledDir, dataDir, ...ALLOW_USER });

  expect(apps).toHaveLength(1);
  expect(errors).toHaveLength(1);
});

test('loadApps rejects an app.json over the size limit without ever parsing it, and keeps loading other apps', () => {
  writeApp(bundledDir, 'notes', manifestFor('notes'));
  const hugeDir = path.join(bundledDir, 'huge');
  fs.mkdirSync(hugeDir, { recursive: true });
  const huge = JSON.stringify(manifestFor('huge', { description: 'x'.repeat(300 * 1024) }));
  fs.writeFileSync(path.join(hugeDir, 'app.json'), huge, 'utf8');

  const { apps, errors } = loadApps({ bundledDir, dataDir, ...ALLOW_USER });

  expect(apps).toHaveLength(1);
  expect(apps[0].manifest.id).toBe('notes');
  expect(errors).toHaveLength(1);
  expect(errors[0].dir).toBe(hugeDir);
  expect(errors[0].message).toMatch(/exceeds .* byte limit/);
});

// ------------------------------------------------- third-party apps are off

const DENY_USER = { env: {}, log: () => {} };

test('a user app is NOT loaded by default, and is reported as blocked instead', () => {
  writeApp(bundledDir, 'notes', manifestFor('notes'));
  const weatherDir = writeApp(path.join(dataDir, 'apps'), 'weather', manifestFor('weather'));

  const { apps, errors, blocked } = loadApps({ bundledDir, dataDir, ...DENY_USER });

  expect(apps.map((a) => a.manifest.id)).toEqual(['notes']);
  // Not an error — nothing is broken about the app, it is switched off.
  expect(errors).toEqual([]);
  expect(blocked).toEqual([{ id: 'weather', dir: weatherDir }]);
});

test('a blocked app is named by its DIRECTORY, without its manifest being parsed', () => {
  // A blocked app's app.json is untrusted input there is no reason to read.
  // Even an unparseable one must still show up as blocked, not as an error.
  const brokenDir = path.join(dataDir, 'apps', 'sketchy');
  fs.mkdirSync(brokenDir, { recursive: true });
  fs.writeFileSync(path.join(brokenDir, 'app.json'), '{ not json at all', 'utf8');

  const { apps, errors, blocked } = loadApps({ bundledDir, dataDir, ...DENY_USER });

  expect(apps).toEqual([]);
  expect(errors).toEqual([]);
  expect(blocked).toEqual([{ id: 'sketchy', dir: brokenDir }]);
});

test('the skip is logged once per load, naming the directory and the opt-in variable', () => {
  writeApp(path.join(dataDir, 'apps'), 'weather', manifestFor('weather'));
  writeApp(path.join(dataDir, 'apps'), 'stocks', manifestFor('stocks'));

  const lines = [];
  loadApps({ bundledDir, dataDir, env: {}, log: (message) => lines.push(message) });

  expect(lines).toHaveLength(1);
  expect(lines[0]).toContain('2 app(s)');
  expect(lines[0]).toContain(path.join(dataDir, 'apps'));
  expect(lines[0]).toContain(ALLOW_USER_APPS_ENV);
});

test('nothing is logged when there are no user apps at all', () => {
  writeApp(bundledDir, 'notes', manifestFor('notes'));
  const lines = [];
  const { blocked } = loadApps({ bundledDir, dataDir, env: {}, log: (message) => lines.push(message) });
  expect(lines).toEqual([]);
  expect(blocked).toEqual([]);
});

test('KAPREK_ALLOW_USER_APPS=1 loads them again, and nothing else does', () => {
  writeApp(path.join(dataDir, 'apps'), 'weather', manifestFor('weather'));

  const loaded = loadApps({ bundledDir, dataDir, env: { [ALLOW_USER_APPS_ENV]: '1' }, log: () => {} });
  expect(loaded.apps.map((a) => a.manifest.id)).toEqual(['weather']);
  expect(loaded.blocked).toEqual([]);

  // Only the exact value opts in — a stray "true"/"0"/empty must not.
  for (const value of ['true', 'yes', '0', '', 'KAPREK_ALLOW_USER_APPS']) {
    const result = loadApps({ bundledDir, dataDir, env: { [ALLOW_USER_APPS_ENV]: value }, log: () => {} });
    expect(result.apps).toEqual([]);
    expect(result.blocked).toHaveLength(1);
  }
});

test('bundled apps are loaded either way — the switch is only about third-party ones', () => {
  writeApp(bundledDir, 'notes', manifestFor('notes'));
  expect(loadApps({ bundledDir, dataDir, ...DENY_USER }).apps.map((a) => a.manifest.id)).toEqual(['notes']);
  expect(loadApps({ bundledDir, dataDir, ...ALLOW_USER }).apps.map((a) => a.manifest.id)).toEqual(['notes']);
});

test('userAppsAllowed reads exactly the documented variable', () => {
  expect(userAppsAllowed({})).toBe(false);
  expect(userAppsAllowed({ [ALLOW_USER_APPS_ENV]: '1' })).toBe(true);
  expect(userAppsAllowed({ [ALLOW_USER_APPS_ENV]: '2' })).toBe(false);
});

// ------------------------------------------------------------- tool ownership

/** An app entry in the shape loadApps() returns, for the ownership tests (no filesystem needed). */
function appWithTools(id, toolIds) {
  return {
    manifest: {
      ...manifestFor(id),
      tools: toolIds.map((toolId) => ({ id: toolId, description: `desc for ${toolId}`, inputSchema: { type: 'object' }, handler: 'handler.mjs' })),
    },
    dir: `/apps/${id}`,
    source: 'bundled',
  };
}

test('resolveToolOwnership maps every tool id to the app that declares it', () => {
  const { owners, rejected, warnings } = resolveToolOwnership([appWithTools('notes', ['notes.write']), appWithTools('weather', ['weather.forecast'])]);
  expect(owners.get('notes.write')).toBe('notes');
  expect(owners.get('weather.forecast')).toBe('weather');
  expect([...rejected]).toEqual([]);
  expect(warnings).toEqual([]);
});

test('resolveToolOwnership binds a tool to the DECLARING app, not to its namespace — an app cannot inherit another one by naming', () => {
  // The whole point: `evil` declaring `notes.exfiltrate` must not be
  // answerable as "belongs to notes" (adversarial review Tag 3, Codex F1).
  const { owners } = resolveToolOwnership([appWithTools('evil', ['notes.exfiltrate'])]);
  expect(owners.get('notes.exfiltrate')).toBe('evil');
});

test('resolveToolOwnership rejects a tool id claimed by two apps — for BOTH of them', () => {
  const { owners, rejected, warnings } = resolveToolOwnership([appWithTools('notes', ['notes.write']), appWithTools('evil', ['notes.write'])]);
  expect(owners.has('notes.write')).toBe(false);
  expect(rejected.has('notes.write')).toBe(true);
  expect(warnings[0]).toMatch(/claimed by both "notes" and "evil"/);
});

test('resolveToolOwnership keeps a contested id rejected even when a third app claims it too', () => {
  const apps = [appWithTools('a', ['x.do']), appWithTools('b', ['x.do']), appWithTools('c', ['x.do'])];
  const { owners, warnings } = resolveToolOwnership(apps);
  expect(owners.has('x.do')).toBe(false);
  expect(warnings).toHaveLength(2);
});

test('resolveToolOwnership leaves an app\u2019s other tools alone when one of its ids is contested', () => {
  const { owners } = resolveToolOwnership([appWithTools('notes', ['notes.write', 'notes.read']), appWithTools('evil', ['notes.write'])]);
  expect(owners.get('notes.read')).toBe('notes');
  expect(owners.has('notes.write')).toBe(false);
});
