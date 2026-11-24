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

- Each file of a round and the command that writes it: read `references/layout.md`.

## Capture order

- Save the violation log before any `pnpm stand reset`, `seed` or `demo reset` (`qa-seed`), and
  everything else before `pnpm stand down`.
- Take the stand state from `pnpm stand status --json`: it leaves out the control token. Never
  copy the home's manifest, `secrets.env`, the token file or `config.yaml`; copy named files only,
  never the whole home.
- Snapshot the database after the last action with `copyDatabase`, never `cp`: `references/layout.md`.

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
- A prototype round adds the State | Theme | Verdict table after the coverage line
  (`references/prototype-vs-build.md`).

## Outcome on the live board

Only in a board QA round, with bare `board` on the live task. In a manager run post nothing to the
live board: return the verdict, the reason and the report path to the caller.

- The round's executor follows `turnExecutor` (`packages/core/src/domain/dispatch.ts`): column
  orchestrator `operator` -> the operator; `none` at Review, Product Review, QA or Ready to
  Merge -> the operator; `none` at Dev -> the task's live worker, else the operator; any other
  value -> that column's orchestrator project.
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
