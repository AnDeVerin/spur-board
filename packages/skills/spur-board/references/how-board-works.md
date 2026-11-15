# How the Board works

`board task <task> --why`: gates, holds, waits, turn and moves.

## Columns and executors

`todo`, `ready-for-dev`, `dev`, `review`, `product-review`,
`external-review`, `qa`, `ready-to-merge`, `done`.
`projects[].columns[].enabled: false` or omitting an optional column skips its gate;
To Do, Dev, Done stay on.

`projects[].columns[].orchestrator` selects one executor:
`none` (live worker, else operator), `operator`, or project with role
`orchestrator` or `curator`. Workers own code and branch; others submit inspected heads or return findings;
never push.

`projects[].spurProjects[].role` accepts `worker`, `operator`, `curator` and
`orchestrator`. Curators guide; orchestrators execute columns.

## Gates and placement

Facts feed gates: move the task and open a turn (at most one per evaluation).
Turns follow unmet entry gates, post-submit failures, rerouting or Done wrap-up.
Holds and existing turns can yield neither action.

Moves, turns and course checks need `projects[].dispatcher.mode: on`;
default is `shadow`: proposed placement only; no turns, doorbells or blocks.

Gates are cumulative. At turn boundaries, return to the leftmost failing column.
Taken turns hold until submit, return or new head. Pending CI, unknown
mergeability and incomplete comments wait. Handoffs await prerequisites; Dev
gets repair turns for red CI, drafts, conflicts or unhandled external comments.

Dev needs an open non-draft PR, passing checks, no conflict, handled external
feedback, comment history and current-head submit. Feedback excludes
bots, approvals and `projects[].operatorGithubLogin` (agents' account), so worker
thread replies never count; others' posts do.
A status comment whose last line is a hidden `board-reviewer-progress` or
`board-reviewer-unavailable` marker is not external feedback. No required checks: count non-skipped checks. `projects[].reposWithoutCi` waives absent checks
for listed repos; never failed/skipped required ones.

Review and Product Review need current-head internal review marks, separate from
External Review's external approval. QA: current-head submit; Ready to Merge awaits merge. Executor `none` may reuse same-head submits from other worker columns. Gate rules only configure enabled columns and no-CI.

Review/Product Review marks persist on the current head. Moving left clears
visit submissions from that column onward. New heads invalidate internal marks,
even old heads.

Anomalies: closed PR without merge/replacement, or closed ticket with live work
and no merge. `board status` lists them; they may open operator blocks.

## Turns and delivery

A turn `T<number>`: a visit. Keyed `board inbox ack <entries>`.
Only the acknowledging session may submit or return: keyed
`board submit <turn> <sha>` accepts the head; keyed
`board return <turn> <reason>` sends findings to Dev. In
shadow mode, use keyed `board submit <task> <sha>`.
Unseen heads answer `pending`: that submit is final; do not resubmit or raise a
block. Confirms or returns the turn
(`projects[].dispatcher.submitConfirmMs`).

New heads close taken turns outside Dev; taken Dev turns survive pushes.
Untaken turns: CI, draft, conflict or external-comment returns.
Operator turns: 1 inbox item + Slack thread until exit.

Closed turns receive no further Board sends; Obsolete queued rings are dropped;
a message already accepted by Spur cannot be retracted. Check `board inbox` and
act only on a current turn; reread after `turn_closed`.

Open-turn executors in `needs_input`, `error`, `rate_limited` or `stopped` raise
one system question after `health.turnStallAfterMs` (600000 ms default): curator,
else operator; unread curator questions escalate. Time starts at the later of
turn creation/state start; taking never resets it. The reason names turn, session,
state, elapsed time and existing executor questions; quota name is unavailable,
reset shown when known. Evidence freezes per turn/session/state episode; dismissal
suppresses it. Recovery, replacement, removal, archive or turn closure withdraws
it. Blind Spur opens none, retains existing blocks, honors known closure/removal.

## Doorbells

A turn opened for you by your own confirmed submit or return is first rung only after `doorbells.firstRetryMs`; a turn opened for you any other way rings at once.

Read `board inbox` for a ringing turn, block, answer or follow-up. Ordinary task
comments and blocks tracked by their author role do not ring themselves.

Unacked series repeat up to three delivered rings; acknowledgement stops them.
Removal notices and quiet-turn reminders ring once. Busy recipients, pending
delivery and earlier Spur queue rings defer sends. Queued rings can time out.

Most notices await recipients. Taskless worker, orchestrator and operator-agent
answers end without a live asker. Curator and course-check questions fall back
to operator; operator conversations await their project. Exhaustion alerts the
operator except removals/reminders; curator questions move to operator.

## Course checks and cycle limits

`projects[].columns[].courseCheck` defaults to 3 counted returns to Dev;
`courseCheck: 0` disables it. `projects[].columns[].cycleLimit` defaults to 10 and
takes priority. Executor returns, changes requested and external comments count;
CI failures, conflicts and drafts alone do not count, nor reopened tickets or
mode switches.

Checks hold for input.
If returns keep hitting the same mechanism, fix the bug class once; cover its variants with one table test. Put remaining edges with no user-visible effect under Risk in the PR description. Still fix P0/P1 and user-visible findings in this PR.
`projects[].columns[].courseCheckTo`: `operator`, curator or column orchestrator.
Default: curator (`projects[].spurProjects[].role`), else operator. An answer
resets the course count and reaches the worker as a task comment. Only the
operator can resolve the separate cycle limit and reset its count. With no live
session it falls back to the operator; a live conductor that does not
answer keeps the question, with intervention item.

## Blocks and escalation

A question (`needs_input`): column orchestrator, else curator, else
operator. Avoid self-routing: orchestrators ask the curator; curators
ask the operator.

A `code` block goes to the worker; `dependency` or `external` block stays with
its author's role. Escalation: column orchestrator to curator to
operator; other blocks escalate straight to the operator. Use keyed
`board escalate <block>` if its addressee cannot resolve it.

Taskless questions, all roles to operator:
`board project ask <project> <text> --to operator --key <key>`.
Project questions get Slack threads except operator-agent asks. Read
`board inbox`, keyed `board answer`. Answers reach a current curator; other
roles use the asking session.

`operator.slack` is the Slack user ID; roles follow session.

## Slack now

`slack.channels.feed`: curator answers and operator items,
except items elsewhere/delivery problems.
`slack.channels.orchestrators`: block threads addressed to the operator by
others. Answer in the existing block thread.

## Slack addressing

With `projects[].spurProjects[].shortName`, a new operator message in
`slack.channels.orchestrators` starts a conversation. A leading registered
`@shortName` selects that Spur project and is stripped. With absent or unknown
leading name, `slack.defaultAddressee` gets the complete text, retaining any
unknown prefix; without it Board replies once with the valid prefixes.
Middle mentions and Slack `<@U…>` address nobody. Unknown names cause no lookup
error; check short-name collisions with workspace names.
A task key after the prefix attaches it.

Read `board inbox`, reply with `board answer`. Each operator thread message
rings again; `close` or ✅ closes it. Replies use `projects[].spurProjects[].displayName` and `icon`,
else project name/role icon (`board` for operator). No session:
`board status` lists it as waiting.

## Done follows the ticket

Done follows the ticket, not a merge: `projects[].tracker.doneStatuses` for Jira; for GitHub, the Issue must be
closed. If open after merge, link another PR.
