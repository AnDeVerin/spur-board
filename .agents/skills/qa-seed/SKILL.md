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
- Read `references/scenarios.md` for the projects, columns, roles and session states each
  scenario sets up, and how to get a shadow marker.

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
- `fake slack post --text <t>` posts a new operator message in the orchestrators channel and
  prints its fake Slack message number `<n>`; follow up or `close` it with
  `fake slack click <n> answer --text`.
- `fake github` commands and their traps: read `references/github-fake.md`.
- `fake host cpu|ram|disk <percent> [<mount>]` sets what the daemon samples, from CPU 10, RAM 50
  and `/` at 50; reset and seed restore these. Samples come every 30 s of real time, not stand
  clock time: a `host-disk:` item needs two at 90% or more, then a tick (`pnpm stand poll`).

## Violations and reset

- `pnpm stand violations` prints the requests no fake models. A non-empty log fails the round.
- Read and save the violation log before any `pnpm stand reset` or `seed`: both drop it.
- Use `reset` to rerun a scenario from a clean state, not to clear a failure you have not recorded.
