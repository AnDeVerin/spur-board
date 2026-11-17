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
10. Docs - `git rev-parse HEAD`, then `doc-reviewer` with the spec, every `developer` output of
    the run and its `Head:` line (`references/runtime.md`, Handoff). Skip a test or CI diff
    (modifier in `.agents/skills/manager/SKILL.md`) and record `SKIPPED - <reason>`.
11. Browser QA (UI) - a visible web UI change only: `tester` with its `Head:` line at the stand
    webUrl, never the live board. It runs the modifier scenarios; an issue naming
    `design/prototypes/<slice>/` adds the pairs of
    `.agents/skills/qa-report/references/prototype-vs-build.md`. A FAIL for no stand webUrl, or
    because the browser tool cannot run or cannot reach 127.0.0.1, is an external blocker:
    `Missing: tester - external blocker: <reason>`, no `developer` fix, no rerun; the run goes on.
12. Design review (UI) - `designer` (code) with its `Head:` line, the changed files, the step 11
    screenshots and report path, and the decisions section the `developer` returned.
13. Review - a PR exists: push, and bring its `## Changed checks` section up to date with the
    developer's output per `gitflow`. Then `reviewer` with the spec, every `developer` output of
    the run and `PR: <url> | none`.
14. Validate - `tester` when a modifier asks for it and step 11 did not run, with its `Head:` line
    (`references/runtime.md`, Handoff), recorded right before each spawn.
15. PR - follow `gitflow`: push, then open the PR or update its body from the spec, the gate
    outputs and the developer's `Changed checks`. After step 11, Testing gets a `<details>` block
    with the report table, the screenshot names, the round path relative to the artifacts
    directory and each `tester` and `designer` (code) verdict as `<verdict> (x<N>) on <sha>`; a
    prototype run fills `## Design System decisions` from the `developer` output.
    Skip only without commits or when the issue says no PR.
16. Close-out - one evidence line per acceptance criterion, taken from a gate output (a reviewer
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
| doc-reviewer | DOCS_APPROVED, DOCS_CHANGES_REQUESTED |

- Code gate CHANGES_REQUESTED, DOCS_CHANGES_REQUESTED or FAIL -> `developer` with the findings ->
  the same gate reruns. Exception: a step 11 external blocker goes under Missing with no fix.
- Spec gap (SPEC_CHANGES_REQUESTED, SPEC_REJECTED, tier 1-2 designer plan CHANGES_REQUESTED) ->
  `architect`, never `developer` -> the same gate reruns.
- A reviewer MUST FIX only about the PR body -> the manager fixes it with `gh pr edit`, never
  `developer` -> `reviewer` reruns.
- Caps per task: `spec-critic` 3 runs -> `BLOCKED_SPEC`, stop before `developer`; `reviewer` 3
  (the third returns BLOCKED_REVIEW) -> open the PR and report it; `tester` 2; `designer` 2 per
  mode -> `BLOCKED_DESIGN`, listed under Missing, and the run goes on (tier 3: step 8);
  `doc-reviewer` 2 -> the second run's DOCS_CHANGES_REQUESTED is `BLOCKED_DOCS`, its findings go
  under Missing with no fix, and the run goes on to the next step.
- A `developer` fix after `reviewer` APPROVED reruns `reviewer` before the PR. Other downstream
  gates rerun only when their input changed.
- Fix reruns: before a `developer` fix for `reviewer`, `tester` or `designer` (code), record
  `git rev-parse HEAD`. A fix whose `git diff --name-only <recorded>..HEAD` is not a test or CI
  diff reruns, in step order, `doc-reviewer`, then for a UI change `tester` (step 11) and
  `designer` (code), then `reviewer`; the gate that asked reruns in its place. Each rerun counts
  toward its cap; at the cap there is no rerun and the gate goes under Missing.
- Final head of a `tester` or `designer` (code) verdict: an APPROVED review on `headRefOid`, no
  open point -> `pnpm ci:status` once. Exit not 0 -> mark the verdict `older than <HEAD>`.
  Exit 0 and `git diff --name-only <verdict head>..HEAD` has a path under `packages/web/`
  outside `test/`, `gallery/` and `kit/`; `docs/design-system-decisions.md`; or, for an issue
  naming `design/prototypes/<slice>/`, that folder or
  `.agents/skills/qa-report/references/prototype-vs-build.md` -> each runs in step order from a
  worktree at HEAD, once per gate per task, outside its cap: `<verdict> on <sha> (final head)`.
  FAIL or CHANGES_REQUESTED -> `developer`; reruns count toward the cap, recorded after the
  `(final head)` record; at it, Testing: `Missing: <gate> - verdict older than <sha>`. No such
  path -> Testing: `no UI change since <verdict head>`.
- Close-out and `doc-reviewer`: a stale verdict reruns once only while under the cap. That run's
  DOCS_CHANGES_REQUESTED is `BLOCKED_DOCS` with its findings under Missing, no fix. At the cap ->
  `Missing: doc-reviewer - verdict older than <sha>`.
- critic ALL_REJECTED or researcher NO_VIABLE_OPTION -> one more research round with the critic's
  direction; still none -> stop and report.
- After Clarify, a new unknown takes a documented default under Assumptions. Never a second
  question.
- Stop only for an external blocker, an operator cancel, or new out-of-scope work; name it under
  Missing.
