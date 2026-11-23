# Web UI: board

The Board screen of the [web UI](web-ui.md): the header, the inbox, the task columns and the
Backlog group.

## What it shows

Header, left to right:

- The logo.
- The project switcher lists `<id> · dispatcher <mode>`, checking the current project. Escape or
  an outside click closes it. The browser keeps the choice, else the first project. Long ids end
  in `…`.
- Dispatcher mode: `dispatcher on` or `dispatcher shadow`.
- The filter matches full/short keys (`#12`), session or block ids, ignoring case. Misses dim,
  stay visible and accept Tab; Clear resets the filter.
- The live indicator: `connecting` until the stream answers, then `live`, `reconnecting` or
  `offline`.
- The inbox button highlights nonzero active counts; `–` means no successful read yet. It opens the
  right panel at `?open=inbox`, also opened directly. All/configured project/system filters apply to
  active and handled entries; counts include only active ones. Failures precede attention, newest
  first within severity. Handled entries keep query order, marked handled with their answer channel
  if supplied. Supplied actions show apart; an exact trailing `: <action>` leaves the description. A
  column orchestrator with no live session reads `No session to ring for <column>`, its Spur project
  when known, the turns waiting, the oldest one's `T<n>` and age, and its minutes without one, then
  its action and `It clears itself when a session appears.` It closes the inbox and opens that
  column's help on **Who** (choosing its project, its head in view), which links the oldest turn's
  task; a spine opens the task. Cleared, it moves to handled as
  `Had no session to ring for <column>`, in the past tense with the oldest `T<n>` and no action, and
  opens that task. A re-raise for the same column replaces it. An entry without `noSession` keeps
  the plain row, with its action. Before the first success, the panel says inbox data is
  unavailable; later failures keep data. Task rows open the task view and task-less block rows the
  block panel over the retained panel, choosing their project when config arrives. Closing either
  focuses its row or panel Close if removed; inbox close focuses the inbox button. Back/Forward
  follow these layers. Other task-less rows with a known HTTP(S) destination open it in a new tab on
  click or Enter, keeping the inbox. Task navigation wins over a URL. Rows without a safe
  destination stay focusable. Each active item entry (`I<n>`) has a quiet `Close I<n>` below its row
  that sends one `item.close`, as Slack's Close does: a ledger item's block closes with it and a
  failed post stays unsent. Blocks, turns and handled entries have none. It reads `Closing I<n>`
  while sent, then `Closed I<n>, waiting for the board.` until the re-read moves the entry to
  handled; focus then goes to the next row, else the previous one, else panel Close. A failure keeps
  the entry with `Could not close I<n>: <message>`: the daemon's problem message,
  `the request failed.` for any other failure, or `the board is unavailable.` while the daemon or
  live updates are unavailable.

Columns follow configuration order:

- Fitting rows centre; wider rows scroll horizontally from the left.
- Columns are 320px wide, 248px at 760px or narrower. Card accent rails are 2px wide.
- A column header shows name, task count and executor (kind, then name), then a sort letter
  menu: Time, Key or [Manual](web-ui-board-move.md#manual-order); `↑`/`↓` reverses `T`/`K`.
  `T ↑`, the default, puts the longest in the column first; `K ↑` the lowest key, by number.
  Rows without a time go last. The browser keeps it per project and column. Spines have none;
  the filter only dims.
- The executor line is a button with an icon for who moves a task here. It opens column help,
  **Who** first, then **Rules**, read from `columns.describe` on each open: a skeleton while it
  reads, an error in the panel if it fails. Escape, Close, an outside or second click, focus
  leaving head and panel, or a sort menu opening close it; help opening closes a sort menu: one
  is open at most. A column whose Spur project has no live session turns the line
  attention-coloured with ` · no live session`. Spines have no help; Backlog parts do.
- An empty column collapses to a spine with its name and `0`.
- Two or three adjacent Todo-group columns (`todo`, `triage`, `ready-for-dev`) sit under one
  `Backlog` band with their total count; `todo` alone stays a plain column. Each part's head
  reads `manual` instead of the executor, or `mirror · <Project>` with a mirror icon when a
  GitHub Project places its tasks; its Who tab names the Project, field and last read. A mirror
  that cannot be read is frozen: ` · frozen` on the line, a warning dot on the band and a notice
  above the part's cards ([mirrored part](web-ui-board-move.md#mirrored-part)). The band's caret folds the group into one
  column, a section per part (`empty` with no tasks), and unfolds it. The browser keeps the fold
  per project; a fold reads nothing from the daemon.
- A Backlog card moves to another part of its band with a reason: see
  [moving between Backlog parts](web-ui-board-move.md).
- `done` lists every done task in a compact scrolling list, each with its time in the column.
- A card opens the task view on click or Enter, a new tab on a modified click. It shows the short
  key (full key on hover) and its time in the column, the ticket title, then:
  - Ticket, first pull request and Spur session links open new tabs; Tab reaches them after the
    card. Sessions need `web.spurUiOrigin`; else a `session <id>` chip, cut at 20 characters.
    Jira links use `ticketBrowseBase` plus the key; other tickets and PRs use observed URLs.
  - Four cells for the first pull request: checks, merge, resolved threads, reviews on the head.
    Red: failed, conflicting or changes requested. Soft fill and glyph in the status colour with
    neutral text and border: yellow for pending or unresolved, green for passed, no conflicts or
    approved. `–`: nothing reported. `?`: mergeability unknown. All four
    grey: not confirmed, the GitHub source is stale or blind. Four `—`: linked, not observed yet.
    `+N`: other pull requests. An open turn without one shows `no PR yet`. In Ready to Merge,
    with approval facts and no changes requested, reviews counts every approval and adds a quiet
    `+N` (commits since the approval) or `?` (not counted or unread), explained by its
    tooltip; an approval before a watched change or a rewritten history turns it yellow.
  - Markers: `B<n> → you` for your block (`+N` for the others), the agents' block count, `returned`
    with its findings, `draft`, and in shadow mode the dispatcher's column. The agents' block count
    and overflow `+N` have a soft red fill and red block icon with neutral text and border;
    `B<n> → you` keeps its attention styling. In Ready to Merge a warn approval chip comes first
    when the cell turns yellow: `approved before` up to two entries then `+K` (all in its
    tooltip), or `approval: history rewritten`; it also shows with changes requested or grey cells.
    Next, when the QA column's latest submission was carried or skipped and not voided,
    `QA carried` (tooltip: source commit and reason) or a warn `QA skipped` (tooltip: reason);
    tested, none or no QA column adds nothing. See [Approvals](web-ui-task-approvals.md).
  - The turn line: turn, executor and age. The left rail takes its colour: blue while an agent works
    on it; yellow for your turn (`open`, or `taken` once you hold it), or not taken (dashed
    rail, hollow dot); red when stalled; none without a turn. An operator session holding your
    turn reads like an agent. Ages stop while the data is stale. A `board wait` adds amber line
    2: clock `wakes <hh:mm> · <reason>` (UTC), reason cut when narrow, full on hover; stall wins.
- Unconfigured columns: a trailing count opens a list of task keys, titles and original columns.
  Rows open the task view and keep status order. At zero, both are absent.

On a narrow screen columns scroll sideways; the mode and filter are hidden.
