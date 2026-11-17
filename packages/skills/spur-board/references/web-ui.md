# Web UI

View the Board and freshness, answer open operator questions and add comments. Archived tasks
are read-only; other actions use CLI, MCP or Slack.

## Opening it

Enable the optional web listener with `web.port` and `web.publicOrigin` per
[Optional browser access](https://github.com/AnDeVerin/spur-board/blob/main/SETUP.md#optional-browser-access),
then open `web.publicOrigin`. For 503 `UI is not built`, follow
[Building the web UI](https://github.com/AnDeVerin/spur-board/blob/main/SETUP.md#building-the-web-ui).

Reads: `config.get`, chosen-project `status.get`, `inbox.operator`, open-task `task.get`/`task.history` and
`/v1/events`. The UI owns no data.

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

## Status bar

Left to right: **services** toggles its panel; service buttons (daemon, slack, github, spur, jira
when listed); Light/Dark/Auto theme menu with the choice's icon; daemon version, empty until
the first status read.

Service dots follow `status.get` health: green healthy, amber degraded, red failing. Names read
`<service>: <word>`:

- daemon: `running`, `stalled` after 120 s without a completed tick, `no answer since <time>` when
  the UI cannot read it, or `no answer` if the first read fails.
- slack: `up` or `down`.
- github, spur and jira: `polling` when healthy. GitHub takes the worst across repository pull
  request and issue sources. Otherwise the first source matching the service's colour supplies
  `blind: <reason>`, `never completed`, `warming up` or `stale`. Else `waits for rate budget`
  means a GitHub budget reached its configured reserve; hover for the reason.
- `unknown`, with a hollow dot, for a service with no health row, for all before the first status
  read, and for all but the daemon while the daemon does not answer.

The bar follows each `status` stream message, about every 30 s, and reads nothing itself.

## Services panel

Opened from the bar or by `?open=services`, the left panel shows boxes from `status.get` only:

- daemon: Version, Started, Last dispatch.
- host: CPU, RAM and Disk percent bars, amber at 80% and red at 90%; an unread value shows `— /
100`, never 0. A host load wait adds an amber row.
- slack: when down, Down since, Reason and Spaces.
- One box per GitHub source, spur, one per Jira source, headed by its own state: Last complete
  poll, Last observation, Blind (when blind), Freshness, Warming up, Points last hour (pull request
  sources) and Budget: a bar of requests left over the limit with its reset time, amber at 20% and
  red at 5%; `<n> left` without a limit; `—` without a budget. The spur box adds an availability
  line while Spur is unavailable.

Healthy services omit their healthy-since time. Before the first status the panel waits; an
unreachable daemon makes boxes unknown. Lost live updates with a reachable daemon show
`Data from <time>` and retain data. Close, Escape, the scrim or services button closes the panel;
focus returns to its opener, or services after a link.

While open, header and columns are inert; the bar accepts pointer only (Tab stays in the panel).
Narrow panels cover the bar. Opening and closing add history entries; Back after close reopens it.

## Task view

A card or `?open=<task key>` opens links, **Why it is here**, **Blocks**, **Comments** and
**History** (journal events with channel, e.g. `operator (web)`). See the
[task view](web-ui-task-view.md) guide.

## Live and stale states

Screen times are UTC, `hh:mm dd/mm/yy`.

- **Loading**: skeleton columns, the inbox count `–`, and the switcher disabled until config
  answers.
- **Live**: the indicator reads `live`. The stream tells the UI which projects changed; a change in
  the chosen project rereads its config and status, and any change rereads the inbox. A
  changed journal head or daemon instance on reconnect, a `reset` and the 30-second status frame
  reread everything.
- **Empty**: a project with no tasks shows a message instead of columns.
- **Reconnecting**: the stream dropped; the UI reconnects with backoff, changing only the indicator.
- **Offline**: after five failed connection attempts, an error banner says live updates are lost and
  gives the data's time; the columns dim and the UI keeps reconnecting.
- **Daemon down**: config/status read failed. The error banner gives data time and warns that
  answers/comments cannot be sent; the daemon button turns red. Initial failure shows no data
  and no columns.
- **Source blind**: a warning names unresponsive project sources and their last complete poll;
  warming-up sources are omitted.
- **Shadow**: an info banner says the dispatcher computes columns and turns but does not act.

Banners order errors, warnings, info. Data time means this browser's last good status read.

**Retry now** reconnects a waiting stream and rereads config, status and inbox, showing `Retrying`
until done. Inbox failures keep the last count without a banner.
