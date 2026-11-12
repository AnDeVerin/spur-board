---
name: qa-stand
description: Run a disposable board stand for QA - up, down, status, logs, roles, refusals and cleanup, reached only through pnpm stand board|mcp. Use when you test board behaviour on a stand or run pnpm stand. Don't use for seeding state or fakes (use qa-seed) or evidence and outcome (use qa-report).
---

# QA stand

A stand is a disposable board: one process with the daemon on a temp home, dummy secrets, the
fake Slack, Spur and GitHub APIs and a network guard. `pnpm stand help` prints every command; the
flags live in `USAGE` in `packages/stand/src/cli.ts`. This card keeps the rules, traps and order.

## Lifecycle

- Run every `pnpm stand` command from the checkout of the head you test; the stand runs that
  checkout's code.
- `pnpm stand up [--scenario <name>]` detaches and prints one JSON line with `home`, `daemonUrl`,
  `controlUrl` and the seeded `scenario`. Keep `home`.
- Commands find stands under the real path of `TMPDIR`: run them all with one `TMPDIR`. One live
  stand is picked by itself; several need `--home <dir>`; none -> exit 2.
- `pnpm stand status [--json]` shows the stand and whether its API answers; no stand -> exit 2.
- `pnpm stand logs` prints the daemon log; `pnpm stand logs --stand` the stand process log.
- `pnpm stand down` stops the process group and removes the home. Capture evidence first
  (`qa-report`); nothing in the home survives.
- `up` and `down` prune dead stands. `pnpm stand down` every stand you started, on pass, fail or
  error; check with `pnpm stand status` that none is left.
- `pnpm stand up --foreground` stays attached and stops with its parent; a sidecar runs it this
  way (`docs/qa-stand.md`).

## Roles

- `pnpm stand board [--as operator|worker|orchestrator] <args...>` runs the board CLI against the
  stand; the default is `operator`.
- `operator` carries the stand's operator token and no session.
- `worker` carries a session of the worker project `stand-worker`; `orchestrator` a session of
  `stand-qa`, the orchestrator of the stand's `qa` column.
- `pnpm stand mcp [--as <role>]` runs the board MCP server against the stand with the same roles.
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

## Exit codes

- 0 ok, 1 failure, 2 usage (bad arguments, no stand, a refused wrapper command), 3 refused.
- `pnpm stand violations` exits 1 when a request reached no fake (`qa-seed`).
