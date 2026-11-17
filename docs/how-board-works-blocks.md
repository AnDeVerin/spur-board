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

<!-- prettier-ignore-start -->
| Kind | Condition | Action | Severity | Clears when |
| --- | --- | --- | --- | --- |
| `token_request` | an agent asks for a token | approve or deny it in Slack within 15 minutes of the request | attention | approved, denied, expired or revoked |
| `post_blocked` | a text looked like a secret and was not sent | close the item once you have read it | attention | its block closes or you close the item |
| `post_failed` | a chat delivery failed | check the chat gateway, then retry the item | failure | you retry or close the item |
| `transport_health` | a chat connection is down | check the Slack app tokens | failure | the connection is back |
| `answer_undelivered` | an answer did not reach the asking session | check the asking session, then retry the item | failure | you retry the item, the session reads it or its block or turn closes |
| `worker_not_reading` | the worker does not read its doorbell | check the worker session, then retry the item | failure | you retry the item, the worker reads it or its block or turn closes |
| `answer_author_unavailable` | no live session can take an answer | with a task: comment on the task so a live session reads the answer, then close the item; without: pass the answer to the asking session yourself, then close the item | attention | you close the item |
| `inbound_failure` | a chat message could not be applied | check the daemon log, then retry the item | failure | a retry applies it or you close the item |
| `inbound_gap` | chat messages may be missing | check the conversation for missed messages | failure | you close the item |
| `board_observation` | any other key | check the task, then close the item | attention | the condition ends or you close the item |
| `board_observation` `source:` | a source is blind | check the token, settings, daemon or source it names | failure | the source reads again |
| `board_observation` `pr-outcome:` | a linked PR closed unmerged or vanished | check the pull request, then close the item or archive the task | attention | the PR is seen again or you close the item; unlinking does not clear it |
| `board_observation` `lookup:` | the ticket lookup failed | check the ticket in the tracker, then close the item or archive the task | attention | a lookup succeeds or you close the item |
| `board_observation` `operator-block:` | a block waits for you | not listed: shown as its block | attention | the block closes |
| `board_observation` `block:` | a block waits for its addressee | answer `B<n>` if it is a question, or close it with a reason; listed only when the block is not addressed to you; otherwise shown as its block | attention | the block closes |
| `board_observation` `filter:` | the ticket left the tracker filter but work is live | return the ticket to the tracker filter, or finish or unlink the linked work (`board unlink <task> --pr <pr> --reason <reason>`) | attention | the ticket is back in the filter or no linked open PR or live session is left |
| `board_observation` `health:` | a session health flag | check session `<session>` in Spur; a vanished worker: start a new worker for the task, or archive the task | attention | the flag ends |
| `worker_ended` | the task's worker session was killed | start a new worker for the task, or archive the task | attention | the flag ends |
| `turn` | a turn is yours | listed as its `T…` entry | attention | the turn closes |
| `anomaly` | a session or turn of the task is stuck, done or lost | wait for the answer to `B<n>`, or answer it yourself; listed only when addressed to the curator; otherwise shown as its block | attention | the condition ends or its block closes |
| `cycle_limit` | the task reached its column's cycle limit | not listed: shown as its block | attention | its block closes |
| `course_check` | the task keeps returning from a column | wait for the answer to `B<n>`, or answer it yourself; listed only when addressed to the curator or orchestrator; otherwise shown as its block | attention | its block closes |
| `conversation_waiting` | your conversation waits for a live session | start a session in its Spur project, or close `B<n>` with a reason | attention | a session starts or the block closes |
<!-- prettier-ignore-end -->
