# Web UI: board

The Board screen of the [web UI](web-ui.md): the header, the inbox, the task columns and the
Backlog group.

## What it shows

Header, left to right:

- The logo.
- The project switcher lists `<id> · dispatcher <mode>`, checking the current project. Escape or
  an outside click closes it. The browser remembers the choice, falling back to the first project
  if removed. Long ids end in `…`.
- Dispatcher mode: `dispatcher on` or `dispatcher shadow`.
- The filter matches full/short keys (`#12`), session or block ids, ignoring case. Misses dim,
  remain visible and accept Tab; Clear resets the filter.
- The live indicator: `connecting` until the stream answers, then `live`, `reconnecting` or
  `offline`.
- The inbox button highlights nonzero active counts; `–` means no successful read yet. It opens
  the right panel at `?open=inbox`, also available directly. All/configured project/system filters
  apply to active and handled entries; counts include only active entries. Failures precede
  attention, newest first within severity. Handled entries retain query order, marked handled
  with their answer channel when supplied. Supplied actions appear separately; an exact terminal
  `: <action>` is removed from the description. A column orchestrator with no live session reads
  `No session to ring for <column>`, its Spur project, the turns waiting, the oldest one's `T<n>`
  and age, and how long it has had no live session, then its action and
  `It clears itself when a session appears.`; it opens the oldest waiting turn's task and moves to
  handled once it is cleared, reading `Had no session to ring for <column>` and saying in the past
  tense that its Spur project had no live session, with the oldest turn's `T<n>` and no action. A
  re-raise for the same column replaces it, and the earlier item is not listed. Text it cannot read
  keeps the plain row, which also drops the action once handled. Before the first success, the panel
  says inbox data is unavailable; later failures retain data. Task rows open above the retained
  panel and select their project when config arrives. Task close focuses its row or panel Close if
  removed; panel close focuses the header inbox button. Back/Forward follow these layers. Task-less
  rows with a known HTTP(S) destination open it in a new tab on click or Enter, retaining the inbox.
  This applies to active and handled entries. Task navigation takes precedence even when a URL is
  supplied. Rows without a safe destination remain focusable. Each active item entry (`I<n>`) has a
  quiet `Close I<n>` below its row that sends one `item.close`, as Slack's Close does: a ledger
  item's block closes with it and a failed post stays unsent. Blocks, turns and handled entries have
  none. It reads `Closing I<n>` while sent, then `Closed I<n>, waiting for the board.` until the
  re-read moves the entry to handled; focus then goes to the next row, else the previous one, else
  panel Close. A failure keeps the entry with `Could not close I<n>: <message>`: the daemon's
  problem message, `the request failed.` for any other failure, or `the board is unavailable.` while
  the daemon or live updates are unavailable.

Columns follow configuration order:

- Fitting rows centre; wider rows scroll horizontally from the left.
- Columns are 320px wide above 760px and retain 248px at 760px or narrower. Card accent rails
  are 2px wide; empty-column spines retain their compact width.
- A column header shows name, task count and executor (kind, then name), then two sort buttons.
  `T`/`K` sorts by time in the column or by key; `↑`/`↓` reverses. `T ↑`, the default, puts the
  longest in the column first; `K ↑` the lowest key, numbers compared as numbers. Rows without a
  time go last. The browser keeps the order per project and column. Spines have none; the filter
  only dims.
- An empty column collapses to a spine with its name and `0`.
- Two or three adjacent Todo-group columns (`todo`, `triage`, `ready-for-dev`) sit under one
  `Backlog` band with their total count; `todo` alone stays a plain column. Each part's head
  reads `manual` instead of the executor. The band's caret toggle folds the group into one
  column with a section per part (`empty` when it has no tasks) and unfolds it back into
  columns. The browser keeps the fold per project; a fold reads nothing from the daemon.
- A card in a Backlog part moves to another part of its band with a reason, sent as one
  `task.move` (`manual`):
  - Its `⋯` menu (`Move <short key>`), the last of its links, lists `Move to <part>…` for each
    other part. A tap or click opens it pinned with focus on the first item.
  - Dragging the card onto another part's cards, empty spine or folded section marks that part
    and, except on a spine, reads `Drop to move to <part>. A reason is asked.`; its own part,
    other columns and drags from elsewhere take nothing.
  - The task view's `Move to` row ([task view](web-ui-task-view.md)) does the same.

  Each opens the form `Move <short key> to <part>: reason`, focused, with `Move to <part>` and
  Cancel: under the card from the menu or a drop, in the task view from its row. The send stays
  disabled until the reason has text; over 20,000 characters it says so. Nothing moves before
  the daemon accepts: the send then reads `Moving` until a read shows the task in the target
  part, at the end of its list, then the form closes. On the Board the moved card takes focus;
  in the task view the first part button does. A refusal shows the daemon's hint under the field and keeps the reason; any other
  failure reads `Could not move the task. Send again to retry.`. A resend of the same reason
  reuses its idempotency key, so it never moves twice; an edited reason is a new move. Until the
  move shows, another form for the task with the same part and reason joins it; any other reads
  `This task is already being moved. Wait until the Board shows it.`. While the
  daemon or live updates are unavailable the send is disabled and the hint adds why, then
  `Moves cannot be sent.`. Cancel closes the form at any time.

- `done` lists every done task in a compact scrolling list, each with its time in the column.
- A card opens the task view on click or Enter, a new tab on a modified click. It shows the short
  key (full key on hover) and its time in the column, the ticket title, then:
  - Ticket, first pull request and Spur session links open new tabs; Tab reaches them after the
    card. Sessions need `web.spurUiOrigin`; otherwise a `session <id>` chip truncates at 20 characters.
    Jira links use `ticketBrowseBase` plus the key; other tickets and PRs use observed URLs.
  - Four cells for the first pull request: checks, merge, resolved threads, reviews on the head.
    Red: failed, conflicting or changes requested. Yellow: pending or unresolved. Soft green fill
    and green glyph with neutral text and border: passed, no conflicts or approved.
    `–`: nothing reported. `?`: mergeability unknown. All four
    grey: not confirmed, the GitHub source is stale or blind. Four `—`: linked, not observed yet.
    `+N`: other pull requests. An open turn without one shows `no PR yet`.
  - Markers: `B<n> → you` for your block (`+N` for the others), the agents' block count, `returned`
    with its findings, `draft`, and in shadow mode the dispatcher's column. The agents' block count
    and overflow `+N` have a soft red fill and red block icon with neutral text and border;
    `B<n> → you` keeps its attention styling.
  - The turn line: turn, executor and age. The left rail takes its colour: blue while an agent works
    on it; yellow for your turn, or not taken (dashed rail, hollow dot); red when stalled; none
    without a turn. Ages stop while the data is stale.
- Unconfigured columns: a trailing count opens a list of task keys, titles and original columns.
  Rows open the task view and keep status order. At zero, both are absent.

On a narrow screen columns scroll sideways; the mode and filter are hidden.
