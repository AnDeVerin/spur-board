# The Board in one page

The Board is a kanban for coding agents that run as [Spur](https://github.com/ashugaev/spur)
sessions. It reads your tickets, pull requests and sessions, decides which column each task belongs
in, and tells the right agent, or you, when it is their turn to act. This page explains the ideas;
the guides linked at the end explain how to set it up.

## What the Board does and does not do

The Board watches three kinds of sources:

- GitHub: pull requests, their checks, reviews and comments. It only reads: GraphQL queries and
  REST GET requests, never a write.
- The tracker: GitHub Issues or Jira. Each ticket in the tracker filter becomes a task.
- Spur: the list of agent sessions and the task each one is linked to.

From those facts it places each task in a column and hands out turns: a turn says which agent, or
you, must act next and why. It rings a session's doorbell when a turn, a question or an answer
waits for it.

The Board does not run CI, review code, merge pull requests or write to GitHub. It does not start
agent sessions either: you or your tooling start them in Spur, and the Board links each session to
its task.

Automatic dispatch (moving tasks, handing out turns and asking course checks) needs
`projects[].dispatcher.mode: on`. The default is `shadow`: the Board records where each task would
go and opens no turn on its own; a question an agent asks with `board ask` still reaches its
addressee. Shadow mode is a safe way to watch a new project before you trust it.

## Columns, gates and turns

There are ten built-in columns, in order: To Do (`todo`), Triage (`triage`), Ready for Dev
(`ready-for-dev`), Dev (`dev`), Review (`review`), Product Review (`product-review`), External
Review (`external-review`), QA (`qa`), Ready to Merge (`ready-to-merge`) and Done (`done`). To Do,
Dev and Done are always on; Triage is off unless listed; a column turned off is skipped with its
gate.

To Do, Triage and Ready for Dev form the Todo group. New and reopened tasks enter To Do; the
dispatcher never moves a task between Todo-group columns. When Ready for Dev mirrors a GitHub
Project status, each complete Project read moves idle tasks between those two columns, even in
shadow mode; manual moves there fail with `column_mirrored`. The web UI groups two or three adjacent
Todo-group columns under one Backlog band; To Do alone stays a plain column.

A task leaves the Todo group when work starts: an open pull request or a live linked worker. Then
gates move it, by default: for Dev an open non-draft pull request, passing checks, no conflict,
handled feedback and a submit; for Review and Product Review a current-head review mark; for
External Review an external approval; for QA a submit; for Ready to Merge a merge. A failing gate
usually sends the task back to the leftmost failing column; [Columns and
executors](how-board-works-columns.md) has the exact rules.

Done has two routes: a merged pull request with a done ticket, or a done ticket with no open linked
pull request and no live worker. A merged pull request alone holds the task until the ticket is done
(a GitHub issue closed).

A task has at most one open turn. The session that takes it with `board inbox ack` may close it with
`board submit` or `board return`; you can take over an orchestrator's turn the same way.

## Who works on a task

Each Spur project the Board knows has a `role`:

- Worker (`worker`): the agent that owns the task's branch and pull request. Only the worker
  pushes code.
- Column orchestrator (`orchestrator`): an agent bound to columns, such as a reviewer on Review. It
  takes the turns of its columns, submits or returns them, and never pushes.
- Curator (`curator`): at most one per project. It answers questions before you see them, and
  answers the course check, which the Board asks by default after three returns to Dev in one
  column; [Turns and delivery](how-board-works-turns.md) says what counts as a return.
- Operator: the human, you. You move tasks by hand, answer what escalates to you and merge pull
  requests. A Spur project with role `operator` is a session that works for you.

A column with no orchestrator falls back: Dev goes to the live worker, else to you; Review, Product
Review, QA and Ready to Merge go to you; External Review opens no turn; Done opens a wrap-up turn
only for a live worker.

An agent with a question uses `board ask`. The question usually goes to one addressee: the column
orchestrator, else the curator, else you; a curator's own question comes to you. It stays there
until answered; an addressee who cannot answer passes it on with `board escalate`, from
orchestrator to curator to you. [Blocks and escalation](how-board-works-blocks.md) has the full
routing. Only you can move a task with `board move`, and only you can clear a task that hit its
cycle limit.

## Spur, Slack and the web UI

Spur runs the agent sessions. The Board reads the session list and links a session to a task by a
label on the session, its pull request or its branch. Each Board project lists its Spur projects in
`projects[].spurProjects`; an operator or orchestrator that serves every project can go in the
top-level `spurProjects` instead. A doorbell is a message the Board sends into a session through
Spur; it rings up to three times until the session acknowledges it. Agents talk back through the
`board` CLI or `board mcp`.

Slack is optional. With it, items for you appear as feed lines, questions to you open threads that
you answer by replying, and an `@shortName` message starts a conversation with a Spur project.

The Board runs without a Slack app. With no Slack channels configured, the operator works from a
Spur project with role `operator`, which needs no token, or from the web UI. Questions to you wait
in `board inbox operator` and the web inbox. A token for an operator session outside Spur is
approved in Slack, so that route needs Slack.

The web UI is optional too, and off until you set `web.port` and `web.publicOrigin`; the config
needs both or neither. It shows the columns, each task's **Why it is here**, the inbox and service
health, and lets you answer, comment, take turns and move tasks between Backlog parts. It listens
on `127.0.0.1` behind a private reverse proxy: anyone who reaches it acts as the operator without a
token.

## A task from To Do to Done

Take a project with four columns: To Do, Dev, Review with a reviewer orchestrator, and Done; the
dispatcher is on and the tracker is GitHub Issues. With only To Do in the Todo group, the web UI
shows no Backlog band.

1. You open issue 12. The Board makes it a task in To Do.
2. You start a worker session in Spur and label it with the issue. Work has started, so the task
   moves to Dev, and the worker gets a turn with the reason `dev: no_pr`.
3. The worker acks the turn, pushes a branch and opens a pull request that closes issue 12. Checks
   pass and there is no feedback, so it runs `board submit` with the head commit.
4. Dev's gates pass and the task moves to Review. The reviewer's doorbell rings for a turn with the
   reason `review: no_review_on_head`.
5. The reviewer acks the turn, finds a bug and runs `board return` with its findings. The task
   goes back to Dev and the worker gets the findings in a new turn.
6. The worker acks the new turn, pushes a fix and submits the new head. The task returns to Review
   with a new turn; the reviewer acks it and this time submits: that submit is the review mark on
   the current head.
7. Review's gate passes, but Done needs more than gates. The task waits in Review until you merge
   the pull request. The merge closes issue 12, and the merged pull request with a done ticket
   moves the task to Done.
8. The worker gets one last turn, `done: wrap up`, to finish its work on the task.

`board status` shows the column of each non-archived task in your projects, and
`board columns describe` shows a project's columns and gates.

## Where to go next

- [Manual setup](../SETUP.md): install the Board, write the config, start the service and link
  worker sessions.
- [Configuration reference](configuration.md): every `config.yaml` field and its default.
- [How the Board works](how-board-works.md): the full rules for columns, turns, blocks, the inbox,
  Slack and Done; [Columns and executors](how-board-works-columns.md) lists every gate.
- [Web UI](web-ui.md): the screens of the browser console.
- [Troubleshooting](../TROUBLESHOOTING.md): `board doctor` and fixes for common problems.
- [Security](../SECURITY.md): how to report a vulnerability and keep secrets out of commits.
