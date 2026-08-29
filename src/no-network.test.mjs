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
import { test, it, expect } from 'vitest';
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
//   - src/cli/update.mjs spawns `npm install -g kaprek@latest` when someone
//     typed `kaprek update`, and is ALSO the one file allowed to make a
//     real outbound request (see ALLOWED_REGISTRY_FILE below).
//   - src/server/notify.mjs runs the ONE command the user put in
//     notify.json when a question is parked. kaprek ships no channels of its
//     own (that is on the kill list by name), so this is how a person gets
//     told. Pinned below: never through a shell, and the question's text
//     goes in on stdin rather than as an argument — an agent chooses what a
//     tool is called, and that text must never become part of a command line.
//   - src/resume/launch.mjs opens the user's own already-authenticated agent
//     CLIs as terminal tabs (kaprek resume).
//   - src/server/ensure.mjs spawns a second, detached kaprek process
//     (bin/cli.mjs --no-open, this same package's own entrypoint — see the
//     spawn-argument pin below) when a Claude Code SessionStart hook fires
//     and no instance is running yet: kaprek starting itself, not a foreign
//     command.
const ALLOWED_CHILD_PROCESS_FILES = [
  path.join(ROOT, 'bin', 'cli.mjs'),
  path.join(ROOT, 'src', 'triggers', 'clipboard.mjs'),
  path.join(ROOT, 'src', 'cli', 'update.mjs'),
  path.join(ROOT, 'src', 'server', 'notify.mjs'),
  path.join(ROOT, 'src', 'resume', 'launch.mjs'),
  path.join(ROOT, 'src', 'server', 'ensure.mjs'),
];
const ALLOWED_CHILD_PROCESS_DIR = path.join(ROOT, 'src', 'harness');

function isAllowedChildProcessSource(file) {
  return ALLOWED_CHILD_PROCESS_FILES.includes(file) || file.startsWith(`${ALLOWED_CHILD_PROCESS_DIR}${path.sep}`);
}

// Two sanctioned outbound connects in the whole tree, both to 127.0.0.1 and
// nothing else — the loopback test below pins both, so neither exemption can
// quietly widen into a real network call:
//   - the instance lock asks whoever holds its derived port whether they are
//     a kaprek on the same data dir (src/lib/instance-lock.mjs).
//   - src/server/ensure.mjs asks whether the port named in instance.lock is
//     actually accepting connections, before deciding whether to spawn a
//     second kaprek.
// Every other network pattern, fetch() first among them, stays forbidden in
// both files too.
const ALLOWED_LOOPBACK_CONNECT_FILES = [path.join(ROOT, 'src', 'lib', 'instance-lock.mjs'), path.join(ROOT, 'src', 'server', 'ensure.mjs')];

// THE ONE FILE THAT MAY LEAVE THIS MACHINE, and it exists to be that: an
// update command that cannot ask what the newest version is would be a
// button that does nothing. It is confined to the npm registry (pinned by
// the test below), it runs only when someone typed `kaprek update`, and it
// prints what it is about to do first. Nothing else in the tree may do this
// — the guard is what keeps "kaprek does not phone home" a fact rather than
// an intention.
const ALLOWED_REGISTRY_FILE = path.join(ROOT, 'src', 'cli', 'update.mjs');

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
      if (ALLOWED_LOOPBACK_CONNECT_FILES.includes(file) && pattern === LOOPBACK_CONNECT_PATTERN) continue;
      // The update command's registry call. Confined by the test below to
      // registry.npmjs.org and nothing else.
      if (file === ALLOWED_REGISTRY_FILE && NETWORK_PATTERNS.includes(pattern)) continue;
      if (pattern.test(content)) {
        violations.push(`${path.relative(ROOT, file)}: matches ${pattern}`);
      }
    }
  }
  expect(violations).toEqual([]);
});

test('the notifier never runs anything through a shell', () => {
  const content = fs.readFileSync(path.join(ROOT, 'src', 'server', 'notify.mjs'), 'utf8');
  // The exemption above is only defensible while this holds: the command
  // comes from a file the user wrote, but the TEXT comes from an agent.
  expect(content).toMatch(/shell:\s*false/);
  expect(content).not.toMatch(/shell:\s*true/);
});

it('src/resume/launch.mjs spawns only wt.exe / powershell.exe / where.exe / net.exe and never a shell string', () => {
  const src = fs.readFileSync(path.join(ROOT, 'src', 'resume', 'launch.mjs'), 'utf8');
  expect(src).not.toMatch(/\bexec\(/);
  expect(src).not.toMatch(/shell:\s*true/);
  expect(src).toMatch(/execFileSync\('where\.exe'/);
  expect(src).toMatch(/execFileSync\('net\.exe'/);
  expect(src).toMatch(/spawn\(PATHS\.wt,/);
  expect(src).toMatch(/spawn\(PATHS\.powershell,/);
});

test('the update command talks to the npm registry and to nothing else', () => {
  const content = fs.readFileSync(ALLOWED_REGISTRY_FILE, 'utf8');
  // Every absolute URL in the file, so a second host cannot be added
  // without this failing. The exemption above is only defensible while this
  // stays exactly one address.
  const urls = [...content.matchAll(/https?:\/\/[^'"`\s)]+/g)].map((match) => match[0]);
  expect(urls).toEqual(['https://registry.npmjs.org/kaprek/latest']);
});

test('the instance lock only ever talks to 127.0.0.1', () => {
  // Pins one of the two loopback exemptions above. The lock derives a port
  // from the data dir path and asks whoever holds it whether they are a
  // kaprek on that same dir; if a hostname or a second address ever appears
  // in this file, the exemption is no longer about loopback and this test
  // has to be the thing that says so.
  const content = fs.readFileSync(ALLOWED_LOOPBACK_CONNECT_FILES[0], 'utf8');
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

  // Both pins, separately. The set check above survives losing either one as
  // long as the other remains — and losing the probe's pin is exactly the
  // defect this file is here to prevent. The behavioural proof lives in
  // instance-lock.test.mjs ("the probe talks to the same IP stack the holder
  // bound"); these two lines make the static guard fail for the same reason.
  expect(content).toMatch(/net\.connect\([^;]*host:\s*LOCK_HOST/);
  expect(content).toMatch(/\.listen\([^;]*host:\s*LOCK_HOST/);
});

test('the autostart aliveness probe only ever talks to 127.0.0.1', () => {
  // Pins the other loopback exemption. src/server/ensure.mjs decides whether
  // to spawn a second kaprek based on whether the port named in
  // instance.lock answers, never by resolving a hostname — the same
  // ::1-vs-127.0.0.1 trap instance-lock.mjs documents for net.connect's
  // default host.
  const content = fs.readFileSync(ALLOWED_LOOPBACK_CONNECT_FILES[1], 'utf8');
  const addresses = [...content.matchAll(/\d{1,3}(?:\.\d{1,3}){3}/g)].map((match) => match[0]);
  expect([...new Set(addresses)]).toEqual(['127.0.0.1']);
  expect(content).toMatch(/net\.connect\(\{[^}]*host:\s*'127\.0\.0\.1'/);
});

test('the autostart spawn only ever launches this same package\'s bin/cli.mjs, detached, with --no-open', () => {
  // Pins the child-process exemption for src/server/ensure.mjs: it must stay
  // "kaprek launches another kaprek", never grow into running an arbitrary
  // command.
  const content = fs.readFileSync(path.join(ROOT, 'src', 'server', 'ensure.mjs'), 'utf8');
  expect(content).toMatch(/spawn\(execPath,\s*\[cliPath,\s*'--no-open'\]/);
  expect(content).toMatch(/detached:\s*true/);
});

test('root package.json declares no runtime dependencies', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  expect(pkg.dependencies).toBeUndefined();
});

test('web/package.json depends on exactly react and react-dom', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'web', 'package.json'), 'utf8'));
  expect(Object.keys(pkg.dependencies).sort()).toEqual(['react', 'react-dom']);
});
