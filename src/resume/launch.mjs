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

function psQuote(s) {
  return `'${String(s).replace(/'/g, "''")}'`;
}

// Shell-Befehl, den der Nutzer auch selbst kopieren kann.
export function buildClaudeCommand(id) {
  return `claude --dangerously-skip-permissions --resume ${id}`;
}
export function buildKimiCommand(id) {
  return `kimi --yolo -S ${id}`;
}

export function buildScript({ cwd, header, exe, args }) {
  const lines = [
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

// Startet einen Tab. Gibt { ok, method, script } zurück.
export async function openTab({ cwd, title, exe, args = [], launchDir = DEFAULT_LAUNCH_DIR }) {
  if (!cwd || !fs.existsSync(cwd)) cwd = HOME;
  await fsp.mkdir(launchDir, { recursive: true });
  const script = path.join(launchDir, `${safeSlug(title)}_${process.pid}_${Date.now()}.ps1`);
  await fsp.writeFile(script, buildScript({ cwd, header: title, exe, args }), 'utf8');

  const psArgs = ['-NoExit', '-NoLogo', '-ExecutionPolicy', 'Bypass', '-File', script];
  if (PATHS.wt) {
    // -w 0 = zuletzt benutztes Fenster (derselben Elevation); nt = neuer Tab
    const wtArgs = ['-w', '0', 'nt', '--title', title, '-d', cwd, PATHS.powershell, ...psArgs];
    const child = spawn(PATHS.wt, wtArgs, { detached: true, stdio: 'ignore', windowsHide: true });
    child.unref();
    return { ok: true, method: 'wt-tab', script };
  }
  // Fallback ohne Windows Terminal: eigenes Fenster
  const child = spawn(PATHS.powershell, psArgs, { detached: true, stdio: 'ignore', cwd });
  child.unref();
  return { ok: true, method: 'powershell-window', script };
}

export function openClaudeSession(s, { skipPermissions = true, launchDir } = {}) {
  const args = [];
  if (skipPermissions) args.push('--dangerously-skip-permissions');
  args.push('--resume', s.id);
  return openTab({ cwd: s.cwd, title: `CC · ${path.basename(s.cwd || '') || 'home'} · ${s.id.slice(0, 8)}`, exe: PATHS.claude, args, launchDir });
}

export function openKimiSession(s, { yolo = true, launchDir } = {}) {
  const args = [];
  if (yolo) args.push('--yolo');
  args.push('-S', s.id);
  return openTab({ cwd: s.cwd, title: `Kimi · ${path.basename(s.cwd || '') || 'home'} · ${s.id.slice(-8)}`, exe: PATHS.kimi, args, launchDir });
}

export function buildCodexCommand(id) {
  return `codex resume ${id} --dangerously-bypass-approvals-and-sandbox`;
}
export function buildGrokCommand(id) {
  return `grok --resume ${id} --permission-mode bypassPermissions`;
}

export function openCodexSession(s, { bypass = true, launchDir } = {}) {
  const args = ['resume', s.id];
  if (bypass) args.push('--dangerously-bypass-approvals-and-sandbox');
  return openTab({ cwd: s.cwd, title: `Codex · ${path.basename(s.cwd || '') || 'home'} · ${s.id.slice(-8)}`, exe: PATHS.codex, args, launchDir });
}

export function openGrokSession(s, { bypass = true, launchDir } = {}) {
  const args = ['--resume', s.id];
  if (bypass) args.push('--permission-mode', 'bypassPermissions');
  return openTab({ cwd: s.cwd, title: `Grok · ${path.basename(s.cwd || '') || 'home'} · ${s.id.slice(-8)}`, exe: PATHS.grok, args, launchDir });
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
