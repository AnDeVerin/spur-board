# Scenario notes

- The `dispatch-*` scenarios run project `stand` in `dispatcher.mode: on` with To Do, Dev, Review
  (`--as orchestrator`), Ready to Merge (the operator) and Done.
- `dispatch-new-head-in-ready-to-merge` and `dispatch-ci-red-new-head-in-product-review` add
  Product Review and run Review, Product Review and Ready to Merge by `--as orchestrator`.
- `qa-carried` and `qa-skipped` add QA (`--as orchestrator`) to the `dispatch-*` board; the card
  waits in Ready to Merge with the matching QA submission. `dispatch-happy-path` has no QA column.
- `approval-stale`, `approval-stale-quiet`, `approval-multi`, `approval-rewritten`,
  `approval-uncounted` and `approval-stale-no-watch` wait in Ready to Merge on the `dispatch-*`
  board with seeded approvals on PR #1 and `approvalWatch` `[back/, front/]` (none for
  `approval-stale-no-watch`, whose chip caps six watched entries); each `settled` checks the
  `prSummary[].approvals` facts.
- `dispatch-ci-pending-after-submit` and `dispatch-ring-closed-turn` set the conductor session
  `--state waiting` so rings to it go out.
- The curator scenarios (`question-to-curator`, `curator-escalation`, `curator-absent`,
  `project-question-to-operator`) add `stand-curator` as the stand project's curator; their seeds
  set the worker and curator sessions `--state waiting` so rings go out.
- `operator-conversation` gives `stand-curator` the short name `cur` and `stand-qa` the short name
  `qa`, the default addressee; read a conversation with `board inbox --as curator` or
  `--as orchestrator`.
- `dispatch-course-check` adds `stand-curator` as the curator too, and sets the worker and
  curator sessions `--state waiting`, so only the course check holds the worker's rings: answer
  its course block `--as curator`, then `pnpm stand poll`.
- `dispatch-dead-executor` kills the worker role session and keeps its link. To hand the task to
  a new worker, create it with `fake spur session` and `poll`, then `link.remove` the dead
  session and `link.add` the new one; without the removal the new one links as `other` and gets
  no worker turns.
- `columns-basic` writes `task.column` directly, so `shadowDiffers` stays false and no shadow
  marker shows. For one, in the default `dispatcher.mode: shadow`, move a task with `--correct`,
  backwards for a stable result:
  `pnpm stand board move 'stand-org/board#5' dev --correct --reason qa` changes only its shadow
  column, and `status` shows `shadowDiffers: true`. The gates settle a forward move from the new
  column at once, so its shadow column can move on (`docs/cli.md`).
- `external-review-quiet` adds External Review with `quietAfterMs: 300000` before Ready to Merge
  on the `dispatch-*` board; the seed shifts the clock six minutes, so the card waits there with
  an `external-quiet:` inbox item. An approval (`fake github review`) and `poll` clear it.
- `ready-mirror` gives project `stand` To Do, Triage, Ready for Dev, Dev and Done, with Ready for
  Dev mirroring `Status = Ready` of the fake Project `stand-org/1` through source
  `github-project:stand:stand-org/1`. A manual move into or out of Ready for Dev is refused:
  move a task with `fake github issue <n> project-status` and `poll`.
