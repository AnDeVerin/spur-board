# Done follows the ticket

## Done follows the ticket

One linked PR merging does not by itself finish the task. Done: `projects[].tracker.doneStatuses` for Jira; for GitHub, the Issue must be
closed. A merged PR holds the task until the ticket is done; to continue the work, change the
ticket, in the tracker filter or manually included, at or after the newest eligible merge (for
example, move it back to in progress), then link another PR. When no merged PR of the task has a
stored merge time (facts from before the dispatcher), work instead resumes once the ticket, in the
tracker filter or manually included, is seen open at or past the judged PR's last update plus the
tracker interval.

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

## Merged PR alerts

An agent holding the current open non-Done turn raises an `ended-turn:` item (`worker_ended`) when
it ends, whatever its PRs; it has no `health:` item (see the [inbox](how-board-works-inbox.md)).
Without a turn, a worker that completed, was killed or vanished raises its `health:` item
(`anomaly`, `worker_ended` or `board_observation`) while the ticket is not done, no worker is live
and no open or counting merged PR is linked, once a complete Spur poll and complete PR polls follow
its end. A merged PR counts, and so suppresses these items, while the ticket is not done, unless one
of these holds:

- the ticket changed in any way (status, label, comment) at or after the newest eligible merge
  while in the tracker filter or manually included; when no merged PR has a stored merge time, it
  was seen open at or past the judged PR's last update plus the tracker interval;
- a linked PR closed unmerged at or after the newest merge opened its closed-without-merge block,
  once complete PR polls follow the close and the ticket, in the tracker filter or manually
  included, is seen not done one tracker interval after the newest merge. After a merge, that
  block itself waits for the same sighting, so a ticket the merge edits and closes within the
  interval raises nothing.

A merged PR linked as a conflict counts here like an active one, unless an active link of the
task merged too: then only the active merges count for the ticket change, as for the dispatcher.
The newest merge of the closed-without-merge block and its interval is always that of any link
kind, so a conflict merge after an active one supersedes the closes before it. The alert text says
`PR <repo>#<n> merged, ticket reopened` after such a ticket change (not when no merged PR has a
stored merge time), else `no PR`.

## Done wrap-up

Entering Done opens one wrap-up turn (`done: wrap up`) for the live worker, or for the Done
column's orchestrator (`projects[].columns[].orchestrator`); none for an operator Done or when
neither a live worker nor a Done orchestrator is available. It closes like any turn (submit, the task leaving Done, archive), and
also when its holder session ends: that close shows `turn_closed` outcome `moved`, and the
holder's end raises no stall block on it. After an end, a live worker still linked to the task,
or the Done orchestrator, gets a new one.
