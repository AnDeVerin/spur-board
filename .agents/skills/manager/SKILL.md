---
name: manager
description: Run a GitHub issue through tiered gates of role agents - plan, spec check, one Clarify round, implement, review, PR, close-out. Use when asked to run /manager or $manager on an issue. Don't use for questions or one-line edits (work directly).
---

# Manager

Route one issue through the gates below. Roles do the work; the manager spawns them, passes their
output blocks on, writes the spec file and reports. It never edits tracked files and runs only
intake (`gh`, `git fetch`), PR (`git push`, `gh pr`) and read-only handoff (`git rev-parse HEAD`)
commands.

Role files: `.agents/agents/<role>.md`. Branches, commits and the PR: `gitflow`. Spawning,
handoff and tracking details: `references/runtime.md`. Report and question templates:
`references/templates.md`.

## Rules

- One issue, one branch, one PR. Never merge, approve, or push to `main`.
- Ask nothing outside Clarify, and run Clarify at most once per task. Resolve unknowns from the
  code and the issue first.
- The smallest team that covers the tier and the modifiers. One gate, one owner, one output.
- Run `spec-critic` and `designer` (plan) in parallel; both are read-only. `developer` scopes run
  one after another in the same worktree, so no commit picks up another scope's files.
- Local checks only. Never wait for or poll remote CI.
- No verdict is never a pass. A role that died, returned nothing, or returned no `Verdict:` line
  gets one rerun; still none -> stop with `Missing: <gate>`.

## Tiers

Score ambiguity and blast radius from intake, then read the tier from the table.

- Ambiguity: low - the issue names the behaviour and testable criteria; med - one design choice
  is open; high - several viable approaches or an unclear requirement.
- Blast radius: low - one package, no shared contract; med - several modules or a shared helper;
  high - contracts, storage schema, CI, auth, agent workflow files, or several packages.

| Ambiguity \ Blast | low | med | high |
|---|---|---|---|
| low | 0 | 1 | 1 |
| med | 1 | 1 | 2 |
| high | 2 | 2 | 2 |

| Tier | Planning gates |
|---|---|
| 0 direct | none - `developer` works from the issue |
| 1 self-plan | `architect` -> `spec-critic` |
| 2 strong-plan | `researcher` -> `critic` -> `architect` -> `spec-critic` |
| 3 end-to-end | none - one `developer` does recon, plan and implementation |

Pick tier 3 instead of the table when the plan can only be found by trying code (a spike, an
unexplained failure, a toolchain upgrade).

Modifiers, on any tier:
- Visible web UI change: `designer` plan pass (on the spec, or on the tier 3 developer's plan) and
  code pass.
- Tier 2 and up: a simplify pass by `developer` after implementation.
- `.agents/`, `.claude/`, `.codex/` or `AGENTS.md` touched: `reviewer` checks the copies match.
- Any committed change (code, docs or config): `reviewer`, then the PR.
- Behaviour that checks cannot show (a CLI flow, an API call, a UI flow), or validation the issue
  asks for: `tester`.

Escalation: architect `Verdict: RAISE_TIER` or developer `Verdict: ESCALATE` -> re-route to the
higher tier's team from the current gate. Never lower a tier.

## Gate procedure

Run the gates in references/gates.md; keep its order, verdict caps and spec-file rules.
