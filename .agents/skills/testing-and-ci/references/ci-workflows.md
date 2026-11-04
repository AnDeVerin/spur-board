# CI workflow and dependency policy

- Keep PR CI active for draft PRs, including edits and ready-for-review transitions; do not add
  a top-level path filter. Scope optional jobs through `changes` instead (`.github/workflows/ci.yml`,
  `scripts/ci.ts`).
- Cancel older runs for the same PR, but let main and manual runs finish. The PR-number group
  and `cancel-in-progress` expression enforce this (`.github/workflows/ci.yml`).
- Run test and package-smoke jobs on Node 24 and 26; pin workflow actions to commit SHAs and give
  each job a timeout (`.github/workflows/ci.yml`).
- Keep local Vitest reporters at their defaults. In CI, configure default, github-actions and
  junit reporters with `reports/junit.xml`; upload `reports/` on test failure so annotations and
  JUnit evidence survive (`vitest.config.ts`, `.github/workflows/ci.yml`).
- Run actionlint and zizmor when `.github/` changes; `changes` selects the workflows job and
  `ci-ok` accepts its skip only for unrelated changes (`.github/workflows/ci.yml`, `scripts/ci.ts`).
- Release only after `ci-ok` succeeds on a main push. Grant `id-token: write` for trusted
  publishing and do not pass an npm token; `release.config.cjs` disables the npm plugin's direct
  publish (`.github/workflows/ci.yml`, `release.config.cjs`).
- Keep Renovate on its weekly schedule with a seven-day minimum release age, no automerge and
  `chore(deps)` commits (`renovate.json`). Match catalog-specific dependency types when grouping.
- Keep pnpm's seven-day minimum release age and strict dependency builds. Permit install scripts
  only through `allowBuilds` (`pnpm-workspace.yaml`).
- Keep audit exceptions keyed to an exact advisory ID with a reason and removal path; the
  scheduled security job still runs `pnpm audit` (`pnpm-workspace.yaml`,
  `.github/workflows/security.yml`).
