# loryme

> Your Claude Code sessions never die — you just can't see them.

loryme is a local, read-only viewer for Claude Code session transcripts. It scans `~/.claude/projects`, turns the raw JSONL logs into a searchable list of threads, and serves them from a tiny local web UI. Nothing leaves your machine.

**Status: pre-release, not yet published.**

<!-- TODO: add screenshot before launch (docs/screenshot.png) -->

## Quickstart

```
npx loryme
# → opens http://127.0.0.1:4900 — all projects, all sessions, thread view
```

No install, no config, no account. Ctrl+C stops the server.

## Flags

| Flag | Default | Description |
| --- | --- | --- |
| `--port <n>` | `4900` | Port to listen on. If taken, tries up to 10 higher. |
| `--dir <path>` | `~/.claude/projects` | Root directory to scan for sessions. |
| `--no-redact` | off | Disable secret redaction in session digests. |
| `--no-open` | off | Don't open the default browser automatically. |
| `-h, --help` | — | Show usage and exit. |

## Features

- Lists every project and session found under `~/.claude/projects`, sorted by recency.
- Thread view per session: user/assistant turns, tool calls, subagent transcripts.
- Streaming parser handles multi-hundred-MB JSONL files without loading them whole into memory.
- Secret redaction on by default, applied before any truncation.
- Zero runtime dependencies. The web UI ships as a prebuilt static bundle.

## Search

Full-text search across every indexed session, backed by SQLite FTS5. Requires Node 22+, since it uses the built-in `node:sqlite` module — on older Node it degrades cleanly, the UI reports search as unavailable instead of crashing. Only redacted content is indexed, same as the digest view. Build or refresh the index from the reindex button in the search view (`#/search`), or `POST /api/search/reindex`.

The index only covers a session's title plus its user/assistant text, truncated to the first 4,000 characters per event — tool output, thinking blocks, and subagent transcripts are not indexed at all. A search miss doesn't mean the term isn't in the session; it may just be outside what's indexed.

## Task board

A local task board (`#/board`) for tracking work against these sessions.

The core rule: a task can only be marked done once it carries a complete 7-field completion record — what triggered it, the outcome, the approach taken, the course including any detours or failures, how it was verified, the effort spent, and what's still open. All seven fields are required and enforced server-side, not just suggested by the UI. It's the discipline your future self wants but never keeps on its own.

## Receipts

A receipt is an ed25519-signed snapshot of a completed task: its doc plus its linked sessions, signed at the moment you ask for one. It proves that a given key signed this exact state at this time — it does not prove the work is good, and the agent name is self-declared, not a verified identity. The verify view shows valid/invalid; editing the doc after signing invalidates the receipt, because verification always re-checks against the task's current state, not a stored snapshot.

## Claude Code hook (optional)

loryme can install a Claude Code **Stop** hook that gently enforces the policy engine's rules (e.g. flagging a session that made a commit without a linked board task). It is opt-in only — nothing is installed by default.

Important: a Stop hook fires *after* the turn already ended — after any tool call in it, including a `git commit`, already ran. It cannot prevent a commit or require a task link "before" one happens; it can only look back at the transcript once the turn is over and react (log, warn, or refuse to end that particular Stop event) to what already occurred. Think of it as a nag, not a gate.

- `loryme hooks install` adds one entry to `~/.claude/settings.json` (backs up the file first, leaves any other hooks untouched).
- `loryme hooks uninstall` removes only that entry, at any time, identified by a stable `--managed-by` marker so a later reinstall never creates a duplicate.
- `loryme hooks status` shows whether it's installed and which policy mode is active.

Policy mode lives in `<dataDir>/policy.json`: `observe` (default) fully evaluates both rules and logs any violation to `policy.log`, but always resolves to allow — it's for seeing what would happen before switching modes. `warn` writes its reasons to stderr (Claude Code hooks reference exit 0 as no objection either way, so this is best-effort visibility, not a blocking signal). `block` is the only mode that can actually end a turn abnormally, and even then at most once per session. The hook fails open on any internal error — a bug here must never stop you from ending a turn. This is the single exception to loryme's read-only promise; every other feature only reads `~/.claude/projects`.

## Privacy

- **Local only.** The server binds to `127.0.0.1` and rejects requests with a foreign `Host` header — enforced by the server's own tests (`src/server/server.test.mjs`).
- **Redaction on by default.** 10 secret patterns (API keys, Stripe/GitHub/Cloudflare/Google tokens, Bearer headers, `TOKEN=`/`SECRET=`/`API_KEY=`-style assignments) are replaced with `[REDACTED]` before a digest is built. Opt out consciously with `--no-redact`. Behavior is checked by an end-to-end test (`src/redaction-e2e.test.mjs`).
- **Read-only, with one opt-in exception.** loryme never writes to `~/.claude` unless you explicitly run `loryme hooks install` — see [Claude Code hook](#claude-code-hook-optional) above. Every other feature only reads `~/.claude/projects`.
- **No telemetry.** Zero runtime dependencies, nothing phones home. A static guard test (`src/no-network.test.mjs`) fails the build if a network-client or subprocess call is added to the Node code (`src/`, `bin/`) outside the one documented case (opening your browser locally). The web UI naturally does use `fetch` — that's how it talks to loryme's own local API on `127.0.0.1` (`web/src/lib/api.ts`) — but it has no other network call, and that promise isn't enforced by the static guard above (which only scans `src/`/`bin/`, not `web/`); it's plain source you can read yourself.
- **Everything loryme writes, in full:**
  - `<dataDir>` (default `~/.loryme`, override with `LORYME_DATA_DIR`): board events (`board/events.jsonl`), the search index (`search.db`, redacted content only), signing keys (`keys/`), and policy state and logs (`policy.json`, `policy-state/`, `policy.log`).
  - Your OS temp directory: a small metadata cache (titles + timestamps + a `machineHint`, a username heuristic parsed out of a session's `cwd`, all redacted, auto-evicted after 30 days). Written with default file permissions (unlike the signing keys under `keys/`, which are created `0600`).
  - `~/.claude/settings.json`: only if you run `loryme hooks install` (backed up first, removed again with `loryme hooks uninstall`).
- **Single-process assumption.** loryme expects one server instance per data dir. Running two instances against the same `<dataDir>` at once is an unsupported, documented limitation — not something the code guards against.

These are not just claims in prose — each one is enforced by a test in `src/`. Read the tests if you want to verify it yourself instead of trusting this README.

## FAQ

**Claude Code changed its transcript format and loryme broke — now what?**
The JSONL format Claude Code writes is undocumented and has drifted before. The parser is deliberately tolerant, but in two different ways depending on where the drift shows up: a line that isn't even valid JSON is silently skipped and counted (`brokenLines`), never thrown on. A well-formed line whose `type` the parser doesn't recognize is also silently skipped — it never becomes an event at all, so it does not surface anywhere in the UI. Separately, the web UI's event renderer falls back to a generic `UnknownBlock` for any event *kind* the parser itself emits that the renderer has no component for yet — a safety net for the UI lagging behind the parser, not a way to see raw unrecognized transcript lines. If a session renders oddly, missing content is more likely a silently-skipped line than a crash — a `doctor` command to diagnose format drift is planned but not built yet.

**Which platforms are supported?**
Windows, macOS, Linux. Requires Node.js ≥ 20.

**Does this send anything to Anthropic, or anywhere else?**
No. See [Privacy](#privacy) above.

**Can I point it at a different directory, e.g. a backup of my sessions?**
Yes, `--dir <path>`.

## License

Apache-2.0. Unofficial community tool — not affiliated with or endorsed by Anthropic.
