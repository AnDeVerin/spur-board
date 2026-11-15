# How the Board works

Start with `board task <task> --why`: it explains the gates, holds, open turn and
last moves behind the task's position.

## Columns and executors

The fixed order is `todo`, `ready-for-dev`, `dev`, `review`, `product-review`,
`external-review`, `qa`, `ready-to-merge`, `done`.
`projects[].columns[].enabled` false, or omitting an optional column, skips it and
its gate; To Do, Dev and Done must stay enabled.

Each column has one executor, selected by `projects[].columns[].orchestrator`:
`none` uses the task's live worker, falling back to the operator; `operator` uses
the operator; another value names a configured Spur project whose session takes
the turn. The worker owns the code and branch. Other column executors inspect the
head and submit it or return it with findings; they do not push to that branch.

`projects[].spurProjects[].role` currently accepts `worker`, `operator` and
`curator`. The curator answers questions and checks direction. A separate
`orchestrator` project role is planned, not available; today column assignment
uses the configured Spur project name rather than that role value.

## Gates and placement

The operational moves, turns and course checks below apply with
`projects[].dispatcher.mode: on`. The default is `shadow`: gates record a proposed
position, but open no turns, doorbells or blocks; submit using the task key.

Gates are cumulative: a column checks its own enabled exit gate and every enabled
gate to its left. At a turn boundary, a broken earlier gate returns the task to
the leftmost failing column. A taken turn normally holds its column until it is
submitted, returned or closed by a new head. Pending CI, unknown mergeability and
incomplete comment history are waits, not reasons by themselves to send work back.
Downstream handoff waits for settled prerequisites; Dev can still receive a
repair turn to fix red CI, a draft, conflicts or unhandled external comments.

Dev needs an open, non-draft PR, passing checks, no conflict, handled external
feedback, complete comment history and a submit on the current head. With no
required checks, non-skipped checks are evaluated. `projects[].reposWithoutCi`
waives the check requirement only for a listed repository with no checks at all;
it does not waive a failing or skipped required check.

Review and Product Review need current-head review marks. External Review waits
for external approval. QA needs a current-head submission; Ready to Merge waits
for the PR to merge. A column with executor `none` can use a worker submission on
that head from another worker-executed column. These fixed gate rules have no
configuration switch beyond enabling columns and the no-CI exception above.

A Review or Product Review mark lasts across visits while its head remains
current. A visit submission belongs to one column visit; a move left clears
submissions at that column and to its right. A new head invalidates internal
Review and Product Review marks, even if an older head later comes back.

## Turns and delivery

A turn `T<number>` hands one column visit to its executor. First acknowledge it
with keyed `board inbox ack <entries>`. Only the acknowledging session may submit
or return it: keyed `board submit <turn> <sha>` accepts the head, and keyed
`board return <turn> <reason>` sends findings back to Dev. A worker submits a fresh
PR head after pushing. In shadow mode, use keyed `board submit <task> <sha>`.
An unseen head answers `pending`: that submit is final,
so do not resubmit or raise a block; the Board confirms it or hands the turn back
(`projects[].dispatcher.submitConfirmMs`).

A new head closes taken turns outside Dev; a taken Dev turn survives the worker's
push so that worker can submit it. An unacknowledged turn does not hold back a
return for CI, draft, conflict or external comments. The operator gets one inbox
item and Slack thread for a turn, which closes when the task leaves the column.

Closed turns receive no further Board sends. Obsolete queued rings are dropped,
but a message already accepted by Spur cannot be retracted. On receipt, check
`board inbox` and act only on a current turn; after `turn_closed`, read it again.

## Course checks and cycle limits

`projects[].columns[].courseCheck` defaults to 3 counted returns to Dev from that
column; `courseCheck: 0` disables the course check.
`projects[].columns[].cycleLimit` defaults to 10 and takes priority if both limits
are reached. Executor returns, changes requested and external comments count;
CI failures, conflicts and drafts alone do not count. Reopening a ticket or
switching dispatcher mode does not count as a return.

A course check holds the task and asks for direction, with open findings.
`projects[].columns[].courseCheckTo` may name `operator`, the curator, or a
configured column orchestrator. Without it, the target is the curator selected by
`projects[].spurProjects[].role`, or the operator if no curator is configured.
An answer resets the course count and reaches the worker as a task comment.
The cycle limit is separate: only the operator can resolve it and reset its count.

If the course-check addressee has no live session, the question falls back to the
operator. A live conductor that was rung but does not answer keeps the question;
the operator gets an item to intervene.

## Blocks and escalation

A question (`needs_input`) goes to the column's configured orchestrator, then the
curator when no other orchestrator takes it, otherwise the operator. Routing
avoids asking yourself: an orchestrator's own question goes to the curator, and
the curator's own question goes to the operator. A column explicitly assigned to
`operator` also sends questions to the operator.

A `code` block goes to the worker to repair. A `dependency` or `external` block
stays with its author's role to track the dependency or outside event. Questions
can escalate from column orchestrator to curator to operator; other blocks
escalate straight to the operator. Escalation skips a step your own project also
holds: a curator that also orchestrates the column escalates its column's
question straight to the operator. Use keyed `board escalate <block>`
when the current addressee cannot resolve it.

The routing configuration is `projects[].columns[].orchestrator`,
`projects[].spurProjects[].role` and `operator.slack` (the operator's Slack user
ID). Role addresses follow the current session filling the role.

## Slack now

`slack.channels.feed` carries summaries like curator answers and operator
items, except items shown elsewhere and delivery problems.
`slack.channels.orchestrators` carries block threads addressed to the operator by
someone else. Answer in the existing block thread to preserve its task context.

## Slack addressing

Once a `projects[].spurProjects[].shortName` is set, a new operator message in
`slack.channels.orchestrators` starts a conversation. A leading registered
`@shortName` selects that Spur project and is stripped from the text. With an
absent or unknown leading name, `slack.defaultAddressee` receives the complete
text, retaining any unknown prefix; without it the Board replies once with the
valid prefixes. A mention in the middle, or a Slack `<@U…>` mention, addresses
nobody; an unknown name causes no lookup error. The operator checks short-name
collisions with workspace names. A task key right after the prefix attaches the
conversation to that task.

The addressee is rung with the block ID, reads the text in `board inbox` and
replies in the thread with `board answer`. Each operator thread message rings it
again; `close` or ✅ in the thread closes it. Replies post under
`projects[].spurProjects[].displayName` and `icon`, else the Spur project's
name and role icon (`board` for an operator role). While no live session can
take it, `board status` lists it as waiting.

## Done follows the ticket

One linked PR merging does not by itself finish the task. Done follows ticket
completion: `projects[].tracker.doneStatuses` defines Jira's done statuses;
for GitHub, the Issue must be closed. After a merge the Board waits for tracker
confirmation; if the ticket remains open once that confirmation settles, work
continues and another PR can be linked.
