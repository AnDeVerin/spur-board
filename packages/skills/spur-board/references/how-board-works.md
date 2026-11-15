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
