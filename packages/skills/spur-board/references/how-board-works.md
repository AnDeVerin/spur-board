# How the Board works

Choose the topic for the decision or action in front of you:

- [Columns and gates](how-board-works-columns.md): find the executor, placement rules and gate requirements.
- [Turns and delivery](how-board-works-turns.md): acknowledge work, submit or return, handle doorbells and repeated returns.
- [Blocks and escalation](how-board-works-blocks.md): route a question or escalate a block.
- [Slack conversations](how-board-works-slack.md): choose a channel, address an agent and answer in a thread.
- [Done follows the ticket](how-board-works-done.md): check when a task is finished.

Read effective project configuration with `board config get`, then the current overview with
`board status`. Configuration lists enabled columns in order, their executors, dispatcher mode
and effective Spur projects with display names. It excludes credentials and adapter settings.
A worker executor falls back to the operator when no live worker exists; unbound external review
is handled by the dispatcher.
Column bindings `none` and `operator` keep their routing meaning even when a Spur project has the
same name.

Compact status rows include the unclosed `turn` (or null), `prSummary` and navigation `links`.
An untaken turn names its last assigned recipient session in `addressedTo`; a taken turn names
its holder and time in `taken`. Feedback, return context and thread details stay in task/inbox views.
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
Only `comment.add` and `block.answer` are enabled writes. Token and skill routes stay on the
agent API. The web listener is off by default and a failed bind does not stop the agent API.

A private-network proxy must preserve Host. Exact Origin, Host, JSON and fetch-metadata checks
reject foreign browser pages; anyone with network or local access can still act as operator.
Logs include the web channel and untrusted forwarded client/user-agent metadata. Web writes
persist `via: web` in the journal; history returns `actor: operator` with `via: web`, allowing
clients to show `operator (web)`.
Missing UI assets return a 503 build hint while health and operations remain available.

## Web shell

The private web package builds an empty desktop shell with task count, named source health,
stream state, a persistent Light/Dark/Auto theme choice and the packaged version in its footer.
It uses local JetBrains Mono fonts and the V1 prototype tokens. Read failures retain previous
status as stale; stream failures reconnect with capped backoff and show offline after five
failed attempts while continuing recovery. The first valid stream handshake refreshes status
to close the startup read race; later changes to the stream head or instance also refresh it.
Reconnects retain valid SSE cursors, including ID-only records, until the server clears them.

The configured daemon web listener serves the packaged SPA and its local assets. The stream
server remains pending in #533, so the shell currently reports reconnecting then offline/stale
while status reads and theme controls remain available. Until #547 adds daemon version fields,
the footer version comes from the CLI manifest at build time.
