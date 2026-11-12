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
- There are no fake PR comments or reviews yet, and no Jira fake: Jira polls fail by design and
  show in the daemon log, not in the violation log.

## Violations and reset

- `pnpm stand violations` prints the requests no fake models. A non-empty log fails the round.
- Read and save the violation log before any `pnpm stand reset` or `seed`: both drop it.
- Use `reset` to rerun a scenario from a clean state, not to clear a failure you have not recorded.
