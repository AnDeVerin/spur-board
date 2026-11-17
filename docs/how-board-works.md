# How the Board works

Choose the topic for the decision or action in front of you:

- [Columns and gates](how-board-works-columns.md): find the executor, placement rules and gate requirements.
- [Turns and delivery](how-board-works-turns.md): acknowledge work, submit or return, handle doorbells and repeated returns.
- [Blocks and escalation](how-board-works-blocks.md): route a question or escalate a block, and read the operator inbox and what to do about each item.
- [Slack conversations](how-board-works-slack.md): choose a channel, address an agent and answer in a thread.
- [Done follows the ticket](how-board-works-done.md): check when a task is finished.

Read effective project configuration with `board config get`, then the current overview with
`board status`. Configuration lists enabled columns in order, their executors, dispatcher mode,
effective Spur projects with display names and each project's `ticketBrowseBase`
(`<tracker baseUrl>/browse/` for Jira, else null), plus `web.publicOrigin` (the listener's origin,
null when off or not bound yet) and `web.spurUiOrigin` (null when not configured). It excludes
credentials and adapter settings.
A worker executor falls back to the operator when no live worker exists; unbound external review
is handled by the dispatcher.
Column bindings `none` and `operator` keep their routing meaning even when a Spur project has the
same name.

Compact status rows include the unclosed `turn` (or null), `prSummary` and navigation `links`.
An untaken turn names its last assigned recipient session in `addressedTo`; a taken turn names
its holder and time in `taken`. `turn.stalledSince` is the executor stall start while its stall
block is open, else null. `blocks` lists open blocks as `{id, addressee, session}`; `session` is
the assigned session, null for the operator. A task returned to Dev has `returned`
`{from, at, by, block, findings}` until it leaves Dev or its next submit. A turn's feedback,
return context and thread details stay in task/inbox views. Top-level `daemon` gives `version`,
`startedAt` and `lastDispatchAt`, the last completed tick (null until the first).
`host` holds CPU, memory and data-volume disk usage from the daemon's last sample, taken every
30 s (null before the first; a read never samples, so an old `sampledAt` means sampling is
stuck). `services[]` gives one row per service (daemon, each chat gateway, then github, spur
and jira) with `state` (healthy, degraded or failing), `since`, `lastGoodAt` and `reason`. The
daemon row turns degraded after 120 s without a completed tick; a gateway fails while it is
down; github, spur and jira take their worst source among the `sources` you see, failing when
blind and degraded when never completed, stale, warming up or waiting for the rate budget.
`sources[].healthySince` is when a source became usable (not blind) in this daemon run, so it
and a healthy `since` reset on restart: read them beside `daemon.startedAt`.
`prSummary` is an array with one entry per observed effective PR, or null when none is observed.
It counts required checks when present, otherwise all reported checks: success and neutral pass,
expected and pending wait, and every other state, including skipped, fails. It preserves unknown
mergeability, counts review threads and lists only latest reviews on the current head.
These are facts, not gate verdicts. `factAt` is the observation time; `unconfirmed` marks stale
facts or a blind or missing source. Use `board task PROJ-123 --why` for gate explanations.

Status `links` is always `{ticket, prs, sessions}`: the observed ticket URL or null, effective PR
URLs (also before observation), and effective session IDs. Banned links are excluded. Clients own
session navigation. This replaces the former detail-only association array; use `board task PROJ-123`
for the detailed association list. `board status --detail` adds full ticket, PR and session facts.
The catalog version changes with these contracts; restart the daemon and live MCP sessions together.

## Browser access

With `web.port` and `web.publicOrigin` configured, a second loopback listener serves browser
assets, health and catalog operations whose `web` binding is enabled. It uses the same registry,
authorization, idempotency and operation hooks as the agent API, with the operator caller.
Effective project configuration is available through `config.get`.
Only `comment.add`, `block.answer` and `block.followup` are enabled writes. Token and skill routes stay on the
agent API. The web listener is off by default and a failed bind does not stop the agent API.

A private-network proxy must preserve Host. Exact Origin, Host, JSON and fetch-metadata checks
reject foreign browser pages; anyone with network or local access can still act as operator.
Logs include the web channel and untrusted forwarded client/user-agent metadata. Web writes
persist `via: web` in the journal; history returns `actor: operator` with `via: web`, allowing
clients to show `operator (web)`.
Missing UI assets return a 503 build hint while health and operations remain available.

## Web shell

The private web package builds the Board screen for one chosen project; the
[web UI](web-ui.md) guide describes what it shows and its states. It reads `config.get`,
`status.get` with detail for the chosen project, `inbox.operator`, `task.get` with `why` for
the open task and `task.history` while its History tab shows, and never writes: answers and comments stay in the CLI, MCP and Slack. A card
click or the address `?open=<task key>` opens the [task view](web-ui-task-view.md) with its
"Why it is here" section and its History tab.
The header holds the project switcher,
dispatcher mode, a key, session and block filter that dims and never hides cards, the live
indicator and the inbox count; columns follow configuration order, empty ones collapse and
`done` lists every done task. The status bar holds one health button per service (daemon,
slack, github, spur, and jira when configured), coloured from the `services` rows of
`status.get`, the persistent Light/Dark/Auto theme choice and the daemon version; its services
panel (`?open=services`) shows daemon, host, gateway and per-source rows from the same read. It uses local JetBrains Mono fonts and the
V1 prototype tokens. Failed reads keep the last good data on screen under an error banner with
its time; stream failures reconnect with capped backoff and show offline after five failed
attempts while continuing recovery. Reconnects retain valid SSE cursors, including ID-only
records, until the server clears them.

The configured daemon web listener serves the packaged SPA and its local assets, and streams
live updates from `GET /v1/events` as server-sent events. The stream opens with `hello` (journal
head and daemon instance), then sends one `invalidate` per committed batch of journal events,
naming the projects and task keys it touched; the screen rereads configuration and status when
the chosen project is named, and the inbox on every batch. A `reset` asks for a full reread:
after a client fell behind, or when its last event ID is ahead of the journal. A `status` frame
every 30 seconds carries source and transport health and also triggers a full reread; a comment
line every 15 seconds keeps proxies from closing the stream. The first `hello`, and a later one
with a changed head or a new instance after a daemon restart, make the screen reread everything.
The status bar version is `daemon.version` from `status.get`, so a stale bundle never claims
the daemon's version; it stays empty until the first status read.
