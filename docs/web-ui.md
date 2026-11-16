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
- A task whose column the project's configuration does not list is not shown.

On a narrow screen the columns scroll sideways, and the mode and the filter are hidden.

The footer keeps the task count, source health, the Light, Dark and Auto theme switch and the
daemon version.

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
  sent. On the first load there is no data, so the banner says so and no columns show.
- **Source blind**: a warning banner names a source of the project that has stopped answering
  and the time of its last complete poll, such as Spur not answering since 14:40 15/11/26.
  Several such sources share one banner. A source that is still warming up is not named.
- **Shadow**: an info banner says the dispatcher computes columns and turns but does not act.

All banners that apply are shown, errors first, then warnings, then info. The time of data is
when this browser last received a good status read, not when the error happened.

**Retry now** on an error banner reconnects the stream at once if it is waiting between
attempts, and rereads the configuration, the status and the inbox. It reads `Retrying` until
those reads finish. A failed inbox read keeps the last count and shows no banner.
