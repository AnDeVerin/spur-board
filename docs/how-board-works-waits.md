# Turn waits

## Start a wait

Wait only on a condition you cannot change and must re-check: a busy test stand, no free slot,
high machine load, a deploy, an outside service. Not on your own work (review fixes, tests,
checks, rebasing): work holding the turn, so a stall reaches the operator; a wait hides it.

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
`limit`), while you still hold the open turn. A take, a submit or a close grants no grace.

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

## How a wait ends

| Outcome     | When                                                                                                                     |
| ----------- | ------------------------------------------------------------------------------------------------------------------------ |
| `woken`     | its time ran out; an agent holder is rung                                                                                |
| `limit`     | its time ran out and the turn's waits reached a limit; an agent holder is rung                                           |
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
