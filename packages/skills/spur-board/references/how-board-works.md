# How the Board works

Choose the topic for the decision or action in front of you:

- [Columns and gates](how-board-works-columns.md): find the executor, placement rules and gate requirements.
- [Turns and delivery](how-board-works-turns.md): acknowledge work, submit or return, handle doorbells and repeated returns.
- [Task history](how-board-works-history.md): read the journal events of a task.
- [Blocks and escalation](how-board-works-blocks.md): route a question or escalate a block, and read the operator inbox.
- [Operator inbox items](how-board-works-inbox.md): what to do about each item kind and when it clears.
- [Slack conversations](how-board-works-slack.md): choose a channel, address an agent and answer in a thread.
- [Done follows the ticket](how-board-works-done.md): check when a task is finished.
- [Browser access and web shell](how-board-works-web.md): the web listener and its checks, what the [web UI](web-ui.md) reads and how it stays live.

Read effective project configuration with `board config get`, then the current overview with
`board status`. Configuration lists enabled columns in order, their executors (with `quietTurnAfterMs` and
`noRecipientAfterMs` on columns with a named orchestrator), dispatcher mode,
effective Spur projects with display names, each project's `ticketBrowseBase`
(`<tracker baseUrl>/browse/` for Jira, else null) and each project's `checksGate`, plus `web.publicOrigin` (the listener's origin,
null when off or not bound yet) and `web.spurUiOrigin` (null when not configured). It excludes
credentials and adapter settings.
A worker executor falls back to the operator when no live worker exists; unbound external review
is handled by the dispatcher.
Column bindings `none` and `operator` keep their routing meaning even when a Spur project has the
same name.

Compact status rows include the unclosed `turn` (or null), `prSummary` and navigation `links`.
Compact and detailed rows have `columnEnteredAt`: latest real entry into the current column
in UTC, falling back to original add time; null if neither is known.
Rows also have `position`: the 1-based place in the column's one board-wide order; new arrivals
go last.
An untaken turn names its last assigned recipient session in `addressedTo`; a taken turn names
its holder and time in `taken`. `turn.stalledSince` is the executor stall start while its stall
block is open, else null. `blocks` lists open blocks as `{id, addressee, session}`; `session` is
the assigned session, null for the operator. A task returned to Dev has `returned`
`{from, at, by, block, findings}` until it leaves Dev or its next submit. A turn's feedback,
return context and thread details stay in task/inbox views. Top-level `daemon` gives `version`,
`startedAt` and `lastDispatchAt`, the last completed tick (null until the first).
`host` holds CPU, memory and disk usage from the daemon's last sample, taken every 30 s (null
before the first; a read never samples, so an old `sampledAt` means sampling is stuck).
`host.volumes` lists each distinct volume among `/`, the data directory and the temp directory,
with its `mount`, least free space first; a volume that cannot be read is left out. `host.disk`
is the first of them, the volume closest to running out. `services[]` gives one row per service (daemon, each chat gateway, then github, github-project
when a column mirrors a GitHub Project, spur and jira) with `state` (healthy, degraded or failing), `since`, `lastGoodAt` and `reason`. The
daemon row turns degraded after 120 s without a completed tick; a gateway fails while it is
down; github, github-project, spur and jira take their worst source among the `sources` you see,
failing when blind or a mirror read failed and degraded when never completed, stale, warming up or waiting for the rate budget.
`sources[].waitsForBudget` marks each source whose next regular poll the daemon put off for a
rate limit: its last poll in this daemon run, complete or not, left a GitHub budget under
`github.reserveRemaining`, failed as throttled, or failed in any other way while the last budget
seen in this run, an on-demand refresh's included, is under the reserve before its reset. A stored
budget or an on-demand refresh alone never marks one, and the service row names the wait before
warm-up or staleness.
`sources[].healthySince` is when a source became usable (not blind) in this daemon run, so it
and a healthy `since` reset on restart: read them beside `daemon.startedAt`.
`prSummary` is an array with one entry per observed effective PR, or null when none is observed.
It counts required checks when present, otherwise all reported checks: success and neutral pass,
expected and pending wait, and every other state, including skipped, fails. It preserves unknown
mergeability, counts review threads and lists only latest reviews on the current head.
These are facts, not gate verdicts. `factAt` is the observation time; `unconfirmed` marks stale
facts or a blind or missing source. Use `board task PROJ-123 --why` for gate explanations.
An open PR with an approval also has `approvals[]`, one per latest approval in review order:
`author`, `sha` and `onHead`. An approval on the head has `commitsAfter: 0`. For an older one,
`commitsAfter` counts the single-parent commits after it (merges left out), `changedAfter`
lists the top-level entries they changed (`name/` for a directory, a bare name for a root
file), and `watchedAfter` the ones matching the project's `approvalWatch`, or all of them
without the key. `notCounted` replaces them with `history_rewritten`, `rate_limit` or
`pr_too_large`; none of them means not read yet. A hint, never a gate. `board task` shows the
same `approvals` on its PR links.

Status `links` is always `{ticket, prs, sessions}`: the observed ticket URL or null, effective PR
URLs (also before observation), and effective session IDs. Banned links are excluded. Clients own
session navigation. This replaces the former detail-only association array; use `board task PROJ-123`
for the detailed association list. `board status --detail` adds full ticket, PR and session facts.
The catalog version changes with these contracts; restart the daemon and live MCP sessions together.
