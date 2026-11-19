# Columns and executors

`board columns describe [--project <project>]` (`columns_describe` in MCP) reads
visible enabled columns' exits, returns, executors and escalation timing.
JSON: IDs; terminal: readable text. Cumulative rules appear once per owner.
Task state: `board task <KEY> --why`.
Named sessions: doctor's live project selection. Orchestrator recipients
(curator turns too) may use live authors/task-linked sessions.
Curator questions/course checks use its selected session. Executor turns/ordinary
orchestrator questions await recipients; curator questions and agent course checks
fall back to the operator. `escalation.silent` uses per-column `quietTurnAfterMs`
for named turns, global idle timing for workers. `escalation.noRecipient` uses
`noRecipientAfterMs` for untaken named turns; it raises an item without rerouting.

`exit.to` is null at Done and the last enabled stage before it. Green checks and
an open PR do not complete work. `completion` bypasses gates (Ready to Merge too): eligible merged PR + done ticket, or done ticket with
no open PR/live worker after fresh, complete, non-blind observations of every
repo and Spur since task change. Done means GitHub `closed` or Jira
`doneStatuses`; text names statuses/tracker interval. After merge,
missing/unconfirmed tickets hold dispatch. Open tickets resume without that PR after one tracker interval,
observed in-filter or manually included;
dropped-filter evidence stays unconfirmed. Blind GitHub/pending submits hold both
routes. Exclude archived tasks; links: unbanned/past the reopen floor.
Missing/unreadable PR facts (chosen/fallback) hold. Cycle holds allow
completion. Dispatcher `on` applies moves; `shadow` computes shadow position.

## Columns and executors

`todo`, `triage`, `ready-for-dev`, `dev`, `review`, `product-review`,
`external-review`, `qa`, `ready-to-merge`, `done`.
`projects[].columns[].enabled`: disabled/omitted columns skip gates;
To Do, Dev, Done stay enabled. `triage` is off unless `columns` lists it.

The Todo group is `todo`, `triage` and `ready-for-dev`: the dispatcher never moves a task between them.
Open PR/live worker skips the group to Dev. New/reopened tasks enter `todo`,
including reopen with a hidden PR from another group column.

`board move <task> <column> --reason <text> --key <key>` defaults to manual;
Explicit `--manual`. MCP: `task_move`, `mode: manual`; also operator web API.
Operators only. Require enabled Todo-group source/target, else
`move_outside_todo_group`. Eligible unbanned open PRs (including conflict links) or
live linked workers give `work_started`.

Manual moves change the real column in both modes: a fresh visit at target end,
even same-column moves. Idle ticks keep placement; work/completion/reopen follow
facts. Timestamp ties use journal order; saved reverse-time/key sorts win.
Reason: non-blank, max 20,000 UTF-16 units, literal in events/move views; history
normalizes whitespace to one line. Key: explicit, non-blank; retry identical input
with the same key. `--correct` retains correction/settling behavior.

| Placement             | Owner             |
| --------------------- | ----------------- |
| New/reopen to `todo`  | Dispatcher        |
| Idle Todo-group move  | Operator: manual  |
| Work/completion/gates | Dispatcher        |
| Repair and settle     | Operator: correct |

No mirroring config; reserved `column_mirrored` directs status to the named project.
`board config get`: `group: todo`; `board status`: `columnGroups`.

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

Dispatcher moves, executor turns and course checks need `projects[].dispatcher.mode: on`;
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
except enabled columns, no-CI, checks gate and resolved threads.

`projects[].checksGate` (default `dev`; `review`, `product-review` or
`external-review`, enabled) moves the pending-CI wait to that column's exit. Red
checks return the task to Dev from any column, after the submit of a taken turn;
Ready to Merge needs green. Only right of `dev` a cancelled check counts as running
for about two GitHub poll intervals. It takes effect after a restart.

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
submit can satisfy QA after correction. Retained QA cannot supply Dev's submit
requirement: after returning to Dev, submit the current Dev visit before advancing.

PR closed without merge with no open PR, or closed
ticket with live work and no merged PR. `board status` lists them as operator block threads.
