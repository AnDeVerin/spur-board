# Verdicts and retries

Step numbers are the Loop steps in `references/gates.md`.

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
- Final head of each `tester` or `designer` (code) gate whose modifier applies to the task at
  HEAD, recorded verdict or not, whatever its `## Acceptance gates` line says (a stale `n/a` gets
  the passed head or the placeholder; a gate whose modifier no longer applies gets `n/a`): no
  open point, and an APPROVED review on `headRefOid` or an acceptance-gates-only failure ->
  fetch, check out `headRefOid`, `pnpm ci:status <N>` once. Exit not 0 with another failed job ->
  mark the verdict `older than <HEAD>`; an acceptance-gates-only failure never does.
  Acceptance-gates-only failure: `ci:status` lists the acceptance-gates job as the only counted
  failed job, the ci run is completed, and `gh run view <its ci run id> --log-failed` once shows
  `ci-ok: acceptance-gates failure FAIL` and no other `ci-ok: ... FAIL` line except
  `ci-ok: FAIL`; otherwise wait for the next notification. `ci:status` neither counts ci-ok nor
  prints its log, `--log-failed` prints nothing for an unfinished run, and on a PR edit ci-ok
  also carries the reused code run's failures.
  Otherwise, per gate, `<passed head>` is the head of its last tester PASS or designer APPROVED,
  never a FAIL or CHANGES_REQUESTED head. No passed head, or
  `git diff --no-renames --name-only <passed head>..HEAD` (as CI) has a path under
  `packages/web/` outside `test/`, `gallery/` and `kit/`; `docs/design-system-decisions.md`; or,
  for an issue naming `design/prototypes/<slice>/`, that folder or the step 11 pairs file -> that
  gate runs, in step order, from a worktree at HEAD, once per gate per task, outside its cap:
  `<verdict> on <sha> (final head)`.
  FAIL or CHANGES_REQUESTED -> `developer`; reruns count toward the cap, recorded after the
  `(final head)` record; at it, Testing: `Missing: <gate> - verdict older than <sha>`. No such
  path -> Testing: `no UI change since <passed head>`; never without a passed head.
- After a final-head run with tester PASS or designer APPROVED, and after each
  `no UI change since`, write that head into the PR body's `## Acceptance gates` (`gitflow`);
  after FAIL or CHANGES_REQUESTED keep the gate's last passed head. `n/a` only for a gate this
  task does not use; an applicable gate with no passed head keeps the template placeholder, not
  `n/a`: CI stays red, Testing names it under Missing, and a human decides. The cap never
  excuses the final-head run; CI acceptance-gates stays red until each gate's SHA has no UI diff
  to the PR head. CI counts only the base paths above (`isUiPath`, `scripts/acceptance-gates.ts`;
  change both together); the `design/prototypes/<slice>/` clause stays a manager check.
- Close-out and `doc-reviewer`: a stale verdict reruns once only while under the cap. That run's
  DOCS_CHANGES_REQUESTED is `BLOCKED_DOCS` with its findings under Missing, no fix. At the cap ->
  `Missing: doc-reviewer - verdict older than <sha>`.
- critic ALL_REJECTED or researcher NO_VIABLE_OPTION -> one more research round with the critic's
  direction; still none -> stop and report.
- After Clarify, a new unknown takes a documented default under Assumptions. Never a second
  question.
- Stop only for an external blocker, an operator cancel, or new out-of-scope work; name it under
  Missing.
