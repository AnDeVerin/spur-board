# Columns and executors

`board columns describe [--project <project>]` (MCP `columns_describe`) reads
column/exit/completion policy. Task facts: `board task <KEY> --why`.

## Columns and executors

`todo`, `triage`, `ready-for-dev`, `dev`, `review`, `product-review`,
`external-review`, `qa`, `ready-to-merge`, `done`.
`projects[].columns[].enabled`: disabled/omitted columns skip gates;
To Do, Dev, Done stay enabled. `triage` is off unless `columns` lists it.

The Todo group is `todo`, `triage` and `ready-for-dev`: the dispatcher never moves a task between them.
Open PR/live worker skips the group to Dev. New/reopened tasks enter `todo`.

Manual: operator-only; enabled Todo-group endpoints, else
`move_outside_todo_group`; eligible unbanned open PRs (conflicts too) or live linked
workers give `work_started`. CLI default `--manual`; MCP `task_move`; web API.
Both modes: real column, new visit (same column too).
Idle stays until a later reopen; work/completion follow facts. Ties: journal
order; saved sorts win. Need non-blank literal reason
(max 20,000 UTF-16 units), explicit non-blank key; retry identical input/key.
Exact reason in events; one line in history.

`--correct` repairs enabled non-Done columns then settles gates. Dev return:
`board return <turn> <reason>`. QA: `board submit <turn> <sha>` records evidence.

| Column            | Position source                | Who moves                    | Command                                                       |
| ----------------- | ------------------------------ | ---------------------------- | ------------------------------------------------------------- |
| `todo`            | New/reopened; manual           | Dispatcher/operator          | `board move <task> todo --reason <text> --key <key>`          |
| `triage`          | Manual                         | Operator                     | `board move <task> triage --reason <text> --key <key>`        |
| `ready-for-dev`   | Manual or Project mirror       | Operator/mirror              | `board move <task> ready-for-dev --reason <text> --key <key>` |
| `dev`             | Work start/gate failure/return | Dispatcher/executor/operator | `board move <task> dev --correct --reason <text>`             |
| `review`          | Gates: internal review         | Dispatcher/operator          | `board move <task> review --correct --reason <text>`          |
| `product-review`  | Gates: product review          | Dispatcher/operator          | `board move <task> product-review --correct --reason <text>`  |
| `external-review` | Gates: external approval       | Dispatcher/operator          | `board move <task> external-review --correct --reason <text>` |
| `qa`              | Gates: QA confirmation         | Dispatcher/operator          | `board move <task> qa --correct --reason <text>`              |
| `ready-to-merge`  | Gates: merge                   | Dispatcher/operator          | `board move <task> ready-to-merge --correct --reason <text>`  |
| `done`            | Completion: PR/ticket facts    | Dispatcher                   | None (automatic)                                              |

Order: one per column, board-wide; arrivals go last. Operator:
`board order <task> --before <task> --key <key>` (`--after`, `--top`, `--bottom`);
`board status` shows `position`.

Mirror: `source` on `ready-for-dev`; `column_mirrored` refuses manual moves there.
Each complete read moves idle tasks between it and `todo`, overriding `--correct`.
`board config get`: `group: todo`; `board status`: `columnGroups`.

Each column has one executor: `projects[].columns[].orchestrator`:
`none` (Dev, Done: live worker, else operator; External Review: no turn; others:
operator), `operator`, or project with role
`orchestrator` or `curator`. The worker owns the code and branch; others inspect/return, never push.

`projects[].spurProjects[].role` accepts `worker`, `operator`, `curator` and
`orchestrator`.

Top-level `spurProjects[].columns` fills `none` columns board-wide;
`role: operator` there serves operatorless projects, one session in
each. A project-level binding wins.

## Gates and placement

Facts (head, checks, reviews, comments, ticket, sessions) feed gates; actions: move the task, open an executor turn (at most one
per evaluation). Turns follow unmet entry gates, actionable post-submit failures,
rerouting or Done wrap-up. Holds and existing turns can yield neither action.

Dispatcher moves, executor turns, course checks need `projects[].dispatcher.mode: on`;
default is `shadow`: no doorbells or blocks.

Gates are cumulative: each column checks its enabled gate and those to its left. At a turn boundary, failed gates return to the leftmost failing
column. Taken turns hold until submit, return or a new head. Pending CI, unknown
mergeability and incomplete comment history are waits. Downstream handoff waits
for settled prerequisites; Dev can receive a repair turn.

Dev needs an open non-draft PR, passing checks, no conflict, handled
feedback, comment history, current-head submit. Feedback excludes
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
External Review's external approval. QA: current-head submit; Ready to Merge awaits merge. A submit counts only in its own column. After a submit, an operator Ready to Merge waits for the merge with no new turn. Gate rules have no switch
except enabled columns, no-CI, checks gate, resolved threads and review rule
(`approvalRule: github-rules`, `docs/configuration.md`).

`projects[].checksGate` (default `dev`; `review`, `product-review` or
`external-review`, enabled) moves the pending-CI wait to that column's exit. Red
checks return the task to Dev from any column, after the submit of a taken turn;
Ready to Merge needs green. Only right of `dev` a cancelled check counts as running
for about two GitHub poll intervals. Applies after a restart.

`projects[].columns[].requireResolvedThreads` (default: `ready-to-merge` only)
gates that column and those right of it: an unresolved review thread, outdated
or by anyone, returns the task to Dev, whose turn lists each thread link. The
worker fixes or answers, then resolves each; reviewers never do. A
Dev submit on the same head moves right, keeping marks and approval. An
approval's inline notes are threads; it still passes External Review.

Review/Product Review mark lasts across visits on the current head. QA submissions
also survive returns and corrections to Dev on the same head. Other visit
submissions belong to one column visit; moving left clears them and those to the
right. A different observed PR head permanently invalidates internal Review,
Product Review and QA evidence, even if the head later returns.
Operator correction into QA clears confirmed and pending QA evidence,
keeping review marks; with passing upstream gates,
this opens a fresh QA turn. Retained QA cannot supply Dev's submit
requirement: submit the current Dev visit first.

PR closed without merge with no open PR, or closed
ticket with live work and no merged PR. `board status` lists them as operator block threads.
