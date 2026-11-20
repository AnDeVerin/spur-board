# Web UI: moving between Backlog parts

How the [Board](web-ui-board.md) of the [web UI](web-ui.md) moves a task between Backlog parts.

A card in a Backlog part moves to another part of its band with a reason, sent as one
`task.move` (`manual`):

- Its `⋯` menu (`Move <short key>`), the last of its links, lists `Move to <part>…` for each
  other part. A tap or click opens it pinned with focus on the first item.
- Dragging the card onto another part's cards, empty spine or folded section marks that part
  and, except on a spine, reads `Drop to move to <part>. A reason is asked.`; its own part,
  other columns and drags from elsewhere take nothing.
- The task view's `Move to` row ([task view](web-ui-task-view.md)) does the same.

Each opens the form `Move <short key> to <part>: reason`, focused, with `Move to <part>` and
Cancel: under the card from the menu or a drop, in the task view from its row. The send stays
disabled until the reason has text; it says when over 20,000 characters. Nothing moves before
the daemon accepts: the send then reads `Moving` until a read shows the task in the target part,
then the form closes. The move starts a new column visit at the end of the part; where the card
shows follows the part's sort (last under the default `T ↑`). On the Board the moved card takes
focus; in the task view the first part button does. A refusal shows the daemon's hint under the
field and keeps the reason; any other failure reads
`Could not move the task. Send again to retry.`. A resend of the same reason reuses its
idempotency key, so it never moves twice; an edited reason is a new move. Until a task read
shows the outcome, another form for the task with the same part and reason joins it; any other
reads `This task is already being moved. Wait until the Board shows it.`. While the daemon or
live updates are unavailable the send is disabled and the hint adds why, then
`Moves cannot be sent.`. Cancel always closes it.
