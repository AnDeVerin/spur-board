# Done follows the ticket

## Done follows the ticket

One linked PR merging does not by itself finish the task. Done: `projects[].tracker.doneStatuses` for Jira; for GitHub, the Issue must be
closed. If still open, link another PR.

A done ticket also finishes a task with no open linked PR and no live linked worker, even
without a merged PR. Every configured GitHub repository and Spur must have a complete, unblind
view; each repository's confirming poll must start strictly after the task's latest change. An
unchanged complete poll can supply that confirmation. A pending submit still holds the task. Open conflict PR links count as work
in flight. The move reason is `ticket_done_no_pr`; an effective merged PR keeps reason `merged`.
Reopening a ticket finished without a PR returns the task to To Do.

## Done wrap-up

Entering Done opens one wrap-up turn (`done: wrap up`) for the live worker, or for the Done
column's orchestrator (`projects[].columns[].orchestrator`); none for an operator Done or when
neither a live worker nor a Done orchestrator is available. It closes like any turn (submit, the task leaving Done, archive), and
also when its holder session ends: that close shows `turn_closed` outcome `moved`, and the
holder's end raises no stall block on it. After an end, a live worker still linked to the task,
or the Done orchestrator, gets a new one.
