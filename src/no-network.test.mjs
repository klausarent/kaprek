// Static guard against network and subprocess code outside of tests.
//
// kaprek is a purely local tool. The server uses http.createServer() to
// RECEIVE loopback requests, but never calls an HTTP client itself to SEND
// data, and never spawns subprocesses except for the documented cases
// below. This test is a plain text-pattern search, not an AST scan and not
// a runtime proof: a call assembled via, say, string concatenation
// ('fe' + 'tch') or dynamic property access (globalThis['fetch']) would NOT
// be caught. It serves as a tripwire against naive/accidental additions of
// network or subprocess calls (e.g. for a future "cloud sync" feature), not
// as a guarantee against active circumvention.
import { test, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');

const NETWORK_PATTERNS = [
  /\bfetch\(/,
  /\bhttp\.request\(/,
  /\bhttps\.request\(/,
  /\bhttps\.get\(/,
  /\bnet\.connect\(/,
  /\btls\.connect\(/,
  /\bdgram\./,
  /\bXMLHttpRequest\b/,
  /\bWebSocket\b/,
  /\bcreateConnection\(/,
];

const CHILD_PROCESS_PATTERNS = [
  /\bfrom\s+['"](?:node:)?child_process['"]/,
  /require\(\s*['"](?:node:)?child_process['"]\s*\)/,
  // No leading dot: otherwise false positive on RegExp.prototype.exec()
  // (e.g. PERSISTED_OUTPUT_RE.exec(...) in parse.mjs/scan.mjs), which has
  // nothing to do with child_process.exec().
  /(?<!\.)\bexecSync\(/,
  /(?<!\.)\bexec\(/,
  /(?<!\.)\bexecFile\(/,
  /(?<!\.)\bexecFileSync\(/,
  /(?<!\.)\bspawnSync\(/,
  /(?<!\.)\bspawn\(/,
  /(?<!\.)\bfork\(/,
];

const FORBIDDEN_PATTERNS = [...NETWORK_PATTERNS, ...CHILD_PROCESS_PATTERNS];

// Three sanctioned exceptions in the whole tree, all local process launches,
// never a network call — network patterns remain forbidden for these files
// too, only the child_process patterns are allowed:
//   - bin/cli.mjs uses child_process.spawn() to open the system default
//     browser locally (cmd/start, open, xdg-open).
//   - src/harness/* is the harness adapter: kaprek's whole job there is
//     spawning the user's locally installed, already-authenticated agent
//     CLI (e.g. `claude`) and speaking stream-json over stdio — never a
//     provider API call (fetch() stays forbidden here too).
//   - src/triggers/clipboard.mjs runs `powershell -NoProfile -Command
//     Get-Clipboard` via execFile (no shell) for the clipboard trigger: the
//     zero-dependency way to read the local clipboard on Windows.
const ALLOWED_CHILD_PROCESS_FILES = [path.join(ROOT, 'bin', 'cli.mjs'), path.join(ROOT, 'src', 'triggers', 'clipboard.mjs')];
const ALLOWED_CHILD_PROCESS_DIR = path.join(ROOT, 'src', 'harness');

function isAllowedChildProcessSource(file) {
  return ALLOWED_CHILD_PROCESS_FILES.includes(file) || file.startsWith(`${ALLOWED_CHILD_PROCESS_DIR}${path.sep}`);
}

/** Recursively collects all .mjs file paths under `dir`. */
function collectMjsFiles(dir) {
  const files = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...collectMjsFiles(full));
    } else if (entry.isFile() && full.endsWith('.mjs')) {
      files.push(full);
    }
  }
  return files;
}

function isTestFile(filePath) {
  return filePath.endsWith('.test.mjs');
}

test('static guard: no network-client or subprocess APIs outside test files (except bin/cli.mjs opening the browser and src/harness/* spawning the agent CLI)', () => {
  const srcFiles = collectMjsFiles(path.join(ROOT, 'src'));
  const binFiles = collectMjsFiles(path.join(ROOT, 'bin'));
  const sourceFiles = [...srcFiles, ...binFiles].filter((f) => !isTestFile(f));

  // Guard against a scan that silently finds nothing (e.g. wrong path after a refactor).
  expect(sourceFiles.length).toBeGreaterThan(0);

  const violations = [];
  for (const file of sourceFiles) {
    const content = fs.readFileSync(file, 'utf8');
    const isAllowedChildProcessFile = isAllowedChildProcessSource(file);
    for (const pattern of FORBIDDEN_PATTERNS) {
      if (isAllowedChildProcessFile && CHILD_PROCESS_PATTERNS.includes(pattern)) continue;
      if (pattern.test(content)) {
        violations.push(`${path.relative(ROOT, file)}: matches ${pattern}`);
      }
    }
  }
  expect(violations).toEqual([]);
});

test('root package.json declares no runtime dependencies', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  expect(pkg.dependencies).toBeUndefined();
});

test('web/package.json depends on exactly react and react-dom', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'web', 'package.json'), 'utf8'));
  expect(Object.keys(pkg.dependencies).sort()).toEqual(['react', 'react-dom']);
});
