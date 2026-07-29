# loryme

> Your Claude Code sessions never die — you just can't see them.

loryme is a local, read-only viewer for Claude Code session transcripts. It scans `~/.claude/projects`, turns the raw JSONL logs into a searchable list of threads, and serves them from a tiny local web UI. Nothing leaves your machine.

**Status: pre-release, not yet published.**

![screenshot](docs/screenshot.png)

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

## Task board

A local task board (`#/board`) for tracking work against these sessions.

The core rule: a task can only be marked done once it carries a complete 7-field completion record — what triggered it, the outcome, the approach taken, the course including any detours or failures, how it was verified, the effort spent, and what's still open. All seven fields are required and enforced server-side, not just suggested by the UI. It's the discipline your future self wants but never keeps on its own.

## Receipts

A receipt is an ed25519-signed snapshot of a completed task: its doc plus its linked sessions, signed at the moment you ask for one. It proves that a given key signed this exact state at this time — it does not prove the work is good, and the agent name is self-declared, not a verified identity. The verify view shows valid/invalid; editing the doc after signing invalidates the receipt, because verification always re-checks against the task's current state, not a stored snapshot.

## Claude Code hook (optional)

loryme can install a Claude Code Stop hook that gently enforces the policy engine's rules (e.g. requiring a linked board task before a commit). It is opt-in only — nothing is installed by default.

- `loryme hooks install` adds one entry to `~/.claude/settings.json` (backs up the file first, leaves any other hooks untouched).
- `loryme hooks uninstall` removes only that entry, at any time, identified by a stable `--managed-by` marker so a later reinstall never creates a duplicate.
- `loryme hooks status` shows whether it's installed and which policy mode is active.

Policy mode lives in `<dataDir>/policy.json`: `observe` (default, log only), `warn`, or `block`. A `block` decision fires at most once per session, and the hook fails open on any internal error — a bug here must never stop you from ending a turn. This is the single exception to loryme's read-only promise; every other feature only reads `~/.claude/projects`.

## Privacy

- **Local only.** The server binds to `127.0.0.1` and rejects requests with a foreign `Host` header — enforced by the server's own tests (`src/server/server.test.mjs`).
- **Redaction on by default.** 10 secret patterns (API keys, Stripe/GitHub/Cloudflare/Google tokens, Bearer headers, `TOKEN=`/`SECRET=`/`API_KEY=`-style assignments) are replaced with `[REDACTED]` before a digest is built. Opt out consciously with `--no-redact`. Behavior is checked by an end-to-end test (`src/redaction-e2e.test.mjs`).
- **Read-only, with one opt-in exception.** loryme never writes to `~/.claude` unless you explicitly run `loryme hooks install` — see [Claude Code hook](#claude-code-hook-optional) above. Every other feature only reads `~/.claude/projects`.
- **No telemetry.** Zero runtime dependencies, nothing phones home. A static guard test (`src/no-network.test.mjs`) fails the build if a network-client or subprocess call is added to the Node code (`src/`, `bin/`) outside the one documented case (opening your browser locally). The web UI bundle contains no `fetch` call by construction, but is not covered by this static guard — it's plain source you can read yourself in `web/src/`.
- **Everything loryme writes, in full:**
  - `<dataDir>` (default `~/.loryme`, override with `LORYME_DATA_DIR`): board events (`board/events.jsonl`), the search index (`search.db`, redacted content only), signing keys (`keys/`), and policy state and logs (`policy.json`, `policy-state/`, `policy.log`).
  - Your OS temp directory: a small metadata cache (titles + timestamps, redacted, auto-evicted after 30 days).
  - `~/.claude/settings.json`: only if you run `loryme hooks install` (backed up first, removed again with `loryme hooks uninstall`).
- **Single-process assumption.** loryme expects one server instance per data dir. Running two instances against the same `<dataDir>` at once is an unsupported, documented limitation — not something the code guards against.

These are not just claims in prose — each one is enforced by a test in `src/`. Read the tests if you want to verify it yourself instead of trusting this README.

## FAQ

**Claude Code changed its transcript format and loryme broke — now what?**
The JSONL format Claude Code writes is undocumented and has drifted before. The parser is deliberately tolerant: it never throws on an unrecognized line, it wraps anything it doesn't understand in an `UnknownBlock` and keeps going. If a session renders oddly, that's the fallback working as intended, not a crash. A `doctor` command to diagnose format drift is planned but not built yet.

**Which platforms are supported?**
Windows, macOS, Linux. Requires Node.js ≥ 20.

**Does this send anything to Anthropic, or anywhere else?**
No. See [Privacy](#privacy) above.

**Can I point it at a different directory, e.g. a backup of my sessions?**
Yes, `--dir <path>`.

## License

Apache-2.0. Unofficial community tool — not affiliated with or endorsed by Anthropic.
