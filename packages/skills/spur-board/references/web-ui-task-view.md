# Web UI: task view

The task view of the [web UI](web-ui.md) shows one task in a dialog over the columns; on a
narrow screen it fills the screen. It reads `task.get` with `why` and `detail`.

## Opening it

A click or Enter on a card opens it and sets the address to `?open=<task key>`. Opening that
address opens it too, with the full key (`?open=ex%2Frepo%237`) or a short one
(`?open=repo%237`). `?open=inbox` and `?open=services` open no task view.

A task entry in the inbox opens above the retained panel, even without configuration. Its project
is selected once configuration arrives. Back and Forward restore both layers.

## What it shows

- The header reads `#7 · DEV · 2h 9m`: short key (hover for full key), uppercase column with
  the active Now tab's weight and colour, then lowercase time since the task entered its
  column, from its card's status row: shadow moves and shadow corrections do not count, and a
  task that never moved counts from when it was added. Like the card, it counts to the last good
  status read. A task with no card in the chosen project, or a card
  in another column, omits the time; no task data shows only the key.
  Now/History tabs and Close sit at its right.
- `Now` starts with the ticket title from the task's card: a placeholder until the status read
  answers, none without a card in the chosen project.
- Below the title come chips for the task's links: tickets, then pull requests, then sessions.
  They reuse the card's bordered PR status cells with ticket, PR and terminal icons. Soft fills
  and icon colours follow link kind: violet for tickets, green for PRs and blue for sessions,
  with neutral text and borders, including links without a destination. A PR link stays green whatever
  its checks or status. The current
  ticket uses its held card's Jira browse URL or safe observed URL, even without a browse base
  or task link; unsafe/missing destinations stay plain, outside Tab order.
  Long labels truncate with full accessible text and hover titles. Links use
  the focus ring; text brightens on hover, focus within and touch.
  Pull requests written `<owner>/<repo>#<n>` open GitHub. Sessions open
  `<web.spurUiOrigin>/sessions/<session id>`; without that origin they stay plain.
  Extra tickets, and the current ticket without a matching held card, use these ref rules:
  `<owner>/<repo>#<n>` opens GitHub; a Jira key such as `PROJ-12` uses the project's
  `ticketBrowseBase` only when its prefix before `-<number>` matches the task's, ignoring case.
  Other ticket refs, Jira keys from another project, or Jira keys without a browse base stay plain.
  All links open new tabs.
- A Backlog task, unless archived, shows `Move to` [part buttons](web-ui-board-move.md).
- A taken open turn's active wait, unless it is an operator turn you hold, adds an amber strip
  under the chips: `waiting: <reason> · wakes <hh:mm>` (UTC), then `(in 20m)`/`(now)`. Unlike
  the card, it shows during a stall too. Long reasons wrap; hidden while the Turn section re-reads.
  On an agent's turn, `End wait` ends it at once ([waits](how-board-works-waits.md)).
- `History` lists the task's journal events, newest first by event time; events at the same
  time keep the reverse of their journal order. Each row shows the time (UTC, `hh:mm dd/mm/yy`),
  the summary of what changed with who did it, and the raw event kind, such as `turn_taken`. An agent reads as its session;
  a write adds its channel: `operator (web)`, `operator (slack)`, `operator (cli)`,
  `operator (mcp)`; `cli` and `mcp` are what the client reported. An event kind
  this version does not know still shows, with its raw kind. A facts event that changed only
  an update or activity time, or only what another row already says, is not shown; a long summary wraps.
  Adjacent events with the same raw kind, actor, channel and summary fold when there are three
  or more: the newest row shows `+N` hidden rows and `since` the oldest event's UTC time, adding
  the date across UTC days. Select `+N` to show every row with a shared rail and faint fill;
  `N rows` folds the run again. Pairs stay separate. An expanded run stays open when a newer
  matching event arrives, and a focused run control keeps focus. The controls only change the view.
  On a narrow screen the kind is hidden. A task with no events reads
  `No journal events for this task.`

## Why it is here

The section lists the exit conditions of the column the dispatcher works from (the shadow
column in shadow mode): each one met, failed or waiting with its reason, or not checked. A column without exit conditions reads `No exit conditions in <column>`; when the
conditions are unknown (an unconfigured project, or missing pull request facts) the row reads
`Exit conditions unknown`.

Then come each hold, the open turn (its id, who executes it, who took it and how long ago), and
the open blocks. When every exit condition is met, or the column has none, a last row names the
next column: `When dev exit conditions pass → review`.
From a Todo-group column the row names the first enabled
column right of the group: the task moves there once work starts, with an open PR or a live
worker.

The section header sums up the failed and waiting conditions and the open blocks, or reads
`all pass` or `unknown`.

An open orchestrator or operator turn has a **Turn** section ([Turn](web-ui-task-turn.md)), then an
open PR with approvals an **Approvals** section ([Approvals](web-ui-task-approvals.md)).

## Latest submission

Before Blocks, the **Latest submission** section shows the latest accepted submission. It starts
closed; its header reads the basis, then ` · pending` and ` · voided` when they hold
(`tested · pending`), or `No submissions yet`. Open, it lists the column, UTC time, full
submitted SHA, declared basis, applicable source and original tested SHA, literal reason, and
pending and voided state. `tested` records provenance and does not mean checks passed; the latest
row includes pending or voided submissions. An older server without this field omits the
section. Long SHAs and reasons wrap in Now and History. Normal submission history also shows
basis, source, tested origin and reason while preserving head-confirmation wording; legacy
submissions read as tested.

## Remembered sections

Each section of Now keeps its open or closed state in this browser, for every task and project
and after a reload. Without browser storage the defaults apply: all open except Latest
submission.

## Blocks and comments

**Blocks**, **Comments** and their three writes (answer, follow up, comment):
[blocks and comments](web-ui-task-blocks.md).

## States

- A key the daemon does not know, or a value that is not a task key such as `?open=509`, shows
  `Task not found.`
- A failed read shows an error banner, `Could not load the task.`, with **Retry**, above the
  data loaded before. Offline with the task loaded, the dialog shows no banner: the Board's
  offline banner says so, and the rows may be out of date.
- History reads `task.history` only while its tab shows. A failed read shows
  `Could not load the history.` with **Retry** above the rows loaded before, with the same
  offline rule. A task the daemon no longer knows shows `Task not found.`
- It rereads the task when the stream names it and whenever the UI rereads everything: a
  `reset`, the 30-second status frame, a changed journal head or daemon instance, and
  **Retry now**. A shown History rereads at the same moments.

## Closing it

Escape, a click outside the dialog or Close closes the task view. For a task opened from a card
or directly from its address, closing removes `open`, keeping the other parameters. Focus
returns to the card that opened it; after opening from the address, to the card of that task
when the columns show it.

For a task opened from the inbox, closing returns to `?open=inbox` and keeps the panel and its
filter open. Focus returns to the inbox row that opened the task, or, if that row is gone, to
the panel's Close button. A second Escape closes the inbox and focuses its header
button. Closing adds a history entry, so Back opens the task again.
