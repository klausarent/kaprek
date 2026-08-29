// Keeping kaprek's memory in step with Klaus' own memory files — the
// `~/.claude/projects/<slug>/memory/*.md` notes Fable writes after every
// session, entirely independent of anything kaprek itself ever learned.
// Until now those two stores never met: kaprek only knew what a Stop hook
// harvested from inside a ```kaprek-remember block (see harvest.mjs), while
// the bulk of what Klaus actually knows sat in files kaprek never opened.
//
// Runs inside the SessionStart hook with a small budget (deadlineMs), same
// discipline as harvest.mjs: never throws, checks the clock after every
// file, and keeps just enough state (mtime, size, hash) to skip a file
// untouched since the last run without rereading it. No YAML parser — the
// frontmatter block is a handful of fixed-shape lines, read the way a human
// would read them.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { openMemory } from './store.mjs';
import { visibleScopes } from './scopes.mjs';
import { looksLikeSecret } from './import.mjs';

/** A description longer than this is truncated with an ellipsis rather than remembered whole — this block is a session-start line, not a briefing. */
export const MAX_TEXT_CHARS = 400;

const KNOWN_TYPE_PREFIXES = ['project', 'feedback', 'reference', 'user'];

/**
 * Klaus' own memory folder: `~/.claude/projects/<homedir-slug>/memory`,
 * where `<homedir-slug>` is the home directory path with `:`, `\` and `/`
 * turned into `-` — the same convention the memory files already live
 * under. `KAPREK_MEMORY_DIR` overrides it outright, for tests and for
 * anyone whose memory files live somewhere else.
 */
export function defaultMemoryDir({ homedir = os.homedir(), env = process.env } = {}) {
  if (typeof env.KAPREK_MEMORY_DIR === 'string' && env.KAPREK_MEMORY_DIR.trim() !== '') return env.KAPREK_MEMORY_DIR;
  const slug = homedir.replace(/[:\\/]/g, '-');
  return path.join(homedir, '.claude', 'projects', slug, 'memory');
}

function statePath(dataDir) {
  return path.join(dataDir, 'memory', 'sync-state.json');
}

function readState(file) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    return parsed && typeof parsed.files === 'object' && parsed.files !== null ? parsed.files : {};
  } catch {
    return {};
  }
}

function writeState(file, files) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ files }), 'utf8');
}

function readScopeMap(dataDir) {
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(dataDir, 'memory', 'scope-map.json'), 'utf8'));
    return parsed && typeof parsed.memory_slug_to_scope === 'object' && parsed.memory_slug_to_scope !== null ? parsed.memory_slug_to_scope : {};
  } catch {
    return {};
  }
}

/** Strips a leading and trailing `"` or `'` pair, if the value has one — the only quoting this reader understands. */
function unquote(value) {
  if (value.length >= 2) {
    const first = value[0];
    const last = value[value.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) return value.slice(1, -1);
  }
  return value;
}

/**
 * Reads `name`, `description` and `metadata.type` out of a frontmatter
 * block, line by line — no YAML parser, because every one of these files
 * has the same handful of top-level keys plus one indented block.
 * `description` routinely contains colons and quotes of its own (a
 * one-line project summary usually does), so everything after the first
 * `description:` on its line is taken as the value, not split further.
 * Returns null when the text has no frontmatter block at all (fewer than
 * two `---` lines).
 */
export function parseFrontmatter(text) {
  const lines = text.split(/\r?\n/);
  const dashes = [];
  for (let i = 0; i < lines.length && dashes.length < 2; i += 1) {
    if (lines[i].trim() === '---') dashes.push(i);
  }
  if (dashes.length < 2) return null;

  let name = null;
  let description = null;
  let type = null;
  let inMetadata = false;
  for (const line of lines.slice(dashes[0] + 1, dashes[1])) {
    const isTopLevel = line.length > 0 && !/^\s/.test(line);
    if (isTopLevel) {
      inMetadata = false;
      const nameMatch = /^name\s*:\s*(.*)$/.exec(line);
      if (nameMatch) {
        name = unquote(nameMatch[1].trim());
        continue;
      }
      const descMatch = /^description\s*:\s*(.*)$/.exec(line);
      if (descMatch) {
        description = unquote(descMatch[1].trim());
        continue;
      }
      if (/^metadata\s*:/.test(line)) inMetadata = true;
      continue;
    }
    if (inMetadata) {
      const typeMatch = /^\s+type\s*:\s*(.*)$/.exec(line);
      if (typeMatch) type = unquote(typeMatch[1].trim());
    }
  }
  return { name, description, type };
}

/** The filename stem with a known category prefix (`project_`, `feedback_`, `reference_`, `user_`) removed, if it has one — the same slugging scope-map.json's own keys use (`project_kaprek.md` -> `kaprek`). */
function slugFor(stem) {
  for (const prefix of KNOWN_TYPE_PREFIXES) {
    if (stem.startsWith(`${prefix}_`)) return stem.slice(prefix.length + 1);
  }
  return stem;
}

/**
 * Which scope a memory file belongs to: an exact scope-map hit first, then
 * the `project_<x>` -> `project:<x>` guess for a file whose slug already
 * matches a project folder's basename, then `person:local` — each only if
 * that scope already exists in this store. sync.mjs never creates a scope;
 * a file that resolves to nothing usable (including `person:local` itself
 * missing) is skipped rather than filed under a scope invented for it.
 */
export function resolveScopeId({ stem, scopeMap, existingScopeIds }) {
  const mapped = scopeMap[slugFor(stem)];
  if (typeof mapped === 'string' && existingScopeIds.has(mapped)) return mapped;

  const projectMatch = /^project_(.+)$/.exec(stem);
  if (projectMatch) {
    const candidate = `project:${projectMatch[1].replace(/_/g, '-')}`;
    if (existingScopeIds.has(candidate)) return candidate;
  }

  if (existingScopeIds.has('person:local')) return 'person:local';
  return null;
}

/**
 * Reads Klaus' own memory files and writes what they say into kaprek's
 * memory store, so a fresh kaprek — or one that has been offline a while —
 * catches up with what Fable already knows without a manual import.
 *
 * Idempotent and incremental: a file untouched since the last run (same
 * mtime and size) is not even reopened; one whose content changed is
 * reparsed and its description handed to `remember()`, which itself turns
 * a repeat into a confirmation rather than a duplicate — so a file whose
 * mtime moved without its content changing (a checkout, a touch) costs a
 * `memory.confirmed` event at worst, never a duplicate fact. Deleted files
 * are dropped from the state; nothing is ever un-remembered, the memory
 * log stays append-only like every other kaprek store.
 *
 * Never throws. A missing memory directory returns `{ scanned: 0 }` and
 * nothing else — the caller (the SessionStart hook) has a hard budget and
 * no business seeing this as an error.
 *
 * @param {object} [options]
 * @param {string} options.dataDir
 * @param {string} [options.memoryDir] - defaults to Klaus' own memory folder
 * @param {number} [options.deadlineMs]
 * @param {() => number} [options.now] - injected for the deadline check only; `remember()` keeps using the real clock
 */
/**
 * Handles one file: reads it if (and only if) it changed since the saved
 * state, updates `files[name]` in place, and reports what happened —
 * `'unchanged'`, `'skipped'` (no usable description, a secret, or no scope
 * to file it under) or `'written'`/`'confirmed'` (what `remember()` itself
 * returned). A file that cannot even be stat'd or read counts as
 * `'unchanged'`: there is nothing new to record, and no state to update.
 */
function syncOneFile({ memoryDir, name, files, scopeMap, existingScopeIds, memory }) {
  const fullPath = path.join(memoryDir, name);
  let stat;
  try {
    stat = fs.statSync(fullPath);
  } catch {
    return 'unchanged';
  }

  const previous = files[name];
  if (previous && previous.mtimeMs === stat.mtimeMs && previous.size === stat.size) return 'unchanged';

  let raw;
  try {
    raw = fs.readFileSync(fullPath, 'utf8');
  } catch {
    return 'unchanged';
  }

  files[name] = { mtimeMs: stat.mtimeMs, size: stat.size, sha256: crypto.createHash('sha256').update(raw).digest('hex') };

  const frontmatter = parseFrontmatter(raw);
  if (!frontmatter || typeof frontmatter.description !== 'string' || frontmatter.description.trim() === '') return 'skipped';

  let text = frontmatter.description.trim();
  if (text.length > MAX_TEXT_CHARS) text = `${text.slice(0, MAX_TEXT_CHARS - 1)}…`;
  if (looksLikeSecret(text)) return 'skipped';

  const stem = name.slice(0, -3); // strip '.md'
  const scopeId = resolveScopeId({ stem, scopeMap, existingScopeIds });
  if (!scopeId) return 'skipped';

  const kind = frontmatter.type === 'user' ? 'profile' : 'fact';
  try {
    const outcome = memory.remember({ scopeId, text, kind, origin: `memory-sync:${name}`, confidence: 0.9 });
    return outcome.confirmed ? 'confirmed' : 'written';
  } catch {
    return 'skipped';
  }
}

export function syncMemoryDir({ dataDir, memoryDir = defaultMemoryDir(), deadlineMs = 700, now = Date.now } = {}) {
  try {
    if (typeof dataDir !== 'string' || dataDir.trim() === '') return { scanned: 0 };
    if (typeof memoryDir !== 'string' || !fs.existsSync(memoryDir) || !fs.statSync(memoryDir).isDirectory()) return { scanned: 0 };

    const stateFile = statePath(dataDir);
    const files = readState(stateFile);
    const scopeMap = readScopeMap(dataDir);
    const memory = openMemory(dataDir);
    const existingScopeIds = new Set(memory.scopes().map((scope) => scope.id));

    const entries = fs
      .readdirSync(memoryDir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith('.md') && entry.name !== 'MEMORY.md')
      .map((entry) => entry.name)
      .sort();

    // A file no longer on disk is gone from the state too — append-only
    // means we never retract what it once said, but there is also nothing
    // left to compare it against on the next run.
    const present = new Set(entries);
    for (const name of Object.keys(files)) {
      if (!present.has(name)) delete files[name];
    }

    const started = now();
    let scanned = 0;
    let written = 0;
    let confirmed = 0;
    let skipped = 0;
    let deferred = false;

    for (const name of entries) {
      scanned += 1;
      const outcome = syncOneFile({ memoryDir, name, files, scopeMap, existingScopeIds, memory });
      if (outcome === 'written') written += 1;
      else if (outcome === 'confirmed') confirmed += 1;
      else if (outcome === 'skipped') skipped += 1;

      // Checked once per file, after it is fully handled — never mid-file,
      // so a file is either done or untouched, never half-remembered.
      if (now() - started > deadlineMs) {
        deferred = true;
        break;
      }
    }

    writeState(stateFile, files);
    return { scanned, written, confirmed, skipped, deferred };
  } catch {
    return { scanned: 0 };
  }
}
