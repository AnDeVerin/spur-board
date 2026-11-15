# How the Board works

`board task <task> --why`: gates, holds, waits, turn and moves.

## Columns and executors

Order: `todo`, `ready-for-dev`, `dev`, `review`, `product-review`,
`external-review`, `qa`, `ready-to-merge`, `done`.
`projects[].columns[].enabled` false or an omitted optional column skips its gate;
To Do, Dev and Done stay enabled.

Each column has one executor: `projects[].columns[].orchestrator` selects
`none` (live worker, else operator), `operator`, or a project with role
`orchestrator` or `curator`. The worker owns the code and branch; other executors
inspect and submit the head or return findings without pushing.

`projects[].spurProjects[].role` accepts `worker`, `operator`, `curator` and
`orchestrator`. Curators check direction; orchestrators execute columns, never as workers.

## Gates and placement

Facts (head, checks, reviews, comments, ticket, sessions) feed gates. The
dispatcher has two actions: move the task and open an executor turn (at most one
per evaluation). Turns follow unmet entry gates, actionable post-submit failures,
rerouting or Done wrap-up. Holds and existing turns can yield neither action;
facts need not cause handoffs.

Moves, turns and course checks require `projects[].dispatcher.mode: on`. The
default is `shadow`: proposed placement only, no turns, doorbells or blocks;
submit by task key.

Gates are cumulative: each column checks its enabled gate and those to its left. At a turn boundary, broken gates return work to the leftmost failing
column. Taken turns hold until submit, return or a new head. Pending CI, unknown
mergeability and incomplete comment history are waits. Downstream handoff waits
for settled prerequisites; Dev can receive a repair turn for red CI, drafts,
conflicts or unhandled external comments.

Dev needs an open non-draft PR, passing checks, no conflict, handled external
feedback, complete comment history and current-head submit. Non-skipped checks
count when none are required. `projects[].reposWithoutCi` waives absent checks
for listed repos, never failing or skipped required checks.

Review and Product Review need current-head internal review marks, separate from
External Review's external approval. QA needs a current-head submission; Ready to Merge waits for merge. Executor `none` may reuse same-head worker submissions
from another worker column. Fixed gate rules have no configuration switch
beyond enabled columns and the no-CI exception.

A Review or Product Review mark lasts across visits on the current head. A visit
submission belongs to one column visit; moving left clears submissions there and
to its right. New heads invalidate internal Review and Product Review marks,
even if an old head returns.

Derived anomalies include a PR closed without merge with no open PR, or a closed
ticket with live work and no merged PR. `board status` lists them; they can also
surface as operator block threads.

## Turns and delivery

A turn `T<number>` assigns a visit. Use keyed `board inbox ack <entries>`.
Only the acknowledging session may submit or return: keyed
`board submit <turn> <sha>` accepts the head; keyed
`board return <turn> <reason>` sends findings to Dev. Submit after pushing. In
shadow mode, use keyed `board submit <task> <sha>`.
Unseen heads answer `pending`: that submit is final; do not resubmit or raise a
block. It confirms or returns the turn
(`projects[].dispatcher.submitConfirmMs`).

A new head closes taken turns outside Dev; taken Dev turns survive pushes.
Untaken turns allow returns for CI, drafts, conflicts or external comments.
Operator turns get one inbox item and Slack thread until the task leaves.

Closed turns receive no further Board sends. Obsolete queued rings are dropped;
a message already accepted by Spur cannot be retracted. Check `board inbox` and
act only on a current turn; reread after `turn_closed`.

## Doorbells

A doorbell expects action: read `board inbox` for the turn, addressed
block, answer or follow-up. Ordinary task comments do not ring; nor does a block
tracked by its author role ring itself. Notifications are separate from moves.

Unacknowledged series normally repeat, up to three delivered rings;
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
CI failures, conflicts and drafts alone do not count, nor ticket reopening or
dispatcher mode changes.

Course checks hold work for direction.
`projects[].columns[].courseCheckTo`: `operator`, curator or column orchestrator.
Default: curator (`projects[].spurProjects[].role`), else operator. An answer
resets the course count and reaches the worker as a task comment. Only the
operator can resolve the separate cycle limit and reset its count. With no live
session the question falls back to the operator; a live conductor that does not
answer keeps the question, with an intervention item.

## Blocks and escalation

A question (`needs_input`) goes to the column orchestrator, else curator, else
operator. Routing avoids asking yourself: orchestrators ask the curator; curators
ask the operator. An `operator` column asks the operator.

A `code` block goes to the worker; a `dependency` or `external` block stays with
its author's role. Questions escalate from column orchestrator to curator to
operator; other blocks escalate straight to the operator. Skip your own project:
a curator orchestrating the column escalates straight to the operator. Use keyed
`board escalate <block>` if the addressee cannot resolve it.

Taskless: all roles, operator only:
`board project ask <project> <text> --to operator --key <key>`.
Project `needs_input` blocks get Slack threads except operator-agent asks;
operator: `board inbox`, keyed `board answer`. Answers reach a current curator session; other roles use the asking session.

Routing: `projects[].columns[].orchestrator`, `projects[].spurProjects[].role`,
`operator.slack` (Slack user ID). Roles follow the current session.

## Slack now

`slack.channels.feed` carries curator answers and operator items,
except those elsewhere and delivery problems.
`slack.channels.orchestrators` carries block threads addressed to the operator by
others. Answer in the existing block thread.

## Slack addressing

With `projects[].spurProjects[].shortName`, a new operator message in
`slack.channels.orchestrators` starts a conversation. A leading registered
`@shortName` selects that Spur project and is stripped. With an absent or unknown
leading name, `slack.defaultAddressee` receives the complete text, retaining any
unknown prefix; without it the Board replies once with the valid prefixes.
Middle mentions or Slack `<@U…>` address nobody; unknown names cause no lookup
error. The operator checks short-name collisions with workspace names.
A task key after the prefix attaches it.

The addressee gets the block ID, reads `board inbox`, replies with
`board answer`. Each operator thread message rings again; `close` or ✅ in the
thread closes it. Replies use `projects[].spurProjects[].displayName` and `icon`,
else project name and role icon (`board` for operator). Without a session,
`board status` lists it as waiting.

## Done follows the ticket

One linked PR merging does not by itself finish the task. Done follows the
ticket: `projects[].tracker.doneStatuses` for Jira; for GitHub, the Issue must be
closed. After merge, wait for tracker confirmation; if it settles open, work
continues and another PR can be linked.
