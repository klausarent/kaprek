// Posture and hard denials — the two guards that turn "fail-closed" from a
// sentence in the README into a setting a receipt can name.
//
// POSTURE is one dial with three positions, in the vocabulary the chat
// picker already uses: `ask` (everything write-shaped asks), `edits`
// (edits run free), `auto` (nothing asks). It is a CEILING, not a default:
// a turn may pick any stance up to it, never past it. The global dial lives
// in policy.json; a mission may set its own, and a mission's dial can only
// be stricter than the global one — a narrower scope tightens, it never
// loosens (qm's rule, the one worth copying). A request past the ceiling
// is refused with the reason, not clamped: a picker that says "auto" while
// the turn runs "edits" would be lying.
//
// HARD DENIALS hold in every posture, including `auto`. They are the short
// list of things no agent turn gets to do on this machine no matter what
// the person clicked: writing an agent's own configuration (the reverse-
// skill finding — a skill that rewrites ~/.claude is a skill that rewrites
// the next session's rules), and a recursive delete aimed at a root or a
// home. Two layers enforce them, because one is not enough: kaprek's own
// approval handler refuses the call when the CLI asks (chat, trigger,
// relay, deferred alike), and the settings file kaprek hands the CLI
// carries the path rules as `permissions.deny`, which the CLI evaluates
// itself — the only layer that still holds in `auto`, where the CLI never
// asks anyone. Bash patterns are not expressible as CLI deny rules with
// any honesty (the hooks reference says so itself: argument order defeats
// them), so those live in the handler only, and this file says so.
import os from 'node:os';
import path from 'node:path';

/** Strict to open. The index IS the rank. */
export const POSTURES = Object.freeze(['ask', 'edits', 'auto']);
const RANK = { ask: 0, edits: 1, auto: 2 };

export function isPosture(value) {
  return typeof value === 'string' && Object.hasOwn(RANK, value);
}

/** The stricter of two postures; a missing one does not count. */
export function stricterPosture(a, b) {
  if (!isPosture(a)) return isPosture(b) ? b : null;
  if (!isPosture(b)) return a;
  return RANK[a] <= RANK[b] ? a : b;
}

/**
 * The ceiling that applies to a turn: the global dial, tightened by the
 * mission's own if it has one. A mission cannot loosen — a mission posture
 * looser than the global one is simply the global one.
 */
export function effectivePosture({ global = 'auto', mission = null } = {}) {
  const base = isPosture(global) ? global : 'auto';
  return stricterPosture(base, mission) ?? base;
}

/** Whether a requested stance is at or below the ceiling. */
export function postureAllows(ceiling, requested) {
  if (!isPosture(ceiling) || !isPosture(requested)) return false;
  return RANK[requested] <= RANK[ceiling];
}

export class HardDenialValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'HardDenialValidationError';
  }
}

/** The tool names that carry a file path, and where they carry it. */
const PATH_FIELDS = ['file_path', 'path', 'notebook_path', 'filePath'];
const COMMAND_FIELDS = ['command', 'cmd'];

/**
 * What no agent turn may do on this machine. Always on, in every posture.
 * A person who disagrees edits policy.json by hand — an agent turn is
 * exactly the actor this list exists to keep out of that file.
 */
export const BUILTIN_HARD_DENIALS = Object.freeze([
  Object.freeze({
    id: 'agent-config-write',
    why: "an agent's own configuration is written by a person, never by a turn — a turn that rewrites it rewrites the rules of the next session",
    tools: Object.freeze(['Edit', 'Write', 'NotebookEdit', 'MultiEdit']),
    paths: Object.freeze(['~/.claude/**', '~/.claude.json', '~/.codex/**', '~/.gemini/**', '~/.kimi-code/**', '**/.mcp.json']),
  }),
  Object.freeze({
    id: 'recursive-delete-of-root',
    why: 'a recursive delete aimed at a filesystem root, a home directory, or everything in the current directory',
    tools: Object.freeze(['Bash', 'PowerShell']),
    // rm -r… / rmdir /s / Remove-Item -Recurse whose target is `/`, `~`,
    // `$HOME`, a drive root, `*`, or `.`. Fragile by nature (see the file
    // comment) — a backstop for the obvious case, not a parser.
    command: String.raw`(?:^|[\s;&|(])(?:rm\s+(?:-[A-Za-z]*r[A-Za-z]*\s+)+|rmdir\s+\/[sS]\s+(?:\/[qQ]\s+)?|Remove-Item\s+(?:-\w+\s+)*)(?:"|')?(?:~|\$HOME|\$env:USERPROFILE|\/|[A-Za-z]:[\\\/]?|\*|\.)(?:"|')?(?:\s|$)`,
  }),
]);

/** Normalizes a filesystem path the way the CLI's own rules do: forward slashes, `/c/...` for a drive. */
export function posixPath(p) {
  let s = String(p).replace(/\\/g, '/');
  const drive = /^([A-Za-z]):\//.exec(s);
  if (drive) s = `/${drive[1].toLowerCase()}${s.slice(2)}`;
  return s;
}

function globToRegExp(pattern, home) {
  let p = String(pattern).replace(/\\/g, '/');
  if (p.startsWith('~/') || p === '~') p = `${posixPath(home)}${p.slice(1)}`;
  else if (p.startsWith('//')) p = p.slice(1);
  else if (!p.startsWith('/') && !p.startsWith('**')) p = `**/${p}`;
  let out = '^';
  for (let i = 0; i < p.length; i += 1) {
    const ch = p[i];
    if (ch === '*') {
      if (p[i + 1] === '*') {
        // `**/` swallows any number of segments including none; a bare `**` swallows anything.
        if (p[i + 2] === '/') {
          out += '(?:.*/)?';
          i += 2;
        } else {
          out += '.*';
          i += 1;
        }
      } else {
        out += '[^/]*';
      }
    } else if (ch === '?') out += '[^/]';
    else out += ch.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`${out}$`, process.platform === 'win32' ? 'i' : '');
}

/**
 * Validates and normalizes the `hardDenials` a person added in policy.json.
 * Each rule names the tools it covers and either path patterns (gitignore
 * style, `~/` and `//` as in the CLI's own rules) or a command regex.
 */
export function validateHardDenials(raw) {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) throw new HardDenialValidationError('hardDenials must be an array');
  const ids = new Set();
  return raw.map((rule, index) => {
    const where = `hardDenials[${index}]`;
    if (rule === null || typeof rule !== 'object' || Array.isArray(rule)) throw new HardDenialValidationError(`${where} must be an object`);
    for (const key of Object.keys(rule)) {
      if (!['id', 'why', 'tools', 'paths', 'command'].includes(key)) throw new HardDenialValidationError(`${where}: unknown field "${key}"`);
    }
    if (typeof rule.id !== 'string' || rule.id.trim() === '') throw new HardDenialValidationError(`${where}.id must be a non-empty string`);
    if (ids.has(rule.id) || BUILTIN_HARD_DENIALS.some((b) => b.id === rule.id)) throw new HardDenialValidationError(`${where}.id "${rule.id}" is already taken`);
    ids.add(rule.id);
    if (!Array.isArray(rule.tools) || rule.tools.length === 0 || !rule.tools.every((t) => typeof t === 'string' && t !== '')) {
      throw new HardDenialValidationError(`${where}.tools must be a non-empty array of tool names`);
    }
    if (rule.paths !== undefined && (!Array.isArray(rule.paths) || !rule.paths.every((p) => typeof p === 'string' && p !== ''))) {
      throw new HardDenialValidationError(`${where}.paths must be an array of patterns`);
    }
    if (rule.command !== undefined) {
      if (typeof rule.command !== 'string' || rule.command === '') throw new HardDenialValidationError(`${where}.command must be a regular expression string`);
      try {
        new RegExp(rule.command);
      } catch (err) {
        throw new HardDenialValidationError(`${where}.command is not a valid regular expression: ${err.message}`);
      }
    }
    if (rule.paths === undefined && rule.command === undefined) throw new HardDenialValidationError(`${where} needs paths or a command`);
    return {
      id: rule.id,
      why: typeof rule.why === 'string' ? rule.why : 'denied by policy.json',
      tools: [...rule.tools],
      ...(rule.paths ? { paths: [...rule.paths] } : {}),
      ...(rule.command ? { command: rule.command } : {}),
    };
  });
}

/** Built-ins first, then what the person added. */
export function hardDenialsOf(policy) {
  return [...BUILTIN_HARD_DENIALS, ...(Array.isArray(policy?.hardDenials) ? policy.hardDenials : [])];
}

/**
 * Whether a proposed tool call hits a hard denial.
 *
 * @param {{toolName?: string, input?: object}} request
 * @param {Array<object>} [rules] - default: the built-ins
 * @returns {{denied: false}|{denied: true, rule: {id: string, why: string}, matched: string}}
 */
export function evaluateHardDenials(request, rules = BUILTIN_HARD_DENIALS, { home = os.homedir() } = {}) {
  const toolName = typeof request?.toolName === 'string' ? request.toolName : '';
  const input = request?.input && typeof request.input === 'object' ? request.input : {};
  for (const rule of rules) {
    if (!rule.tools.includes(toolName) && !rule.tools.includes('*')) continue;
    if (rule.paths) {
      const candidates = PATH_FIELDS.map((field) => input[field]).filter((v) => typeof v === 'string' && v !== '');
      for (const candidate of candidates) {
        const normalized = posixPath(path.isAbsolute(candidate) ? candidate : candidate);
        for (const pattern of rule.paths) {
          if (globToRegExp(pattern, home).test(normalized)) return { denied: true, rule: { id: rule.id, why: rule.why }, matched: candidate };
        }
      }
    }
    if (rule.command) {
      const text = COMMAND_FIELDS.map((field) => input[field]).find((v) => typeof v === 'string');
      if (text !== undefined) {
        let re;
        try {
          re = new RegExp(rule.command, 'm');
        } catch {
          continue; // validated at load time; a bad built-in would be a bug, not a reason to allow
        }
        if (re.test(text)) return { denied: true, rule: { id: rule.id, why: rule.why }, matched: text.slice(0, 200) };
      }
    }
  }
  return { denied: false };
}

/**
 * The path rules as `permissions.deny` entries for the settings file kaprek
 * hands the CLI. `Edit(...)` only: the CLI checks file writes against Edit
 * rules and accepts a Write/NotebookEdit rule without acting on it.
 * Command rules have no honest CLI form and are left to the handler.
 */
export function cliDenyRules(rules = BUILTIN_HARD_DENIALS) {
  const out = [];
  for (const rule of rules) {
    if (!rule.paths) continue;
    if (!rule.tools.some((t) => ['Edit', 'Write', 'NotebookEdit', 'MultiEdit', '*'].includes(t))) continue;
    for (const pattern of rule.paths) {
      const entry = `Edit(${String(pattern).replace(/\\/g, '/')})`;
      if (!out.includes(entry)) out.push(entry);
    }
  }
  return out;
}
