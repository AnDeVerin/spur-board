# Browser access and the web shell

## Browser access

With `web.port` and `web.publicOrigin` configured, a second loopback listener serves browser
assets, health and catalog operations whose `web` binding is enabled. It uses the same registry,
authorization, idempotency and operation hooks as the agent API, with the operator caller.
Effective project configuration is available through `config.get`.
Enabled writes are `comment.add`, `block.answer`, `block.followup`, `item.close` and
`task.move`. The shell moves a task between Backlog parts through `task.move` from the card
menu, a drop on another part or the task view.
Token and skill routes stay on the agent API. The web listener is off by default
and a failed bind does not stop the agent API.

A private-network proxy must preserve Host. Exact Origin, Host, JSON and fetch-metadata checks
reject foreign browser pages; anyone with network or local access can still act as operator.
Logs include the web channel and untrusted forwarded client/user-agent metadata. Web writes
persist `via: web` in the journal; history returns `actor: operator` with `via: web`, allowing
clients to show `operator (web)`.
Missing UI assets return a 503 build hint while health and operations remain available.
Every web answer carries `x-board-version` with the daemon's version, and the served page names
the same version in a `board-version` meta tag; the web shell compares the two to notice an
update.

## Web shell

The private web package builds the Board screen for one chosen project; the
[web UI](web-ui.md) guide describes what it shows and its states. It reads `config.get`,
`status.get` with detail for the chosen project, whose sources and services cover every project, whatever project is chosen, `inbox.operator` and `task.get` with `why` for
the open task, and `task.history` while History shows. A card click or the address `?open=<task key>` opens the
[task view](web-ui-task-view.md) with its "Why it is here", Blocks and Comments sections and History tab.
The task view can answer open operator questions through `block.answer`, follow up on answered
ones through `block.followup` and add task comments
through `comment.add`. The operator inbox can close an active item through `item.close`, and the Board and task view
move a task between Backlog parts with a reason through `task.move`; other actions stay in the CLI, MCP and Slack. Failed sends preserve
drafts, and confirmed writes refresh authoritative task data. While the daemon or live updates
are unavailable, the forms are disabled with a reason and retain their drafts.
Archived tasks also disable the writes while keeping drafts. If a question closes or is
reassigned, newer unsent answer text stays selectable, read-only.
The header holds the project switcher,
dispatcher mode, a key, session and block filter that dims and never hides cards, the live
indicator and the inbox count; columns follow configuration order, empty ones collapse,
adjacent Todo-group columns show under one Backlog band that folds into one column, and
`done` lists every done task. The status bar holds one health button per service (daemon,
slack, github, spur, and jira when configured), coloured from the `services` rows of
`status.get`, the persistent Light/Dark/Auto theme choice and the daemon version; its services
panel (`?open=services`) shows daemon, host, gateway and spur rows, then per-source rows grouped by project, from the same read. It uses local JetBrains Mono fonts and the
V1 prototype tokens. Failed reads keep the last good data on screen under an error banner with
its time; stream failures reconnect with capped backoff and show offline after five failed
attempts while continuing recovery. Reconnects retain valid SSE cursors, including ID-only
records, until the server clears them.

The daemon serves the packaged SPA and streams `GET /v1/events` as server-sent events. `hello`
names the journal head and daemon instance. Each committed journal batch sends an `invalidate`
with affected projects and tasks; the screen rereads configuration and status for its chosen
project, and the inbox on every batch. `reset` requests a full reread after a cursor falls behind
or ahead of the journal. The first `hello`, or a changed head or instance, also rereads everything.
Timestamp-only changes to session `lastActivityAt`, PR `updatedAt` or ticket `updatedAt` refresh
the full snapshot without a facts event or task change time. A `status` frame every 30 seconds
carries source and transport health and triggers a full reread, including these quiet refreshes.
A comment every 15 seconds keeps proxies open. The status bar reads `daemon.version` from
`status.get` and stays empty until that first read.
