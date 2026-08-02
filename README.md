# kaprek

> Your Claude Code sessions never die — you just can't see them.

kaprek is a local agent workspace built around the Claude Code CLI you already have. It runs chat turns and scheduled triggers through that CLI, shows you what the agents are doing, and asks before they do anything you said should need asking. It also reads `~/.claude/projects` and serves your existing session transcripts as a searchable list of threads.

kaprek itself has no server and no account. Your prompts still go to Anthropic, because the `claude` CLI sends them — see [What leaves your machine](#what-leaves-your-machine).

**Status: early preview.** Built and tested on Windows first; macOS/Linux should work but have seen less real use — [issues](https://github.com/klausarent/kaprek/issues) welcome.

![kaprek's thread view — a session rendered as a conversation, with tool calls](docs/screenshot.png)

*The screenshot shows synthetic demo data, not a real session.*

## Quickstart

```
npx kaprek
# → opens http://127.0.0.1:4900 — all projects, all sessions, thread view
```

No install and no config for kaprek itself, and it has no account of its own. Ctrl+C stops the server.

Viewing transcripts needs nothing else. Chat and triggers need the `claude` CLI installed and signed in — kaprek runs your CLI and never asks for an API key.

## Updating

```
kaprek update          # look, and install if there is something newer
kaprek update --check  # only look
```

This is the one command that talks to the internet, and it says so before it
does. There is no check on start: a tool that phones home every time it boots
is a tool nobody can reason about.

What it does depends on how kaprek got onto the machine, because only one of
those can be updated by npm:

| Installed as | `kaprek update` |
| --- | --- |
| global (`npm i -g kaprek`) | installs the new version |
| through `npx` | tells you to run `npx kaprek@latest` — nothing is installed to update, and without `@latest` npx reuses its cache |
| a project's dependency | tells you to update it in that project |
| a git checkout | tells you to `git pull` — npm would overwrite your working tree |

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
- Preserves a session's scratchpad work products (scripts, data, images) before OS temp cleanup deletes them — see [Artifact preservation](#artifact-preservation).
- Missions: name a goal once, point it at a real project directory, and every chat, task, and pending question of that work hangs together — see [Missions](#missions).
- Two engines: chats run on your Claude Code CLI by default, or on your Codex CLI — picked per chat, same approval flow, same inbox — see [Engines](#engines).
- Guided planning: say what you want to build and answer a few cards instead of a wall of questions; the plan lands at a path kaprek chose and shows up under [Plans](#plans) — with its full path, so you never go hunting through folders for it.
- Council: put your engines in four roles (lead, thinker, worker, peer) and ask the ones you are not using for a second opinion — kaprek shows where they disagree rather than smoothing it over. See [Council](#council).
- Recipes: a relay run's shape is a file, not code — who takes part, which handoff asks you first, which step may touch files. See [Relays and recipes](#relays-and-recipes).
- Memory with scopes: what one agent learned is there for the next one, and a scope that is not on your path upwards is invisible — see [Memory](#memory).
- Setup page (`#/setup`): which agent CLIs are installed and signed in on this machine, where their config lives, which MCP servers they have, and which keys your `.env` defines — paths and names only, never a value.

## Missions

A mission (`#/missions`) is what you're trying to get done: a title, a goal,
and optionally the project directory the work lives in. Chats started inside a
mission are linked to it, board tasks can be linked to it, and the mission's
detail page shows what is waiting on you — the same durable inbox questions,
grouped by the work they belong to. There is only one interface: the same
missions page serves a weekend project and a client codebase alike.

**The working-directory rule, stated plainly:** by default every chat turn
runs in a jailed `<dataDir>/workspace` directory, so an agent never edits
whatever directory kaprek happened to be started from. A mission may point at
a real project directory instead. That is the one deliberate door out of the
jail, and it is bound to an explicit human act: you type the absolute path
once when creating the mission, it is checked to exist right there, and it is
re-checked on every turn — if the directory is gone the turn fails with an
error rather than silently falling back to the workspace. Every turn of that
mission (including follow-ups addressed by chat id alone) runs in the
mission's directory, with the same permission flow as any other turn.

Presets pre-fill a new mission: two generic ones ship built in (`blank` and
`guided-feature`), and you can add your own as JSON files under
`<dataDir>/presets/` — `{id, title, description, goalTemplate, firstPrompt}`.
A user preset with a builtin's id replaces it; an invalid file is skipped with
a warning, never a crash.

## Plans

Say something like "let's build a small line counter" and kaprek offers to
work through it as a quiz: a few questions, each with two to four options and
a description of what choosing it means, plus a box for the answer nobody
listed. Answering sends the next turn with each question quoted next to your
answer.

When there is enough to design with, the agent writes the plan — to a path
kaprek decided BEFORE the turn started, not one it reports afterwards. That
inversion is the point. `#/plans` lists every plan, shows its absolute path
with a copy button, ticks steps straight into the file (so your editor and
your git see the same truth), and starts a chat that works through it.

A guided turn where the agent answered in prose anyway says so. The mode is
an instruction to a model, not a guarantee, and a quiet failure would leave
you with the old wall of text wearing a new label.

## Council

Four jobs, and whichever engines you have doing them:

| Role | Does |
| --- | --- |
| `lead` | Splits the work and puts the answers back together. |
| `thinker` | Architecture, algorithms, the analysis worth paying for. |
| `worker` | Boilerplate, tests, mechanical edits. |
| `peer` | Independent second opinion. Several are fine. |

No model name is wired into kaprek. Running Codex as the lead with Claude on
the peer bench is two dropdowns on `#/council`, and the suggestion you start
from is built from what is actually installed on your machine.

A consultation sends every peer the same package — the question, the files
worth reading, the constraints, what was already ruled out — in parallel and
read-only. A peer never sees your conversation: an investigation's thread
does not survive being handed over, and a peer answering from half the
context answers confidently and wrongly.

Peers answer with a verdict (`agree` / `concerns` / `disagree`), so one
dissenter means no consensus and you see the disagreement in the peer's own
words. If only one engine is installed, kaprek says there is no second
opinion to get instead of asking one model to review itself.

`off` / `plans` / `decisions` / `always` govern what kaprek asks **unasked**.
The "Second opinion" button in a chat works at every level, including `off`.

At `plans` and above, writing a plan is the moment that fires by itself: the
peers get the plan's path and read the file. That consultation does **not**
hold the turn open — it takes minutes, it runs beside the chat, and its
result lands in `#/chat` when it is done, whether or not the tab stayed open.
One consultation per chat at a time, two in total. A verdict about a plan you
edited afterwards is marked as stale rather than shown as review, and one
interrupted by a restart says so instead of being quietly asked again.

## Engines

A new chat picks which already-installed, already-authenticated CLI runs its
turns: `claude` (the default) or `codex`. The choice is fixed at chat
creation — one conversation is one CLI session, and handing a resume id from
one CLI to another is not a thing — and shows as a badge afterwards; the
default engine deliberately shows nothing.

The Codex engine speaks JSON-RPC to `codex app-server`, spawned per turn the
same way `claude -p` is. Approvals work identically from your side: with the
default permission mode, Codex runs in a read-only sandbox, so every write it
wants becomes a question — in the live approval dialog or the durable inbox,
wherever the turn is running. Honest differences, declared by the registry
(`GET /api/engines`) rather than discovered mid-turn: Codex reports token
usage but **no dollar figure** (cost shows as unknown, never as a made-up
number), an approval cannot rewrite the proposed input on allow, and
Claude-specific options (allowed tools, MCP config, settings files) do not
apply.

A chat's own engine is still fixed at creation. A **relay recipe** is the one
place where several engines work inside one chat on purpose — see below.

## Relays and recipes

A relay is a controlled handoff between agents: each step is an event in the
chat log, under a budget, with a human gate. A **recipe** says who takes part
and in what order — it is data, and `<dataDir>/recipes/*.json` is yours to
add to. `GET /api/recipes` lists what is available; the relay panel picks one.

```json
{
  "id": "write-review-apply",
  "title": "Draft, review, then apply",
  "steps": [
    { "id": "write",  "agent": "grok" },
    { "id": "review", "agent": "claude" },
    { "id": "apply",  "agent": "codex", "tools": "full" }
  ],
  "edges": [
    { "from": "write",  "to": "review" },
    { "from": "review", "to": "apply", "requiresHuman": true },
    { "from": "apply",  "to": "write" }
  ],
  "budgets": { "maxRounds": 2, "hardMaxTurns": 12, "retriesPerDispatch": 1 },
  "escalation": { "onPeerFailure": "stop", "onBudget": "question" }
}
```

- **Edges carry the policy.** `requiresHuman` asks *before* the step on the
  far side runs, which is the only moment the answer can still change
  anything. The approval buys exactly one passage of that edge and no extra
  round; the same edge asks again next time round.
- **Tools are per step and fail-closed.** A step gets none unless it says
  `"tools": "full"`, and only `claude` and `codex` steps can — a text peer has
  no tools to give. A step that has them runs in the mission's own directory,
  and every action it takes goes through the approval inbox with the same
  24-hour window a trigger's question gets. That is what lets an overnight
  batch park on a question instead of being auto-denied.
- **Retries are budgeted**, with 15s then 30s of backoff, each attempt in the
  log under its own dispatch id. When they are spent, `escalation` decides:
  `stop`, `question` (ask you), or `notify` (carry on past the broken step and
  say so).
- **The deferred inbox is the only human gate.** Round gates, edge gates and
  peer-failure questions all land there — as does every approval a step with
  tools asks for. A relay step *waits* on its question rather than ending and
  being replayed later, so the answer reaches the process (and the engine)
  that asked it. The honest limit: that question lives as long as the relay
  turn does, not for 24 hours.

Refusals happen before a run starts, not three handoffs in: an unknown agent,
an unknown recipe id, a duplicate step id, or a step no edge leads to.

Starting a relay from a trigger stays deliberately closed — an unattended
loop that starts itself is the one thing on the kill list.

## Memory

What was learned while working, kept per scope, so the next agent starts
with it instead of rediscovering it.

A scope is `person:` → `project:` → `mission:`, and **visibility runs
upwards, never down**. A mission sees its project sees its person; a person
does not see into their missions, and two trees that do not share a parent
see nothing of each other. That single rule is both halves of what memory
has to do: what Codex learned about a project is there for Claude, and a
scope belonging to somebody else's work is not readable from yours. Both are
tests, not assurances.

A turn inside a mission is given what its scope knows — profile first, then
facts, evidence only on request — and can add to it by answering with a
fenced block:

````
```kaprek-remember
{"text": "the deploy token lives in the CI settings, not in .env", "kind": "fact"}
```
````

The agent supplies the text; kaprek attaches the owner. An agent that could
name its own scope could write into one it may not read. A chat outside any
mission has no scope and neither reads nor writes.

The profile is frozen for the length of a conversation: a profile line
written while a chat is running takes effect in the next one. It sits at the
head of every prompt in that chat, which is exactly what a provider's prefix
cache keys on — changing it mid-conversation would throw away every cached
token for the rest of it. Facts are not frozen; they arrive as they are
learned.

Every statement carries an origin and an age. Past 90 days without a verify
it still comes back, marked stale — an agent that forgets on a schedule is
one nobody can reason about. Forgetting is an event with a reason, and
evidence is a pointer into a session, never a copied excerpt. `#/memory`
shows one scope at a time; there is deliberately no "everything" view.

When the same failure pattern shows up three times, kaprek writes down the
rule it would add and asks. Until someone accepts it, that proposal reaches
no prompt at all — a system that turns its own observations into active rules
re-educates itself out of sight. Accepted rules go into the prompt as
instructions; a rejected one is not proposed again.

Not built, deliberately: vector search, embeddings, automatic summarizing of
raw transcripts, syncing between machines.

## Answering from a phone (`--lan`)

kaprek listens on `127.0.0.1`. `kaprek --lan` also listens on this machine's
network address and prints a QR code:

```
http://127.0.0.1:4900

Also reachable at http://192.168.1.42:4900 — anyone on this network who has
the token can answer your questions.
The token is in the QR code below. Scan it with your phone:

  █▀▀▀▀▀█ ▀▄█▀▄ █▀▀▀▀▀█
  ...
```

Scan it and the phone lands on the approvals inbox, where allow and deny are
full-width buttons a thumb can hit. An overnight batch parks on its question
and the answer reaches the turn that is waiting for it.

What holds either way:

- **The token is only handed out over loopback.** Normally kaprek puts it in
  the page it serves, which is how the browser on this machine gets it
  without anyone typing. A request from the network gets the page *without*
  it and has to bring one — that is what the QR carries, and it is why the
  QR is not decoration. The phone keeps it per tab and strips it out of the
  address bar.
- **The Host check gains exactly one address**, this machine's own. A
  hostname pointed at that IP is still refused, so DNS rebinding gets no
  further than it did before.
- **`--lan` is a flag, not a setting.** Opening a port to a network should
  not be something you can switch on once and forget.
- On a machine with no network address, `--lan` stays on loopback and says
  so rather than printing a QR for an address that does not exist.

## Search

Full-text search across every indexed session, backed by SQLite FTS5. Requires Node 22+, since it uses the built-in `node:sqlite` module — on older Node it degrades cleanly, the UI reports search as unavailable instead of crashing. Only redacted content is indexed, same as the digest view. Build or refresh the index from the reindex button in the search view (`#/search`), or `POST /api/search/reindex`.

The index only covers a session's title plus its user/assistant text, truncated to the first 4,000 characters per event — tool output, thinking blocks, and subagent transcripts are not indexed at all. A search miss doesn't mean the term isn't in the session; it may just be outside what's indexed.

## Task board

A local task board (`#/board`) for tracking work against these sessions.

The core rule: a task can only be marked done once it carries a complete 7-field completion record — what triggered it, the outcome, the approach taken, the course including any detours or failures, how it was verified, the effort spent, and what's still open. All seven fields are required and enforced server-side, not just suggested by the UI. It's the discipline your future self wants but never keeps on its own.

## Receipts

A receipt is an ed25519-signed snapshot of a completed task: its doc plus its linked sessions, signed at the moment you ask for one. It proves that a given key signed this exact state at this time — it does not prove the work is good, and the agent name is self-declared, not a verified identity. The verify view shows valid/invalid; editing the doc after signing invalidates the receipt, because verification always re-checks against the task's current state, not a stored snapshot.

## Artifact preservation

Claude Code writes scratchpad work products (scripts, data files, images) under `<OS temp dir>/claude/<projectSlug>/<sessionId>/scratchpad/`, alongside the transcript it also writes to `~/.claude/projects`. The transcript survives — that's kaprek's whole reason to exist — but the OS temp directory does not; it gets wiped routinely, and a scratchpad disappears with it while the transcript that references it lives on.

kaprek sweeps every session's scratchpad into `<dataDir>/artifacts/<projectSlug>/<sessionId>/` in two ways: automatically (best-effort, small byte budget) when the Stop hook fires for that session, and fully (no budget beyond the caps below) whenever the search index is rebuilt (`POST /api/search/reindex`, including the button in `#/search`). A per-session `manifest.json` makes repeat sweeps idempotent — unchanged files are neither re-hashed nor re-copied. Two caps bound disk usage: a single file over 25 MB is skipped (recorded in the manifest as `too-large`), and once a session's preserved total crosses 100 MB (20 MB for the hook's own smaller sweep) further files are skipped as `session-budget`. A session's preserved artifacts, if any, show up under an "Artifacts" section on its thread view.

## Claude Code hook (optional)

kaprek can install a Claude Code **Stop** hook that gently enforces the policy engine's rules (e.g. flagging a session that made a commit without a linked board task). It is opt-in only — nothing is installed by default.

Important: a Stop hook fires *after* the turn already ended — after any tool call in it, including a `git commit`, already ran. It cannot prevent a commit or require a task link "before" one happens; it can only look back at the transcript once the turn is over and react (log, warn, or refuse to end that particular Stop event) to what already occurred. Think of it as a nag, not a gate.

- `kaprek hooks install` adds one entry to `~/.claude/settings.json` (backs up the file first, leaves any other hooks untouched).
- `kaprek hooks uninstall` removes only that entry, at any time, identified by a stable `--managed-by` marker so a later reinstall never creates a duplicate.
- `kaprek hooks status` shows whether it's installed and which policy mode is active.

Policy mode lives in `<dataDir>/policy.json`: `observe` (default) fully evaluates both rules and logs any violation to `policy.log`, but always resolves to allow — it's for seeing what would happen before switching modes. `warn` writes its reasons to stderr (Claude Code hooks reference exit 0 as no objection either way, so this is best-effort visibility, not a blocking signal). `block` is the only mode that can actually end a turn abnormally, and even then at most once per session. The hook fails open on any internal error — a bug here must never stop you from ending a turn. This is the single exception to kaprek's read-only promise; every other feature only reads `~/.claude/projects`.

## Approvals

Before an agent runs a tool it can be made to ask. What happens next depends on whether anyone is there.

**You started the turn.** The question appears in the chat you are looking at, the turn waits for your answer, and after 10 minutes without one it is denied. Unchanged, and right: you are already there.

**A trigger started the turn on its own.** Nobody is there, so nothing waits. The question is filed to the inbox and the agent is told, in the same breath, that the action has been filed and that it should carry on with everything else and finish its turn. Later you open kaprek, see the question in the floating box (bottom right, on every page) or under `#/approvals`, and decide:

- **Approve & run now** — kaprek starts a short follow-up turn in that same chat which runs exactly that one action. The approval is single-use and exact: the same call a second time, or a call one byte different, goes back into the inbox.
- **Deny** — recorded, nothing runs.
- **×** — hides the card in the box. It is not an answer: the question stays in `#/approvals`, stays answerable, and comes back into the box the next time the trigger asks.
- **Nothing at all** — after 24 hours the question lapses, quietly. A trigger that still wants it asks again on its next run.

This is a deliberate trade. The agent does not get to do the thing it asked for while you sleep, and a task that truly cannot continue without the answer will end unfinished. In exchange, nothing is held hostage to a question: no `claude` process parked overnight, no chat locked for hours, no trigger blocked behind one waiting for an answer that may never come.

**What survives what.** A filed question survives the turn that raised it, and it survives restarting kaprek — it hangs on no process, and approving starts a fresh turn. A question in a live chat dialog does not: the turn waiting on it dies with the server, so those are marked `process gone` on the next start and refused rather than answered.

Two limits worth knowing. The action is replayed from the input kaprek stored, and inputs over 1 MiB are kept only as a preview — approving one of those starts a turn that asks again before it runs, with you there to answer. And a follow-up turn is a trigger turn like any other, so it is refused while another turn is running in that chat; approve again once it is done.

## What leaves your machine

kaprek runs agent turns. That changes the honest answer to "does anything leave my machine", so this section states it plainly rather than in a slogan.

**Stays on your machine.** Chat logs (`<dataDir>/chats/`), trigger configuration (`triggers.json`), the run and cost log (`runs.jsonl`), everything an agent writes in the workspace (`<dataDir>/workspace/`), the board, the search index and preserved artifacts. kaprek operates no server of its own, has no account, and sends none of this anywhere. The static guard test `src/no-network.test.mjs` fails the build if a network call is added to `src/` or `bin/`.

**The one exception, and it is a command you type.** `kaprek update` asks the
npm registry which version is newest — an update command that cannot do that
would be a button that does nothing. It runs only when asked, prints what it
is about to do first, and the same guard test pins it to
`registry.npmjs.org` and nothing else. There is no check on start.

**Goes to Anthropic.** Everything an agent actually processes. kaprek starts your local `claude` CLI as a subprocess, and that CLI talks to Anthropic under your account and your agreement with them — kaprek neither adds to nor removes from what the CLI sends. That includes:

- every chat message you type, and the tool results the turn produces;
- every trigger prompt, on every automatic run. A heartbeat trigger sends its checklist file along each time it fires. A file-watch trigger sends the paths that changed. A clipboard trigger sends the clipboard text that matched its pattern.

A trigger that runs every 30 minutes is 48 requests a day to Anthropic that you did not individually approve. That is the point of triggers; it is also worth knowing before you enable one on a workspace holding something sensitive.

**What the instance token protects against.** Every `/api/*` route requires the per-installation token, and the browser gets it from a `<meta>` tag in the served `index.html`. That stops a random web page you have open from driving your local kaprek: a foreign origin cannot read the response to `GET /`, so it never learns the token, and it cannot set the required header either.

It does **not** protect against other programs on this machine. Any local process can request `GET /` and read the token out of the HTML, then use the API exactly as you would — including starting agent turns and approving filed questions, which runs the approved tool call. The fix is a desktop shell that keeps the token out of HTTP entirely; that is on the backlog and not built. Until then, the security boundary is "you trust the software running under your own user account".

**What apps may do.** Only the apps bundled with kaprek are loaded. Anything you drop into `<dataDir>/apps/` is found, listed on the Apps page as not loaded, and skipped — because every app's tools run inside one shared Node process, so a third-party app could patch `JSON.stringify` or `process.stdout.write` and read or rewrite another app's results, and a synchronous loop in one would wedge them all. That stays shut until app handlers run isolated. `KAPREK_ALLOW_USER_APPS=1` loads them anyway; setting it is a decision to open exactly that gap.

For the apps that do load, file access is genuinely enforced: the MCP server runs under Node's `--permission` model with a narrow allowlist (write only inside the workspace, read only the app directories and the workspace — see `src/apps/mcp-config.mjs`).

Their **network access is not restricted at all.** Node's permission model has no network scope, so an app handler can open any connection it likes. The `policy.dataEgress` and `policy.externalAction` fields in a manifest are display metadata for the Apps page; nothing enforces them. This is why bundled apps are reviewed with kaprek and third-party ones are off by default.

**The tool list heals itself, and the first run after a CLI update may fail.** kaprek asks the `claude` CLI which tools it has and keeps a learned list, so that a tool the CLI added is covered by the approval rules instead of slipping past them. When the CLI gains a tool kaprek has never seen, the next trigger run stops fail-closed rather than proceeding with an unverified list — and records what it learned. The run after that generally succeeds; on our own machine it took two. This is deliberate: the safe direction for an unknown tool is to stop, not to allow.

## Privacy

- **Local only.** The server binds to `127.0.0.1` and rejects requests with a foreign `Host` header — enforced by the server's own tests (`src/server/server.test.mjs`).
- **Redaction on by default.** 10 secret patterns (API keys, Stripe/GitHub/Cloudflare/Google tokens, Bearer headers, `TOKEN=`/`SECRET=`/`API_KEY=`-style assignments) are replaced with `[REDACTED]` before a digest is built. Opt out consciously with `--no-redact`. Behavior is checked by an end-to-end test (`src/redaction-e2e.test.mjs`).
- **Artifacts are the one exception to redaction.** Preserved scratchpad files (see [Artifact preservation](#artifact-preservation)) are copied byte-for-byte, in the clear, under `<dataDir>/artifacts/`. They are not chat transcripts — they're work products (scripts, data, images) — and running secret-redaction text substitution over arbitrary file content, including binaries, would silently corrupt it. Preservation stays strictly local either way: nothing here is ever sent anywhere.
- **Read-only, with one opt-in exception.** kaprek never writes to `~/.claude` unless you explicitly run `kaprek hooks install` — see [Claude Code hook](#claude-code-hook-optional) above. Every other feature only reads `~/.claude/projects`.
- **No telemetry.** Zero runtime dependencies; kaprek itself phones nothing home (agent turns go to Anthropic through your own CLI, see [What leaves your machine](#what-leaves-your-machine)). A static guard test (`src/no-network.test.mjs`) fails the build if a network-client call is added anywhere in the Node code (`src/`, `bin/`). It permits exactly one outgoing connection: the instance lock (`src/lib/instance-lock.mjs`) connects to `127.0.0.1` (or to its own named pipe on Windows) to ask whoever holds the lock address whether they are another kaprek on the same data dir. A second test in the same file pins that module to loopback, so the exception cannot quietly grow into a real network call. Subprocess calls are likewise refused outside the three places that need one: `bin/cli.mjs` opening your browser, `src/harness/*` starting the `claude` CLI, and `src/triggers/clipboard.mjs` reading the Windows clipboard. The web UI naturally does use `fetch` — that's how it talks to kaprek's own local API on `127.0.0.1` (`web/src/lib/api.ts`) — but it has no other network call, and that promise isn't enforced by the static guard above (which only scans `src/`/`bin/`, not `web/`); it's plain source you can read yourself.
- **Everything kaprek writes, in full:**
  - `<dataDir>` (default `~/.kaprek`, override with `KAPREK_DATA_DIR`): board events (`board/events.jsonl`), the search index (`search.db`, redacted content only), signing keys (`keys/`), policy state and logs (`policy.json`, `policy-state/`, `policy.log`), preserved scratchpad artifacts (`artifacts/<projectSlug>/<sessionId>/`, **not** redacted — see [Artifact preservation](#artifact-preservation)), the approval inbox (`approvals.json`, redacted like every other stored tool input — see [Approvals](#approvals)), and `instance.lock` (pid, server port, lock address, start time). That file is there for you to read when you wonder what is running; it holds no lock. Exclusivity comes from the OS handle described below, so a leftover `instance.lock` from a crash blocks nothing and is simply overwritten by the next start.
  - Your OS temp directory: a small metadata cache (titles + timestamps + a `machineHint`, a username heuristic parsed out of a session's `cwd`, all redacted, auto-evicted after 30 days). Written with default file permissions (unlike the signing keys under `keys/`, which are created `0600`).
  - `~/.claude/settings.json`: only if you run `kaprek hooks install` (backed up first, removed again with `kaprek hooks uninstall`).
- **One server per data dir, enforced.** A second start against the same `<dataDir>` refuses to run rather than silently landing on another port. The lock is an OS handle, not a file: on Windows a named pipe whose name carries a hash of the data dir path, on macOS and Linux a TCP socket on `127.0.0.1` at a port derived from that same hash (23000–31999, clear of the ranges the OS hands out for outgoing connections). Either way the OS refuses the second bind, and a crashed instance releases its lock the moment the process dies — no waiting period, nothing left to clean up. The Windows half of that is measured; the macOS and Linux half rests on documented socket semantics that this build has not yet run against a real POSIX kernel (the tests that prove it are in the suite and ungated, they simply have not run there). One data dir means one address and no fallback: if something else holds it, kaprek asks for a one-line greeting, reports the running instance when the answer is its own, and otherwise refuses to start instead of moving somewhere else. Moving is how you end up with two.
  This stops accidental double starts — a second double-click, a launcher left in Autostart. It is not a defence against hostile local code: any program running as you can squat the pipe name or port and keep kaprek from starting, the same boundary the instance token lives on (see [Known gaps](#known-gaps)). See `src/lib/instance-lock.mjs`.

These are not just claims in prose — each one is enforced by a test in `src/`. Read the tests if you want to verify it yourself instead of trusting this README.

## Known gaps

Things this version does not do, listed here because each one is a limit you can run into rather than a feature nobody got to.

- **An unattended agent does not get to wait for you.** A question a trigger raises is filed, not waited on, so the action does not happen until you approve it and kaprek runs the follow-up turn. Work that genuinely cannot proceed without that action ends unfinished, and the turn's own report is where you find out. This is the trade described in [Approvals](#approvals), not an oversight.
- **A live chat question still dies with the server.** Only filed questions survive a restart. One raised in a chat you are sitting in belongs to a turn that is waiting, and that turn ends when the process does.
- **Nobody has to be there.** A `question` trigger now runs whether or not anyone will ever look at what it asks. The failure direction is safe (unanswered means not done), but the turn did run and did cost.
- **Three trigger turns at a time.** A tick starts at most three; the rest stay due and try again a minute later. A scheduled trigger whose window closes while all three slots are busy misses that run outright.
- **The instance token does not stop local programs.** See [What leaves your machine](#what-leaves-your-machine). A desktop shell that never puts the token on HTTP is the fix.
- **Neither does the instance lock.** A program running as you can bind kaprek's pipe name (or its derived port) first and stay silent, and every start against that data dir then refuses. The lock is built against accidental double starts, not against local code that wants to get in the way. On Windows the pipe namespace is machine-wide, so two accounts pointing `KAPREK_DATA_DIR` at one directory can also block each other; the refusal names that case.
- **Third-party apps are off, and app handlers can reach the network.** Both come from the same missing piece: apps share one process and are unfenced on the network side. Worker isolation is the fix; until then only bundled apps load (`KAPREK_ALLOW_USER_APPS=1` overrides it).

## FAQ

**Claude Code changed its transcript format and kaprek broke — now what?**
The JSONL format Claude Code writes is undocumented and has drifted before. The parser is deliberately tolerant, but in two different ways depending on where the drift shows up: a line that isn't even valid JSON is silently skipped and counted (`brokenLines`), never thrown on. A well-formed line whose `type` the parser doesn't recognize is also silently skipped — it never becomes an event at all, so it does not surface anywhere in the UI. Separately, the web UI's event renderer falls back to a generic `UnknownBlock` for any event *kind* the parser itself emits that the renderer has no component for yet — a safety net for the UI lagging behind the parser, not a way to see raw unrecognized transcript lines. If a session renders oddly, missing content is more likely a silently-skipped line than a crash — a `doctor` command to diagnose format drift is planned but not built yet.

**Which platforms are supported?**
Windows, macOS, Linux. Requires Node.js ≥ 22 (the search index uses the built-in `node:sqlite`). Clipboard triggers are Windows-only; the trigger page says so on the trigger itself.

**Does this send anything to Anthropic, or anywhere else?**
Yes, to Anthropic — every chat message and every trigger prompt, because your own  CLI sends them under your account. kaprek adds no destination of its own and has no server. See [What leaves your machine](#what-leaves-your-machine) for the details, including what a scheduled trigger sends on each run.

**Can I point it at a different directory, e.g. a backup of my sessions?**
Yes, `--dir <path>`.

## License

Apache-2.0. Unofficial community tool — not affiliated with or endorsed by Anthropic.
