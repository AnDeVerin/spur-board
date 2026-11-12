---
name: qa-stand
description: Run a disposable board stand for QA - up, down, status, logs, roles, refusals and cleanup, reached only through pnpm stand board|mcp. Use when you test board behaviour on a stand or run pnpm stand. Don't use for seeding state or fakes (use qa-seed) or evidence and outcome (use qa-report).
---

# QA stand

A stand is a disposable board with fake Slack, Spur and GitHub APIs (`docs/qa-stand.md`).
`pnpm stand help` prints every command and flag; this card keeps the rules, traps and order.

## Lifecycle

- Run every `pnpm stand` command from the checkout of the head you test; the stand runs that
  checkout's code.
- `pnpm stand up [--scenario <name>]` detaches and prints one JSON line with `home`, `daemonUrl`,
  `controlUrl` and the seeded `scenario`. Keep `home`.
- Commands find stands under the real path of `TMPDIR`: run them all with one `TMPDIR`. One live
  stand is picked by itself; several need `--home <dir>`.
- Check the stand with `pnpm stand status` and read its logs with `pnpm stand logs`.
- `pnpm stand down` stops the process group and removes the home; capture evidence first
  (`qa-report`).
- `up` and `down` prune dead stands. `pnpm stand down` every stand you started, on pass, fail or
  error; check with `pnpm stand status` that none is left.
- A sidecar runs `pnpm stand up --foreground` (`docs/qa-stand.md`).

## Roles

- `pnpm stand board` and `pnpm stand mcp` take `--as operator|worker|orchestrator`; the default is
  `operator`.
- `operator` carries the stand's operator token and no session.
- `worker` carries a session of the worker project `stand-worker`; `orchestrator` a session of
  `stand-qa`, the orchestrator of the stand's `qa` column.
- The wrapper refuses `service`, `update`, `rollback`, `skills` and `token create` with exit 2:
  they act on the real machine or write outside the stand.

## Live board

- `pnpm stand board` and `pnpm stand mcp` are the only ways to reach a stand.
- A bare `board` command reaches the live board, not the stand. Use it only for the outcome on
  the live task in a board QA round (`qa-report`); never to drive a scenario.

## Refusals

`up` refuses with exit 3 and `stand refused (<reason>)`:

| Reason | Cause | Fix |
|---|---|---|
| `live_home` | stand root inside the live board's home | set `TMPDIR` elsewhere |
| `unsafe_root` | `TMPDIR` or a parent owned by another user, or group- or world-writable without the sticky bit | `TMPDIR` = a private directory, mode 700 |
| `live_port` | the live board's port | `--port 0` or 4780-4799 |
| `port_range` | port outside the stand range | `--port 0` or 4780-4799 |
| `external_secrets` | real credential variables in the environment | run the printed `env -u <NAME> ... pnpm stand up` |
| `env_proxy` | the Node env proxy is on | start without it |

- Never put real credentials back to get past a refusal; the guard keeps the stand off real
  services.
- Exit 2 is also bad arguments, no stand found, or a refused wrapper command.
