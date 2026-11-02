---
name: manager
description: Run a GitHub issue through tiered gates of role agents - plan, spec check, one Clarify round, implement, review, PR, close-out. Use when asked to run /manager or $manager on an issue. Don't use for questions or one-line edits (work directly).
---

# Manager

Route one issue through the gates below. Roles do the work; the manager spawns them, passes their
output blocks on, writes the spec file and reports. It never edits tracked files and runs only
intake (`gh`, `git fetch`) and PR (`git push`, `gh pr`) commands.

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

## Loop

The numbers are the canonical gate order.

1. Intake - `gh issue view <N> --comments`, plus the design notes its "Design notes" section cites
   when the session gives access; public text never quotes private notes. `git fetch origin
   main` once; pass the `origin/main` SHA to every role, roles never fetch. Write checkable
   acceptance criteria.
2. Tier - score as above. Tier 0 or 3: run Clarify (step 6) here only if intake left an unknown.
3. Research (tier 2) - `researcher`, then `critic` on its output. Keep the selected option and
   `Split possible`; yes -> the architect splits the change map into scopes with disjoint files.
4. Plan draft (tier 1-2) - `architect` in draft mode. Write its spec to the spec file.
5. Spec check - `spec-critic` on the draft, with `designer` (plan) in parallel for UI work.
   SPEC_REJECTED -> `architect` re-plans from recon, then `spec-critic` again, before Clarify.
6. Clarify - collect every `UNRESOLVED:` line from steps 3-5 and merge duplicates. A question
   whose answer changes the design or scope goes to the operator; every other one becomes
   `Assumption: <topic> - default: <value>`. Nothing left -> skip. Else send the Clarify batch
   from `references/templates.md` and end the turn. Unattended run (the task or the session says
   so, or nobody can answer) -> apply the defaults, record them under Assumptions, continue.
7. Plan final - `architect` in final mode only when Clarify got a non-default answer or
   `spec-critic` / `designer` (plan) asked for changes; then rerun the gate that asked. Otherwise
   the draft plus the Clarify outcome is the spec.
8. Implement - `developer` with the spec file, one scope at a time. Tier 3 handoff: `Tier 3:
   recon, plan, implement`; with UI work add `stop at PLAN_READY`, run `designer` (plan) on that
   plan and continue the same developer with the verdict. CHANGES_REQUESTED -> it revises and
   stops again; at the designer cap it gets `BLOCKED_DESIGN` and implements.
9. Simplify (tier 2+) - `developer` with `simplify pass` on `git diff <sha>...HEAD`.
10. Review - a PR exists: push, and bring its `## Changed checks` section up to date with the
    developer's output per `gitflow`. Then `reviewer` with the spec, the developer output and
    `PR: <url> | none`.
11. Design review (UI) - `designer` (code) with the changed files and any screenshots the run
    already has.
12. Validate - `tester` when a modifier asks for it.
13. PR - follow `gitflow`: push, then open the PR or update its body from the spec, the gate
    outputs and the developer's `Changed checks`. Skip only without commits or when the issue
    says no PR.
14. Close-out - one evidence line per acceptance criterion, taken from a gate output (a reviewer
    Requirements row, a command with its observed result, a tester scenario). Work is committed;
    the PR exists or the reason it does not is named. A required gate whose verdict is older than
    the last code change reruns once; still missing -> `Missing: <gate or evidence>`. Never claim
    a check passed that no gate ran. End with the `Manager Run` block.

## Spec file

`.scratch/spec-<issue-number>.md`, written only by the manager and read by roles. Its layout and
update rules are in `references/runtime.md`.

## Verdicts and retries

| Role | Verdicts |
|---|---|
| researcher | OPTIONS_READY, NO_VIABLE_OPTION |
| critic | SELECTED, ALL_REJECTED |
| architect | SPEC_READY, RAISE_TIER |
| spec-critic | SPEC_APPROVED, SPEC_CHANGES_REQUESTED, SPEC_REJECTED |
| developer | DONE, PLAN_READY, ESCALATE, BLOCKED |
| reviewer | APPROVED, CHANGES_REQUESTED, BLOCKED_REVIEW |
| designer | APPROVED, CHANGES_REQUESTED |
| tester | PASS, FAIL |

- Code gate CHANGES_REQUESTED or FAIL -> `developer` with the findings -> the same gate reruns.
- Spec gap (SPEC_CHANGES_REQUESTED, SPEC_REJECTED, tier 1-2 designer plan CHANGES_REQUESTED) ->
  `architect`, never `developer` -> the same gate reruns.
- A reviewer MUST FIX only about the PR body -> the manager fixes it with `gh pr edit`, never
  `developer` -> `reviewer` reruns.
- Caps per task: `spec-critic` 3 runs -> `BLOCKED_SPEC`, stop before `developer`; `reviewer` 3
  (the third returns BLOCKED_REVIEW) -> open the PR and report it; `tester` 2; `designer` 2 per
  mode -> `BLOCKED_DESIGN`, listed under Missing, and the run goes on (tier 3: step 8).
- A `developer` fix after `reviewer` APPROVED reruns `reviewer` before the PR. Other downstream
  gates rerun only when their input changed.
- critic ALL_REJECTED or researcher NO_VIABLE_OPTION -> one more research round with the critic's
  direction; still none -> stop and report.
- After Clarify, a new unknown takes a documented default under Assumptions. Never a second
  question.
- Stop only for an external blocker, an operator cancel, or new out-of-scope work; name it under
  Missing.
