# Web UI: task view

The task view of the [web UI](web-ui.md) shows one task in a dialog over the columns; on a
narrow screen it fills the screen. It reads `task.get` with `why` for the open task, `task.history` while History shows and, like
the rest of the UI, refreshes from the event stream. It also offers the three writes below.

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
  set it is plain text `session <id>`. A Jira-shaped ticket key such as `PROJ-12` links to
  `<tracker baseUrl>/browse/<key>` of the open task's project, in a new tab, when it belongs to
  that task's Jira project: its prefix before `-<number>` matches the task key's, in any case. A
  key from another Jira project may live on another Jira site, so it is plain text. A Jira key is
  plain text too when the project has no `ticketBrowseBase` in `config.get`, as a GitHub Issues
  project; any other ticket ref is plain text too.
- `History` lists the task's journal events, newest first; events at the same time keep the
  reverse of their journal order. Each row shows the time (UTC, `hh:mm dd/mm/yy`), the summary
  with who did it, and the raw event kind, such as `turn_taken`. An agent reads as its session;
  a write adds its channel: `operator (web)`, `operator (slack)`, `operator (cli)`,
  `operator (mcp)`; `cli` and `mcp` are what the client reported. An event kind
  this version does not know still shows, with its raw kind.
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

## Blocks and comments

**Blocks** shows the total and the number open, with open blocks first. Each item names its
author, addressee, age and reason, its resolution and question-answer channel when known, and
its replies, oldest first. Completed code blocks retain their completion reference.
Agent names use configured Spur project display names, with project and
session identifiers as fallbacks; the operator reads as `you`. Empty blocks read
`No blocks on this task.`

Only an open question (`needs_input`) addressed to the operator has an answer form. **Send answer** calls
`block.answer`. An answered question shows **Follow up**. It opens the same field,
`Follow-up on B<n>`, with **Send follow-up**, which calls `block.followup`, and an icon
**Cancel** that closes it and sends nothing. A sent follow-up closes the field and shows as the
block's next reply. Cancel after a failed send keeps the text and its key. **Comments** lists
task comments with their authors, ids and ages, excluding block replies. Its composer stays
available with count zero. **Add comment** calls `comment.add` for the task. Answering agent
blocks, and editing or deleting comments remain outside this view.

The forms retain exact text on failure and announce the error. Blank or whitespace-only text
and text longer than 20,000 characters are rejected locally. Sending guards against duplicate
clicks. Retrying unchanged text after an uncertain failure reuses its intent key; editing it
creates a new intent. Drafts remain while the daemon or live updates are unavailable; fields
and send actions are disabled with a reason until recovery. A short reconnect keeps them usable.

After success the view rereads authoritative task data. While that read runs it says
`Answer sent. Refreshing task…`, `Follow-up sent. Refreshing task…` or
`Comment added. Refreshing task…`. If the read fails, the
success remains confirmed and **Refresh task** retries only the read. It cannot resend that
successful intent. Text edited during a send survives completion of the earlier revision.
Closing the dialog does not persist drafts.

If a question closes, is withdrawn or is reassigned while you type, a newer unsent revision
stays visible as selectable **Unsent answer draft** text. It is read-only: it offers no send. An unchanged confirmed submission clears after canonical
reconciliation. Pending and uncertain intent state survives eligibility changes and History
navigation; only the submitted revision may be cleared by its completion.
Pending or uncertain submitted text is labelled **Answer draft (unconfirmed)**, so it can be
copied without implying that the write failed or offering another send on a closed block.

Archived tasks show `This task is archived. Answers and comments cannot be sent.` The fields
and send actions are disabled, preserving pending, failed and newer drafts. Reactivating the
task enables still-eligible forms again. History and read-only **Refresh task** recovery for an already
confirmed write remain available while archived.

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
