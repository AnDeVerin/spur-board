---
name: qa-seed
description: Put a stand into a known state - scenarios, fakes, the stand clock, wait, poll, reset and the violation log. Use when you seed or drive a stand with pnpm stand. Don't use for starting or stopping it (use qa-stand) or evidence (use qa-report).
---

# QA seed

Every command here acts on a running stand (`qa-stand`). Flags and the scenario list are in
`pnpm stand help` and `USAGE` in `packages/stand/src/cli.ts`.

## Scenarios

- Scenario names are in `pnpm stand help`; each one's summary and seed live in
  `packages/stand/src/scenarios/`.
- Seed at start with `pnpm stand up --scenario <name>`, or later with `pnpm stand seed <name>`:
  `seed` resets the stand onto the scenario's config, seeds it, and you then run
  `pnpm stand wait scenario`.
- The seeded task keys, block IDs and sessions are in the `scenario` field of the `up` line and of
  `pnpm stand status --json`. Take names from there, not from the scenario source.
- Quote task keys in the shell: `'stand-org/board#1'`; an unquoted `#` starts a comment.

## Waiting

- Wait on a concrete condition with `pnpm stand wait <condition> [--timeout <s>]`, never `sleep`.
  Conditions: `api-ready`, `sources-polled`, `outbox-drained`, `scenario`. Timeout 0-600 s,
  default 30.
- `pnpm stand wait scenario` checks the seeded scenario has settled; with nothing seeded it exits 1.
- `pnpm stand poll [source]` restarts every source's poll now, then ticks and pulses the outbox;
  follow it with `wait sources-polled` or `wait outbox-drained`.

## Clock

- `pnpm stand clock +<n><s|m|h|d>` moves the stand clock forward, never back, then ticks and
  pulses the outbox. Timers stay real.
- After a shift run `pnpm stand poll`, which restarts the stale window.

## Fakes

- `pnpm stand fake slack outbox` lists messages posted to the fake Slack and any call to a Slack
  method it lacks; `pnpm stand fake slack click <n> <button>` presses a button as the operator.
- `pnpm stand fake spur session <id>` creates or updates a fake Spur session; `restart`, `fail`,
  `clear` and `inspect` change the instance, add or drop failure rules, and print its state.
- `pnpm stand fake github pr <n> <verb>` and `pnpm stand fake github issue <n> <verb>` drive pull
  requests and issues; `pnpm stand fake github fail <mode>` fails the API until `clear` or reset.
- The default fake repo is `stand-org/board`; pass `--repo owner/name` for another.
- There are no fake PR comments or reviews yet, and no Jira fake: Jira polls fail by design and
  show in the daemon log, not in the violation log.

## Violations and reset

- `pnpm stand violations` prints the requests no fake models and exits 1 when there are any. A
  non-empty log fails the round.
- Read and save the violation log before any `pnpm stand reset` or `seed`: `reset` stops the
  daemon, restores the home, seeds the last scenario again and drops the log.
- Use `reset` to rerun a scenario from a clean state, not to clear a failure you have not recorded.
