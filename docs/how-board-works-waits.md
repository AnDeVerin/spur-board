# Turn waits

## Start a wait

Wait only on what the Board cannot see: a busy test stand, no free slot, high machine load,
someone else's deploy, an outside service you call. Not on your own work (review fixes, tests,
checks, rebasing): work holding the turn, so a stall reaches the operator; a wait hides it.
Not on what the Board watches (CI runs in any state, reviews, approvals, mergeability, merges):
submit the head and stop; red checks or other needs bring a new Dev turn.
If your next step needs it (you merge, or shadow mode), wait for it.

A submit needs no green checks. Running checks hold the task at the `checksGate` column's exit
(Dev by default); red checks, a cancelled run included, return it to Dev with a new turn. With
`checksGate` right of Dev, a cancelled run counts as running for about two GitHub poll intervals
first. Only the latest run of each check counts, so a rerun on the same head replaces a
cancelled run. When the PR has required checks, only those count, and the Board does not watch the
others. While GitHub computes mergeability, the task holds at Dev's exit; a conflict returns it to
Dev with a new turn.

To wait on a taken, open turn you hold, instead of sitting quiet:
`board wait <turn> --for <minutes> --reason <text> --key <key>` (MCP `task_wait`).

- `--for` is whole minutes, 1 to 120. `--reason` is up to 200 characters and not blank.
- Only the session that took the turn may wait on it, the operator after a takeover included.
  An untaken turn or one another session holds answers `not_turn_taker`; a closed turn or one of
  an earlier column visit `turn_closed`; an archived task `task_archived`.
- The answer is `{turn, wait: {reason, since, wakesAt}, waits}`; `waits` counts this turn's waits.
- A new wait on a waiting turn replaces it: the old one ends `closed` and its time counts.
- Starting a wait drops the turn's unsent quiet-turn reminder.

## While it waits

Until the wait ends the Board raises no quiet-turn reminder, no `stuck-turn:` item and no
`worker_idle` health item for the turn. A `stuck-turn:` item raised before the wait clears on the
next reconcile. `stuck_worker`, `needs_input`, turn-stall and ended-holder items still fire.

`worker_idle` also stays off for `health.idleInDevAfterMs` after the wait runs out (`woken` or
`limit`) or the operator ends it (`ended`), while you still hold the open turn. A take, a submit or a close grants no grace.

`board status`, `board task <task> --why`, `board inbox` and `task.get` show the active wait on
the turn as `wait: {reason, since, wakesAt}`; it is absent with no active wait.

## The wake

The first tick at or after `wakesAt` (ticks run every minute) ends the wait `woken` and rings you
once (an operator holder, or a worker whose task link the operator removed, is not rung; the
wait just ends):

`<KEY> turn T<n> wait ended: <reason>; check board inbox (N<id>-<ring>)`

The reason is the one you gave, on one line. The wake ring follows the normal doorbell rules: it
waits while you are busy or Spur is blind, ends silently with no live holder session and is
dropped when the turn closes or is taken. The quiet clock restarts at the wake, so the normal
reminder and then `stuck-turn:` follow if you stay quiet. If this take's reminder was already
delivered, no second reminder comes before the `stuck-turn:` item (one reminder per take).

## End a wait early

The operator can end the active wait on an open turn at once: `board wait <turn> --end --key <key>`
(MCP `task_wait` with `end: true`), or `End wait` on the task panel's wait strip.

- Pass `--end` alone: with `--for` or `--reason` the call answers `usage`, as does a call with
  none of the three.
- The holder or another session with a grant gets `not_operator`; a caller with no grant
  `forbidden`. A turn with no active wait answers `no_active_wait`, a closed turn or one of an
  earlier column visit `turn_closed`, an archived task `task_archived`. A refusal writes nothing.
- The answer is `{turn, waits}`. The wait ends `ended`, and the time it ran counts toward the
  turn's limits.

An agent holder is rung once, by the wake ring's rules:

`<KEY> turn T<n> wait ended by the operator: <reason>; check board inbox (N<id>-<ring>)`

No ring goes to the operator token, to an operator session that ends its own wait, to a worker
whose task link the operator removed or to a holder whose session ended. The quiet clock
restarts at the end, as after a wake.

## How a wait ends

| Outcome     | When                                                                                                                     |
| ----------- | ------------------------------------------------------------------------------------------------------------------------ |
| `woken`     | its time ran out; an agent holder is rung                                                                                |
| `limit`     | its time ran out and the turn's waits reached a limit; an agent holder is rung                                           |
| `ended`     | the operator ended it early; an agent holder is rung                                                                     |
| `submitted` | the holder submitted the turn                                                                                            |
| `closed`    | a return, move, correction, archive or other close; a take or takeover; a new wait; the holder's session ended (no ring) |

A new head on a turn that stays open does not end the wait. History lists `turn_wait_started`
and `turn_wait_ended`; a close that ends a wait lists the end before `turn_closed`.

## Limits

Waits are counted per turn over its whole life, and a take or a replacement keeps the count:

- `health.turnWait.maxWaits` (default 8): waits one turn may start.
- `health.turnWait.maxTotalMs` (default 7200000, two hours): total time the waits of one turn may
  last. A wait is cut to the time left, and ends `limit` when it uses it up.

Past either limit `board wait` answers `turn_wait_limit` and writes nothing: submit or return the
turn instead. The holder keeps the turn, and the operator gets one item:

<!-- prettier-ignore-start -->
| Kind | Condition | Action | Severity | Clears when | URL |
| --- | --- | --- | --- | --- | --- |
| `board_observation` `turn-wait:` | an open turn that is not waiting has used its waits; the text reads `<KEY>: turn T<n> has waited <total> for <reason>` | check the holder session, then close the item | attention | the turn closes or you close the item | stored target |
<!-- prettier-ignore-end -->

## Spur blind during a wait

While Spur is blind the Board holds a `stuck-turn:` item raised before the wait; it clears on the
first reconcile after Spur reports again. A wake ring due meanwhile waits for Spur too.
