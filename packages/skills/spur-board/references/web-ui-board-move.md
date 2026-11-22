# Web UI: moving and ordering cards

How the [Board](web-ui-board.md) of the [web UI](web-ui.md) moves a task between Backlog parts
and orders the cards of a column by hand ([Manual order](#manual-order)).

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
focus; in the task view the first enabled part button does. A refusal shows the daemon's hint under the
field and keeps the reason; any other failure reads
`Could not move the task. Send again to retry.`. A resend of the same reason reuses its
idempotency key, so it never moves twice; an edited reason is a new move. Until a task read
shows the outcome, another form for the task with the same part and reason joins it; any other
reads `This task is already being moved. Wait until the Board shows it.`. While the daemon or
live updates are unavailable the send is disabled and the hint adds why, then
`Moves cannot be sent.`. Cancel always closes it.

## Manual order

`Manual` (`M`) in a column's sort menu orders it by the board's stored order, the `position` of
`status.get`; tasks without one, from an older daemon, go last. Done only sorts. In Manual each
card shows a grip before its key and reorders three ways, each sending one `task.order` with its
own idempotency key:

- Drag: a line marks where the card lands; the drop places it before the card under it, or
  after the one above when it moves down. A drop at its own place sends nothing.
- `Alt+Up` / `Alt+Down` on a focused card moves it one step; the card keeps focus.
- The `⋯` menu, also on a narrow screen, lists `Move to top` and `Move to bottom`, disabled at
  the ends, then a Backlog card's parts after a rule. Cards in a mirrored part reorder too.

Nothing moves before a read shows the result. Until then the card is dimmed and the column
takes no other reorder: its order items read `Wait until the Board shows the last reorder.`.
A screen reader then hears `<short key> moved to <N> of <M>`. A refusal leaves the card in
place and shows `<short key> not moved` under the column head with the cause, such as
`The order changed on the board while you dragged.`, and `The card stays where it was.`, until
Dismiss.

A reorder this tab did not make, seen in a read, tints the moved card briefly with
`moved by operator`. The note names the role, not a person or session: a reorder from the CLI,
MCP or an operator-role Spur session reads the same.

Time and Key show no grip and keep their sort. A card outside a Backlog band cannot be dragged
there; trying it, or dragging a Backlog card over its own part, reads
`Cards keep the chosen sort. To reorder by hand, switch to Manual.`, whose button switches the
column to Manual. A Backlog card still drags to another part in any sort.

## Mirrored part

When `ready-for-dev` mirrors a GitHub Project, only the Project moves tasks into or out of it.
The menu lists those moves disabled, each with
`ready-for-dev mirrors GitHub Project "<name>" (<owner>/<number>, field <field>). Change the task status there instead.`
under it. A drag into or out of the part marks the part under the card in the attention colour
with that text as its note (a spine's tooltip) and takes no drop. The task view disables those
part buttons and shows the text after them. Moves between the other parts work as before.

A mirror that cannot be read is frozen: tasks stay where its last complete read put them. The
part head adds ` · frozen` and its tooltip names the cause; the band shows a warning dot; a
warning notice above the cards, folded or not, reads `Mirror not readable: frozen` with the
cause and `Last complete read <time>` (`No complete read yet.` before one). The cause is the
failure of the last read, else why the source is blind, such as
`No complete observation in 3 poll intervals`, then `Polls wait for the GitHub rate budget.`
while polling waits for it. An empty frozen part stays a column for the notice. The Who tab of
the part shows the same; a readable mirror shows `read <age> ago`. A degraded one adds an amber
dot and `degraded · ` before it, or `waiting for the GitHub rate budget · ` while polling waits
for the budget. The top warning names a blind or failing mirror too, as the notice can be off
screen on a narrow window.
