# How the Board works

## Columns and executors

`todo`, `ready-for-dev`, `dev`, `review`, `product-review`,
`external-review`, `qa`, `ready-to-merge`, `done`.
`projects[].columns[].enabled`: disabled/omitted optional columns skip gates;
To Do, Dev, Done stay enabled.

Each column has one executor: `projects[].columns[].orchestrator`:
`none` (live worker, else operator), `operator`, or project with role
`orchestrator` or `curator`. The worker owns the code and branch; others inspect/return, never push.

`projects[].spurProjects[].role` accepts `worker`, `operator`, `curator` and
`orchestrator`. Curators guide; orchestrators execute.

## Gates and placement

Facts (head, checks, reviews, comments, ticket, sessions) feed gates; two actions: move the task and open an executor turn (at most one
per evaluation). Turns follow unmet entry gates, actionable post-submit failures,
rerouting or Done wrap-up. Holds and existing turns can yield neither action.

Moves, turns and course checks need `projects[].dispatcher.mode: on`;
default is `shadow`: proposed placement only; no turns, doorbells or blocks.

Gates are cumulative: each column checks its enabled gate and those to its left. At a turn boundary, failed gates return to the leftmost failing
column. Pending CI, unknown
mergeability and incomplete comment history are waits. Downstream handoff waits
for settled prerequisites; Dev can receive a repair turn.

Dev needs an open non-draft PR, passing checks, no conflict, handled external
feedback, comment history and current-head submit. Feedback excludes
bots, approvals and `projects[].operatorGithubLogin` (agents' account), so worker
thread replies never count; others' posts do.
The repo owner's and the human operator's own accounts count too, unless one is
that login: a PR comment is a change request; talk to agents in Slack
(`@shortName`) or the Board. A review-thread reply is a new review. An approval
hides its inline comments; thread resolution and the head a comment was left on
change nothing. Bots (GitHub Apps) neither return a task, approve it nor block
an approval. Handled means handed by ID to a Dev turn, not answered; in shadow
mode, a later submit in Dev or an executor `none` column handles it.
A status comment whose last line is a hidden `board-reviewer-progress` or
`board-reviewer-unavailable` marker is not external feedback. No required checks: non-skipped count. `projects[].reposWithoutCi` waives absent checks
for listed repos; never failed/skipped required ones.

Review and Product Review need current-head internal review marks, separate from
External Review's external approval. QA: current-head submit; Ready to Merge awaits merge. Executor `none` may reuse same-head submits from other worker columns. Fixed gate rules have no configuration switch
except enabled/no-CI.

Review/Product Review mark lasts across visits on the current head. A visit
submission belongs to one column visit; moving left clears it and those to the right. New heads invalidate internal Review and Product Review marks,
even old heads.

PR closed without merge with no open PR, or closed
ticket with live work and no merged PR. `board status` lists them as operator block threads.

## Turns and delivery

A turn `T<number>`: keyed `board inbox ack <entries>`.
Only the acknowledging session may submit or return: keyed
`board submit <turn> <sha>` accepts the head; keyed
`board return <turn> <reason>` sends findings to Dev. In
shadow mode, use keyed `board submit <task> <sha>`.
Unseen heads answer `pending`: that submit is final; do not resubmit or raise a
block. Confirm timeout: `projects[].dispatcher.submitConfirmMs`.

A new head closes taken turns outside Dev; taken Dev turns survive pushes.
Right of Dev, red CI, a draft, a conflict or an external comment returns the
task to Dev at once, unless a turn is taken; then after its submit or return.
The Dev turn hands the comments, beside a return's `code` block.
Operator turns: 1 inbox item + Slack thread until exit.

Closed turns receive no further Board sends; Obsolete queued rings are dropped;
a message already accepted by Spur cannot be retracted. Check `board inbox` and
act only on a current turn; reread after `turn_closed`.

Open-turn executors in `needs_input`, `error`, `rate_limited` or `stopped` raise
one question after `health.turnStallAfterMs` (default 600000 ms): curator unless self, else
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

`projects[].columns[].courseCheck` defaults to 3 counted returns to Dev;
`courseCheck: 0` disables it. `projects[].columns[].cycleLimit` defaults to 10 and
takes priority. Executor returns and external comments (a changes-requested
review is one) count; CI failures, conflicts and drafts alone do not count, nor
reopened tickets or mode switches.

If returns keep hitting the same mechanism, fix the bug class once; cover its variants with one table test. Put remaining edges with no user-visible effect under Risk in the PR description. Still fix P0/P1 and user-visible findings in this PR.
`projects[].columns[].courseCheckTo`: `operator`, curator or column orchestrator.
Default: curator (`projects[].spurProjects[].role`), else operator. An answer
resets the course count and reaches the worker as a task comment. Only the
operator can resolve the separate cycle limit and reset its count. With no live
session it falls back to the operator; a live conductor that does not
answer keeps the question.

## Blocks and escalation

A question (`needs_input`): column orchestrator, else curator, else
operator. Routing avoids asking yourself: orchestrators ask the curator; curators
ask the operator.

A `code` block goes to the worker; `dependency` or `external` block stays with
its author's role. Escalation: column orchestrator to curator to
operator; other blocks escalate straight to the operator. Use keyed
`board escalate <block>` if its addressee cannot resolve it.

Taskless: all roles, operator only:
`board project ask <project> <text> --to operator --key <key>`.
Project `needs_input` blocks get Slack threads except operator-agent asks;
operator: `board inbox`, keyed `board answer`. Answers reach a current curator session; other roles use the asking session.

`projects[].columns[].orchestrator`, `projects[].spurProjects[].role`,
`operator.slack`.

## Slack now

`slack.channels.feed`: curator answers and operator items,
except elsewhere/delivery problems.
`slack.channels.orchestrators`: block threads addressed to the operator by
others. Answer in the existing block thread.

## Slack addressing

With `projects[].spurProjects[].shortName`, a new operator message in
`slack.channels.orchestrators` starts a conversation. A leading registered
`@shortName` selects that Spur project and is stripped. With absent or unknown
leading name, `slack.defaultAddressee` gets the complete text, retaining any
unknown prefix; without it Board replies once with the valid prefixes.
Middle mentions or Slack `<@U…>` address nobody; unknown names cause no lookup
error. The operator checks short-name collisions with workspace names.
A task key after the prefix attaches it.

Read `board inbox`; reply with `board answer`. Each operator thread message rings again; `close` or ✅ in the
thread closes it. Replies use `projects[].spurProjects[].displayName` and `icon`,
else project/role icon. No session:
`board status` lists it as waiting.

## Done follows the ticket

One linked PR merging does not by itself finish the task. Done: `projects[].tracker.doneStatuses` for Jira; for GitHub, the Issue must be
closed. If open after merge, link another PR.
