# Web UI

View the Board and freshness, answer operator questions, follow up on them, comment, close
an operator inbox item, submit or return an orchestrator turn, and move a task between Backlog
parts.
Archived tasks are read-only; other actions use CLI, MCP or Slack.

## Opening it

Enable the optional web listener with `web.port` and `web.publicOrigin` per
[Optional browser access](https://github.com/AnDeVerin/spur-board/blob/main/SETUP.md#optional-browser-access),
then open `web.publicOrigin`. For 503 `UI is not built`, follow
[Building the web UI](https://github.com/AnDeVerin/spur-board/blob/main/SETUP.md#building-the-web-ui).
The page shows the Spur mark as its tab icon and, over HTTPS, installs on a phone as a standalone
app (see Optional browser access).

Reads: `config.get`, chosen-project `status.get` and `columns.describe`, `inbox.operator`,
open-task `task.get`/`task.history` and `/v1/events`. The UI owns no data.

## Screens

- [Board](web-ui-board.md): the header, the inbox, the task columns and the Backlog group.
- [Status bar and services](web-ui-status.md): service health and the services panel.
- [Task view](web-ui-task-view.md): a card or `?open=<task key>` opens links, **Why it is here**,
  **Approvals**, **Blocks**, **Comments** and **History** (journal events with channel, e.g.
  `operator (web)`).
- [Task blocks and comments](web-ui-task-blocks.md): answers, follow-ups and comments in the task
  view.
- [Turn](web-ui-task-turn.md): take an orchestrator turn and submit it or return it to Dev.
- [Moving between Backlog parts](web-ui-board-move.md): the card menu, drop and task-view move
  with a reason.
- [Approvals](web-ui-task-approvals.md): approval freshness in the task view and on the Ready to
  Merge card.

## Live and stale states

Screen times are UTC, `hh:mm dd/mm/yy`.

- **Loading**: skeleton columns, the inbox count `–`, and the switcher disabled until config
  answers.
- **Live**: the indicator reads `live`. The stream tells the UI which projects changed; a change in
  the chosen project rereads its config, status and column policy, and any change rereads the inbox. A
  changed journal head or daemon instance on reconnect, a `reset` and the 30-second status frame
  reread everything.
- **Empty**: a project with no tasks shows a message instead of columns.
- **Reconnecting**: the stream dropped; the UI reconnects with backoff, changing only the indicator.
- **Offline**: after five failed connection attempts, an error banner says live updates are lost and
  gives the data's time; the columns dim and the UI keeps reconnecting.
- **Daemon down**: config/status read failed. The error banner gives data time and warns that
  answers/comments cannot be sent; the daemon button turns red. Initial failure shows no data
  and no columns.
- **Unreadable answer**: the daemon answered config or status, but the answer did not match what
  this page expects. The error banner says the answer could not be read; the rest is as daemon
  down. A failed request on either read still shows daemon down.
- **Updated**: a daemon on another version answered. The page reloads itself with the same
  address and brings back unsent answer, follow-up and comment text; it waits up to 15 seconds
  for an answer, follow-up or comment send in progress first, not for a Turn send. When it cannot (it already reloaded once for that version and
  still runs the older page, a send is still in progress after 15 seconds, or session storage
  fails), an error banner with **Reload** names the version and the columns dim; without session
  storage it warns that unsent text is lost. A **Reload** or **Retry now** that cannot save unsent
  text shows that warning first and stays; the next **Reload** goes on. An open task view or inbox
  repeats that banner, so **Reload** keeps the text typed there without closing it.
- **Source blind**: a warning names unresponsive project sources and their last complete poll;
  warming-up sources are omitted.
- **Shadow**: an info banner says the dispatcher computes columns and turns but does not act.

Banners order errors, warnings, info. Data time means this browser's last good status read.

**Retry now** reconnects a waiting stream and rereads config, status and inbox, showing `Retrying`
until done; after an update it reloads the page instead. Inbox failures keep the last count
without a banner.
