# Columns and executors

## Columns and executors

`todo`, `ready-for-dev`, `dev`, `review`, `product-review`,
`external-review`, `qa`, `ready-to-merge`, `done`.
`projects[].columns[].enabled`: disabled/omitted columns skip gates;
To Do, Dev, Done stay enabled.

Each column has one executor: `projects[].columns[].orchestrator`:
`none` (live worker, else operator), `operator`, or project with role
`orchestrator` or `curator`. The worker owns the code and branch; others inspect/return, never push.

`projects[].spurProjects[].role` accepts `worker`, `operator`, `curator` and
`orchestrator`.

Top-level `spurProjects[].columns` fills `none` columns board-wide;
`role: operator` there serves operatorless projects, one session acting in
each. A project-level binding wins.

## Gates and placement

Facts (head, checks, reviews, comments, ticket, sessions) feed gates; two actions: move the task and open an executor turn (at most one
per evaluation). Turns follow unmet entry gates, actionable post-submit failures,
rerouting or Done wrap-up. Holds and existing turns can yield neither action.

Moves, turns and course checks need `projects[].dispatcher.mode: on`;
default is `shadow`: no doorbells or blocks.

Gates are cumulative: each column checks its enabled gate and those to its left. At a turn boundary, failed gates return to the leftmost failing
column. Taken turns hold until submit, return or a new head. Pending CI, unknown
mergeability and incomplete comment history are waits. Downstream handoff waits
for settled prerequisites; Dev can receive a repair turn.

Dev needs an open non-draft PR, passing checks, no conflict, handled
feedback, comment history and current-head submit. Feedback excludes
bots, approvals and `projects[].operatorGithubLogin` (agents' account), so worker
thread replies never count; others' posts do.
The repo owner's and the human operator's own accounts count too, unless one is
that login: a PR comment is a change request; talk to agents in Slack
(`@shortName`) or the Board. A review-thread reply is a new review. An approval
hides its inline comments; thread resolution and the head a comment was left on
change nothing for feedback. Bots (GitHub Apps) neither return a task, approve it nor block
an approval; their threads still count. Handled means handed by ID to a Dev turn, not answered; in shadow
mode, a later submit in Dev or an executor `none` column handles it.
An edit after the hand makes it unhandled again, returning a task right of Dev.
A status comment whose last line is a hidden `board-reviewer-progress` or
`board-reviewer-unavailable` marker is not external feedback. No required checks: non-skipped count. `projects[].reposWithoutCi` waives absent checks
for listed repos; never failed/skipped required ones.

Review and Product Review need current-head internal review marks, separate from
External Review's external approval. QA: current-head submit; Ready to Merge awaits merge. Executor `none` may reuse same-head submits of other worker columns. Fixed gate rules have no configuration switch
except enabled columns, no-CI and resolved threads.

`projects[].columns[].requireResolvedThreads` (default: `ready-to-merge` only)
gates that column and those right of it: an unresolved review thread, outdated
or by anyone, returns the task to Dev, whose turn lists each thread link. The
worker fixes or answers, then resolves each; reviewers never do. A
Dev submit on the same head moves right, keeping marks and approval. An
approval's inline notes are threads; it still passes External Review.

Review/Product Review mark lasts across visits on the current head. QA submissions
also survive returns and corrections to Dev on the same head. Other visit
submissions belong to one column visit; moving left clears them and those to the
right. A different observed PR head permanently invalidates its internal Review,
Product Review and QA evidence, even if the head later returns to that commit.
Explicit operator correction into QA clears confirmed and pending QA evidence,
keeping review marks. With passing upstream gates and a QA orchestrator or operator,
this opens a fresh QA turn. Executor `none` keeps worker-column reuse: a valid Dev
submit can satisfy QA after correction, and retained worker QA can satisfy Dev.

PR closed without merge with no open PR, or closed
ticket with live work and no merged PR. `board status` lists them as operator block threads.
