# Web UI: board

The Board screen of the [web UI](web-ui.md): the header, the inbox and the task columns.

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
  `: <action>` is removed from the description. Before the first success, the panel says inbox data
  is unavailable; later failures retain data. Task rows open above the retained panel and select
  their project when config arrives. Task close focuses its row or panel Close if removed; panel close focuses the
  header inbox button. Back/Forward follow these layers. Non-task rows are focusable; all are read-only.

Columns follow configuration order:

- A column header shows name, task count and executor (kind, then name).
- An empty column collapses to a spine with its name and `0`.
- `done` lists every done task in a compact scrolling list.
- A card opens the task view on click or Enter, a new tab on a modified click. It shows the short
  key (full key on hover), the ticket title, then:
  - Ticket, first pull request and Spur session links open new tabs; Tab reaches them after the
    card. Sessions need `web.spurUiOrigin`; otherwise a `session <id>` chip truncates at 20 characters.
    Jira links use `ticketBrowseBase` plus the key; other tickets and PRs use observed URLs.
  - Four cells for the first pull request: checks, merge, resolved threads, reviews on the head.
    Red: failed, conflicting or changes requested. Yellow: pending or unresolved. Green glyph:
    passed, no conflicts or approved. `–`: nothing reported. `?`: mergeability unknown. All four
    grey: not confirmed, the GitHub source is stale or blind. Four `—`: linked, not observed yet.
    `+N`: other pull requests. An open turn without one shows `no PR yet`.
  - Markers: `B<n> → you` for your block (`+N` for the others), the agents' block count, `returned`
    with its findings, `draft`, and in shadow mode the dispatcher's column.
  - The turn line: turn, executor and age. The left rail takes its colour: blue while an agent works
    on it; yellow for your turn, or not taken (dashed rail, hollow dot); red when stalled; none
    without a turn. Ages stop while the data is stale.
- Unconfigured columns: a trailing count opens a list of task keys, titles and original columns.
  Rows open the task view. At zero, both are absent.

On a narrow screen columns scroll sideways; the mode and filter are hidden.
