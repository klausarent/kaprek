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

## Privacy

- **Local only.** The server binds to `127.0.0.1` and rejects requests with a foreign `Host` header — enforced by the server's own tests (`src/server/server.test.mjs`).
- **Redaction on by default.** 10 secret patterns (API keys, Stripe/GitHub/Cloudflare/Google tokens, Bearer headers, `TOKEN=`/`SECRET=`/`API_KEY=`-style assignments) are replaced with `[REDACTED]` before a digest is built. Opt out consciously with `--no-redact`. Behavior is checked by an end-to-end test (`src/redaction-e2e.test.mjs`).
- **Read-only.** loryme never writes to `~/.claude`.
- **No telemetry.** Zero runtime dependencies, nothing phones home. A static guard test (`src/no-network.test.mjs`) fails the build if a network-client or subprocess call is added to the Node code (`src/`, `bin/`) outside the one documented case (opening your browser locally). The web UI bundle contains no `fetch` call by construction, but is not covered by this static guard — it's plain source you can read yourself in `web/src/`.
- **Writes a small metadata cache to your OS temp directory** (titles + timestamps, redacted, auto-evicted after 30 days). Nothing else is written.

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
