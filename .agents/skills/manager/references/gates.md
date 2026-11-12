# Manager gate procedure

## Loop

The numbers are the canonical gate order.

1. Intake - `gh issue view <N> --json title,body,comments` (without a TTY, `--comments` prints
   only the comments), plus the design notes its "Design notes" section cites when the session
   gives access; public text never quotes private notes. `git fetch origin main` once; pass the
   `origin/main` SHA to every role, roles never fetch. Write checkable acceptance criteria.
2. Tier - score with the table in `.agents/skills/manager/SKILL.md`. Tier 0 or 3: run Clarify
   (step 6) here only if intake left an unknown.
3. Research (tier 2) - `researcher`, then `critic` on its output. Keep the selected option and
   `Split possible`; yes -> the architect splits the change map into scopes with disjoint files.
4. Plan draft (tier 1-2) - `architect` in draft mode. Write its spec to the spec file.
5. Spec check - `spec-critic` on the draft, with `designer` (plan) in parallel for UI work.
   SPEC_REJECTED -> `architect` re-plans from recon, then `spec-critic` again, before Clarify.
6. Clarify - collect every `UNRESOLVED:` line from steps 3-5 and merge duplicates. A question
   whose answer changes the design or scope goes to the operator; every other one becomes
   `Assumption: <topic> - default: <value>`. Nothing left -> skip. Else send the Clarify batch
   from `.agents/skills/manager/references/templates.md` and end the turn. Unattended run (the task or the session says
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
12. Validate - `tester` when a modifier asks for it, with its `Head:` line (`references/runtime.md`,
    Handoff), recorded right before each spawn.
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
update rules are in `.agents/skills/manager/references/runtime.md`.

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
