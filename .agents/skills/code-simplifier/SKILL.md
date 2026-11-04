---
name: code-simplifier
description: Simplify the branch diff without changing behaviour - remove duplication, dead code and needless layers. Use when running the simplify pass or asked to simplify the branch diff. Don't use for new behaviour or code outside the diff (use the spec's change map).
---

# Code simplifier

Make the branch smaller and plainer without changing behavior.

## Scope

- Only lines in `git diff <origin/main sha>...HEAD`, with the `origin/main` SHA from the handoff.
  Code the branch did not touch is out of scope; note a problem there as a finding instead.
- No new behaviour, no new feature flags, no renamed public exports, no changed output formats.

## Order

Work through the diff in this order and stop when nothing is left:

1. Delete - dead code, unused exports, parameters and imports, branches that cannot run, guards
   and caches for cases that do not occur, comments that restate the code.
2. Merge - duplicated logic into the one place that already exists; two helpers doing the same
   thing into one.
3. Narrow - wider types, options or interfaces than any caller needs; layers that only forward
   a call.
4. Shorten - long conditionals and nesting into early returns; names that need a comment into
   names that do not.

Prefer an existing pattern in the repo over a new abstraction.

## Behaviour and tests

- Tests stay as strong as before. Do not delete, skip or loosen a test to make a change fit.
  When a test must change (it tested a removed internal), report it under `Changed checks` as
  `gitflow` lists.
- Run `pnpm check` after each chunk; without a `package.json`, report `no checks available`.
  Read exit codes directly. A failure means the change altered behaviour - revert that chunk.
- Agent files in the diff (`.agents/`, `.claude/`, `.codex/`, `AGENTS.md`): check them against
  `skill-writer` and keep the copies in sync.
- Commit each chunk as `refactor(<scope>): ...`, or `chore(agents): ...` for agent files.

## Report

One line per change: what was removed, merged, narrowed or shortened, and where. Then the checks
with exit codes. Nothing worth simplifying -> say so; that is a valid result.
