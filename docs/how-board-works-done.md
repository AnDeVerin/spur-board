# Done follows the ticket

## Done follows the ticket

One linked PR merging does not by itself finish the task. Done: `projects[].tracker.doneStatuses` for Jira; for GitHub, the Issue must be
closed. A merged PR holds the task until the ticket is done; to continue the work, change the
ticket at the merge or after it (for example, move it back to in progress), then link another PR.
A merged PR with no stored merge time (facts from before the dispatcher) instead resumes work once
the ticket is seen open at or past the PR's last update plus the tracker interval.

A done ticket also finishes a task with no open linked PR and no live linked worker, even
without a merged PR. Every configured GitHub repository and Spur must have a complete, unblind
view; every repository and Spur must confirm the absence of in-flight work with a complete poll
started strictly after the Board accepts the task's latest work change. A delayed change
invalidates earlier confirmations even when its source poll began earlier. Unchanged complete
polls can supply renewed confirmation; a disappearing worker is a new change that needs it.
After ticket closure, the first fresh confirmation from every required source
finishes the task; this can take two ordinary full polling rounds, rather than one global
round. A pending submit still holds the task. Open conflict PR links count as work
in flight. The move reason is `ticket_done_no_pr`; an effective merged PR keeps reason `merged`.
Reopening a ticket finished without a PR returns the task to To Do.

## Done wrap-up

Entering Done opens one wrap-up turn (`done: wrap up`) for the live worker, or for the Done
column's orchestrator (`projects[].columns[].orchestrator`); none for an operator Done or when
neither a live worker nor a Done orchestrator is available. It closes like any turn (submit, the task leaving Done, archive), and
also when its holder session ends: that close shows `turn_closed` outcome `moved`, and the
holder's end raises no stall block on it. After an end, a live worker still linked to the task,
or the Done orchestrator, gets a new one.
