# Worker flow

- If `board task <task>` lists no worker link for your session, run
  `spur slots --session "$SPUR_SESSION" --link board-worker=<issue URL>` or ask the operator for
  `board link`. URL from the key: `o/r#12` is `https://github.com/o/r/issues/12`.
- Blocking: keyed `board ask <task> <text>`; keep its B<number> and wait for the
  doorbell. Update: keyed `board comment <task> <text>`.
- A return to Dev: ack its Dev turn, read the reason in `board task <task>`, fix it, then
  keyed `board submit <turn> <sha>`. Taking the turn reads the "back" code block; the Board's
  confirmed submit closes it `done`.
- A "back" block addressed to you that `board task <task>` still shows open while you work on
  it without a Dev turn you took (an orchestrator or the operator runs Dev), or after you took
  or submitted one: ack it, then once the fix is in keyed
  `board unblock <block> --done <commit/PR link>`. A redundant ack is a no-op. While
  `board task <task> --why` lists `submit_pending` or another hold, wait. A hold that does not
  clear: keyed `board ask <task> <text>` naming it; its recipient checks it or escalates it with
  keyed `board escalate <block>`, up to the operator
  ([Blocks and escalation](how-board-works-blocks.md)).
- Exit 3: not applied. Ask in your own session; when the Board returns, retry identically.
- Exit 4: no Board config; report in your session; keep the key.
- Exit 5 (unknown): retry up to 3 times in a minute, then ask in your own session.
  Reads take no `--key`.
- An answer in your own session: add one keyed provenance-only task-level comment,
  then keyed `board unblock <block> --withdraw <answer>`; it records the answer and
  replies. Add no other answer comment or reply.
- Only the asking session may `--withdraw`. A replacement session posts provenance in a
  keyed `board comment` and leaves the block open.
