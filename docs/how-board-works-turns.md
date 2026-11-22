# Turns and delivery

## Turns and delivery

A turn `T<number>`: keyed `board inbox ack <entries>`.
Only the acknowledging session may submit or return: keyed
`board submit <turn> <sha>` accepts the head; keyed
`board return <turn> <reason>` sends findings to Dev; a review orchestrator adds
`--findings <n>` and `board status` shows the count in the row's `returned`. In
shadow mode, use keyed `board submit <task> <sha>`.
Unseen heads answer `pending`: that submit is final; do not resubmit or raise a
block. Confirm timeout: `projects[].dispatcher.submitConfirmMs`.

QA on the same head holds a taken turn through upstream failures until submit or
return. Leaving QA closes its turn; a late submit with a new key gets `turn_closed`.
An unseen-head QA submit closes the turn while pending and gives no gate credit
until confirmed. Confirmation survives upstream revalidation: completing Dev and
reviews on that head needs no second QA submit. Confirmed QA survives same-head
returns and corrections to Dev. Correction into QA clears even pending QA evidence:
with upstream gates passing, a QA orchestrator or operator gets a fresh turn.
Retained QA cannot satisfy Dev: a return to Dev needs the current Dev visit's submit.

Submissions declare provenance with `--basis tested|carried|skipped`; omitted means
`tested`. This records the submitter's declaration, not a claim that checks passed.
`carried` requires `--from <full lowercase SHA>` and `--reason <text>`: the source
must be a tested submission on this task or a carried submission with a tested
origin. Carry chains retain the supplied source and pin the original tested row;
no git ancestry is checked. `skipped` requires a reason. `tested` permits a reason;
only `carried` permits `from`. Supplied reasons are nonblank literal text of
at most 2,000 UTF-16 units. Workers and column orchestrators keep their existing
submit permissions for every basis. All bases close turns and follow the same
head confirmation and gates; only returns increment course and cycle counts.

`board task`, `board status` and task history show provenance. The latest
submission includes its pending and voided state: historical tested submissions
remain carryable even when pending or voided, independently of gate validity.
Legacy rows with nullable provenance read as tested; stored command results and
omitted-input fingerprints remain compatible. Migration rollback is the normal
pre-update backup restore; the migrated database has no downgrade guarantee.
After a catalog upgrade, restart the daemon and MCP clients together.

A new head closes taken turns outside Dev and Done; taken Dev turns and Done
wrap-up turns survive pushes, and a wrap-up turn closes when its holder ends or,
untaken, no recipient is left.
Right of Dev, red CI, a draft, a conflict, an external comment or an unresolved
thread where required returns the task to Dev at once, unless a turn is taken; then after its submit or return.
The Dev turn hands the comments, beside a return's `code` block.
Each handed entry has its `url`, `editedAt` once edited, and a review's inline
`comments` with `url` and `threadId`. Turns of a Dev visit opened by a return
show `returned`: who, from, the turn, the `code` block and the verbatim reason.
A worker taking that turn reads its block; the block closes `done` with the SHA once
the Board confirms the turn's submit, an operator's included.

Closed turns receive no further Board sends; Obsolete queued rings are dropped;
a message already accepted by Spur cannot be retracted. Check `board inbox` and
act only on a current turn; reread after `turn_closed`.
[Task history](how-board-works-history.md#task-history) lists journal events `turn_opened`,
`turn_taken` and `turn_closed`: executor, taker, outcome.

An operator finds turns addressed to it in `board inbox operator`, not `board inbox`.
An operator takes a turn addressed to it, or takes over an open orchestrator
turn, taken or not, with keyed
`board inbox ack <entries>`, then submits or returns it, or does both from the web
[Turn](web-ui-task-turn.md) section. The earlier holder gets
`not_turn_taker`, then `turn_closed`. The takeover is not sticky: the addressed
orchestrator can ack the turn back.

Open-turn executors in `needs_input`, `error`, `rate_limited` or `stopped` raise
one question after `health.turnStallAfterMs` (default 600000): curator unless self, else
operator. Time starts at the later turn/state start; taking never resets it.
One frozen explanation/dismissal per turn/session/state episode. Recovery,
replacement, removal, archive or turn closure withdraws it. Blind Spur opens none,
holds existing; gaps restart timing for new questions.

An accepted ended session holding the current non-Done turn raises one
`worker_ended` attention item immediately, with no stall block. Every end reason
counts, including unknown; an open PR or another linked live session does not
resolve the held turn. Start a replacement worker, retake an operator turn
(`board inbox ack`), or archive the task. The item clears on turn closure,
actual holder replacement, archive or departure from the column visit. Existing
ended-holder stall blocks withdraw with a recorded reason,
even while Spur is blind. Removing a link alone leaves a taken turn unresolved.
Stopped sessions with no end time keep stall timing;
untaken Done wrap-ups close.

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

A taken turn is reminded, then flagged stuck, after `health.idleInDevAfterMs` of quiet;
a named column orchestrator's turn uses the column's
`quietTurnAfterMs` instead. When the column's untaken turns have no live session to ring for
its `noRecipientAfterMs` (default 10 minutes, counted from the later of the ring and the
moment the last session that could take them stopped being a recipient: its first end, absence
or finished state), the operator gets one `no-session:` inbox item per column.

A holder can [wait on its turn](how-board-works-waits.md).

## Course checks and cycle limits

`projects[].columns[].courseCheck` defaults to 3 returns to Dev;
`courseCheck: 0` disables it. `projects[].columns[].cycleLimit` defaults to 10 and
takes priority. Executor returns and external comments (a changes-requested
review is one) count, as do thread returns; CI failures, conflicts and drafts alone do not count, nor
reopened tickets or mode switches. With External Review enabled, returns for external comments
count toward its `courseCheck` instead, as does each external change request on a new PR head
while the task is in Dev, once per head; `cycleLimit` stays per column.

Repeated mechanism: fix its class once, one table test. Code a finding only if it breaks the task's goal in its target setup or regresses the release, whatever its severity; else PR Risk with a thread reply, no code. Unclear scope: `board ask` first.
`projects[].columns[].courseCheckTo`: `operator`, curator or column orchestrator.
Default: curator (`projects[].spurProjects[].role`), else operator. An answer
resets the course count and reaches the worker as a task comment. Only the
operator can resolve the separate cycle limit and reset its count. With no live
session it falls back to the operator; a live conductor that does not
answer keeps the question.
