// Scanner für Claude-Code- und Kimi-Sessions. Keine Dependencies.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import readline from 'node:readline';
import { readLedgerIndex } from '../ledger/sessions.mjs';

export const HOME = os.homedir();
// The four engines' session stores, read at call time (never captured once
// at import time) so a test — or --dir / a resume-home option — can point
// them elsewhere before the first scan. setStoreRoots() is the only writer.
export const STORES = {
  claudeProjects: path.join(HOME, '.claude', 'projects'),
  kimiHome: path.join(HOME, '.kimi-code'),
  codexSessions: path.join(HOME, '.codex', 'sessions'),
  grokSessions: path.join(HOME, '.grok', 'sessions'),
};

/**
 * Repoints one or more store roots. `home` sets all four relative to that
 * home directory; a named field overrides `home` for that one store. Used
 * by the server (--dir, a resume-home option) and by tests that must never
 * scan the real machine's session history.
 */
export function setStoreRoots({ home, claudeProjects, kimiHome, codexSessions, grokSessions } = {}) {
  if (home) {
    STORES.claudeProjects = path.join(home, '.claude', 'projects');
    STORES.kimiHome = path.join(home, '.kimi-code');
    STORES.codexSessions = path.join(home, '.codex', 'sessions');
    STORES.grokSessions = path.join(home, '.grok', 'sessions');
  }
  if (claudeProjects) STORES.claudeProjects = claudeProjects;
  if (kimiHome) STORES.kimiHome = kimiHome;
  if (codexSessions) STORES.codexSessions = codexSessions;
  if (grokSessions) STORES.grokSessions = grokSessions;
}
// Where scan results are cached between runs. The server sets this to
// <dataDir>/resume-cache; tests point it at a temp dir. Never the repo.
let CACHE_DIR = path.join(os.tmpdir(), 'kaprek-resume-cache');
const CACHE_VERSION = 3;
export function setCacheDir(dir) {
  CACHE_DIR = dir;
}

// ---------- Textbereinigung ----------

export function cleanText(t) {
  if (!t) return '';
  return String(t)
    .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '')
    .replace(/<command-message>[\s\S]*?<\/command-message>/g, '')
    .replace(/<command-args>[\s\S]*?<\/command-args>/g, '')
    .replace(/<\/?command-name>/g, '')
    .replace(/<local-command-stdout>[\s\S]*?<\/local-command-stdout>/g, '')
    .replace(/<task-notification>[\s\S]*?<\/task-notification>/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function userText(message) {
  const c = message?.content;
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) return c.filter((x) => x && x.type === 'text').map((x) => x.text).join(' ');
  return '';
}

// ---------- Klassifikation ----------

const AUTOMATED_PATTERNS = [
  /chronik-(tag|digest)-prompt/i, // agent-feldstudie Cron-Jobs
  /^\/?kiklaus-daily\b/i, // täglicher Content-Lauf
  /^kiklaus-daily\b/i,
];

export function classify(meta) {
  if (!meta.userMsgs) return { kind: 'empty', reason: 'keine Nutzer-Nachricht' };
  const first = meta.first || '';
  for (const re of AUTOMATED_PATTERNS) {
    if (re.test(first)) return { kind: 'automated', reason: 'Cron/Skill-Lauf' };
  }
  if (meta.userMsgs === 1 && /agent-feldstudie/i.test(meta.cwd || '')) {
    return { kind: 'automated', reason: 'agent-feldstudie Einzellauf' };
  }
  return { kind: 'interactive', reason: '' };
}

// Sessions, deren Datei-mtime weit nach der letzten Nachricht liegt UND die
// zusammen mit mindestens einer weiteren im selben Zeitfenster geschlossen wurden,
// sind mit hoher Wahrscheinlichkeit bei einem Crash/Neustart gemeinsam
// geschlossen worden. Reale Scan-Ergebnisse tragen immer `mtimeMs` (aus
// fsp.stat); fehlt es (z. B. bei handgebauten Session-Objekten in Tests),
// lässt sich der Gap zur Datei-mtime nicht prüfen — dann zählt die Nähe der
// `lastTs`-Werte allein als Kandidat.
export function markCrashGroups(sessions, { windowMs = 120_000, minMembers = 2, gapMs = 5 * 60_000 } = {}) {
  const key = (s) => s.mtimeMs ?? Date.parse(s.lastTs);
  const candidates = sessions
    .filter((s) => s.lastTs && (!s.mtimeMs || s.mtimeMs - Date.parse(s.lastTs) > gapMs))
    .sort((a, b) => key(a) - key(b));
  let group = [];
  const flush = () => {
    if (group.length >= minMembers) {
      const at = new Date(key(group[0])).toISOString();
      for (const s of group) s.crashGroup = at;
    }
    group = [];
  };
  for (const s of candidates) {
    if (group.length && key(s) - key(group[group.length - 1]) > windowMs) flush();
    group.push(s);
  }
  flush();
  return sessions;
}

// ---------- Claude-Transkript parsen ----------

export async function parseClaudeFile(file) {
  const rl = readline.createInterface({ input: fs.createReadStream(file, { encoding: 'utf8' }), crlfDelay: Infinity });
  const meta = { first: '', summary: '', cwd: '', firstTs: '', lastTs: '', userMsgs: 0, version: '', gitBranch: '', compacted: 0 };
  for await (const line of rl) {
    if (!line) continue;
    let o;
    try { o = JSON.parse(line); } catch { continue; }
    if (o.type === 'summary' && o.summary && !meta.summary) meta.summary = String(o.summary).slice(0, 200);
    if (o.cwd && !meta.cwd) meta.cwd = o.cwd;
    if (o.version && !meta.version) meta.version = o.version;
    if (o.gitBranch && !meta.gitBranch) meta.gitBranch = o.gitBranch;
    if (o.timestamp) { if (!meta.firstTs) meta.firstTs = o.timestamp; meta.lastTs = o.timestamp; }
    if (o.type === 'user' && o.message && !o.isMeta) {
      const txt = cleanText(userText(o.message));
      if (!txt || txt.startsWith('[Request interrupted')) continue;
      if (/^This session is being continued from a previous conversation/.test(txt)) { meta.compacted++; continue; }
      meta.userMsgs++;
      if (!meta.first) meta.first = txt.slice(0, 240);
    }
  }
  return meta;
}

function cacheFile(name) { return path.join(CACHE_DIR, `${name}-sessions.json`); }

async function loadCache(name) {
  try {
    const j = JSON.parse(await fsp.readFile(cacheFile(name), 'utf8'));
    if (j.version !== CACHE_VERSION) return {};
    return j.entries || {};
  } catch { return {}; }
}

async function saveCache(name, entries) {
  await fsp.mkdir(CACHE_DIR, { recursive: true });
  const file = cacheFile(name);
  const tmp = file + '.tmp';
  await fsp.writeFile(tmp, JSON.stringify({ version: CACHE_VERSION, entries }), 'utf8');
  await fsp.rename(tmp, file);
}

// ISO-Zeitstempel mit >3 Nachkommastellen (Grok: 9) auf JS-taugliche Form bringen
export function isoFix(ts) {
  return ts ? String(ts).replace(/\.(\d{3})\d+(Z|[+-]\d\d:\d\d)$/, '.$1$2') : '';
}

export function projectSlugToPath(slug) {
  // "C--Users-karent-Documents-Software" bzw. "-C--Users-karent-..." (führender
  // Strich je nach Claude-Version) → "C:\Users\karent\Documents\Software"
  // (heuristisch; cwd aus dem Transkript ist verlässlicher)
  const m = /^-?([A-Za-z])--(.*)$/.exec(slug);
  if (!m) return '';
  return `${m[1]}:\\${m[2].replace(/-/g, '\\')}`;
}

export async function scanClaude({ force = false, onProgress } = {}) {
  const cache = force ? {} : await loadCache('claude');
  const next = {};
  const out = [];
  let dirs = [];
  try { dirs = await fsp.readdir(STORES.claudeProjects, { withFileTypes: true }); } catch { return []; }
  const files = [];
  for (const d of dirs) {
    if (!d.isDirectory()) continue;
    const full = path.join(STORES.claudeProjects, d.name);
    let ents = [];
    try { ents = await fsp.readdir(full, { withFileTypes: true }); } catch { continue; }
    for (const e of ents) {
      if (!e.isFile() || !e.name.endsWith('.jsonl')) continue;
      files.push({ proj: d.name, file: path.join(full, e.name), id: e.name.slice(0, -6) });
    }
  }
  let done = 0;
  for (const f of files) {
    let st;
    try { st = await fsp.stat(f.file); } catch { continue; }
    const key = f.file;
    const cached = cache[key];
    let meta;
    if (cached && cached.mtimeMs === st.mtimeMs && cached.size === st.size) {
      meta = cached.meta;
    } else {
      try { meta = await parseClaudeFile(f.file); } catch { meta = null; }
      if (!meta) continue;
    }
    next[key] = { mtimeMs: st.mtimeMs, size: st.size, meta };
    done++;
    onProgress?.(done, files.length);
    const cwd = meta.cwd || projectSlugToPath(f.proj);
    const s = {
      engine: 'claude',
      id: f.id,
      project: f.proj,
      file: f.file,
      cwd,
      cwdExists: cwd ? fs.existsSync(cwd) : false,
      sizeBytes: st.size,
      mtimeMs: st.mtimeMs,
      firstTs: meta.firstTs,
      lastTs: meta.lastTs,
      userMsgs: meta.userMsgs,
      compacted: meta.compacted,
      title: meta.summary || meta.first || '(leer)',
      first: meta.first,
      summary: meta.summary,
      gitBranch: meta.gitBranch,
    };
    Object.assign(s, classify(meta));
    out.push(s);
  }
  await saveCache('claude', next);
  markCrashGroups(out);
  out.sort((a, b) => (Date.parse(b.lastTs) || b.mtimeMs) - (Date.parse(a.lastTs) || a.mtimeMs));
  return out;
}

// ---------- Kimi ----------

async function kimiFirstPrompt(sessionDir) {
  const wire = path.join(sessionDir, 'agents', 'main', 'wire.jsonl');
  if (!fs.existsSync(wire)) return '';
  const rl = readline.createInterface({ input: fs.createReadStream(wire, { encoding: 'utf8', end: 512 * 1024 }), crlfDelay: Infinity });
  for await (const line of rl) {
    let o;
    try { o = JSON.parse(line); } catch { continue; }
    const s = JSON.stringify(o);
    // Verschiedene Wire-Formate: grob nach erstem Nutzer-Text suchen
    const m = /"role":"user"[\s\S]*?"(?:text|content)":"((?:[^"\\]|\\.){1,300})/.exec(s);
    if (m) { rl.close(); return cleanText(m[1].replace(/\\n/g, ' ').replace(/\\"/g, '"')); }
  }
  return '';
}

export async function scanKimi() {
  const sessionsRoot = path.join(STORES.kimiHome, 'sessions');
  let workspaces = {};
  try { workspaces = JSON.parse(await fsp.readFile(path.join(STORES.kimiHome, 'workspaces.json'), 'utf8')).workspaces || {}; } catch {}
  let wds = [];
  try { wds = await fsp.readdir(sessionsRoot, { withFileTypes: true }); } catch { return []; }
  const out = [];
  for (const wd of wds) {
    if (!wd.isDirectory()) continue;
    const wdRoot = workspaces[wd.name]?.root || '';
    const wdPath = path.join(sessionsRoot, wd.name);
    let ents = [];
    try { ents = await fsp.readdir(wdPath, { withFileTypes: true }); } catch { continue; }
    for (const e of ents) {
      if (!e.isDirectory()) continue;
      const dir = path.join(wdPath, e.name);
      let state = {};
      try { state = JSON.parse(await fsp.readFile(path.join(dir, 'state.json'), 'utf8')); } catch {}
      let st;
      try { st = await fsp.stat(dir); } catch { continue; }
      const cwd = state.cwd || wdRoot || HOME;
      let title = state.title || state.lastPrompt || '';
      if (!title) title = await kimiFirstPrompt(dir);
      const agentCount = state.agents ? Object.keys(state.agents).length : 0;
      // letzte Aktivität: wire.jsonl-mtime des main-Agenten, sonst Ordner-mtime
      let lastMs = st.mtimeMs;
      try { lastMs = (await fsp.stat(path.join(dir, 'agents', 'main', 'wire.jsonl'))).mtimeMs; } catch {}
      out.push({
        engine: 'kimi',
        kind: 'interactive',
        reason: '',
        id: e.name,
        project: wd.name,
        file: dir,
        cwd: cwd.replace(/\//g, '\\'),
        cwdExists: fs.existsSync(cwd),
        sizeBytes: 0,
        mtimeMs: lastMs,
        firstTs: state.createdAt || new Date(st.birthtimeMs || st.mtimeMs).toISOString(),
        lastTs: state.updatedAt && Date.parse(state.updatedAt) > lastMs ? state.updatedAt : new Date(lastMs).toISOString(),
        userMsgs: agentCount ? 1 : 0,
        subagents: Math.max(0, agentCount - 1),
        imported: !!state.custom?.imported_from_kimi_cli,
        title: title || '(ohne Titel)',
        first: title,
      });
    }
  }
  out.sort((a, b) => Date.parse(b.lastTs) - Date.parse(a.lastTs));
  return out;
}

// ---------- Codex (OpenAI / ChatGPT) ----------
// ~/.codex/sessions/YYYY/MM/DD/rollout-<ts>-<uuid>.jsonl; erste Zeile session_meta.

const CODEX_AUTOMATED_ORIGINATORS = new Set(['codex_exec', 'kaprek', 'kaprek-probe']);

export function classifyCodex(meta) {
  if (meta.parentThreadId) return { kind: 'automated', reason: 'Subagent-Thread' };
  if (meta.source === 'exec' || CODEX_AUTOMATED_ORIGINATORS.has(meta.originator)) {
    return { kind: 'automated', reason: `${meta.originator || 'exec'} (headless)` };
  }
  if (!meta.userMsgs) return { kind: 'empty', reason: 'keine Nutzer-Nachricht' };
  return { kind: 'interactive', reason: '' };
}

export async function parseCodexFile(file) {
  const rl = readline.createInterface({ input: fs.createReadStream(file, { encoding: 'utf8' }), crlfDelay: Infinity });
  const meta = { sessionId: '', cwd: '', originator: '', source: '', parentThreadId: '', firstTs: '', lastTs: '', userMsgs: 0, first: '' };
  for await (const line of rl) {
    if (!line) continue;
    let o;
    try { o = JSON.parse(line); } catch { continue; }
    const p = o.payload || {};
    if (o.timestamp) { if (!meta.firstTs) meta.firstTs = o.timestamp; meta.lastTs = o.timestamp; }
    if (o.type === 'session_meta' && !meta.sessionId) {
      meta.sessionId = p.session_id || p.id || '';
      meta.cwd = p.cwd || '';
      meta.originator = p.originator || '';
      meta.source = typeof p.source === 'string' ? p.source : (p.source ? 'sub' : '');
      meta.parentThreadId = p.parent_thread_id || '';
      continue;
    }
    if (o.type === 'response_item' && p.type === 'message' && p.role === 'user') {
      let t = (Array.isArray(p.content) ? p.content : []).map((c) => c?.text || '').join(' ');
      t = t.replace(/<(recommended_plugins|environment_context|user_instructions|permissions instructions|turn_aborted)>[\s\S]*?<\/\1>/g, '').replace(/\s+/g, ' ').trim();
      if (!t || t.startsWith('<')) continue;
      meta.userMsgs++;
      if (!meta.first) meta.first = t.slice(0, 240);
    }
  }
  return meta;
}

export async function scanCodex({ force = false, onProgress } = {}) {
  const cache = force ? {} : await loadCache('codex');
  const next = {};
  const out = [];
  const files = [];
  const walk = async (d) => {
    let ents = [];
    try { ents = await fsp.readdir(d, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) await walk(p);
      else if (e.isFile() && e.name.endsWith('.jsonl')) files.push(p);
    }
  };
  await walk(STORES.codexSessions);
  let done = 0;
  for (const file of files) {
    let st;
    try { st = await fsp.stat(file); } catch { continue; }
    const cached = cache[file];
    let meta;
    if (cached && cached.mtimeMs === st.mtimeMs && cached.size === st.size) meta = cached.meta;
    else { try { meta = await parseCodexFile(file); } catch { continue; } }
    next[file] = { mtimeMs: st.mtimeMs, size: st.size, meta };
    done++;
    onProgress?.(done, files.length);
    const id = meta.sessionId || (/-([0-9a-f-]{36})\.jsonl$/i.exec(file) || [])[1] || path.basename(file, '.jsonl');
    const cwd = meta.cwd || HOME;
    const s = {
      engine: 'codex', id, project: path.basename(path.dirname(file)), file, cwd,
      cwdExists: fs.existsSync(cwd), sizeBytes: st.size, mtimeMs: st.mtimeMs,
      firstTs: meta.firstTs, lastTs: meta.lastTs, userMsgs: meta.userMsgs, compacted: 0,
      title: meta.first || '(leer)', first: meta.first, summary: '',
      originator: meta.originator, source: meta.source,
    };
    Object.assign(s, classifyCodex(meta));
    out.push(s);
  }
  await saveCache('codex', next);
  markCrashGroups(out);
  out.sort((a, b) => (Date.parse(b.lastTs) || b.mtimeMs) - (Date.parse(a.lastTs) || a.mtimeMs));
  return out;
}

// ---------- Grok (xAI Grok Build) ----------
// ~/.grok/sessions/<url-encodierter cwd>/<uuid>/summary.json (+ signals.json)

export function classifyGrok(meta) {
  if (/\\AppData\\Local\\Temp\\|[\\/]\.kaprek([\\/]|$)/i.test(meta.cwd || '')) return { kind: 'automated', reason: 'Temp/kaprek-Lauf' };
  if (!meta.userMsgs) return { kind: 'empty', reason: 'keine Nutzer-Nachricht' };
  // Headless `grok -p` (Peer-Reviews) hinterlässt genau einen Turn; echte Sitzungen haben mehrere.
  if (meta.turns != null && meta.turns <= 1) return { kind: 'automated', reason: 'Einzel-Turn (grok -p?)' };
  return { kind: 'interactive', reason: '' };
}

export async function scanGrok() {
  let cwdDirs = [];
  try { cwdDirs = await fsp.readdir(STORES.grokSessions, { withFileTypes: true }); } catch { return []; }
  const out = [];
  for (const cd of cwdDirs) {
    if (!cd.isDirectory()) continue;
    let cwdFromDir = '';
    try { cwdFromDir = decodeURIComponent(cd.name); } catch {}
    const base = path.join(STORES.grokSessions, cd.name);
    let ents = [];
    try { ents = await fsp.readdir(base, { withFileTypes: true }); } catch { continue; }
    for (const e of ents) {
      if (!e.isDirectory()) continue;
      const dir = path.join(base, e.name);
      let sum = null, sig = null, st;
      try { sum = JSON.parse(await fsp.readFile(path.join(dir, 'summary.json'), 'utf8')); } catch {}
      try { sig = JSON.parse(await fsp.readFile(path.join(dir, 'signals.json'), 'utf8')); } catch {}
      try { st = await fsp.stat(dir); } catch { continue; }
      if (!sum && !fs.existsSync(path.join(dir, 'chat_history.jsonl'))) continue;
      const cwd = sum?.info?.cwd || cwdFromDir || HOME;
      const lastTs = isoFix(sum?.last_active_at || sum?.updated_at) || new Date(st.mtimeMs).toISOString();
      const meta = { cwd, userMsgs: sig?.userMessageCount ?? (sum?.num_chat_messages ? 1 : 0), turns: sum?.next_trace_turn ?? sig?.turnCount ?? null };
      const s = {
        engine: 'grok', id: sum?.info?.id || e.name, project: path.basename(cwd), file: dir, cwd,
        cwdExists: fs.existsSync(cwd), sizeBytes: 0, mtimeMs: st.mtimeMs,
        firstTs: isoFix(sum?.created_at), lastTs, userMsgs: meta.userMsgs, compacted: sig?.compactionCount || 0,
        title: sum?.session_summary || sum?.generated_title || '(ohne Titel)', first: '', summary: '',
        model: sum?.current_model_id || '',
      };
      Object.assign(s, classifyGrok(meta));
      out.push(s);
    }
  }
  out.sort((a, b) => Date.parse(b.lastTs) - Date.parse(a.lastTs));
  return out;
}

/** One shape for all four engines — the launcher's internals stay internal. */
export function publicSession(s) {
  return {
    key: `${s.engine}:${s.id}`,
    engine: s.engine,
    id: s.id,
    cwd: s.cwd ?? '',
    title: cleanText(s.title ?? '(ohne Titel)').slice(0, 200),
    firstTs: s.firstTs ?? s.lastTs ?? '',
    lastTs: s.lastTs ?? '',
    userMsgs: Number.isFinite(s.userMsgs) ? s.userMsgs : 0,
    hidden: s.hidden === true,
    // markCrashGroups() stamps the group's timestamp onto `crashGroup`
    // (not a boolean) — a real value there means "part of a crash group".
    crash: Boolean(s.crashGroup),
    // Set by attachLedgerInfo() below for claude sessions the ledger knows
    // about; null for every other engine, and for a claude session the
    // ledger has never heard from (a headless/cron run, or one that ran
    // before the SessionStart hook was installed).
    ledger: s.ledger ?? null,
  };
}

/**
 * Attaches `{ open, lastType, endReason }` (see src/ledger/sessions.mjs::
 * readLedgerIndex) to every `claude` session whose id the ledger has an
 * entry for, matching on `s.id` — the same id scanClaude() derives from the
 * transcript's filename, which is also the `sessionId` every kaprek hook
 * writes to the ledger. Sessions of other engines, and claude sessions
 * absent from the index, pass through unchanged. Works on either the raw
 * per-engine session shape or the public one — both carry `.engine`/`.id`.
 */
export function attachLedgerInfo(sessions, ledgerIndex) {
  if (!ledgerIndex) return sessions;
  return sessions.map((s) => {
    if (s.engine !== 'claude') return s;
    const entry = ledgerIndex.get(s.id);
    if (!entry) return s;
    return { ...s, ledger: { open: entry.lastType !== 'end', lastType: entry.lastType, endReason: entry.endReason ?? null } };
  });
}

/**
 * Drops `claude` sessions the terminal-session ledger has never heard of —
 * scanClaude() alone cannot tell an interactive session someone is
 * mid-conversation with apart from a headless/cron run that shares the same
 * `~/.claude/projects` store. Other engines are untouched, and `unfiltered`
 * (`kaprek resume --unfiltered` / `?unfiltered=1`) turns this off entirely,
 * exactly reproducing behavior from before this filter existed — including
 * for a claude session whose ledger entry says it already ended; that
 * distinction is `ledger.open`, handled by the caller, not by this filter.
 */
export function filterToLedgerSessions(sessions, ledgerIndex, { unfiltered = false } = {}) {
  if (unfiltered || !ledgerIndex) return sessions;
  return sessions.filter((s) => s.engine !== 'claude' || s.ledger != null);
}

/**
 * Every engine's sessions, newest first. An engine whose store is missing
 * contributes nothing, not an error.
 *
 * `dataDir`, if given, turns on the terminal-session ledger filter for the
 * `claude` engine (see filterToLedgerSessions() above) and attaches
 * `ledger: { open, lastType, endReason }` to every claude session the
 * ledger knows about; omit it (existing callers, most tests) and this
 * behaves exactly as it always did — nothing filtered, `ledger` always
 * null. `unfiltered: true` keeps the `ledger` field but turns the filter
 * off, same as `dataDir` being absent, for exactly the sessions a headless
 * run would otherwise hide.
 *
 * Filtering happens BEFORE markCrashGroups() runs, not after: a headless
 * probe closing near the same time as one real terminal session must not
 * make that session look like part of a multi-session crash group once the
 * probe itself is filtered out of the list.
 */
export async function scanAll({ force = false, dataDir, unfiltered = false } = {}) {
  const parts = await Promise.all([
    scanClaude({ force }).catch(() => []),
    scanCodex({ force }).catch(() => []),
    scanGrok().catch(() => []),
    scanKimi().catch(() => []),
  ]);
  let all = parts.flat();
  if (dataDir) {
    let ledgerIndex = null;
    try {
      ledgerIndex = readLedgerIndex(dataDir);
    } catch {
      ledgerIndex = null;
    }
    all = filterToLedgerSessions(attachLedgerInfo(all, ledgerIndex), ledgerIndex, { unfiltered });
  }
  markCrashGroups(all);
  const sessions = all.map(publicSession).sort((a, b) => (a.lastTs < b.lastTs ? 1 : -1));
  return { sessions, scannedAt: new Date().toISOString() };
}
