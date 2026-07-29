// App data directory resolution.
//
// The directory name and the env var override are both derived from the
// package.json `name` field at runtime rather than hardcoded, so this stays
// correct if the package is ever renamed.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PACKAGE_JSON_PATH = path.join(__dirname, '..', '..', 'package.json');

let cachedName;

/**
 * Reads the `name` field from the project's package.json. Uses
 * fs.readFileSync + JSON.parse instead of a JSON import assertion, since
 * import-assertion syntax and support still differ across Node versions.
 */
export function getPackageName() {
  if (cachedName) return cachedName;
  const pkg = JSON.parse(fs.readFileSync(PACKAGE_JSON_PATH, 'utf8'));
  cachedName = pkg.name;
  return cachedName;
}

/** Builds the override env var name for a package, e.g. `loryme` -> `LORYME_DATA_DIR`. */
function envVarName(name) {
  return `${name.toUpperCase().replace(/-/g, '_')}_DATA_DIR`;
}

/**
 * Resolves the app's data directory. Does not touch the filesystem.
 *
 * Precedence: `env[<NAME>_DATA_DIR]` if set, else `<homedir>/.<package-name>`.
 * `homedir`/`env` are injectable for tests; production callers can omit both.
 */
export function getAppDir({ homedir = os.homedir(), env = process.env } = {}) {
  const name = getPackageName();
  const override = env[envVarName(name)];
  if (override) return override;
  return path.join(homedir, `.${name}`);
}

/** Resolves the app's data directory and creates it (recursively) if missing. */
export function ensureAppDir(options) {
  const dir = getAppDir(options);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}
