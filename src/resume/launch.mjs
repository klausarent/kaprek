// Öffnet Tabs im laufenden Windows Terminal (wt -w 0 nt …).
// Ein Tab = Windows PowerShell (-NoExit) mit einem generierten Start-Skript,
// damit keine Quoting-Kette wt → powershell → claude nötig ist.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { spawn, execFileSync } from 'node:child_process';

const HOME = os.homedir();
// Where the one-shot .ps1 launch scripts go. The server passes
// <dataDir>/resume-cache/launch; tests pass a temp dir.
const DEFAULT_LAUNCH_DIR = path.join(os.tmpdir(), 'kaprek-resume-launch');

// existsSync folgt Reparse-Points; App-Execution-Aliase (WindowsApps\wt.exe) lassen
// sich nicht stat-en, wohl aber lstat-en.
function exists(p) {
  try { fs.lstatSync(p); return true; } catch { return false; }
}

export function findExe(name, fallbacks = []) {
  try {
    const out = execFileSync('where.exe', [name], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    const lines = out.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
    // npm-Shims: "codex" (sh) und "codex.cmd" — für PowerShell die .exe/.cmd bevorzugen
    const first = lines.find((l) => /\.(exe|cmd|bat)$/i.test(l)) || lines[0];
    if (first && exists(first)) return first;
  } catch {}
  for (const f of fallbacks) if (exists(f)) return f;
  return '';
}

export const PATHS = {
  wt: findExe('wt.exe', [path.join(HOME, 'AppData', 'Local', 'Microsoft', 'WindowsApps', 'wt.exe')]),
  claude: findExe('claude.exe', [path.join(HOME, '.local', 'bin', 'claude.exe')]),
  kimi: findExe('kimi.exe', [path.join(HOME, '.kimi-code', 'bin', 'kimi.exe')]),
  codex: findExe('codex', [path.join(process.env.APPDATA || '', 'npm', 'codex.cmd')]),
  grok: findExe('grok', [path.join(process.env.APPDATA || '', 'npm', 'grok.cmd'), path.join(HOME, '.grok', 'bin', 'grok.exe')]),
  powershell: path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
};

export function isElevated() {
  try {
    execFileSync('net.exe', ['session'], { stdio: 'ignore' });
    return true;
  } catch { return false; }
}

// PowerShell reads the typographic single quotes (U+2018, U+2019, U+201A,
// U+201B) as string delimiters too, so a path or a title carrying one would
// end a '…' literal early. Doubling works for all of them.
export function psQuote(s) {
  return `'${String(s).replace(/['‘’‚‛]/g, (q) => q + q)}'`;
}

// What Claude Code puts into the environment of everything it starts. A
// `claude` that inherits CLAUDE_CODE_CHILD_SESSION runs as a child session:
// no transcript is saved, so it cannot be resumed and is gone with its
// window. kaprek's server is often started by the SessionStart hook and
// inherits all of these, so no tab it opens may carry them.
export const SESSION_ENV_MARKERS = [
  'CLAUDECODE',
  'CLAUDE_CODE_CHILD_SESSION',
  'CLAUDE_CODE_ENTRYPOINT',
  'CLAUDE_CODE_EXECPATH',
  'CLAUDE_CODE_MESSAGING_SOCKET',
  'CLAUDE_CODE_MESSAGING_TOKEN',
  'CLAUDE_CODE_SESSION_ATTENDED',
  'CLAUDE_CODE_SESSION_ID',
  'CLAUDE_PID',
  // set for hooks, and the server is usually started by one
  'CLAUDE_PROJECT_DIR',
  'CLAUDE_ENV_FILE',
  'CLAUDE_PLUGIN_ROOT',
];

/** A copy of `env` without the markers of the session that started this process. */
export function tabEnv(env = process.env) {
  const out = { ...env };
  const markers = new Set(SESSION_ENV_MARKERS);
  for (const name of Object.keys(out)) {
    if (markers.has(name.toUpperCase())) delete out[name];
  }
  return out;
}

// Shell-Befehl, den der Nutzer auch selbst kopieren kann.
export function buildClaudeCommand(id) {
  return `claude --dangerously-skip-permissions --resume ${id}`;
}
export function buildKimiCommand(id) {
  return `kimi --yolo -S ${id}`;
}

/** `preamble`: extra PowerShell lines run before the working directory is set — written by kaprek, never built from session text. */
export function buildScript({ cwd, header, exe, args, preamble = [] }) {
  const lines = [
    // Whatever environment the tab ends up with — the one of the `wt` call or
    // one Windows Terminal built itself — the markers are dropped inside the
    // tab as well as in the spawn (see tabEnv).
    ...SESSION_ENV_MARKERS.map((name) => `Remove-Item -LiteralPath ${psQuote(`Env:${name}`)} -ErrorAction SilentlyContinue`),
    ...preamble,
    `$Host.UI.RawUI.WindowTitle = ${psQuote(header)}`,
    `Set-Location -LiteralPath ${psQuote(cwd)}`,
    `Write-Host ${psQuote('[session-launcher] ' + header)} -ForegroundColor DarkCyan`,
  ];
  if (exe) {
    lines.push(`Write-Host ${psQuote('> ' + [path.basename(exe), ...args].join(' '))} -ForegroundColor DarkGray`);
    lines.push(`& ${psQuote(exe)} ${args.map(psQuote).join(' ')}`);
  }
  return lines.join('\r\n') + '\r\n';
}

function safeSlug(s) {
  return String(s).replace(/[^A-Za-z0-9_-]+/g, '_').slice(0, 60);
}

// Startet einen Tab. Gibt { ok, method, script } zurück. `env` is the
// environment of the spawned terminal (default: this process's, minus the
// session markers); `preamble` goes into the start script, see buildScript.
export async function openTab({ cwd, title, exe, args = [], launchDir = DEFAULT_LAUNCH_DIR, env = tabEnv(), preamble = [] }) {
  if (!cwd || !fs.existsSync(cwd)) cwd = HOME;
  await fsp.mkdir(launchDir, { recursive: true });
  const script = path.join(launchDir, `${safeSlug(title)}_${process.pid}_${Date.now()}.ps1`);
  // With a BOM: Windows PowerShell 5.1 reads a script without one in the ANSI
  // code page, which turns every umlaut in a path or a title into garbage.
  await fsp.writeFile(script, `\uFEFF${buildScript({ cwd, header: title, exe, args, preamble })}`, 'utf8');

  const psArgs = ['-NoExit', '-NoLogo', '-ExecutionPolicy', 'Bypass', '-File', script];
  if (PATHS.wt) {
    // -w 0 = zuletzt benutztes Fenster (derselben Elevation); nt = neuer Tab
    const wtArgs = ['-w', '0', 'nt', '--title', title, '-d', cwd, PATHS.powershell, ...psArgs];
    await started(spawn(PATHS.wt, wtArgs, { detached: true, stdio: 'ignore', windowsHide: true, env }));
    return { ok: true, method: 'wt-tab', script };
  }
  // Fallback ohne Windows Terminal: eigenes Fenster
  await started(spawn(PATHS.powershell, psArgs, { detached: true, stdio: 'ignore', cwd, env }));
  return { ok: true, method: 'powershell-window', script };
}

// Resolves once the process exists, rejects when it could not be started.
// spawn() reports a missing or inaccessible executable as an 'error' EVENT,
// after it returned: without a listener that event is an uncaught exception
// (it takes the server down), and "a tab opened" would be reported for a
// terminal that never ran. Both events are emitted on a later tick, so
// listening right after spawn() misses neither.
function started(child) {
  return new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('spawn', () => {
      child.removeListener('error', reject);
      child.on('error', () => {}); // a late error of a detached terminal is not this process's to die of
      child.unref();
      resolve();
    });
  });
}

export function openClaudeSession(s, { skipPermissions = true, launchDir } = {}) {
  const { exe, args } = buildResumeArgs({ engine: 'claude', id: s.id }, { skip: skipPermissions });
  return openTab({ cwd: s.cwd, title: `CC · ${path.basename(s.cwd || '') || 'home'} · ${s.id.slice(0, 8)}`, exe, args, launchDir });
}

export function openKimiSession(s, { yolo = true, launchDir } = {}) {
  const { exe, args } = buildResumeArgs({ engine: 'kimi', id: s.id }, { skip: yolo });
  return openTab({ cwd: s.cwd, title: `Kimi · ${path.basename(s.cwd || '') || 'home'} · ${s.id.slice(-8)}`, exe, args, launchDir });
}

export function buildCodexCommand(id) {
  return `codex resume ${id} --dangerously-bypass-approvals-and-sandbox`;
}
export function buildGrokCommand(id) {
  return `grok --resume ${id} --permission-mode bypassPermissions`;
}

export function openCodexSession(s, { bypass = true, launchDir } = {}) {
  const { exe, args } = buildResumeArgs({ engine: 'codex', id: s.id }, { skip: bypass });
  return openTab({ cwd: s.cwd, title: `Codex · ${path.basename(s.cwd || '') || 'home'} · ${s.id.slice(-8)}`, exe, args, launchDir });
}

export function openGrokSession(s, { bypass = true, launchDir } = {}) {
  const { exe, args } = buildResumeArgs({ engine: 'grok', id: s.id }, { skip: bypass });
  return openTab({ cwd: s.cwd, title: `Grok · ${path.basename(s.cwd || '') || 'home'} · ${s.id.slice(-8)}`, exe, args, launchDir });
}

export function openShell(cwd) {
  return openTab({ cwd, title: `Shell · ${path.basename(cwd || '') || 'home'}`, exe: '', args: [] });
}

// Alte Start-Skripte wegräumen (älter als 1 Tag)
export async function cleanupScripts(launchDir = DEFAULT_LAUNCH_DIR) {
  try {
    const ents = await fsp.readdir(launchDir);
    const cutoff = Date.now() - 24 * 3600_000;
    for (const e of ents) {
      const p = path.join(launchDir, e);
      try { if ((await fsp.stat(p)).mtimeMs < cutoff) await fsp.unlink(p); } catch {}
    }
  } catch {}
}

/** What would be run, without running it — the testable half of a launch. */
export function buildResumeArgs(session, { skip = true } = {}) {
  const { engine, id } = session;
  if (engine === 'claude') return { exe: PATHS.claude, args: [...(skip ? ['--dangerously-skip-permissions'] : []), '--resume', id] };
  if (engine === 'kimi') return { exe: PATHS.kimi, args: [...(skip ? ['--yolo'] : []), '-S', id] };
  if (engine === 'codex') return { exe: PATHS.codex, args: ['resume', id, ...(skip ? ['--dangerously-bypass-approvals-and-sandbox'] : [])] };
  if (engine === 'grok') return { exe: PATHS.grok, args: ['--resume', id, ...(skip ? ['--permission-mode', 'bypassPermissions'] : [])] };
  throw new Error(`unknown engine: ${engine}`);
}

/** Opens the session as a new Windows Terminal tab. Mirrors the launcher's launchOne(). */
export async function resumeSession(session, { skip = true, launchDir = DEFAULT_LAUNCH_DIR } = {}) {
  try {
    const { exe } = buildResumeArgs(session, { skip });
    if (!exe) return { ok: false, error: `${session.engine} CLI not found on this machine` };
    const r = session.engine === 'claude' ? await openClaudeSession(session, { skipPermissions: skip, launchDir })
      : session.engine === 'kimi' ? await openKimiSession(session, { yolo: skip, launchDir })
      : session.engine === 'codex' ? await openCodexSession(session, { bypass: skip, launchDir })
      : session.engine === 'grok' ? await openGrokSession(session, { bypass: skip, launchDir })
      : null;
    if (!r) return { ok: false, error: `unknown engine: ${session.engine}` };
    return { ok: true, method: r.method };
  } catch (err) {
    return { ok: false, error: err?.message ?? String(err) };
  }
}
