# CI workflow and dependency policy

- Keep PR CI active for draft PRs, including edits and ready-for-review transitions; do not add
  a top-level path filter. Scope optional jobs through `changes` instead (`.github/workflows/ci.yml`,
  `scripts/ci.ts`).
- A code event cancels the older run for the PR; an edit never cancels and waits behind it; main
  and manual runs finish. The PR-number group and `cancel-in-progress` enforce this
  (`.github/workflows/ci.yml`). A push while a run is in progress leaves the new run pending until
  the cancelled run's `always()` `ci-ok` ends (15-20 s, longer when runners queue); an edit then
  drops it and its `ci-ok` fails with no completed code run. A retarget is an edit too. Recover by
  pushing a new commit; edit the body only after the push run has started.
- An edit runs only `pr-title`, `guardrails` and `ci-ok`. That `ci-ok` checks this run's title
  and body results and the code jobs of the newest code run on the head commit, never that run's
  `ci-ok`. A new job that does not read the title or body carries the edit guard and joins
  `EDIT_SKIPPED`. To recheck an edit, rerun the edit run: a code run rerun replays its old
  payload (`scripts/ci-runs.ts`, `scripts/ci-runs.test.ts`, `describe('edit runs in ci.yml',`).
- `ci-ok` writes the test and stand wall time per Node leg to the job summary and warns when stand
  is slower; the step never fails `ci-ok` (`scripts/ci-runs.ts`, `standTiming`).
- CI `test` and `stand` jobs: `check:full --only test` and `--only stand` (`.github/workflows/ci.yml`).
- CI `package-smoke` job: `pnpm package:smoke` and `pnpm upgrade:smoke` on PRs, then
  `pnpm update:smoke`; on a PR it runs only when `classifyChanges` in `scripts/ci.ts` marks a
  package change, and not on an edit. Pushes and dispatches smoke the candidate in `release-smoke`.
- `.github/workflows/nightly.yml`: runs the published package's `--version`; on failure
  `scripts/nightly.ts` opens or updates one `ci-nightly` issue.
- Run test, stand and package-smoke jobs on Node 24 and 26; pin workflow actions to commit SHAs and give
  each job a timeout (`.github/workflows/ci.yml`).
- Report a scheduled workflow through `scripts/nightly.ts` under its own issue title. Grant
  `issues: write` only to its `report` job, list every other job in that job's `needs`, and gate
  it to `main` (`scripts/nightly.test.ts`, `describe('scheduled workflows',`).
- The nightly test run shuffles with the run id as seed; reproduce a failing order with
  `--sequence.shuffle --sequence.seed=<run id>`; the shuffled runs name every Vitest project
  (`.github/workflows/nightly-tests.yml`, `scripts/nightly.test.ts`, `describe('nightly-tests.yml',`).
- Keep knip in the `quality` job, not in scheduled workflows (`.github/workflows/ci.yml`).
- Run Stryker weekly over `packages/core/src/domain` with no threshold: the score goes to the job
  summary, the report to the `mutation-report` artifact. Call it as
  `GITHUB_ACTIONS=false pnpm exec stryker run`, never through `env`, which hides it from knip.
  Keep `vitest.pool: "forks"` so the testkit env scrub applies, and load the runner by its
  `./node_modules` path, which pnpm's plugin glob misses (`.github/workflows/mutation.yml`,
  `stryker.config.json`).
- Keep local Vitest reporters at their defaults. In CI, configure default, github-actions and
  junit reporters with `reports/junit.xml`; upload `reports/` on test failure so annotations and
  JUnit evidence survive (`vitest.config.ts`, `.github/workflows/ci.yml`).
- Run actionlint and zizmor when `.github/` changes; `changes` selects the workflows job and
  `ci-ok` accepts its skip only for unrelated changes (`.github/workflows/ci.yml`, `scripts/ci.ts`).
- Release only after `ci-ok` succeeds on a main push. Grant `id-token: write` for trusted
  publishing and do not pass an npm token; `release.config.cjs` disables the npm plugin's direct
  publish (`.github/workflows/ci.yml`, `release.config.cjs`).
- Smoke the release candidate outside `release`: `release-build` packs it at the dry-run version
  with `contents: read` and no cache, `release-smoke` checks its sha256 and smokes it, and
  `release` publishes only those bytes and fails closed on a version or sha256 mismatch. After
  that failure re-run all jobs, not failed jobs: the old outputs are stale
  (`scripts/release-package.ts`, `scripts/ci.test.ts`, `describe('release workflow isolation',`).
- Keep Renovate on its weekly schedule with a seven-day minimum release age and no automerge.
  The runtime group commits as `fix(deps)`, so it releases; everything else commits as
  `chore(deps)` (`renovate.json`, `release.config.cjs`).
- Renovate tags every catalog entry `pnpm.catalog.default`, so the last packageRule names the
  third-party dependencies the published package installs or inlines. A dependency only a
  `./testing` export uses, like ws, stays out. Add a new runtime dependency there;
  `scripts/renovate.test.ts` (`describe('renovate.json',`) fails until you do.
- Keep `@types/node` on the major of the oldest Node in `engines.node`. Change its
  `allowedVersions` rule and catalog range with `engines.node` (`renovate.json`,
  `pnpm-workspace.yaml`, `package.json`, `packages/cli/package.json`).
- Keep pnpm's seven-day minimum release age and strict dependency builds. Permit install scripts
  only through `allowBuilds` (`pnpm-workspace.yaml`).
- Keep audit exceptions keyed to an exact advisory ID with a reason and removal path; the
  scheduled security job still runs `pnpm audit` (`pnpm-workspace.yaml`,
  `.github/workflows/security.yml`).
