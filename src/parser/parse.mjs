// Streaming digest parser for Claude Code session transcripts (JSONL, up to 110 MB).
// Reads line-by-line via node:readline/fs.createReadStream — never loads the
// whole file into memory as a string.
import fs from 'node:fs';
import readline from 'node:readline';
import path from 'node:path';
import os from 'node:os';

const PERSISTED_OUTPUT_RE = /Full output saved to:\s*(.+)/;
const GIT_COMMIT_RE = /git commit/g;

// Secret redaction (SECURITY): tool inputs/results and text can contain real
// API keys from live sessions. Every known secret format is replaced BEFORE
// truncation, otherwise a key could get cut off right at the truncation
// boundary and become "accidentally" unrecognizable (not a reliable
// protection) — redaction must always precede truncation, never follow it.
const SECRET_PATTERNS = [
  /sk-[A-Za-z0-9_-]{20,}/g, // Anthropic/OpenAI/Stripe secret keys
  /sk_(test|live)_[A-Za-z0-9]{16,}/g, // Stripe sk_test_/sk_live_
  /cf[a-z]{1,3}_[A-Za-z0-9_-]{20,}/g, // Cloudflare
  /GOCSPX-[A-Za-z0-9_-]+/g, // Google OAuth client secret
  /1\/\/[A-Za-z0-9_-]{20,}/g, // Google refresh tokens
  /re_[A-Za-z0-9_-]{15,}/g, // Resend
  /ghp_[A-Za-z0-9]{20,}/g, // GitHub personal access token
  /github_pat_[A-Za-z0-9_]{20,}/g, // GitHub fine-grained PAT
];
const BEARER_RE = /Bearer\s+[A-Za-z0-9._~+/=-]{16,}/g;
const KEY_VALUE_RE = /\b([A-Z][A-Z0-9_]*(?:TOKEN|SECRET|API_KEY|APIKEY|PASSWORD|PASSWD)[A-Z0-9_]*)\s*[=:]\s*["']?\S{8,}/g;

// Secrets registered at RUNTIME by the code that owns them — currently the
// per-installation instance token (see src/server/token.mjs). Its format (64
// hex characters) is indistinguishable from a harmless sha256 hash, of which
// real transcripts are full, so no pattern above can catch it without
// redacting every commit hash and content digest in every session. Registering
// the one live value instead is exact: it can never over-redact, and it cannot
// be forgotten at a single call site the way "remember to redact the token
// here too" could.
const registeredSecrets = new Set();

/** Registers a literal secret value to be redacted from every string redactSecrets() touches. Values shorter than 16 chars are ignored — too short to replace without mangling ordinary text. */
export function registerSecret(value) {
  if (typeof value !== 'string' || value.length < 16) return;
  registeredSecrets.add(value);
}

/** Clears the registered-secret set. For tests, so one test's registered value cannot influence another's expectations. */
export function clearRegisteredSecrets() {
  registeredSecrets.clear();
}

/** Replaces known secret formats in `str` with [REDACTED]. Non-strings/empty stay unchanged. */
export function redactSecrets(str) {
  if (typeof str !== 'string' || str.length === 0) return str;
  let out = str;
  // Registered literals first: a plain substring replacement, so no escaping
  // question ever arises about a value that was never a pattern.
  for (const secret of registeredSecrets) {
    if (out.includes(secret)) out = out.split(secret).join('[REDACTED]');
  }
  for (const re of SECRET_PATTERNS) {
    out = out.replace(re, '[REDACTED]');
  }
  out = out.replace(BEARER_RE, 'Bearer [REDACTED]');
  out = out.replace(KEY_VALUE_RE, '$1=[REDACTED]');
  return out;
}

/**
 * Truncates a string to `limit` characters; appends the ORIGINAL length.
 * Exported so other persistence paths (see src/orchestrator/run.mjs) can
 * apply the exact same truncation as a reloaded/historical digest, instead
 * of re-implementing it.
 */
export function truncate(str, limit) {
  if (typeof str !== 'string' || str.length <= limit) return str;
  return `${str.slice(0, limit)} …[truncated, ${str.length} chars]`;
}

/** Extracts the readable text from tool_result content (string or block array). */
function toolResultText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((block) => (typeof block === 'string' ? block : block?.text ?? ''))
      .join('\n');
  }
  return '';
}

/**
 * Streams a JSONL transcript file in and returns the raw data needed for
 * event mapping and meta computation.
 */
async function collect(jsonlPath) {
  const rl = readline.createInterface({
    input: fs.createReadStream(jsonlPath, { encoding: 'utf8' }),
    crlfDelay: Infinity,
  });

  const events = []; // raw events, sorted by ts at the end
  const pendingToolUses = new Map(); // tool_use.id -> {msgId, name, input, ts}
  const messageIdsSeen = new Set();
  let toolCalls = 0;
  let gitCommits = 0;
  let firstCwd = null;
  let firstVersion = null;
  const models = new Set();
  let title = null; // the last ai-title line wins
  let lastPromptLeafUuid = null; // title fallback: last-prompt points at the final user prompt
  const userPromptsByUuid = new Map();
  let firstUserPrompt = null;
  let brokenLines = 0;
  let minTs = null;
  let maxTs = null;

  for await (const rawLine of rl) {
    const line = rawLine.trim();
    if (!line) continue;

    let obj;
    try {
      obj = JSON.parse(line);
    } catch {
      brokenLines += 1;
      continue; // skip the broken line, parser keeps going
    }

    if (firstCwd === null && typeof obj.cwd === 'string') firstCwd = obj.cwd;
    if (firstVersion === null && typeof obj.version === 'string') firstVersion = obj.version;
    // Determine the time window across ALL lines with a timestamp, including
    // skipped ones (e.g. system/local_command) — reflects the actual session duration.
    if (typeof obj.timestamp === 'string') {
      if (minTs === null || obj.timestamp < minTs) minTs = obj.timestamp;
      if (maxTs === null || obj.timestamp > maxTs) maxTs = obj.timestamp;
    }

    // Marker lines without uuid/timestamp: ai-title carries the title,
    // last-prompt points at the final user prompt (title fallback), rest skipped.
    if (obj.type === 'ai-title') {
      title = obj.aiTitle ?? title;
      continue;
    }
    if (obj.type === 'last-prompt') {
      lastPromptLeafUuid = obj.leafUuid ?? lastPromptLeafUuid;
      continue;
    }
    if (!obj.timestamp || !obj.uuid) {
      // mode, permission-mode, queue-operation,
      // file-history-snapshot, file-history-delta, ...
      continue;
    }

    const ts = obj.timestamp;

    if (obj.type === 'system') {
      if (obj.subtype === 'compact_boundary') {
        events.push({
          kind: 'compact',
          ts,
          preTokens: obj.compactMetadata?.preTokens ?? null,
          postTokens: obj.compactMetadata?.postTokens ?? null,
        });
      }
      // other subtypes (stop_hook_summary, turn_duration, local_command, ...) skipped
      continue;
    }

    if (obj.type === 'attachment') {
      continue; // no event mapping for hook attachments
    }

    if (obj.type === 'assistant' && obj.message) {
      const msg = obj.message;
      if (typeof msg.model === 'string') models.add(msg.model);
      if (typeof msg.id === 'string') messageIdsSeen.add(msg.id);

      for (const block of msg.content ?? []) {
        if (block.type === 'text') {
          events.push({ kind: 'assistant', ts, msgId: msg.id, text: block.text ?? '' });
        } else if (block.type === 'thinking') {
          // Claude Code often persists thinking as signature-only with an empty
          // text field — skip those instead of rendering empty accordions.
          const thinkingText = typeof block.thinking === 'string' ? block.thinking : '';
          if (thinkingText.trim() !== '') {
            events.push({ kind: 'thinking', ts, msgId: msg.id, text: thinkingText });
          }
        } else if (block.type === 'tool_use') {
          toolCalls += 1;
          if (block.name === 'Bash' && typeof block.input?.command === 'string') {
            // Only count within the actually executed command, not in
            // description/other input fields (which can mention "git commit"
            // in passing without one actually running).
            const matches = block.input.command.match(GIT_COMMIT_RE);
            if (matches) gitCommits += matches.length;
          }
          if (block.name === 'Agent') {
            const input = block.input ?? {};
            events.push({
              kind: 'subagent',
              ts,
              agentId: null, // still unknown at spawn time
              name: input.name ?? null,
              agentType: input.subagent_type ?? null,
              model: input.model ?? null,
              description: input.description ?? null,
            });
          } else {
            // Wait for the matching tool_result; remember a placeholder.
            pendingToolUses.set(block.id, { msgId: msg.id, name: block.name, input: block.input ?? {}, ts });
          }
        }
      }
      continue;
    }

    if (obj.type === 'user' && obj.message) {
      const msg = obj.message;
      const content = msg.content;

      // tool_result line? A single user line can carry SEVERAL tool_result
      // blocks (parallel tool calls answered in one message) — process all.
      const resultBlocks = Array.isArray(content) ? content.filter((b) => b?.type === 'tool_result') : [];
      if (resultBlocks.length > 0) {
        for (const resultBlock of resultBlocks) {
          const pending = pendingToolUses.get(resultBlock.tool_use_id);
          const resultText = toolResultText(resultBlock.content);
          let resultRef = null;
          if (resultText.includes('<persisted-output>')) {
            const match = PERSISTED_OUTPUT_RE.exec(resultText);
            resultRef = match ? match[1].trim() : null;
          }
          events.push({
            kind: 'tool',
            ts: pending ? pending.ts : ts,
            msgId: pending ? pending.msgId : null,
            name: pending ? pending.name : null,
            input: pending ? pending.input : null,
            result: resultText,
            resultRef,
          });
          if (pending) pendingToolUses.delete(resultBlock.tool_use_id);
        }
        continue;
      }

      // Real user prompt: content is a string or text blocks, not isMeta.
      if (!obj.isMeta) {
        let text = null;
        if (typeof content === 'string') {
          text = content;
        } else if (Array.isArray(content)) {
          const textBlock = content.find((b) => b?.type === 'text');
          if (textBlock) text = textBlock.text;
        }
        if (text !== null) {
          events.push({ kind: 'user', ts, text });
          if (typeof obj.uuid === 'string') userPromptsByUuid.set(obj.uuid, text);
          if (firstUserPrompt === null) firstUserPrompt = text;
        }
      }
      continue;
    }
    // other type values (e.g. unknown future markers) are ignored.
  }

  // Leftover tool_use calls without a matching tool_result (e.g. the session
  // was interrupted mid-tool-call) must NOT be silently dropped — surface
  // them as a tool event with result:null/resultRef:null instead.
  for (const pending of pendingToolUses.values()) {
    events.push({
      kind: 'tool',
      ts: pending.ts,
      msgId: pending.msgId,
      name: pending.name,
      input: pending.input,
      result: null,
      resultRef: null,
    });
  }

  // Title fallback for sessions without an ai-title marker (Claude Code does
  // not always generate one, e.g. headless runs): the final user prompt via
  // last-prompt.leafUuid, else the first user prompt. Capped for list views.
  if (title === null) {
    const fallback = (lastPromptLeafUuid && userPromptsByUuid.get(lastPromptLeafUuid)) ?? firstUserPrompt;
    if (typeof fallback === 'string' && fallback.trim() !== '') {
      const oneLine = fallback.trim().replace(/\s+/g, ' ');
      title = oneLine.length > 100 ? `${oneLine.slice(0, 100)}…` : oneLine;
    }
  }

  return {
    events,
    toolCalls,
    gitCommits,
    firstCwd,
    firstVersion,
    models,
    title,
    turns: messageIdsSeen.size,
    brokenLines,
    minTs,
    maxTs,
  };
}

/** Truncates a raw event's input/text/result fields per maxTextLen/maxToolLen. */
function truncateEvent(event, maxTextLen, maxToolLen, redact) {
  const applyRedact = redact ? redactSecrets : (str) => str;
  switch (event.kind) {
    case 'assistant':
    case 'thinking':
    case 'user':
      return { ...event, text: truncate(applyRedact(event.text), maxTextLen) };
    case 'tool':
      return {
        ...event,
        input: event.input !== null ? truncate(applyRedact(JSON.stringify(event.input)), maxToolLen) : null,
        result: event.result !== undefined ? truncate(applyRedact(event.result), maxToolLen) : event.result,
      };
    case 'subagent':
      // Agent-spawn name/description come straight from tool_use input, the
      // same untrusted source as any other tool input — must go through the
      // same redaction as everything else that reaches the digest.
      return {
        ...event,
        name: applyRedact(event.name),
        description: applyRedact(event.description),
      };
    default:
      return event;
  }
}

/**
 * Digests a session transcript file (and recursively its subagents) into a
 * compact, viewer-ready form.
 */
export async function digestSession(jsonlPath, { maxTextLen = 4000, maxToolLen = 1500, redact = true } = {}) {
  const stat = await fs.promises.stat(jsonlPath);
  const raw = await collect(jsonlPath);

  const events = raw.events
    .slice()
    .sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0))
    .map((e) => truncateEvent(e, maxTextLen, maxToolLen, redact));

  const startedAt = raw.minTs;
  const endedAt = raw.maxTs;

  const transcriptDir = path.dirname(jsonlPath);
  const sessionId = path.basename(jsonlPath, '.jsonl');
  const subagentsDir = path.join(transcriptDir, sessionId, 'subagents');

  let subagents = [];
  let hasSubagents = false;
  if (fs.existsSync(subagentsDir)) {
    const entries = fs.readdirSync(subagentsDir).filter((f) => f.endsWith('.jsonl'));
    hasSubagents = entries.length > 0;
    subagents = await Promise.all(
      entries.map(async (fileName) => {
        const agentId = fileName.replace(/^agent-/, '').replace(/\.jsonl$/, '');
        const subJsonlPath = path.join(subagentsDir, fileName);
        const metaPath = path.join(subagentsDir, `agent-${agentId}.meta.json`);
        let meta = {};
        if (fs.existsSync(metaPath)) {
          try {
            meta = JSON.parse(await fs.promises.readFile(metaPath, 'utf8'));
          } catch {
            meta = {};
          }
        }
        // .meta.json is written by Claude Code itself, not by this parser —
        // name/description can carry the same kind of freeform text as any
        // tool input, so it needs the same redaction before it reaches the digest.
        if (redact) {
          if (typeof meta.name === 'string') meta.name = redactSecrets(meta.name);
          if (typeof meta.description === 'string') meta.description = redactSecrets(meta.description);
        }
        const subDigest = await digestSession(subJsonlPath, { maxTextLen, maxToolLen, redact });
        return { agentId, meta, events: subDigest.events };
      }),
    );
  }

  return {
    meta: {
      sessionId,
      projectSlug: path.basename(transcriptDir),
      cwd: raw.firstCwd,
      // ai-title is a marker line from Claude Code, not something this
      // parser already filtered — it can carry secrets in the title text
      // just like any other free-text field, so it needs the same redaction
      // gate before it reaches the digest (API, meta cache, search index).
      title: redact ? redactSecrets(raw.title) : raw.title,
      startedAt,
      endedAt,
      models: [...raw.models],
      version: raw.firstVersion,
      machine: os.hostname(),
      turns: raw.turns,
      toolCalls: raw.toolCalls,
      rawBytes: stat.size,
      hasSubagents,
      gitCommits: raw.gitCommits,
    },
    events,
    subagents,
  };
}
