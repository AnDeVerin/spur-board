---
name: qa-seed
description: Put a stand into a known state - scenarios, fakes, the stand clock, wait, poll, reset and the violation log. Use when you seed or drive a stand with pnpm stand. Don't use for starting or stopping it (use qa-stand) or evidence (use qa-report).
---

# QA seed

Every command here acts on a running stand (`qa-stand`). `pnpm stand help` lists the commands,
verbs and scenario names; this card keeps the rules and traps.

## Scenarios

- Each scenario's summary and seed live in `packages/stand/src/scenarios/`.
- Seed at start with `pnpm stand up --scenario <name>`, or later with `pnpm stand seed <name>`
  followed by `pnpm stand wait scenario`.
- The seeded task keys, block IDs and sessions are in the `scenario` field of the `up` line and of
  `pnpm stand status --json`. Take names from there, not from the scenario source.
- Quote task keys in the shell: `'stand-org/board#1'`; an unquoted `#` starts a comment.
- The `dispatch-*` scenarios run project `stand` in `dispatcher.mode: on` with To Do, Dev, Review
  (`--as orchestrator`), Ready to Merge (the operator) and Done.
- The curator scenarios (`question-to-curator`, `curator-escalation`, `curator-absent`) add
  `stand-curator` as the stand project's curator; their seeds set the worker and curator sessions
  `--state waiting` so rings go out.
- `dispatch-course-check` adds `stand-curator` as the curator too: answer its course block
  `--as curator`, then `pnpm stand poll`.
- `dispatch-dead-executor` kills the worker role session and keeps its link. To hand the task to
  a new worker, create it with `fake spur session` and `poll`, then `link.remove` the dead
  session and `link.add` the new one; without the removal the new one links as `other` and gets
  no worker turns.

## Waiting and time

- Wait on a concrete condition with `pnpm stand wait <condition> [--timeout <s>]`, never `sleep`;
  the timeout is 0-600 s.
- `pnpm stand wait scenario` with nothing seeded exits 1.
- Follow `pnpm stand poll` with `wait sources-polled` or `wait outbox-drained`.
- `pnpm stand clock` moves forward only; run `pnpm stand poll` after a shift.

## Fakes

- Drive the fakes with `pnpm stand fake slack ...`, `pnpm stand fake spur ...` and
  `pnpm stand fake github ...`.
- `fake spur session` takes `--status` from `SESSION_STATUSES` (default `running`) and `--state`
  from `SESSION_HEALTH_STATES` (default `working`), both in `packages/contracts/src/facts.ts`.
  The fake stores any string; the board reports other values as unknown.
- A session at `--state working` (the default) holds the board's rings to it; `--state waiting`
  then `pnpm stand poll` lets them go (`packages/core/src/app/doorbells.ts`).
- `fake spur session <id> --queue hold` keeps later sends in the session's Spur queue, as a busy
  session does, so the board holds the next ring; `--queue deliver` empties it. Run
  `pnpm stand poll` after either so the board reads the queue.
- `fake github pr <n> comment` and `fake github pr <n> review <state>` add a comment, or a review
  on the head, at the stand clock. The author is `--author`, else `stand-reviewer`, or `stand-bot`
  with `--bot`; keep bots off `stand-reviewer`, or its approvals stop counting.

## Violations and reset

- `pnpm stand violations` prints the requests no fake models. A non-empty log fails the round.
- Read and save the violation log before any `pnpm stand reset` or `seed`: both drop it.
- Use `reset` to rerun a scenario from a clean state, not to clear a failure you have not recorded.
