# Worker flow

- If `board task <task>` lists no worker link for your session, run
  `spur slots --session "$SPUR_SESSION" --link board-worker=<issue URL>` or ask the operator for
  `board link`. URL from the key: `o/r#12` is `https://github.com/o/r/issues/12`.
- Blocking: keyed `board ask <task> <text>`; keep its B<number> and wait for the
  doorbell. Update: keyed `board comment <task> <text>`.
- A return to Dev: ack its Dev turn, read the reason in `board task <task>`, fix it, then
  keyed `board submit <turn> <sha>`. Taking the turn reads the "back" code block; once the
  Board confirms the submit, of a new head or the same head as a reply, it closes `done`. If
  the block's doorbell still rings (a turn taken before a Board upgrade), ack it too.
- A Dev turn you cannot take (a named orchestrator or the operator runs Dev) leaves the "back"
  block unread: ack the block on its doorbell, then once the fix is in keyed
  `board unblock <block> --done <commit/PR link>`.
- A "back" block still open after your Dev turn closed (no submit, or one a merge at another
  head superseded, which opens no turn): take a later Dev turn of that visit and submit as
  above. While `board task <task> --why` lists any `holds` (`ticket_unconfirmed`,
  `github_blind` and others), the Board can still open that turn: wait. Only when none is
  listed and no later Dev turn of that visit opened, fix it, then close it with `--done` as
  above. A hold that does not clear (a ticket left unconfirmed): keyed `board ask <task> <text>`
  naming the hold instead of closing by hand. The Board routes it as any question
  ([Blocks and escalation](how-board-works-blocks.md)); its recipient checks the hold or escalates
  it with keyed `board escalate <block>`, up to the operator.
- Exit 3: not applied. Ask in your own session; when the Board returns, retry identically.
- Exit 4: no Board config; report in your session; keep the key.
- Exit 5 (unknown): retry up to 3 times in a minute, then ask in your own session.
  Reads take no `--key`.
- An answer in your own session: add one keyed provenance-only task-level comment,
  then keyed `board unblock <block> --withdraw <answer>`; it records the answer and
  replies. Add no other answer comment or reply.
- Only the asking session may `--withdraw`. A replacement session posts provenance in a
  keyed `board comment` and leaves the block open.
