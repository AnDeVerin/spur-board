# Web UI: task turn

The **Turn** section of the [task view](web-ui-task-view.md) shows the task's open orchestrator
turn and lets the operator close it: submit the work or return it to Dev. Use it when the
orchestrator is down or the verdict comes from elsewhere. Worker, curator and operator turns get
no Turn section; the section sits after **Why it is here**.

## What it shows

- A line per turn: a status light, the turn id, its column, the column executor from
  configuration, then `taken by <name> · <age>` or `not taken · <age>`. Agent names use the
  configured Spur project display name, as in Blocks; the operator reads as `you`.
- While the operator holds the turn: `You hold T<n>; the orchestrator cannot submit or return it
until you finish or it takes the turn back.`
- A note that you can close the turn yourself, then **Submit…**, and **Return to dev…** for a
  column that can return (`review`, `product-review`, `external-review`, `qa`,
  `ready-to-merge`).

## Submit

**Submit…** opens a form, focused on **Commit**. Commit starts as the head SHA of the task's only
open pull request in the chosen project's Board. Without one, for example for a task of another
project, it starts as the head the turn opened on, which may be stale; the field stays editable
and the Board refuses a head that is not the pull request's (`head_mismatch`). Enter a full lowercase SHA, 40 to 64
characters: surrounding spaces are trimmed, upper case is refused.

**Basis** is a tab row: **Tested**, **Carried** or **Skipped**.

- Tested needs nothing more.
- Carried needs **Carried from**, the commit of this task whose tested submit the work comes
  from, and a **Reason**.
- Skipped needs a **Reason**.

A reason must hold text other than spaces and is at most 2000 characters. The request carries
`from` only for carried and `reason` only for carried and skipped.

The button reads **Submit**; there is no confirm dialog. A submit closes the turn and the Board
re-evaluates every gate of the task. The line above the button starts
`This closes T<n> in your name and the board re-evaluates the task's gates.`, then says where
the task goes if they hold: `the task moves to <next>`, the enabled column after the turn's
column. A passing gate never moves a task into Done, only a merged pull request or a done ticket
completes it, so when the next column is Done or there is none it says the task stays in its
column until it completes. When any gate has an unmet exit condition other than the submit or
review on the head, it adds that the task may wait, or move back to a column whose gate fails. A
Done wrap-up turn says the task stays in done. The line ends `It cannot be undone.`

## Return

**Return to dev…** opens a form, focused on **Reason**: required, at most 20000 characters; the
worker gets it as a `code` block. The line above **Return to dev** says `This closes T<n> in your
name and returns the task to dev. It cannot be undone, and it counts toward the cycle limit.`
**Cancel** closes either form, sends nothing and returns focus to the button that opened it.

## Take, then close

Pressing the button first checks the fields: a missing or wrong field shows its error and nothing
is sent. Then the section takes the turn with `inbox.ack` and closes it with `task.submit` or
`task.return`. Each request carries its own idempotency key; the web listener refuses these three
writes without one (`usage`). When the task read already shows the operator holding the turn, the
ack is skipped.

While a request runs, the button reads `Taking the turn`, then `Closing the turn`, and a status
line says the same. The fields, the tabs, Cancel and the turn's buttons wait until it ends.

Once the ack has landed the operator holds the turn: the orchestrator's own submit or return then
gets `not_turn_taker`. It takes the turn back with `board inbox ack <entries>` with the turn ID.

## Refusals

A refused write shows the Board's message in an error banner between the fields and the line
above the button; the fields keep their text. The banner stays while you edit and clears on the
next send and on Cancel. An unchanged resend uses the same keys, so a write that landed is never
applied twice; an edited one is a new write with a new key. After `not_turn_taker` the next send
takes the turn again with a new key. A refusal after the ack leaves the operator holding the turn,
and the hold line says so.

## Closed elsewhere

A form stays bound to the turn it opened on: its requests only ever name that turn. When that
turn closes elsewhere while the form is open, or a write answers `turn_closed`, or the ack answers
`not_found`, the section re-reads the task and shows a notice. For a submit or a return it reads
`T<n> was closed by <name>`: the taker closed it. A submit adds its age, with its basis and short
SHA when the task's latest submission is the one that closed the turn (same column, same time);
a return adds its age. Other closes name no closer, only the outcome:
`T<n> was closed: the task was moved`, `the column was corrected`, `the turn went to another
executor`, `the dispatcher mode changed` or `the task was archived`.

The bound turn's buttons and the send button are disabled; **Cancel** still closes the form and
the notice stays until the view closes or you open a form on a newer turn. When the same read
shows a new orchestrator turn, it appears below with its own buttons, usable once no form of the
closed turn is open. Cancel there moves focus to the new turn's first button, or without one to
the notice.

## Your own close

After a close the section keeps a focused status line, `T<n> submitted.` or `T<n> returned to
dev.`, even when the task then has no open turn. A submit the Board still has to confirm adds
`The board confirms the head on its next polls.`, until a read shows that submission confirmed.
A voided one says the Board voided it: it no longer counts for the gates, so the work needs
another submit. A turn the same write opened shows below.

A Board update waits to reload the page while the ack and the close run, even when the task view
closes first, so it never leaves the operator holding a turn mid-close. An unsent reason survives
that reload and comes back only in the same form of the same turn.

## Unavailable and archived

While the daemon or live updates are unavailable, the buttons are disabled and the section says
`The turn cannot be closed while the board is unavailable.` An archived task reads `This task is
archived. The turn cannot be closed.` Focus on a control that becomes disabled moves to Cancel,
or to the busy button while a request runs.

## Folded

The section folds like the others; folding keeps the form, its text and its keys. The header sums
up the turn: `T<n> · not taken`, `T<n> · taken by <name>` or `T<n> · you hold it`; `Closing
T<n>…` while a request runs; `T<n> · refused, you hold it` after a refusal once the turn is held,
else `T<n> · refused`; `T<n> submitted` or `T<n> returned` after your close; `T<n> closed by
<name>` or `T<n> closed: <outcome>` after a close elsewhere. In the header, both `taken by <name>` and `closed by <name>` name the
session alone, cut to 16 characters, so the section title keeps its room; the turn line and the
notice show the full name. A newer open turn is added after a `;`. A close while the section is folded does not move focus.
