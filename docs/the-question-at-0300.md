<!--
slug: the-question-at-0300
meta-description: A nightly Claude Code turn hits a permission prompt at 03:00. kaprek files the question, lets the turn finish, and runs one action once you approve.
-->

# The question at 03:00

## 03:00, and the agent has a question

This is a made-up example. You work in a terminal with Claude Code all day. kaprek runs underneath: with its hooks installed, your first Claude Code session of the day starts the kaprek server in the background, and it stays up until you run `kaprek stop`.

In kaprek you have set up a nightly trigger. At 03:00 it starts a turn on a demo project called `example-shop`, which sits in kaprek's own workspace folder. The task: run the tests, fix what broke, write a short report. Halfway through, the agent wants to run `npm install --save-dev example-lint-plugin`. In this setup it has to ask before it runs that command. So it asks.

Nobody answers. You are asleep, the terminal tabs are closed, the laptop screen is dark.

People who run agents on a schedule have described this moment in public bug reports. A job stops at a permission prompt in the night and stays stopped. Later runs pile up behind it or skip.

## Two bad defaults

### Wait for the human

The obvious fix is to hold the turn open until someone answers. For a turn you start yourself in a kaprek chat, kaprek does exactly that. The turn waits, and after 10 minutes without an answer the action is denied.

At night the same rule turns ugly. A `claude` process sits parked for hours. The chat is locked. The trigger that started it is stuck behind an answer that may never come. If the machine restarts, the question and the half-done turn vanish together.

### Allow everything up front

The other way out is to switch the prompts off before bed. In Claude Code that is one flag, `--dangerously-skip-permissions`. Then nothing waits, and nothing asks. The gate you set up for installs, deletes and pushes is gone for the whole night. You learn what went through it by reading the diff.

## What kaprek does instead: file it, finish the turn

### The agent is told, and carries on

When a trigger started the turn, kaprek holds nothing open. The question goes into kaprek's approval inbox. In the same step the agent gets a plain message back: this action needs human approval, none is available, the request has been filed. Do not retry it in this turn. Continue with everything that does not need it and finish normally.

In the example, the agent leaves the install alone. It fixes the tests that never needed the plugin. Its report says one action is waiting for you.

### The question survives the turn and a restart

A filed question hangs on no running process. The turn that raised it can end, and kaprek can stop and start again. The question is still answerable, because approving it starts a fresh turn. A question inside a live chat dies with the server; the next start marks it `process gone`.

### The morning starts in the terminal

You open a terminal, as on any other day, and start Claude Code. The night's test fixes are on disk in `example-shop`. You read them the way you read any diff.

The open question does not show up in that terminal, and the new session will not bring it up. kaprek's SessionStart hook counts waiting questions only for kaprek missions, when a session opens in the mission's folder. A trigger's turn runs in a chat that belongs to no mission.

You answer in the browser. Type `kaprek` in the terminal: when the server is already running, it prints the address and opens it in your default browser. The question waits under `#/approvals`. No terminal command answers it.

From there, three moves are left: **Approve & run now**, **Deny**, or nothing at all. A deny is recorded and nothing runs.

## Approve & run now: exactly one action

### A fresh follow-up turn, narrow prompt

Approving starts a short follow-up turn in the same kaprek chat. Its prompt names the approved tool and shows the input. It tells the agent to execute exactly that action, report the result briefly, and do nothing else.

### The same call with the same input, nothing else

The approval covers one call: the same tool with the same input. Suppose the agent in the follow-up turn tries a different package, or adds a flag. That call becomes a new question in the inbox. The same install a second time asks again too.

kaprek replays the action from the input it stored. Inputs over 1 MiB are kept only as a preview. Approving one of those starts a turn that asks again before it runs, this time with you there to answer.

### The approval is spent only once the action ran

Sometimes the follow-up turn ends before it reaches the approved call. The approval is then still unused. kaprek puts the question back as open, so the inbox shows that the install you approved did not happen. You can approve it again.

## What happens if you never answer

Nothing runs. After 24 hours the question lapses quietly. A trigger that still wants the action asks again on its next run.

Some questions end earlier because nobody can answer them any more. The run that asked was aborted, its trigger was deleted, or kaprek shut down. Those are recorded as `cancelled`, with the reason. No person denied anything, so they do not count as a deny.

`#/approvals` has a second tab, **History**. It shows what became of every question that is no longer waiting: the decision, who answered, how long the question waited. A cancelled question stays there for 7 days from the moment it was cancelled. A late click on something that already lapsed or was cancelled is refused, and the refusal names the state that got there first. Nothing is answered twice.

## The trade, stated plainly

The agent does not get to install the plugin while you sleep. If the night's task truly cannot go on without it, the task ends unfinished. The turn's own report is where you read that. The README lists this as the first of its known gaps.

In return, nothing is held hostage to a question. No process parked overnight, no chat locked for hours, no trigger blocked behind a missing click. By morning the work that did not need you is on disk, and the one thing that did waits in the inbox.

## Try it on your own machine

Run `npx kaprek`. It needs Node 22 or newer. There is no account to create and no API key to enter: kaprek runs the `claude` CLI you already have installed and signed in. kaprek is free and open source under Apache-2.0.

For the hooks, install globally: `npm i -g kaprek && kaprek hooks install`. Hooks set up through `npx` point into npm's cache, which npm may clear.

## FAQ

**Does the agent wait overnight for my answer?**
No. A question from a trigger-started turn is filed, and the agent is told to carry on and finish its turn. Only a turn you started yourself waits, and it is denied after 10 minutes.

**Can I answer the question from the terminal?**
No. You answer on the `#/approvals` page of the running kaprek. Typing `kaprek` in the terminal opens the running instance in your browser.

**If I approve in the morning, could the agent run something slightly different?**
The follow-up turn allows the same tool with the same input and nothing else. Any other call becomes a new question. The approval counts as spent only once the action actually ran.

**Does a filed question survive restarting kaprek?**
Yes. It hangs on no running process, and approving starts a fresh turn. A question inside a live chat does not survive a crash.
