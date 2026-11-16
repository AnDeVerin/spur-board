# Blocks and escalation

## Blocks and escalation

A question (`needs_input`): column orchestrator, else curator, else
operator. Routing avoids asking yourself; curators ask the operator.

A `code` block goes to the worker; `dependency` or `external` block stays with
its author's role. Escalation: column orchestrator to curator to
operator; other blocks escalate straight to the operator. Keyed
`board escalate <block>` if its addressee cannot resolve it.

Taskless: all roles, operator only:
`board project ask <project> <text> --to operator --key <key>`.
Project `needs_input` blocks get Slack threads except operator-agent asks;
operator: `board inbox`, keyed `board answer`. Answers reach a current curator session; other roles use the asking session.
A task's blocks (`task.get`) carry `answeredVia`: `web` or `slack` for an answer
from there, else null.

`projects[].columns[].orchestrator`, `projects[].spurProjects[].role`,
`operator.slack`.

## Operator inbox

`board inbox operator` needs the operator grant: the token, the web screen or
an operator Spur session. It lists open operator items, blocks to `operator`
and operator turns of the caller's operator projects; `_board` entries only
for the token and the board-wide operator, or any operator project when there
is none. A block or turn is listed once, not
with its items. Each entry is `attention` or `failure`; a failure says what
to check. `handled` keeps the last 24 h, at most 20, newest first; handled
blocks carry `answeredVia`. Archived tasks are left out.
