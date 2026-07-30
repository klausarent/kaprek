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

// Split out because src/lib/instance-lock.mjs is allowed exactly this one
// call, to 127.0.0.1 only — see ALLOWED_LOOPBACK_CONNECT_FILE below.
const LOOPBACK_CONNECT_PATTERN = /\bnet\.connect\(/;

const NETWORK_PATTERNS = [
  /\bfetch\(/,
  /\bhttp\.request\(/,
  /\bhttps\.request\(/,
  /\bhttps\.get\(/,
  LOOPBACK_CONNECT_PATTERN,
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

// One sanctioned outbound connect in the whole tree: the instance lock asks
// whoever holds its derived port whether they are a kaprek on the same data
// dir (see src/lib/instance-lock.mjs). That is a connect to 127.0.0.1 and
// nothing else — the loopback test below pins it there, so this exemption
// cannot quietly widen into a real network call. Every other network
// pattern, fetch() first among them, stays forbidden in that file too.
const ALLOWED_LOOPBACK_CONNECT_FILE = path.join(ROOT, 'src', 'lib', 'instance-lock.mjs');

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
      if (file === ALLOWED_LOOPBACK_CONNECT_FILE && pattern === LOOPBACK_CONNECT_PATTERN) continue;
      if (pattern.test(content)) {
        violations.push(`${path.relative(ROOT, file)}: matches ${pattern}`);
      }
    }
  }
  expect(violations).toEqual([]);
});

test('the instance lock only ever talks to 127.0.0.1', () => {
  // Pins the one exemption above. The lock derives a port from the data dir
  // path and asks whoever holds it whether they are a kaprek on that same
  // dir; if a hostname or a second address ever appears in this file, the
  // exemption is no longer about loopback and this test has to be the thing
  // that says so.
  const content = fs.readFileSync(ALLOWED_LOOPBACK_CONNECT_FILE, 'utf8');
  const addresses = [...content.matchAll(/\d{1,3}(?:\.\d{1,3}){3}/g)].map((match) => match[0]);
  expect([...new Set(addresses)]).toEqual(['127.0.0.1']);

  // Every host this module names, named once. Grepping for the word
  // "localhost" would hit the module's own explanation of why it must never
  // let the host default to it (that default resolves to ::1 first, and a
  // probe that interviews the wrong IP stack reported a healthy holder as a
  // stranger). So pin the values instead of the prose: every `host:` must be
  // the one constant, and that constant must be loopback.
  expect(content).toMatch(/const LOCK_HOST = '127\.0\.0\.1';/);
  const hosts = [...content.matchAll(/\bhost:\s*([^,\s}]+)/g)].map((match) => match[1]);
  expect(hosts.length).toBeGreaterThan(0);
  expect([...new Set(hosts)]).toEqual(['LOCK_HOST']);
});

test('root package.json declares no runtime dependencies', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  expect(pkg.dependencies).toBeUndefined();
});

test('web/package.json depends on exactly react and react-dom', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'web', 'package.json'), 'utf8'));
  expect(Object.keys(pkg.dependencies).sort()).toEqual(['react', 'react-dom']);
});
