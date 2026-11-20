# Worker flow

- If `board task <task>` lists no worker link for your session, run
  `spur slots --session "$SPUR_SESSION" --link board-worker=<issue URL>` or ask the operator for
  `board link`. URL from the key: `o/r#12` is `https://github.com/o/r/issues/12`.
- Blocking: keyed `board ask <task> <text>`; keep its B<number> and wait for the
  doorbell. Update: keyed `board comment <task> <text>`.
- A return to Dev: ack its Dev turn, read the reason in `board task <task>`, fix it, then
  keyed `board submit <turn> <sha>`. The take reads the "back" code block; your confirmed
  submit closes it `done`, no unblock.
- Close a "back" block by hand: keyed `board unblock <block> --done <commit/PR link>` once the
  fix is in, only if `board task <task>` still shows it open after that submit, or you have no
  Dev turn to submit (an orchestrator or operator runs Dev). Ack it only if its doorbell rang;
  a block that never rang needs no ack. While `board task <task> --why` lists `submit_pending`
  or another hold, wait. A hold that does not clear: keyed `board ask <task> <text>` naming it;
  its recipient checks or escalates it with keyed `board escalate <block>`, up to the operator
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
