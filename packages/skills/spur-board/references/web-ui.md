# Web UI

The web UI shows the Board for one project in a browser: its columns, tasks and whether the
data is current. It only reads; answers, comments and every other action stay in the CLI, the
MCP tools and Slack.

## Opening it

The daemon serves the UI on its web listener, off by default. Set
`web.port` and `web.publicOrigin` as described in
[Optional browser access](https://github.com/AnDeVerin/spur-board/blob/main/SETUP.md#optional-browser-access),
build the UI assets, then open `web.publicOrigin`. A 503 `UI is not built` means they are
missing; see
[Building the web UI](https://github.com/AnDeVerin/spur-board/blob/main/SETUP.md#building-the-web-ui).

The UI reads `config.get`, `status.get` for the chosen project, `inbox.operator` and the
`/v1/events` stream, and holds no data of its own.

## What it shows

The header, from left to right:

- The logo.
- The project switcher: the chosen project's id. It opens a list of every project as
  `<id> · dispatcher <mode>`, the current one checked; Escape or a click outside closes it. The
  browser remembers the choice; a project no longer configured falls back to the first. A long
  id ends in `…`.
- The dispatcher mode of the chosen project: `dispatcher on` or `dispatcher shadow`.
- The filter: the full or short key (`#12`), a session id or a block id, ignoring case. Cards
  that miss are dimmed, never hidden, and reachable with Tab; the clear button resets it.
- The live indicator: `connecting` until the stream first answers, then `live`, `reconnecting`
  or `offline`.
- The inbox button: open operator inbox items across all projects, highlighted above zero, `–`
  until the first inbox read. It sets the address to `?open=inbox`; there is no inbox panel yet.

Below the header, the chosen project's columns in configuration order:

- A column header shows its name, task count and executor (kind, then name).
- An empty column collapses to a spine with its name and `0`.
- `done` lists every done task in a compact scrolling list.
- A card links to `?open=<task key>` (click or Enter; a modified click opens a new tab; no task
  panel yet). It shows the short key (full key on hover), the ticket title, then:
  - Quick links to the ticket, the first pull request and the Spur session open in a new tab,
    never the task; Tab reaches them after their card. The session link needs
    `web.spurUiOrigin`; without it the session is a `session <id>` chip, cut at 20 characters.
  - Four cells for the first pull request: checks, merge, resolved threads, reviews on the
    head. Red: failed, conflicting or changes requested. Yellow: pending or unresolved. Green
    glyph: passed, no conflicts or approved. `–`: nothing reported. `?`: mergeability unknown.
    All four grey: not confirmed, the GitHub source is stale or blind. Four `—`: linked, not
    observed yet. `+N`: other pull requests. An open turn without one shows `no PR yet`.
  - Markers: `B<n> → you` for your block (`+N` for the others), the agents' block count,
    `returned` with the review findings, `draft`, and in shadow mode the dispatcher's column.
  - The turn line: turn, executor and age. The left rail takes its colour: blue while an agent
    works on it; yellow for your turn, or not taken (dashed rail, hollow dot); red when stalled;
    none without a turn. Ages stop while the data is stale.
- A task in a column the configuration does not list is hidden.

On a narrow screen the columns scroll sideways and the mode and filter are hidden.

## Status bar

From left to right: **services**, which opens and closes the services panel; one button per
service (daemon, slack, github, spur, and jira when listed); the Light, Dark and
Auto theme menu, its icon showing the remembered choice; and the daemon version, empty until the
first status read.

Each service button has a dot coloured by its health row in `status.get`: green healthy, amber
degraded, red failing. Its name reads `<service>: <word>`:

- daemon: `running`, `stalled` after 120 seconds without a completed tick,
  `no answer since <time>` when the UI cannot read it, or `no answer` if the first read fails.
- slack: `up` or `down`.
- github, spur and jira: `polling` when healthy. GitHub covers the pull request and issue
  sources of every repository and takes its worst source. Otherwise the word is that of the
  first source, in status order, whose own state has the service's colour: `blind: <reason>`,
  `never completed`, `warming up` or `stale`. Else it is `waits for rate budget`: a GitHub
  budget fell to the configured reserve; hover for the reason.
- `unknown`, with a hollow dot, for a service with no health row, for all while the first
  status read is pending, and for all but the daemon while the daemon does not answer.

The bar follows each `status` stream message, about every 30 seconds, and reads nothing itself.

## Services panel

Opened from the bar or by `?open=services`, the left panel shows boxes from `status.get` only:

- daemon: Version, Started, Last dispatch.
- host: CPU, RAM and Disk percent bars, amber at 80% and red at 90%; an unread value shows
  `— / 100`, never 0. A host load wait adds an amber row.
- slack: when down, Down since, Reason and Spaces.
- One box per GitHub source, spur, and one per Jira source, headed by the source's own state: Last
  complete poll, Last observation, Blind (when blind), Freshness, Warming up, Points last hour (pull
  request sources) and Budget: a bar of requests left over the limit with its reset time, amber at
  20% and red at 5%; `<n> left` without a limit; `—` without a budget. The spur box adds an
  availability line while Spur is unavailable.

No healthy service shows since when it is healthy. Before the first status the panel waits for
it; while the daemon does not answer, the boxes read unknown; once live updates are lost while
the daemon still answers, the header reads `Data from <time>` and the boxes keep the last data.
Close, Escape, the dimmed area and the services button close it; focus returns to the opener, or
to services after a link.

While the panel is open the header and columns are inert and the bar answers the pointer only
(Tab stays in the panel). On a narrow screen the panel covers the bar. Opening and closing each
add a history entry, so Back after a close reopens it.

## Live and stale states

Screen times are UTC, `hh:mm dd/mm/yy`.

- **Loading**: skeleton columns, the inbox count `–`, and the switcher disabled until the
  configuration answers.
- **Live**: the indicator reads `live`. The stream tells the UI which projects changed; a change
  in the chosen project rereads its configuration and status, and any change rereads the inbox.
  A changed journal head or daemon instance on reconnect, a `reset` and the 30-second status
  frame reread everything.
- **Empty**: a project with no tasks shows a message instead of columns.
- **Reconnecting**: the stream dropped; the UI reconnects with backoff and only the indicator
  changes.
- **Offline**: after five failed connection attempts, an error banner says live updates are lost and
  gives the data's time; the columns dim and the UI keeps reconnecting.
- **Daemon down**: a configuration or status read failed. The error banner says the daemon does not
  answer, gives the data's time and warns that answers and comments cannot be sent. The daemon
  button turns red and the other services read `unknown`. On the first load the banner says there is
  no data and no columns show.
- **Source blind**: a warning banner names a project source that has stopped answering and the time
  of its last complete poll. Several share one banner; a source still warming up is not named.
- **Shadow**: an info banner says the dispatcher computes columns and turns but does not act.

Banners show errors first, then warnings, then info. The data time is when this browser last got
a good status read, not when the error happened.

**Retry now** on an error banner reconnects a waiting stream at once and rereads the
configuration, status and inbox; it reads `Retrying` until they finish. A failed inbox read
keeps the last count and shows no banner.
