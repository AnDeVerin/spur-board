# Web UI

The web UI shows the Board for one project in a browser: its columns, the tasks in them and
whether the data on screen is current. It only reads. Answers, comments and every other action
stay in the CLI, the MCP tools and Slack.

## Opening it

The daemon serves the UI on its separate web listener, which is off by default. Set
`web.port` and `web.publicOrigin` as described in
[Optional browser access](https://github.com/AnDeVerin/spur-board/blob/main/SETUP.md#optional-browser-access),
make sure the UI assets are built, then open `web.publicOrigin` in a browser. A 503 that says
the UI is not built means the assets are missing; see
[Building the web UI](https://github.com/AnDeVerin/spur-board/blob/main/SETUP.md#building-the-web-ui).

The UI reads `config.get`, `status.get` for the chosen project, `inbox.operator`, and the
`/v1/events` stream on the same listener. It holds no data of its own.

## What it shows

The header, from left to right:

- The logo.
- The project switcher: the chosen project's id. It opens a plain list of every configured
  project as `<id> · dispatcher <mode>`, with the current one checked. Escape or a click outside
  closes the list. The browser remembers the choice across reloads; a project that is no longer
  configured falls back to the first one. A long id that does not fit ends in `…`, in the
  switcher and in the list.
- The dispatcher mode of the chosen project: `dispatcher on` or `dispatcher shadow`.
- The filter. It matches the full task key, the short key (`#12`), a session id or a block id,
  ignoring case. Cards that do not match are dimmed, never hidden, and stay reachable with Tab.
  The field's clear button resets it.
- The live indicator: `connecting` until the stream first answers, then `live`, `reconnecting`
  or `offline`.
- The inbox button with the number of open items in the operator inbox, across all projects. It
  stands out while the count is above zero and reads `–` until the first inbox read answers.
  Clicking it sets the address to `?open=inbox`; this version has no inbox panel yet.

Below the header come the columns of the chosen project, in configuration order:

- Each column header shows its name, its task count and its executor (kind, then name).
- A column with no tasks collapses to a narrow spine with its name and `0`.
- The `done` column lists every done task in a compact scrolling list.
- A card shows the short key and the ticket title, or the key alone when there is no ticket.
  Hovering shows the full key. A card is a link: a click or Enter sets the address to
  `?open=<task key>`, and a modified click opens a new tab. This version has no task panel yet.
- Beside the key sit quick links to the ticket, the first pull request and the Spur session.
  Each opens in a new tab and never opens the task; Tab reaches them right after their card.
  The session link needs `web.spurUiOrigin`; without it the session shows as a plain
  `session <id>` chip in the markers row, cut at 20 characters with the full id on hover.
- Under the title, four PR status cells describe the first pull request: checks, merge
  conflicts, resolved review threads and reviews on the head. Red means failed, conflicting or
  changes requested; yellow means pending or unresolved; a green glyph means passed, no
  conflicts or approved; a dash means nothing reported, and `?` in the merge cell means
  mergeability is unknown. `+N` counts the other pull requests. When the GitHub source is stale
  or blind, the facts are not confirmed and all four cells turn grey: no colour and no green
  glyph. Four dashes mean the pull request is linked but not observed yet. A card with an open
  turn and no pull request shows a dashed `no PR yet`.
- Markers follow: `B<n> → you` for a block waiting for you (`+N` for its other blocks), the
  count of blocks for agents, `returned` with the number of review findings, `draft`, and in
  shadow mode the dispatcher's column next to the tracker's.
- The turn line at the bottom names the open turn, its executor and its age, and the rail on
  the card's left edge takes its colour: blue while an agent works on a taken turn; yellow when
  the turn is yours, or not taken yet, which also draws a dashed rail and a hollow dot; red when
  the executor has stalled. A card with no open turn has no turn line and no rail. Ages count
  to the time of the last good read, so they stop while the data is stale.
- A task whose column the project's configuration does not list is not shown.

On a narrow screen the columns scroll sideways, and the mode and the filter are hidden.

## Status bar

From left to right: **services**, which opens and closes the services panel; one button per
service (daemon, slack, github, spur, and jira when the status lists Jira); the Light, Dark and
Auto theme menu, whose icon shows the choice the browser remembers; and the version of the
running daemon, empty until the first status read.

A service button shows a dot coloured from the service's health row in `status.get`: green
healthy, amber degraded, red failing. Its name reads `<service>: <word>`:

- daemon: `running`, `stalled` after 120 seconds without a completed tick,
  `no answer since <time>` when the UI cannot read it, or `no answer` when the very first read
  fails.
- slack: `up` or `down`.
- github, spur and jira: `polling` when healthy. GitHub covers the pull request and issue
  sources of every repository and takes its worst source. Otherwise the word is that of the
  first source, in status order, whose own state has the service's colour: `blind: <reason>`,
  `never completed`, `warming up` or `stale`. Else it is `waits for rate budget`: a GitHub
  budget fell to the configured reserve; hover for the reason.
- `unknown`, with a hollow dot, for a service with no health row, for all while the first
  status read is pending, and for all but the daemon while the daemon does not answer.

The bar follows each `status` message of the event stream, about every 30 seconds, and makes
no reads of its own.

## Services panel

Opened from the bar or by `?open=services`, the left panel shows boxes from `status.get` only:

- daemon: Version, Started, Last dispatch.
- host: CPU, RAM and Disk percent bars, amber at 80% and red at 90%; an unread value shows
  `— / 100`, never 0. A host load wait adds an amber row.
- slack: when down, Down since, Reason and Spaces.
- One box per GitHub source, spur, and one per Jira source, headed by the source's own state:
  Last complete poll, Last observation, Blind (when blind), Freshness, Warming up, Points last
  hour (pull request sources) and Budget: a bar of requests left over the limit with its reset
  time, amber at 20% and red at 5%; `<n> left` without a limit; `—` without a budget. The spur
  box adds the Spur availability line while Spur is unavailable.

No healthy service shows since when it is healthy. Before the first status the panel waits for
it; while the daemon does not answer, the boxes read unknown; once live updates are lost while
the daemon still answers, the header reads `Data from <time>` and the boxes keep the last data.
Close, Escape, the dimmed area and the services button close it; focus returns to the opener, or
to services after a link.

Limits: the header and columns are inert while the panel is open, and the bar stays live for the
pointer only (Tab stays in the panel). On a narrow screen the panel covers the bar; Close or
Escape closes it. Opening and closing each add a history entry, so Back after a close reopens
the panel.

## Live and stale states

Times on the screen are UTC, written `hh:mm dd/mm/yy`.

- **Loading**: skeleton columns, the inbox count `–`, and the switcher disabled until the
  configuration answers.
- **Live**: the indicator reads `live`. The stream tells the UI which projects changed; a change
  in the chosen project rereads its configuration and status, and any change rereads the inbox.
  A changed journal head or daemon instance on reconnect, a `reset` and the 30-second status
  frame reread everything.
- **Empty**: a project with no tasks shows a message instead of columns.
- **Reconnecting**: the stream dropped and the UI is reconnecting with backoff. Only the
  indicator changes; the data stays.
- **Offline**: after five failed connection attempts. An error banner says live updates are
  lost and gives the time of the data on screen, and the columns are dimmed. The UI keeps
  trying to reconnect.
- **Daemon down**: a configuration or status read failed. The error banner says the daemon does
  not answer, gives the time of the data on screen and warns that answers and comments cannot be
  sent. The daemon button in the status bar turns red and the other services read `unknown`. On the first load there is no data, so the banner says so and no columns show.
- **Source blind**: a warning banner names a source of the project that has stopped answering
  and the time of its last complete poll, such as Spur not answering since 14:40 15/11/26.
  Several such sources share one banner. A source that is still warming up is not named.
- **Shadow**: an info banner says the dispatcher computes columns and turns but does not act.

All banners that apply are shown, errors first, then warnings, then info. The time of data is
when this browser last received a good status read, not when the error happened.

**Retry now** on an error banner reconnects the stream at once if it is waiting between
attempts, and rereads the configuration, the status and the inbox. It reads `Retrying` until
those reads finish. A failed inbox read keeps the last count and shows no banner.
