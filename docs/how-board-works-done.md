# Done follows the ticket

## Done follows the ticket

One linked PR merging does not by itself finish the task. Done: `projects[].tracker.doneStatuses` for Jira; for GitHub, the Issue must be
closed. If still open, link another PR.

## Done wrap-up

Entering Done opens one wrap-up turn (`done: wrap up`) for the live worker, or for the Done
column's orchestrator (`projects[].columns[].orchestrator`); none for an operator Done or when no
live worker is seen. It closes like any turn (submit, the task leaving Done, archive), and
also when its holder session ends: that close shows `turn_closed` outcome `moved`, and the
holder's end raises no stall block on it. After an end, a live worker still linked to the task,
or the Done orchestrator, gets a new one.
