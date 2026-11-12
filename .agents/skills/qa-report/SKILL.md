---
name: qa-report
description: Plan, evidence and outcome of a QA round - the qa/<task>/<sha8>/r<N>/ layout, the report and what goes to the live board on pass or fail. Use when you plan, record or close a tester round. Don't use for running the stand (use qa-stand).
---

# QA report

## Where

- Evidence goes in `$SPUR_SESSION_ARTIFACTS_DIR/qa/<task>/<sha8>/r<N>/`, or the same layout in
  another directory outside the repo; never inside the checkout.
- `<task>` is the task key, or `issue-<issue-number>` in a manager run with no task key, with
  each character outside `[A-Za-z0-9._-]` replaced by `-`; `<sha8>` the first 8 characters of
  the tested head; `<N>` the next free round number. Never overwrite an earlier round.

## Layout

Run the commands from the tested checkout (`qa-stand`) with `R` set to the round directory;
`<home>` is the `home` from `pnpm stand up`.

```
qa/<task>/<sha8>/r<N>/
  plan.md            written before the first scenario
  report.md          written last
  violations.json    pnpm stand violations > "$R/violations.json"
  stand.json         pnpm stand status --json > "$R/stand.json"
  events.jsonl       pnpm stand board task history '<key>' --json >> "$R/events.jsonl"
                     (one line per stand task the round touched)
  fakes-outbox.json  pnpm stand fake slack outbox > "$R/fakes-outbox.json"
  fakes-spur.json    pnpm stand fake spur inspect > "$R/fakes-spur.json"
  daemon.log         pnpm stand logs > "$R/daemon.log"
  board.sqlite       cp "<home>/board.sqlite" "<home>/board.sqlite-wal" "<home>/board.sqlite-shm" "$R/"
  board.sqlite-wal   (same cp)
  board.sqlite-shm   (same cp)
```

## Capture order

- Save the violation log before any `pnpm stand reset` or `seed` (`qa-seed`), and everything
  else before `pnpm stand down`.
- Take the stand state from `pnpm stand status --json`: it leaves out the control token. Never
  copy the home's manifest, `secrets.env`, the token file or `config.yaml`; copy named files only,
  never the whole home.
- Copy the three database files in one `cp` after the last action. The daemon still runs, so the
  copy is for reading, not a backup. The host may have no sqlite CLI; read it with Node.

## Plan

- The plan names the tested head, `<main-sha>` and the A/B base when there is one, and per
  acceptance criterion the scenario, its commands and the expected result.

## Report

- Line 1 is the coverage: `criteria <covered>/<total>`.
- Then failures first, each with the criterion, the command, what it printed and the evidence
  file; then passes.
- Name each uncovered criterion as one of: not reproduced (the attempts made), unreachable (the
  search command and the SHA it ran on), or pre-existing (shown on the A/B base, with
  `<main-sha>`).

## Outcome on the live board

Only in a board QA round, with bare `board` on the live task. In a manager run post nothing to the
live board: return the verdict, the reason and the report path to the caller.

- The round's executor follows `turnExecutor` (`packages/core/src/app/turns.ts`): column
  orchestrator `operator` -> the operator; `none` -> the task's live worker, else the operator;
  any other value -> that column's orchestrator project.
- Pass: one keyed `board comment <task> "<summary>; report: <path>" --key <key>`, naming
  submission of the tested head as the executor's step. There is no submit command; never invent
  one.
- Fail: first a keyed `board comment <task> "<reason>; report: <path>" --key <key>`. Then:
  - with the `operator` or `column-orchestrator` grant (`block.create` in
    `packages/contracts/src/ops/catalog.ts`):
    `board block <task> --type external --reason "<reason>; report: <path>" --key <key>`;
  - without it, as a project agent:
    `board ask <task> "<reason>; report: <path>" --key <key>`. `blockAddressee`
    (`packages/core/src/domain/blocks/blocks.ts`) routes it: asked by the column's curator -> the
    operator; column orchestrator `operator` -> the operator; an orchestrator project other than
    the asker -> that orchestrator; otherwise the curator if any, else the operator.
- A worker session holds neither block grant (`packages/contracts/src/ops/roles.ts`); never run
  `board block` from one.
- Keys follow `packages/skills/spur-board/SKILL.md`.
