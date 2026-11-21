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
- While the holder waits: `waiting: <reason>, wakes <hh:mm>` (UTC).
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

The button reads **Submit**; there is no confirm dialog. The line above it says
`This closes T<n> in your name and hands the task to the board's gates for <column>.`, then
`Next column: <next>.` when the column has an enabled column after it, and ends
`It cannot be undone.` It names the next column only as a fact of the configuration: the Board's
gates decide where the task goes.

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
and the read that follows shows it in the hold line and the header. A take, submit or return
whose answer was lost, or did not come in 15 seconds, may have landed: Cancel works at once, and
a resend asks again under the same key, so it is safe. A submit or return without an answer keeps
its form as sent, read-only, with
`The earlier send may still land; send it again to settle it, or Cancel.`: the send resends that
input until it gets an answer, and Cancel drops it. Until the read after a take, submit or
return answers, the section names no holder (**Why it is here** reads `holder unknown` too), and
**Submit…**, **Return to dev…** and the form's send stay locked; it shows, under a turn that
write closed too, `Refreshing the turn…` while that read runs and
`Could not refresh the turn. Reload to see who holds it.` when it fails or has not answered in 15
seconds. Cancel on an open turn focuses that line; when the line goes, focus moves to the first
enabled button. After a failure, press **Retry** when the task's error banner offers it: it reads the
task again and keeps an open form. Otherwise reload the page. The line after your own close
keeps the column from the write's answer then.

## Closed elsewhere

A form stays bound to the turn it opened on: its requests only ever name that turn. When that
turn closes elsewhere while the form is open, or a write answers `turn_closed`, or the ack answers
`not_found`, the section re-reads the task and shows a notice. For a submit or a return it reads
`T<n> was closed by <name>`: the taker closed it, and the notice adds how long ago. Other closes name no closer, only the outcome:
`T<n> was closed: the task was moved`, `the column was corrected`, `the turn went to another
executor`, `the dispatcher mode changed` or `the task was archived`.

The bound turn's buttons and the send button are disabled; **Cancel** still closes the form and
the notice stays until the view closes or you open a form on a newer turn. When the same read
shows a new orchestrator turn, it appears below with its own buttons, usable once no form of the
closed turn is open. Cancel there moves focus to the new turn's first button, or without one to
the notice.

## Your own close

After a close the section keeps a focused status line, `T<n> submitted.` or
`T<n> returned to dev.`, then `The task is in <column>.`: the column of the latest task read once
that read shows the turn closed, else the column in the write's answer. It stays even when the task then has no
open turn. A turn the same write opened shows below.

Keys are reused only within the open form. A reload, one after a Board update included, closes the form and
drops its text, and does not wait for a Turn send; one that lands after the ack leaves the operator
holding the turn. The next form takes new keys. Sending from it is safe: the operator may take a
turn it already holds again, and a second close of a closed turn answers `turn_closed`.

## Unavailable and archived

While the daemon or live updates are unavailable, the buttons are disabled and the section says
`The turn cannot be closed while the board is unavailable.` An archived task reads `This task is
archived. The turn cannot be closed.` Focus on a control that becomes disabled moves to Cancel,
or to the busy button while a request runs.

## Folded

The section folds like the others and the browser remembers it ([task view](web-ui-task-view.md));
folding keeps the form, its text and its keys. The header sums
up the turn: `T<n> · not taken`, `T<n> · taken by <name>` or `T<n> · you hold it`; `Closing
T<n>…` while a request runs; `T<n> · refused, you hold it` after a refusal once the turn is held,
else `T<n> · refused`; `T<n> submitted` or `T<n> returned` after your close; `T<n> closed by
<name>` or `T<n> closed: <outcome>` after a close elsewhere. In the header, both `taken by <name>` and `closed by <name>` name the
session alone, cut to 16 characters, so the section title keeps its room; the turn line and the
notice show the full name. A newer open turn is added after a `;`. A close while the section is folded does not move focus.
