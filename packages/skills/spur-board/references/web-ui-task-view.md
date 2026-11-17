# Web UI: task view

The task view of the [web UI](web-ui.md) shows one task in a dialog over the columns; on a
narrow screen it fills the screen. It reads `task.get` with `why` for the open task,
`task.history` while the History tab shows, and, like the rest of the UI, only reads.

## Opening it

A click or Enter on a card opens it and sets the address to `?open=<task key>`. Opening that
address opens it too, with the full key (`?open=ex%2Frepo%237`) or a short one
(`?open=repo%237`). `?open=inbox` and `?open=services` open no task view.

A task entry in the inbox opens above the retained panel, even without configuration. Its project
is selected once configuration arrives. Back and Forward restore both layers.

## What it shows

- The header shows the short key (hover for the full key), then the column and the time since
  the task moved into it, such as `dev · 2h 9m`. Without such a move it shows the column alone.
  The `Now` and `History` tabs and Close sit at its right.
- `Now` starts with the ticket title. It comes from the task's card on the Board, so it reads as
  a placeholder until the status read answers, and a task with no card in the chosen project has
  no title line.
- Below the title come chips for the task's links: tickets, then pull requests, then sessions.
  A pull request or a GitHub issue ticket written `<owner>/<repo>#<n>` is a link that opens
  GitHub in a new tab. A session is a link to its Spur UI page,
  `<web.spurUiOrigin>/sessions/<session id>`, also in a new tab; when `web.spurUiOrigin` is not
  set it is plain text `session <id>`. A Jira ticket is plain text: the UI knows no Jira address.
- `History` lists the task's journal events, newest first; events at the same time keep the
  reverse of their journal order. Each row shows the time (UTC, `hh:mm dd/mm/yy`), the summary
  with who did it, and the raw event kind, such as `turn_taken`. An agent reads as its session;
  a write that came through the web UI or Slack adds its channel: `operator (web)`,
  `operator (slack)`. An event kind this version does not know still shows, with its raw kind.
  On a narrow screen the kind is hidden. A task with no events reads
  `No journal events for this task.`

## Why it is here

The section lists the exit conditions of the column the dispatcher works from (the shadow
column in shadow mode): each one met, failed with its reason, waiting with its reason, or not
checked. A column without exit conditions reads `No exit conditions in <column>`; when the
conditions are unknown (an unconfigured project, or missing pull request facts) the row reads
`Exit conditions unknown`.

Then come each hold, the open turn (its id, who executes it, who took it and how long ago), and
the open blocks. When every exit condition is met, or the column has none, a last row names the
next column: `When dev exit conditions pass → review`.

The section header sums up the failed and waiting conditions and the open blocks, or reads
`all pass` or `unknown`.

## States

- A key the daemon does not know, or a value that is not a task key such as `?open=509`, shows
  `Task not found.`
- A failed read shows an error banner, `Could not load the task.`, with **Retry**, above the
  data loaded before. While the UI is offline and the task was loaded, no banner shows in the
  dialog: the Board's offline banner says so, and the rows may be out of date.
- History reads `task.history` only while its tab shows. A failed read shows
  `Could not load the history.` with **Retry** above the rows loaded before, with the same
  offline rule. A task the daemon no longer knows shows `Task not found.`
- The task view rereads the task when the stream names it, and whenever the UI rereads
  everything: a `reset`, the 30-second status frame, a changed journal head or daemon instance,
  and **Retry now**. While History shows, it rereads the history at the same moments.

## Closing it

Escape, a click outside the dialog or Close closes the task view. For a task opened from a card
or directly from its address, closing removes `open`, keeping the other parameters. Focus
returns to the card that opened it; after opening from the address, to the card of that task
when the columns show it.

For a task opened from the inbox, closing returns to `?open=inbox` and keeps the panel and its
filter open. Focus returns to the inbox row that opened the task, or to the panel's Close
button if that row has disappeared. A second Escape closes the inbox and focuses its header
button. Closing adds a history entry, so Back opens the task again.
