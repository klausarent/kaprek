// App loader — reads app.json manifests from the bundled apps/ directory
// (shipped with kaprek) and from <dataDir>/apps/ (user-installed apps), and
// validates each with manifest.mjs. A single broken manifest is collected
// into `errors` rather than thrown, so one bad app.json can never take down
// every other app — mirrors src/board/store.mjs's "skip the bad line, keep
// going" posture for corrupt event lines.
import fs from 'node:fs';
import path from 'node:path';
import { parseManifest, ManifestValidationError } from './manifest.mjs';

function userAppsDir(dataDir) {
  return path.join(dataDir, 'apps');
}

/** Lists immediate subdirectories of `dir`, or [] if `dir` doesn't exist / isn't readable. */
function listSubdirs(dir) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries.filter((e) => e.isDirectory()).map((e) => path.join(dir, e.name));
}

/**
 * Loads one app.json from `appDir`. Returns `{manifest}` on success, or
 * `{error: {dir, message}}` on any failure (missing file, unreadable,
 * invalid JSON, schema violation) — never throws.
 */
function loadOneApp(appDir) {
  const manifestPath = path.join(appDir, 'app.json');
  let raw;
  try {
    raw = fs.readFileSync(manifestPath, 'utf8');
  } catch (err) {
    return { error: { dir: appDir, message: `could not read app.json: ${err.message}` } };
  }

  try {
    const manifest = parseManifest(raw);
    return { manifest };
  } catch (err) {
    if (err instanceof ManifestValidationError) {
      return { error: { dir: appDir, message: `invalid manifest (${err.field}): ${err.message}` } };
    }
    return { error: { dir: appDir, message: `could not parse app.json: ${err.message}` } };
  }
}

/**
 * Loads every app under `bundledDir` and `<dataDir>/apps`. Returns
 * `{apps: [{manifest, dir, source}], errors: [{dir, message}]}`.
 *
 * Duplicate ids: a bundled app always wins over a user app of the same id —
 * the user app is dropped and reported in `errors` instead of silently
 * shadowing (or being shadowed by) trusted, shipped code. Two apps from the
 * SAME source sharing an id is handled the same way: whichever is
 * encountered first (directory listing order) wins, the rest are reported.
 */
export function loadApps({ bundledDir, dataDir }) {
  const apps = [];
  const errors = [];
  const idsSeen = new Set();

  function loadSource(dir, source) {
    for (const appDir of listSubdirs(dir)) {
      const { manifest, error } = loadOneApp(appDir);
      if (error) {
        errors.push(error);
        continue;
      }
      if (idsSeen.has(manifest.id)) {
        errors.push({
          dir: appDir,
          message: `duplicate app id "${manifest.id}": already provided by another app, skipping this one`,
        });
        continue;
      }
      idsSeen.add(manifest.id);
      apps.push({ manifest, dir: appDir, source });
    }
  }

  if (bundledDir) loadSource(bundledDir, 'bundled');
  if (dataDir) loadSource(userAppsDir(dataDir), 'user');

  return { apps, errors };
}
