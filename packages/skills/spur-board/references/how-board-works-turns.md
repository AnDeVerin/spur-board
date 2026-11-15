# Turns and delivery

## Turns and delivery

A turn `T<number>`: keyed `board inbox ack <entries>`.
Only the acknowledging session may submit or return: keyed
`board submit <turn> <sha>` accepts the head; keyed
`board return <turn> <reason>` sends findings to Dev. In
shadow mode, use keyed `board submit <task> <sha>`.
Unseen heads answer `pending`: that submit is final; do not resubmit or raise a
block. Confirm timeout: `projects[].dispatcher.submitConfirmMs`.

A new head closes taken turns outside Dev; taken Dev turns survive pushes.
Right of Dev, red CI, a draft, a conflict, an external comment or an unresolved
thread where required returns the task to Dev at once, unless a turn is taken; then after its submit or return.
The Dev turn hands the comments, beside a return's `code` block.
Each handed entry has its `url`, `editedAt` once edited, and a review's inline
`comments` with `url` and `threadId`. Turns of a Dev visit opened by a return
show `returned`: who, from, the turn, the `code` block and the verbatim reason.

Closed turns receive no further Board sends; Obsolete queued rings are dropped;
a message already accepted by Spur cannot be retracted. Check `board inbox` and
act only on a current turn; reread after `turn_closed`.
Task history (`board task history <task>`) shows journal events `turn_opened`,
`turn_taken` and `turn_closed`: executor, taker, outcome.
Each event names who acted and, for a write from Slack or the web UI, its
channel (`via`); CLI, MCP and agent writes have none.

Open-turn executors in `needs_input`, `error`, `rate_limited` or `stopped` raise
one question after `health.turnStallAfterMs` (default 600000): curator unless self, else
operator. Time starts at the later turn/state start; taking never resets it.
One frozen explanation/dismissal per turn/session/state episode. Recovery,
replacement, removal, archive or turn closure withdraws it. Blind Spur opens none,
holds existing; gaps restart timing for new questions.

## Doorbells

A turn opened for you by your own confirmed submit or return is first rung only after `doorbells.firstRetryMs`; a turn opened for you any other way rings at once.

A doorbell expects action: read `board inbox` for the turn, addressed
block, answer or follow-up. Ordinary task comments do not ring; nor does a block
tracked by its author role ring itself.

Repeat up to three delivered rings;
acknowledgement stops them. Removal notices and quiet-turn reminders ring once.
Busy recipients defer delivery; pending delivery or earlier rings in the Spur
queue defer repeats. Queues can exhaust their waiting window.

Most notices await recipients; taskless worker, orchestrator and operator-agent
answers end without a live asking session. Curator and course-check orchestrator
questions fall back to operator. Operator conversations await their project.
Exhaustion alerts the operator, except removals and quiet-turn reminders;
curator questions move to operator.

## Course checks and cycle limits

`projects[].columns[].courseCheck` defaults to 3 returns to Dev;
`courseCheck: 0` disables it. `projects[].columns[].cycleLimit` defaults to 10 and
takes priority. Executor returns and external comments (a changes-requested
review is one) count, as do thread returns; CI failures, conflicts and drafts alone do not count, nor
reopened tickets or mode switches.

If returns keep hitting the same mechanism, fix the bug class once; cover its variants with one table test. Put remaining edges with no user-visible effect under Risk in the PR description. Still fix P0/P1 and user-visible findings in this PR.
`projects[].columns[].courseCheckTo`: `operator`, curator or column orchestrator.
Default: curator (`projects[].spurProjects[].role`), else operator. An answer
resets the course count and reaches the worker as a task comment. Only the
operator can resolve the separate cycle limit and reset its count. With no live
session it falls back to the operator; a live conductor that does not
answer keeps the question.
