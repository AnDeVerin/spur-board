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

An agent holding the current open non-Done turn raises `worker_ended` when it ends, whatever its
PRs (see the [inbox](how-board-works-inbox.md)). Without a turn, a worker that completed with its
ticket not done, no live worker and no open PR raises `anomaly` once a complete Spur poll and
complete PR polls follow its end, and a killed worker without a PR whose ticket is not done raises
`worker_ended`; each comes with its `health:` item. A merged PR suppresses these two while the
ticket is not done, unless one of these holds:

- the ticket changed in any way (status, label, comment) at or after the newest eligible merge
  while in the tracker filter or manually included; when no merged PR has a stored merge time, it
  was seen open at or past the judged PR's last update plus the tracker interval;
- a linked PR closed unmerged at or after the newest merge opened its closed-without-merge block,
  once complete PR polls follow the close and the ticket is seen not done one tracker interval
  after the newest merge.

A merged PR linked as a conflict never counts. The alert text says
`PR <repo>#<n> merged, ticket reopened` after such a ticket change (not when no merged PR has a
stored merge time), else `no PR`.

## Done wrap-up

Entering Done opens one wrap-up turn (`done: wrap up`) for the live worker, or for the Done
column's orchestrator (`projects[].columns[].orchestrator`); none for an operator Done or when
neither a live worker nor a Done orchestrator is available. It closes like any turn (submit, the task leaving Done, archive), and
also when its holder session ends: that close shows `turn_closed` outcome `moved`, and the
holder's end raises no stall block on it. After an end, a live worker still linked to the task,
or the Done orchestrator, gets a new one.
