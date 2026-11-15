# How the Board works

`board task <task> --why`: gates, holds, waits, turn and moves.

## Columns and executors

`todo`, `ready-for-dev`, `dev`, `review`, `product-review`,
`external-review`, `qa`, `ready-to-merge`, `done`.
`projects[].columns[].enabled` false or omitted optional columns skip gates;
To Do, Dev, Done stay enabled.

Each column has one executor: `projects[].columns[].orchestrator`:
`none` (live worker, else operator), `operator`, or project with role
`orchestrator` or `curator`. The worker owns the code and branch; others submit or return, never push.

`projects[].spurProjects[].role` accepts `worker`, `operator`, `curator` and
`orchestrator`. Orchestrators run columns, never as workers.

Top-level `spurProjects[].columns` fills `none` columns board-wide;
`role: operator` there serves operatorless projects, one session acting in
each. A project-level binding wins.

## Gates and placement

Facts (head, checks, reviews, comments, ticket, sessions) feed gates; two actions: move the task and open an executor turn (at most one
per evaluation). Turns follow unmet entry gates, actionable post-submit failures,
rerouting or Done wrap-up. Holds and existing turns can yield neither action.

Moves, turns and course checks need `projects[].dispatcher.mode: on`;
default is `shadow`: proposed placement, no turns, doorbells or blocks.

Gates are cumulative: each column checks its enabled gate and those to its left. At a turn boundary, failed gates return to the leftmost failing
column. Taken turns hold until submit, return or a new head. Pending CI, unknown
mergeability and incomplete comment history are waits. Downstream handoff waits
for settled prerequisites; Dev can receive a repair turn.

Dev: open non-draft PR, passing checks, no conflict, handled external
feedback, comment history, current-head submit. Feedback excludes
bots, approvals and `projects[].operatorGithubLogin` (agents' account), so worker
thread replies never count; others' posts do.
A status comment whose last line is a hidden `board-reviewer-progress` or
`board-reviewer-unavailable` marker is not external feedback. No required checks: non-skipped ones count. `projects[].reposWithoutCi` waives absent (never failed/skipped
required) checks for listed repos.

Review and Product Review need current-head internal review marks, separate from
External Review's external approval. QA: current-head submit; Ready to Merge awaits merge. Executor `none` may reuse same-head submits from other worker columns.

Review/Product Review mark lasts across visits on the current head. A visit
submission belongs to one column visit; moving left clears it and rightward ones. New heads invalidate internal Review and Product Review marks,
even old heads.

Anomalies: PR closed without merge with no open PR, or closed
ticket with live work and no merged PR. `board status` lists them; they may surface
as operator block threads.

## Turns and delivery

A turn `T<number>`: a visit. Keyed `board inbox ack <entries>`.
Only the acknowledging session may submit or return, keyed:
`board submit <turn> <sha>` accepts the head;
`board return <turn> <reason>` sends findings to Dev. In
shadow mode, use keyed `board submit <task> <sha>`.
Unseen heads answer `pending`: that submit is final; do not resubmit or raise a
block. Confirms or returns the turn
(`projects[].dispatcher.submitConfirmMs`).

A new head closes taken turns outside Dev; taken Dev turns survive pushes.
Untaken turns: CI, draft, conflict or external-comment returns.
Operator turns: 1 inbox item + Slack thread until exit.

Closed turns receive no further Board sends; Obsolete queued rings are dropped;
a message already accepted by Spur cannot be retracted. Check `board inbox` and
act only on a current turn; reread after `turn_closed`.

## Doorbells

A turn opened for you by your own confirmed submit or return is first rung only after `doorbells.firstRetryMs`; a turn opened for you any other way rings at once.

A doorbell expects action: read `board inbox` for the turn, addressed
block, answer or follow-up. Ordinary task comments do not ring; nor does a block
tracked by its author role ring itself. Rings differ from moves.

Unacked series repeat, up to three delivered rings;
acknowledgement stops them. Removal notices and quiet-turn reminders ring once.
Busy recipients defer delivery; pending delivery or earlier rings in the Spur
queue defer repeats. Queued rings can exhaust their waiting window.

Most notices await recipients; taskless worker, orchestrator and operator-agent
answers end without a live asking session. Curator and course-check orchestrator
questions fall back to operator. Operator conversations await their project.
Exhaustion alerts the operator, except removals and quiet-turn reminders;
curator questions move to operator.

## Course checks and cycle limits

`projects[].columns[].courseCheck` defaults to 3 counted returns to Dev;
`courseCheck: 0` disables it. `projects[].columns[].cycleLimit` defaults to 10 and
takes priority. Executor returns, changes requested and external comments count;
CI failures, conflicts and drafts alone do not count.

If returns keep hitting the same mechanism, fix the bug class once; cover its variants with one table test. Put remaining edges with no user-visible effect under Risk in the PR description. Still fix P0/P1 and user-visible findings in this PR.
`projects[].columns[].courseCheckTo`: `operator`, curator or column orchestrator
(`projects[].spurProjects[].role`); default curator, else operator. An answer
resets the course count and reaches the worker as a task comment. Only the
operator can resolve the separate cycle limit and reset its count. With no live
session it falls back to the operator; a live conductor that does not
answer keeps the question, with intervention item.

## Blocks and escalation

A question (`needs_input`): column orchestrator, else curator, else
operator. Routing avoids asking yourself: orchestrators ask curator; curators
ask operator.

A `code` block goes to the worker; `dependency` or `external` block stays with
its author's role. Escalation: column orchestrator to curator to
operator; other blocks escalate straight to the operator. Keyed
`board escalate <block>` if its addressee can't resolve it.

Taskless: all roles, operator only:
`board project ask <project> <text> --to operator --key <key>`.
Project `needs_input` blocks get Slack threads except operator-agent asks;
operator: `board inbox`, keyed `board answer`. Answers reach a current curator session; other roles use the asking session.

Routing: `projects[].columns[].orchestrator`, `projects[].spurProjects[].role`,
`operator.slack`. Roles follow session.

## Slack now

`slack.channels.feed`: curator answers and operator items,
except items elsewhere/delivery problems.
`slack.channels.orchestrators`: block threads addressed to the operator by
others. Answer in the existing block thread.

## Slack addressing

With any `projects[].spurProjects[].shortName`, `spurProjects[].shortName` or
board-wide operator, a new operator message in
`slack.channels.orchestrators` starts a conversation. A leading registered
`@shortName` selects that Spur project and is stripped. With absent or unknown
leading name, complete text, retaining any
unknown prefix, goes to `slack.defaultAddressee`, else board-wide operator, else
first project with an operator; with none, Board replies once with the valid prefixes.
Middle mentions or Slack `<@U…>` address nobody; unknown names cause no lookup
error. The operator checks short-name collisions with workspace names.
A task key after the prefix attaches it.

Given block ID: `board inbox`, then
`board answer`. Each operator thread message rings again; `close` or ✅ in the
thread closes it. Replies use `projects[].spurProjects[].displayName` and `icon`, top-level ones too,
else project name and role icon (`board` for operator). No session:
`board status` lists it as waiting.

## Done follows the ticket

One linked PR merging does not by itself finish the task. Done per ticket: `projects[].tracker.doneStatuses` for Jira; for GitHub, the Issue must be
closed. If open after merge, link another PR.
