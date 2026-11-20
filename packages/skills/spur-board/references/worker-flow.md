# Worker flow

- If `board task <task>` lists no worker link for your session, run
  `spur slots --session "$SPUR_SESSION" --link board-worker=<issue URL>` or ask the operator for
  `board link`. URL from the key: `o/r#12` is `https://github.com/o/r/issues/12`.
- Blocking: keyed `board ask <task> <text>`; keep its B<number> and wait for the
  doorbell. Update: keyed `board comment <task> <text>`.
- A return to Dev: ack its Dev turn, read the reason in `board task <task>`, fix it, then
  keyed `board submit <turn> <sha>`. Taking the turn reads the "back" code block; the submit,
  of a new head or the same head as a reply, closes it `done` with the SHA.
- Only for a code block without a Dev turn (shadow mode, no return): fix it, then keyed
  `board unblock <block> --done <ref>` with commit/PR link.
- Exit 3: not applied. Ask in your own session; when the Board returns, retry identically.
- Exit 4: no Board config; report in your session; keep the key.
- Exit 5 (unknown): retry up to 3 times in a minute, then ask in your own session.
  Reads take no `--key`.
- An answer in your own session: add one keyed provenance-only task-level comment,
  then keyed `board unblock <block> --withdraw <answer>`; it records the answer and
  replies. Add no other answer comment or reply.
- Only the asking session may `--withdraw`. A replacement session posts provenance in a
  keyed `board comment` and leaves the block open.
