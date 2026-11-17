# Web UI: task view

The task view of the [web UI](web-ui.md) shows one task in a dialog over the columns; on a
narrow screen it fills the screen. It reads `task.get` with `why` for the open task and, like
the rest of the UI, only reads.

## Opening it

A click or Enter on a card opens it and sets the address to `?open=<task key>`. Opening that
address opens it too, with the full key (`?open=ex%2Frepo%237`) or a short one
(`?open=repo%237`). `?open=inbox` and `?open=services` open no task view.

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
  set it is plain text `session <id>`. A Jira-shaped ticket key such as `PROJ-12` links to
  `<tracker baseUrl>/browse/<key>` of the open task's project, in a new tab. It is plain text when
  the project has no `ticketBrowseBase` in `config.get`, as a GitHub Issues project; any other
  ticket ref is plain text too.
- `History` says that history arrives in a later version.

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
- The task view rereads the task when the stream names it, and whenever the UI rereads
  everything: a `reset`, the 30-second status frame, a changed journal head or daemon instance,
  and **Retry now**.

## Closing it

Escape, a click outside the dialog or Close closes it and removes `open` from the address,
keeping the other parameters. Focus returns to the card that opened it; after opening from the
address, to the card of that task when the columns show it. Close adds a history entry, so Back
opens the task again.
