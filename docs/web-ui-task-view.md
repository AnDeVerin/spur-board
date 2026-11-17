# Web UI: task view

The task view of the [web UI](web-ui.md) shows one task in a dialog over the columns; on a
narrow screen it fills the screen. It reads `task.get` with `why` for the open task and, like
the rest of the UI, refreshes from the event stream. It also offers the two writes below.

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
  set it is plain text `session <id>`. A Jira ticket is plain text: the UI knows no Jira address.
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

## Blocks and comments

**Blocks** shows the total and the number open, with open blocks first. Each item names its
author, addressee, age and reason, its resolution and question-answer channel when known, and
its latest associated reply. Completed code blocks retain their completion reference.
Agent names use configured Spur project display names, with project and
session identifiers as fallbacks; the operator reads as `you`. Empty blocks read
`No blocks on this task.`

Only an open question (`needs_input`) addressed to the operator has an answer form. **Send answer** calls
`block.answer`. **Comments** lists task comments with their authors, ids and ages, excluding
block replies. Its composer stays available with count zero. **Add comment** calls
`comment.add` for the task. Follow-up, answering agent blocks, and editing or deleting comments
remain outside this view.

Both forms retain exact text on failure and announce the error. Blank or whitespace-only text
and text longer than 20,000 characters are rejected locally. Sending guards against duplicate
clicks. Retrying unchanged text after an uncertain failure reuses its intent key; editing it
creates a new intent. Drafts remain while the daemon or live updates are unavailable; fields
and send actions are disabled with a reason until recovery. A short reconnect keeps them usable.

After success the view rereads authoritative task data. While that read runs it says
`Answer sent. Refreshing task…` or `Comment added. Refreshing task…`. If the read fails, the
success remains confirmed and **Refresh task** retries only the read. It cannot resend that
successful intent. Text edited during a send survives completion of the earlier revision.
Closing the dialog does not persist drafts.

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
