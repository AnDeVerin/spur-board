# Worker flow

- If `board task <task>` lists no worker link for your session, run
  `spur slots --session "$SPUR_SESSION" --link board-worker=<issue URL>` or ask the operator for
  `board link`. URL from the key: `o/r#12` is `https://github.com/o/r/issues/12`.
- Blocking: keyed `board ask <task> <text>`; keep its B<number> and wait for the
  doorbell. Update: keyed `board comment <task> <text>`.
- A return to Dev: ack its Dev turn and read the reason in `board task <task>`. Code a review
  finding only if it breaks the task's goal in its target setup or regresses the release, else
  put it under PR Risk with a thread reply. Always clear a failing gate that caused the
  return (red CI, draft, conflict), finding or not. Then keyed `board submit <turn> <sha>`.
  The take reads the "back" code block; your confirmed submit closes it `done`, no unblock.
- Close a "back" block by hand: keyed `board unblock <block> --done <commit/PR link>` once the
  fix is in, only if `board task <task>` shows it open with `addressee` worker, and that
  submit left it open or you have no Dev turn (an orchestrator or operator runs Dev). Ack it
  when you read it in `board inbox`; `not_found` means no notification, no ack. If the ack
  answers `forbidden` (the block's ring is assigned to another worker, or you authored the
  block), skip the ack: close it with `--done` if it is yours to close, otherwise leave it to
  the worker it rings. While `board task <task> --why` lists `submit_pending` or another hold,
  wait. A hold that does not clear: keyed `board ask <task> <text>` naming it; its recipient
  checks or escalates it with keyed `board escalate <block>`, up to the operator
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

## QA orchestrator contract

- On a ring, read `board inbox` and take each QA turn whose `taken` is null with keyed
  `board inbox ack <entries>`. Your own (`taken.by` is `agent:<project>/$SPUR_SESSION`) needs no
  ack. Leave a turn whose `taken.by` names the operator or a live session: an ack takes it
  back and their submit or return then fails `not_turn_taker`. Take one over with the ack only
  once its holder session has ended: `board status --detail` shows that session's `endedAt`.
- Test the turn's `head`, then keyed `board submit <turn> <sha>`: `--basis tested` (the default),
  `--basis skipped --reason <text>`, or `--basis carried --from <sha> --reason <text>` for work
  tested on an earlier head. `--from` must name a SHA with a tested submission on this task, or
  one with a carried submission on this task whose origin was tested; a head you tested but never
  submitted answers `submit_source_not_tested`.
  Failed: keyed `board return <turn> <reason>` naming what to fix.
- One session may hold several QA turns; close each by its own T<number>, in any order.
- `turn_closed` (a new head, or the operator closed the turn) or `not_turn_taker` (the operator
  took the turn over): stop that round, re-read `board inbox`, act only on a listed turn that is
  untaken or yours, leave one the operator or a live session holds, then wait for the next ring.

```sh
board inbox
board inbox ack T12 --key inbox-ack-PROJ-7-qa-take-0905
board submit T12 0123456789abcdef0123456789abcdef01234567 --basis tested --key submit-PROJ-7-qa-tested-0940
board inbox ack T13 --key inbox-ack-PROJ-8-qa-take-0906
board return T13 "Export fails on an empty list." --key return-PROJ-8-qa-return-0941
```
