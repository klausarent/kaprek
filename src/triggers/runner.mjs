// Trigger runner — the motor that turns a declarative trigger definition
// (see registry.mjs) into an actual chat turn, WITHOUT any user input. This
// is the mechanism behind kaprek's differentiator: every other local-agent
// product only reacts to something the user typed.
//
// Three sources start a turn here, and they never mix:
//   - the tick (heartbeat, schedule): time-driven, evaluated in tick().
//   - the environment (file-watch, clipboard): a watcher or poller opened by
//     start() and closed by stop(), each with its own discard rules — see
//     handleWatchEvent() and pollClipboard(). Local signals are the part of
//     this nobody else does; they are also the part that can loop back on
//     itself, hence the running-turn discards.
//   - a manual fire (saved-prompt, or any type via POST
//     /api/triggers/<id>/fire): still subject to every check below, never a
//     bypass.
//
// Every path through fireTrigger() is fail-closed: a check that can't be
// satisfied (unknown trigger, limit reached, missing checklist, no
// approval handler for an escalation that requires one, ...) returns
// `{fired:false, reason}` and logs why — it never falls back to "just run
// it anyway".
import fs from 'node:fs';
import path from 'node:path';
import { openChats } from '../chats/store.mjs';
import { readFile as readWorkspaceFile, resolveWorkspacePath } from '../workspace/fs.mjs';
import { readRuns } from '../orchestrator/runs.mjs';
import { redactSecrets, truncate } from '../parser/parse.mjs';
import { SERVER_NAME as MCP_SERVER_NAME } from '../apps/mcp-server.mjs';
import { checkLimits } from './limits.mjs';
import { isClipboardSupported, readWindowsClipboard } from './clipboard.mjs';

const CLAIM_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const HEARTBEAT_OK_MARKER = 'heartbeat_ok';

// A file-watch turn gets a bounded list of paths, never "everything that
// moved": a checkout or an npm install can touch thousands of files, and a
// prompt is not a place to paste them.
const MAX_CONTEXT_FILES = 50;
// Clipboard text reaching the prompt is capped at the same length a persisted
// chat text field is (see run.mjs's DEFAULT_MAX_TEXT_LEN) — redacted FIRST,
// truncated after, never the other way round.
const MAX_CLIPBOARD_PROMPT_CHARS = 4000;

// Types with a condition of their own that a background tick evaluates. The
// other three are event-driven (file-watch, clipboard) or manual-only
// (saved-prompt) and must never be started by the tick.
const TICK_DRIVEN_TYPES = ['heartbeat', 'schedule'];

// Claude Code's documented convention for an MCP-provided tool's qualified
// name is `mcp__<server-name>__<tool-name>` (see mcp-config.mjs's
// `mcpServers` key, the same 'kaprek-apps' as MCP_SERVER_NAME here). A
// kaprek app's own tool id is itself "<app-id>.<action>" (see
// manifest.mjs's TOOL_ID_RE), so the app id a qualified tool name belongs
// to is the FIRST dot-segment after stripping this prefix.
const MCP_TOOL_PREFIX = `mcp__${MCP_SERVER_NAME}__`;

/**
 * Extracts the app id a qualified kaprek-apps MCP tool name belongs to, or
 * null if `toolName` isn't one of ours at all (e.g. a built-in CLI tool
 * like Bash/Write/WebFetch, or an MCP tool from some other server).
 *
 * NOT verified against a live CLI run — see task-7a-review.md's "cannot
 * verify from diff" note on the exact qualified-name format a real `claude`
 * process reports. That is a deliberate, safe direction to be wrong in: if
 * this assumption is off, notifyPolicyHandler() below denies MORE than it
 * should (every tool call fails to match and gets denied), never less —
 * fail-closed either way, just possibly over-strict until verified live.
 */
function appIdForMcpTool(toolName) {
  if (typeof toolName !== 'string' || !toolName.startsWith(MCP_TOOL_PREFIX)) return null;
  const toolId = toolName.slice(MCP_TOOL_PREFIX.length);
  const dotIndex = toolId.indexOf('.');
  return dotIndex > 0 ? toolId.slice(0, dotIndex) : null;
}

/**
 * The `escalation:'notify'` approval handler — a pure policy decision, no
 * human, no SSE, no timeout: allows ONLY a kaprek-apps MCP tool call whose
 * app id is in `trigger.appScope`; denies literally everything else (Bash,
 * Write, Edit, WebFetch, a Read outside the scoped apps, an MCP tool from an
 * app NOT in scope, ...). This is what makes "kein Trigger erzeugt
 * Außenwirkung ohne Freigabe" true for the DEFAULT escalation level by
 * kaprek's own code, instead of depending on whatever the underlying CLI
 * happens to do when no `--permission-prompt-tool` is wired at all (see
 * task-7a-review.md Critical #2) — this handler is ALWAYS passed to
 * runTurn() for a 'notify' trigger, so `--permission-prompt-tool stdio` is
 * always active for one (see claude-code.mjs::buildArgs()).
 */
function notifyPolicyHandler(trigger) {
  return async (request) => {
    const appId = appIdForMcpTool(request.toolName);
    if (appId !== null && trigger.appScope.includes(appId)) {
      return { behavior: 'allow' };
    }
    return { behavior: 'deny', message: 'not permitted for notify trigger' };
  };
}

function pad2(n) {
  return String(n).padStart(2, '0');
}

/** Local "YYYY-MM-DD" for `date`, matching the calendar day a user sees on their own clock. */
function localDateIso(date) {
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
}

/** Local "HH:MM" for `date`, minute precision (seconds/ms dropped — a tick only needs to hit the right minute once). */
function localHHMM(date) {
  return `${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
}

/**
 * The currently-due schedule slot for `trigger` at `nowMs`, or null if none
 * is due right now. For `everyMinutes`, every window has exactly one slot
 * (its start, floored to the interval) that stays "due" for the whole
 * window — idempotency across repeated ticks within it comes entirely from
 * the claim file (see tryClaim()), not from this function returning null a
 * second time. For `dailyAt`, a slot is due only in the exact minute it
 * names; a tick outside that minute sees no slot at all.
 */
function dueScheduleSlot(trigger, nowMs) {
  const date = new Date(nowMs);
  if (trigger.config.everyMinutes !== undefined) {
    const windowMs = trigger.config.everyMinutes * 60_000;
    const windowStart = Math.floor(nowMs / windowMs) * windowMs;
    return new Date(windowStart).toISOString();
  }
  if (localHHMM(date) !== trigger.config.dailyAt) return null;
  return `${localDateIso(date)}T${trigger.config.dailyAt}`;
}

/** Converts an fs path (either separator) into the '/'-separated form used in {{files}} and everywhere else a workspace-relative path is shown. */
function toPosixPath(p) {
  return String(p)
    .split(/[\\/]+/)
    .filter((seg) => seg.length > 0)
    .join('/');
}

/**
 * Builds the final prompt: promptTemplate with {{reason}}/{{checklist}}/
 * {{files}}/{{clipboard}} substituted, plus a short generated context block
 * (no template engine beyond that one substitution pass).
 *
 * `clipboard` is expected to arrive ALREADY redacted and truncated (see
 * pollClipboard()) — this function does no sanitizing of its own, so a future
 * caller cannot accidentally get raw clipboard content into a prompt by
 * passing it here unprocessed.
 */
function buildPrompt(trigger, { reason, checklist, files, clipboard }) {
  const fileList = Array.isArray(files) ? files.join('\n') : '';
  const substituted = trigger.promptTemplate
    .split('{{reason}}')
    .join(reason ?? '')
    .split('{{checklist}}')
    .join(checklist ?? '')
    .split('{{files}}')
    .join(fileList)
    .split('{{clipboard}}')
    .join(clipboard ?? '');

  const contextLines = [
    `[trigger] id: ${trigger.id}`,
    `[trigger] cause: ${reason ?? 'n/a'}`,
    `[trigger] escalation: ${trigger.escalation}`,
  ];
  if (checklist !== undefined) contextLines.push(`[trigger] checklist:\n${checklist}`);
  if (Array.isArray(files) && files.length > 0) contextLines.push(`[trigger] changed files:\n${fileList}`);
  if (clipboard !== undefined) contextLines.push(`[trigger] clipboard (secrets redacted):\n${clipboard}`);

  return `${substituted}\n\n${contextLines.join('\n')}`;
}

/**
 * Creates a trigger runner bound to one dataDir/trigger registry.
 *
 * @param {object} options
 * @param {string} options.dataDir
 * @param {{list: Function, get: Function}} options.triggers - a registry.mjs::openTriggers() instance
 * @param {Function} options.runTurn - src/orchestrator/run.mjs::runTurn, injected so tests can pass a stub around a fake harness
 * @param {{startTurn: Function}} options.harness - e.g. src/harness/fake.mjs for tests
 * @param {string} [options.harnessName]
 * @param {string} options.cwd - the harness's working directory AND the
 *   workspace root a heartbeat trigger's checklistPath is read from (see
 *   src/workspace/fs.mjs) — same directory runTurn() passes to the CLI
 * @param {string} [options.permissionMode]
 * @param {() => number} [options.now] - injectable clock (default Date.now); tests never sleep
 * @param {(message: string) => void} [options.log] - every accept/reject decision is logged through this (default console.log)
 * @param {number} [options.tickMs] - setInterval period for start() (default 60_000)
 * @param {(chatId: string) => (request: import('../harness/adapter.mjs').ApprovalRequest) => Promise<import('../harness/adapter.mjs').ApprovalDecision>} [options.makeUiApprovalHandler] -
 *   a FACTORY, not a handler — called with the trigger turn's own chatId
 *   (known only once runTurn() resolves it, see run.mjs's onChatResolved)
 *   to build the actual per-turn handler. Used ONLY for `escalation:
 *   'question'|'review'` — a 'notify' trigger never needs this at all, it
 *   always gets its own self-contained notifyPolicyHandler() instead (see
 *   above). The server wires this to the SAME makeApprovalHandler() a
 *   normal chat turn uses (src/server/server.mjs), so a question/review
 *   trigger's approval surfaces over SSE if a client happens to be
 *   streaming that chatId, and auto-denies after the same timeout
 *   otherwise — see fireTrigger()'s escalation gate below for what happens
 *   when this option is omitted entirely (a runner built without it, e.g.
 *   in an isolated test).
 * @param {Function} [options.createWatcher] - fs.watch seam, `(absPath,
 *   options, listener) => FSWatcher`. Injected so a test can drive watch
 *   events (including the platform-specific ones a real watcher only produces
 *   sometimes: a `null` filename, a duplicate event per save, a watcher that
 *   dies) deterministically, instead of writing files and hoping the OS
 *   reports them in time.
 * @param {() => Promise<string>} [options.readClipboard] - clipboard read
 *   seam (default src/triggers/clipboard.mjs::readWindowsClipboard). Tests
 *   pass a fake reader; no test ever spawns a real PowerShell.
 * @param {string} [options.platform] - process.platform override, for the
 *   clipboard support check (see supportStatus()).
 */
export function createTriggerRunner({
  dataDir,
  triggers,
  runTurn,
  harness,
  harnessName,
  cwd,
  permissionMode,
  now = Date.now,
  log = (message) => console.log(message),
  tickMs = 60_000,
  makeUiApprovalHandler,
  createWatcher = (absPath, options, listener) => fs.watch(absPath, options, listener),
  readClipboard = readWindowsClipboard,
  platform = process.platform,
}) {
  // Loop guard (part 2 of 2 — part 1 is the cause.origin==='trigger' check
  // in fireTrigger() itself): a trigger already running must not be started
  // again by an overlapping tick or a manual fire while it's still in
  // flight. Cleared in the `finally` below, so it can never leak a stuck id.
  const runningIds = new Set();
  let timer = null;

  // One entry per ACTIVE file-watch trigger: {configKey, watcher, timer,
  // pending, isDir, absPath, relPath}. Built by setupFileWatch(), torn down
  // by teardownFileWatch(), reconciled against the registry on every tick
  // (see syncEnvironmentTriggers) so enabling a watcher in the UI does not
  // need a server restart.
  const watchStates = new Map();
  // Same, per ACTIVE clipboard trigger: {configKey, interval, regex,
  // lastSeen, primed, busy}.
  const pollStates = new Map();
  // Watchers/pollers only exist between start() and stop() — an in-flight
  // async poll must never be able to resurrect one after stop() ran.
  let started = false;

  function currentNow() {
    return now();
  }

  /** Identity of a trigger's config, so a config CHANGE (not just enable/disable) rebuilds its watcher/poller instead of silently keeping the old one. */
  function configKeyOf(trigger) {
    return JSON.stringify(trigger.config);
  }

  function claimsDir() {
    return path.join(dataDir, 'triggers', 'claims');
  }

  /** Filename-safe encoding of a slot for use in a claim's path — ':' is reserved on Windows (NTFS alternate-data-stream syntax), so it is not usable verbatim in a filename component. */
  function claimFilePath(triggerId, slot) {
    return path.join(claimsDir(), `${triggerId}-${slot.replace(/:/g, '-')}.claim`);
  }

  /** Exclusive-create a claim file for (triggerId, slot). Returns true if this call won the claim, false if the slot was already claimed. */
  function tryClaim(triggerId, slot) {
    fs.mkdirSync(claimsDir(), { recursive: true });
    try {
      fs.writeFileSync(claimFilePath(triggerId, slot), '', { flag: 'wx' });
      return true;
    } catch (err) {
      if (err.code === 'EEXIST') return false;
      throw err;
    }
  }

  /** Deletes claim files older than 7 days. Best-effort — a cleanup failure must never block firing. */
  function cleanupOldClaims() {
    const dir = claimsDir();
    if (!fs.existsSync(dir)) return;
    const cutoff = currentNow() - CLAIM_MAX_AGE_MS;
    for (const entry of fs.readdirSync(dir)) {
      const full = path.join(dir, entry);
      try {
        if (fs.statSync(full).mtimeMs < cutoff) fs.unlinkSync(full);
      } catch {
        // best-effort — a single unreadable/already-gone claim must not stop the sweep
      }
    }
  }

  /** allowedTools is derived from appScope, never left unset — an empty appScope MUST mean "no tools", not "the harness's own default set" (see run.mjs's allowedTools passthrough contract). */
  function allowedToolsFor(trigger) {
    return [...trigger.appScope];
  }

  /**
   * Whether a heartbeat trigger is due to fire again, based on its OWN last
   * run in runs.jsonl (not in-memory state — see limits.mjs's identical
   * reasoning) rather than "checklist exists" alone; the checklist check in
   * fireTrigger() below is a firing PRECONDITION, this is the tick's own
   * scheduling decision.
   */
  function heartbeatDue(trigger, nowMs) {
    const runs = readRuns(dataDir).filter((run) => run.triggerId === trigger.id);
    if (runs.length === 0) return true;
    const last = runs[runs.length - 1];
    const lastTs = Date.parse(last.ts);
    if (!Number.isFinite(lastTs)) return true;
    return nowMs - lastTs >= trigger.config.intervalMinutes * 60_000;
  }

  /**
   * A trigger's approval-wiring status — used both by fireTrigger()'s own
   * gate below and exposed to callers (GET /api/triggers, see
   * server.mjs::handleTriggersList) so a 'question'/'review' trigger that
   * structurally can never fire is visible via the API, not just a
   * console.log line (task-7a-review.md Important #2).
   */
  function approvalCapability(trigger) {
    if (trigger.escalation === 'notify') {
      return { approvalPath: 'policy', blocked: null };
    }
    if (typeof makeUiApprovalHandler !== 'function') {
      return { approvalPath: 'ui', blocked: 'no UI approval handler configured for this escalation level' };
    }
    return { approvalPath: 'ui', blocked: null };
  }

  /**
   * Whether this trigger's type can work on THIS machine at all. Only
   * `clipboard` can answer no (Windows-only in v1, see clipboard.mjs) — and
   * it says so in plain text rather than throwing or failing silently at poll
   * time. Exposed to callers (GET /api/triggers) so a UI can grey the trigger
   * out with a reason instead of showing a switch that does nothing.
   */
  function supportStatus(trigger) {
    if (trigger.type === 'clipboard' && !isClipboardSupported(platform)) {
      return { supported: false, unsupportedReason: `clipboard triggers require Windows (this machine reports "${platform}")` };
    }
    return { supported: true, unsupportedReason: null };
  }

  /**
   * Turns a trigger off in the registry and says why — for a condition the
   * trigger cannot recover from on its own (its watcher died, its path is
   * gone). The alternative, leaving it "enabled" while nothing watches
   * anything, is the worst outcome available: a user believing a trigger is
   * armed when it is not (see the task brief: "statt still zu verstummen").
   */
  function disableWithReason(triggerId, reason) {
    teardownFileWatch(triggerId);
    teardownClipboardPoll(triggerId);
    try {
      triggers.setEnabled(triggerId, false);
    } catch (err) {
      log(`trigger ${triggerId}: could not persist self-disable: ${err?.message ?? String(err)}`);
    }
    log(`trigger ${triggerId}: DISABLED itself (${reason})`);
  }

  // ------------------------------------------------------------- file-watch

  /**
   * One accepted watch event's workspace-relative path. fs.watch reports
   * `filename` relative to the watched directory; for a watched single FILE it
   * reports that file's own name, in which case the trigger's configured path
   * already IS the answer. Always '/'-separated, always relative to the
   * workspace root — that is the only path shape anything else in kaprek
   * accepts (see src/workspace/fs.mjs).
   */
  function watchEventRelPath(state, filename) {
    if (!state.isDir) return toPosixPath(state.relPath);
    return `${toPosixPath(state.relPath)}/${toPosixPath(filename)}`;
  }

  /**
   * Maps a raw fs.watch event to one of the trigger's own event names, or null
   * if it must be discarded. 'rename' covers BOTH creation and deletion on
   * every platform, so the only way to tell them apart is to look: the path
   * exists now -> 'add', it doesn't -> 'unlink'.
   */
  function mapWatchEvent(state, eventType, filename) {
    if (eventType === 'change') return 'change';
    if (eventType !== 'rename') return null;
    const absolute = state.isDir ? path.join(state.absPath, filename) : state.absPath;
    return fs.existsSync(absolute) ? 'add' : 'unlink';
  }

  /**
   * The watcher callback for one trigger. Discards, in this order: an event
   * with no usable filename (fs.watch may report `null` — guessing which path
   * it meant would be worse than doing nothing), an event that arrived while
   * this trigger's OWN turn is running (see below), an event deeper than
   * maxDepth, and an event whose kind the trigger did not subscribe to.
   *
   * The running-turn discard is the loop protection this trigger type
   * genuinely needs: if the turn writes into the very directory that started
   * it, the watcher fires again. Buffering those events would only delay the
   * loop by one debounce window instead of breaking it, so they are DROPPED.
   */
  function handleWatchEvent(triggerId, eventType, filename) {
    const state = watchStates.get(triggerId);
    if (!state) return;

    if (typeof filename !== 'string' || filename.length === 0) {
      log(`trigger ${triggerId}: watch event without a filename, discarded`);
      return;
    }
    if (runningIds.has(triggerId)) {
      log(`trigger ${triggerId}: watch event discarded (its own turn is still running)`);
      return;
    }

    const trigger = triggers.get(triggerId);
    if (!trigger || !trigger.enabled || trigger.type !== 'file-watch') return;

    if (state.isDir && trigger.config.maxDepth !== undefined) {
      const depth = toPosixPath(filename).split('/').length;
      if (depth > trigger.config.maxDepth) return;
    }
    const kind = mapWatchEvent(state, eventType, filename);
    if (kind === null || !trigger.config.events.includes(kind)) return;

    state.pending.add(watchEventRelPath(state, filename));
    if (state.timer) return;
    // Debounce: one save produces several events (Windows produces them
    // reliably, other platforms occasionally), so the turn starts once the
    // dust has settled — not once per event.
    state.timer = setTimeout(() => flushWatch(triggerId), trigger.config.debounceMs);
    if (typeof state.timer.unref === 'function') state.timer.unref();
  }

  /** Fires the trigger once for everything collected during one debounce window: deduped (a Set), sorted, capped at MAX_CONTEXT_FILES. */
  function flushWatch(triggerId) {
    const state = watchStates.get(triggerId);
    if (!state) return;
    state.timer = null;
    const files = [...state.pending].sort().slice(0, MAX_CONTEXT_FILES);
    state.pending.clear();
    if (files.length === 0) return;

    fireTrigger(triggerId, { cause: { origin: 'file-watch', files } }).catch((err) => {
      log(`trigger ${triggerId}: file-watch fire error: ${err?.message ?? String(err)}`);
    });
  }

  /**
   * Opens the watcher for one file-watch trigger. The path goes through
   * src/workspace/fs.mjs's own guard (resolveWorkspacePath: root check,
   * relPath syntax, escape check, symlink walk) — raw config never reaches fs
   * directly. A path that cannot be resolved or does not exist yet, and a
   * watcher that refuses to open, both disable the trigger with a logged
   * reason rather than leaving a trigger that looks armed but watches nothing.
   */
  function setupFileWatch(trigger) {
    let absPath;
    let stat;
    try {
      absPath = resolveWorkspacePath({ workspaceDir: cwd, relPath: trigger.config.path });
      stat = fs.statSync(absPath);
    } catch (err) {
      disableWithReason(trigger.id, `file-watch path unusable: ${err.message}`);
      return;
    }

    const isDir = stat.isDirectory();
    const state = { configKey: configKeyOf(trigger), watcher: null, timer: null, pending: new Set(), isDir, absPath, relPath: trigger.config.path };
    try {
      state.watcher = createWatcher(absPath, { recursive: isDir, persistent: false }, (eventType, filename) =>
        handleWatchEvent(trigger.id, eventType, filename),
      );
    } catch (err) {
      disableWithReason(trigger.id, `file watcher could not be opened: ${err.message}`);
      return;
    }
    // A watcher can die at any time (the directory is deleted, a network
    // share drops, the OS hits a handle limit). Without this the trigger
    // would just go quiet forever.
    state.watcher.on?.('error', (err) => {
      disableWithReason(trigger.id, `file watcher failed: ${err?.message ?? String(err)}`);
    });

    watchStates.set(trigger.id, state);
    log(`trigger ${trigger.id}: watching ${toPosixPath(trigger.config.path)} (${isDir ? 'recursive' : 'single file'}, debounce ${trigger.config.debounceMs}ms)`);
  }

  /** Closes one trigger's watcher and clears its debounce timer. Idempotent. */
  function teardownFileWatch(triggerId) {
    const state = watchStates.get(triggerId);
    if (!state) return;
    watchStates.delete(triggerId);
    if (state.timer) clearTimeout(state.timer);
    try {
      state.watcher?.close?.();
    } catch {
      // best-effort — a watcher already dead on its own must not break teardown
    }
  }

  // ------------------------------------------------------------- clipboard

  /**
   * Starts the poller for one clipboard trigger — or deliberately does NOT,
   * and says why: on a platform without clipboard support, and (crucially)
   * for a trigger with no `matchPattern`. In that second case nothing is
   * started at all, so the clipboard is never even READ: a trigger that would
   * fire on every copy is not a feature, and reading without a reason to act
   * is exactly the behaviour that separates a tool from spyware.
   */
  function setupClipboardPoll(trigger) {
    const support = supportStatus(trigger);
    if (!support.supported) {
      log(`trigger ${trigger.id}: clipboard poller not started (${support.unsupportedReason})`);
      return;
    }
    if (trigger.config.matchPattern === undefined) {
      log(`trigger ${trigger.id}: clipboard poller not started (no matchPattern configured — the clipboard is never read)`);
      return;
    }
    let regex;
    try {
      regex = new RegExp(trigger.config.matchPattern);
    } catch (err) {
      disableWithReason(trigger.id, `clipboard matchPattern failed to compile: ${err.message}`);
      return;
    }

    // CONSENT (see the task brief): the visible line is the whole difference
    // between this and a keylogger. One per activation, every activation.
    log(`trigger ${trigger.id}: clipboard trigger ACTIVE — clipboard TEXT is read every ${trigger.config.pollMs}ms while this trigger stays enabled`);

    const state = { configKey: configKeyOf(trigger), interval: null, regex, lastSeen: null, primed: false, busy: false };
    state.interval = setInterval(() => {
      pollClipboard(trigger.id).catch((err) => {
        log(`trigger ${trigger.id}: clipboard poll error: ${err?.message ?? String(err)}`);
      });
    }, trigger.config.pollMs);
    if (typeof state.interval.unref === 'function') state.interval.unref();
    pollStates.set(trigger.id, state);
  }

  /**
   * One clipboard poll. Fires only when ALL of these hold: the trigger is
   * still enabled, no turn of its own is running, the read succeeded, the
   * content DIFFERS from the last seen value, and the pattern matches.
   *
   * The first successful read only primes `lastSeen` and never fires:
   * whatever happened to be on the clipboard before the trigger was switched
   * on is not something the user just did.
   *
   * `lastSeen` lives in memory only and is never written to disk — a trigger
   * definition on disk must not become a log of what the user copied.
   */
  async function pollClipboard(triggerId) {
    const state = pollStates.get(triggerId);
    if (!state || state.busy) return;
    const trigger = triggers.get(triggerId);
    if (!trigger || !trigger.enabled || trigger.type !== 'clipboard') return;
    if (runningIds.has(triggerId)) return;

    state.busy = true;
    try {
      let text;
      try {
        text = await readClipboard();
      } catch (err) {
        // A single failed read (PowerShell timeout, locked clipboard) is
        // normal; it costs this poll, not the trigger.
        log(`trigger ${triggerId}: clipboard read failed: ${err?.message ?? String(err)}`);
        return;
      }
      if (typeof text !== 'string' || !pollStates.has(triggerId)) return;

      if (!state.primed) {
        state.primed = true;
        state.lastSeen = text;
        return;
      }
      if (text === state.lastSeen) return;
      state.lastSeen = text;
      if (!state.regex.test(text)) return;

      // Redaction BEFORE truncation — a secret must not survive by being cut
      // in half (see parse.mjs's SECRET_PATTERNS comment). Everything
      // downstream (prompt, chat store, log) only ever sees this value; the
      // raw text does not leave this function.
      const safeText = truncate(redactSecrets(text), MAX_CLIPBOARD_PROMPT_CHARS);
      log(`trigger ${triggerId}: clipboard match, firing (${safeText.length} chars after redaction)`);
      await fireTrigger(triggerId, { cause: { origin: 'clipboard', clipboardText: safeText } });
    } finally {
      state.busy = false;
    }
  }

  /** Stops one trigger's clipboard poller and drops its in-memory last-seen value. Idempotent. */
  function teardownClipboardPoll(triggerId) {
    const state = pollStates.get(triggerId);
    if (!state) return;
    pollStates.delete(triggerId);
    if (state.interval) clearInterval(state.interval);
    state.lastSeen = null;
  }

  /**
   * Reconciles the live watchers/pollers with the registry: starts one for
   * every enabled file-watch/clipboard trigger that has none, and tears down
   * any whose trigger was disabled, deleted, retyped, or RECONFIGURED (config
   * identity is part of the state, see configKeyOf). Called by start() and by
   * every tick, so a trigger enabled through the API becomes live within one
   * tick without a restart.
   */
  function syncEnvironmentTriggers() {
    if (!started) return;
    const wanted = new Map();
    for (const trigger of triggers.list()) {
      if (!trigger.enabled) continue;
      if (trigger.type === 'file-watch' || trigger.type === 'clipboard') wanted.set(trigger.id, trigger);
    }

    for (const [id, state] of [...watchStates]) {
      const trigger = wanted.get(id);
      if (!trigger || trigger.type !== 'file-watch' || configKeyOf(trigger) !== state.configKey) teardownFileWatch(id);
    }
    for (const [id, state] of [...pollStates]) {
      const trigger = wanted.get(id);
      if (!trigger || trigger.type !== 'clipboard' || configKeyOf(trigger) !== state.configKey) teardownClipboardPoll(id);
    }

    for (const [id, trigger] of wanted) {
      if (trigger.type === 'file-watch' && !watchStates.has(id)) setupFileWatch(trigger);
      if (trigger.type === 'clipboard' && !pollStates.has(id)) setupClipboardPoll(trigger);
    }
  }

  /**
   * fireTrigger(id, {cause, onEvent, onChatId}) -> {fired, reason?, chatId?, result?, silent?}.
   * See the module doc comment for the fail-closed posture; the checks
   * below run in the exact order the task brief specifies.
   *
   * `onEvent`/`onChatId` (both optional) are forwarded straight through to
   * runTurn() — a caller that wants to stream a manually-fired trigger's
   * turn live (see server.mjs's SSE fire route) gets the exact same live
   * hooks a normal chat turn gets; a tick-driven background fire simply
   * omits them.
   */
  async function fireTrigger(id, { cause, onEvent, onChatId } = {}) {
    // 1/2. Loop guard, part 1: a run CAUSED by a trigger must never itself
    // fire another trigger — checked before even looking the trigger up, so
    // no trigger-shape detail can influence this decision.
    if (cause?.origin === 'trigger') {
      const reason = 'loop guard: a trigger-originated cause never fires another trigger';
      log(`trigger ${id}: rejected (${reason})`);
      return { fired: false, reason };
    }

    const trigger = triggers.get(id);
    if (!trigger) {
      const reason = 'unknown trigger';
      log(`trigger ${id}: rejected (${reason})`);
      return { fired: false, reason };
    }
    if (trigger.enabled !== true) {
      const reason = 'trigger disabled';
      log(`trigger ${id}: rejected (${reason})`);
      return { fired: false, reason };
    }

    // Loop guard, part 2: the same trigger must not run twice concurrently.
    if (runningIds.has(id)) {
      const reason = 'already running';
      log(`trigger ${id}: rejected (${reason})`);
      return { fired: false, reason };
    }

    const limitCheck = checkLimits({ dataDir, trigger, now: currentNow() });
    if (!limitCheck.allowed) {
      log(`trigger ${id}: rejected (${limitCheck.reason})`);
      return { fired: false, reason: limitCheck.reason };
    }

    // Platform gate: a trigger whose type cannot work on this machine at all
    // never fires here either (only `clipboard` can be unsupported today).
    const support = supportStatus(trigger);
    if (!support.supported) {
      log(`trigger ${id}: rejected (${support.unsupportedReason})`);
      return { fired: false, reason: support.unsupportedReason };
    }

    // Type-specific firing precondition.
    let checklist;
    let slot;
    let reasonText;
    let files;
    let clipboard;
    if (trigger.type === 'heartbeat') {
      try {
        checklist = readWorkspaceFile({ workspaceDir: cwd, relPath: trigger.config.checklistPath });
      } catch {
        const reason = `heartbeat checklist not found: ${trigger.config.checklistPath}`;
        log(`trigger ${id}: rejected (${reason})`);
        return { fired: false, reason };
      }
      reasonText = `heartbeat interval reached (every ${trigger.config.intervalMinutes}m)`;
    } else if (trigger.type === 'schedule') {
      slot = dueScheduleSlot(trigger, currentNow());
      if (slot === null) {
        const reason = 'no schedule slot due right now';
        log(`trigger ${id}: rejected (${reason})`);
        return { fired: false, reason };
      }
      if (!tryClaim(id, slot)) {
        const reason = `schedule slot already claimed: ${slot}`;
        log(`trigger ${id}: rejected (${reason})`);
        return { fired: false, reason };
      }
      reasonText = `schedule slot due: ${slot}`;
    } else if (trigger.type === 'file-watch') {
      // The watcher supplies the paths (see flushWatch); a manual fire has
      // none, which is allowed — a user pressing "run now" on a watcher is a
      // deliberate act and still passes every cap and escalation check — it
      // just gets an empty {{files}} and says so.
      files = Array.isArray(cause?.files) ? cause.files.filter((f) => typeof f === 'string') : [];
      reasonText = files.length > 0 ? `${files.length} watched path(s) changed` : 'manual fire (no file changes recorded)';
    } else if (trigger.type === 'clipboard') {
      // Only this trigger's own poller can produce a clipboard cause. A
      // manual fire is refused rather than reading the clipboard on demand:
      // an HTTP route that reads the clipboard when asked is precisely the
      // surface the opt-in design exists to avoid.
      if (typeof cause?.clipboardText !== 'string') {
        const reason = 'clipboard triggers fire only from their own poller';
        log(`trigger ${id}: rejected (${reason})`);
        return { fired: false, reason };
      }
      clipboard = cause.clipboardText; // already redacted+truncated by pollClipboard()
      reasonText = 'clipboard content changed and matched the configured pattern';
    } else {
      // saved-prompt: no condition of its own, manual only.
      if (cause?.origin !== 'user') {
        const reason = 'saved-prompt triggers fire only from a manual fire';
        log(`trigger ${id}: rejected (${reason})`);
        return { fired: false, reason };
      }
      reasonText = 'manual fire (saved prompt)';
    }

    // Escalation gate: EVERY trigger turn gets a real approval handler, no
    // exceptions — a 'notify' trigger always has one (its own self-contained
    // notifyPolicyHandler(), built below, needs nothing external). Only
    // 'question'/'review' can actually be unfireable here: they need
    // makeUiApprovalHandler wired (see approvalCapability() above); without
    // it the trigger does not fire at all — never "fires but auto-denies
    // every tool call", which would just be a confusing silent failure deep
    // inside the turn instead of a clear, logged rejection here.
    const capability = approvalCapability(trigger);
    if (capability.blocked) {
      log(`trigger ${id}: rejected (${capability.blocked})`);
      return { fired: false, reason: capability.blocked };
    }

    // Everything past this point is synchronous up to the `await runTurn`
    // call below, so runningIds.add() here is what makes the "already
    // running" check above race-free against a second fireTrigger() call
    // issued before this one's first await (see the module doc comment).
    // It also backs isAnyTriggerRunning() (server-level loop-guard layer 2,
    // see server.mjs's fire route) — runningIds.size > 0 means SOME
    // trigger-origin turn is currently in flight, not just this one.
    runningIds.add(id);
    try {
      const prompt = buildPrompt(trigger, { reason: reasonText, checklist, files, clipboard });

      // A question/review handler needs the turn's chatId in its closure
      // (makeUiApprovalHandler(chatId) -> handler), but chatId is only
      // known once runTurn() resolves/creates it — resolvedChatId is filled
      // in by onChatResolved below, called synchronously BEFORE
      // harness.startTurn() ever runs, so strictly before any approval
      // request could possibly arrive (see run.mjs's own doc comment on
      // onChatResolved). notifyPolicyHandler() needs none of this.
      let resolvedChatId = null;
      const approvalHandlerForTurn =
        trigger.escalation === 'notify' ? notifyPolicyHandler(trigger) : (request) => makeUiApprovalHandler(resolvedChatId)(request);

      const result = await runTurn({
        dataDir,
        text: prompt,
        harness,
        harnessName,
        cwd,
        permissionMode,
        allowedTools: allowedToolsFor(trigger),
        onApprovalRequest: approvalHandlerForTurn,
        onEvent,
        onChatResolved: (chatId) => {
          resolvedChatId = chatId;
          onChatId?.(chatId);
        },
        origin: 'trigger',
        triggerId: id,
        silent: false,
      });

      let silent = false;
      if (trigger.type === 'heartbeat' && result.chatId) {
        silent = maybeSilenceHeartbeatChat(result.chatId);
      }

      log(`trigger ${id}: fired (chatId=${result.chatId ?? 'n/a'}, silent=${silent})`);
      return { fired: true, chatId: result.chatId, result, silent };
    } finally {
      runningIds.delete(id);
    }
  }

  /**
   * A heartbeat run is only "silent" (hidden from the visible chat list by
   * default) if BOTH hold: the final reply is exactly HEARTBEAT_OK (trimmed,
   * case-insensitive) AND no tool ran during the turn at all. The text alone
   * is not trustworthy — a turn that ran e.g. a WebFetch/Read and still
   * happened to answer "HEARTBEAT_OK" did something real and must stay
   * visible regardless of what its final reply claims (task-7a-review.md
   * Important #1).
   */
  function maybeSilenceHeartbeatChat(chatId) {
    const chats = openChats(dataDir);
    let events;
    try {
      events = chats.events(chatId);
    } catch {
      return false; // best-effort — a lookup failure here must not fail an already-completed turn
    }
    if (events.some((e) => e.kind === 'tool')) return false;
    const lastAssistant = [...events].reverse().find((e) => e.kind === 'assistant');
    const text = typeof lastAssistant?.text === 'string' ? lastAssistant.text.trim().toLowerCase() : null;
    if (text !== HEARTBEAT_OK_MARKER) return false;
    chats.setSilent(chatId, true);
    return true;
  }

  /**
   * One scan over every enabled TICK-DRIVEN trigger (heartbeat/schedule),
   * firing whichever is due right now. Fire-and-forget per trigger — a
   * rejected/errored one must not block the others in the same tick. The
   * event-driven types are never fired from here; the tick only keeps their
   * watchers/pollers in sync with the registry.
   */
  function tick() {
    syncEnvironmentTriggers();
    const nowMs = currentNow();
    for (const trigger of triggers.list()) {
      if (!trigger.enabled) continue;
      if (!TICK_DRIVEN_TYPES.includes(trigger.type)) continue;
      const due = trigger.type === 'heartbeat' ? heartbeatDue(trigger, nowMs) : dueScheduleSlot(trigger, nowMs) !== null;
      if (!due) continue;
      const cause = { origin: trigger.type };
      fireTrigger(trigger.id, { cause }).catch((err) => {
        log(`trigger ${trigger.id}: tick error: ${err?.message ?? String(err)}`);
      });
    }
  }

  /**
   * Starts the tick timer (idempotent), sweeps stale claim files once, and
   * opens the watchers/pollers for every enabled environment trigger. The
   * timer is `unref()`'d and every watcher is opened non-`persistent`, so a
   * process exiting with the runner still "running" is never blocked by it.
   */
  function start() {
    cleanupOldClaims();
    started = true;
    syncEnvironmentTriggers();
    if (timer) return;
    timer = setInterval(tick, tickMs);
    if (typeof timer.unref === 'function') timer.unref();
  }

  /** Stops the tick timer AND every watcher, debounce timer and clipboard poller (idempotent) — after stop() the runner holds no open handle and no timer. */
  function stop() {
    started = false;
    for (const id of [...watchStates.keys()]) teardownFileWatch(id);
    for (const id of [...pollStates.keys()]) teardownClipboardPoll(id);
    if (!timer) return;
    clearInterval(timer);
    timer = null;
  }

  /**
   * Loop-guard layer 2 (see server.mjs's fire route doc comment for layer
   * 1/3): true while ANY trigger-origin turn is in flight, not just a
   * specific id. Deliberately coarse — a manual user fire briefly blocked by
   * an unrelated already-running heartbeat is an acceptable false positive;
   * an unnoticed trigger-A-fires-trigger-B-fires-trigger-A chain over HTTP
   * is not.
   */
  function isAnyTriggerRunning() {
    return runningIds.size > 0;
  }

  return { fireTrigger, tick, start, stop, isAnyTriggerRunning, approvalCapability, supportStatus };
}
