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
On an unblocked block, the operator's keyed `board followup <block> <text>`
rings the author like an answer and posts to the block's thread; the block
stays closed, and the column and turn do not change.
A task's blocks (`task.get`) carry `answeredVia`: `web`, `slack`, `cli` or `mcp`
for an answer from there, else null.
Its `comments` leave out a block's opening comment that repeats its reason.

`projects[].columns[].orchestrator`, `projects[].spurProjects[].role`,
`operator.slack`.

## Operator inbox

`board inbox operator` needs the operator grant: the token, the web screen or
an operator Spur session. It lists open operator items, blocks to `operator`
and operator turns of the caller's operator projects; `_board` entries only
for the token and the board-wide operator, or any operator project when there
is none. A block or turn is listed once, not
with its items. Each entry is `attention` or `failure`. Every item entry
(`I…`) carries `action`, what you do about it, and its text ends with it;
block and turn entries have none. `handled` keeps the last 24 h, at most 20,
newest first, with the same actions; handled blocks carry `answeredVia`.
Archived tasks are left out.

The actions use `board answer <block> <text>`,
`board unblock <block> --reason <reason>`,
`board item retry <item>`,
`board item close <item>`,
`board task archive <task>` and
`board unlink <task> --pr <pr> --reason <reason>`.

A stored target is a known structured HTTP(S) destination, never a generic placeholder or a
URL extracted from text. Unknown or invalid targets are omitted. Active and handled entries
carry the same optional `url`; blocks and turns have no synthetic target.

[Operator inbox items](how-board-works-inbox.md) lists each item kind, its action, severity, when it clears and its URL.
