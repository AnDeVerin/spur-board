---
name: testing-and-ci
description: Rules for tests, Vitest, testkit, checks and CI. Use when changing tests, adding a package, fixing lint or type failures, or editing packages/testkit/, scripts/check*, vitest.config.ts or .github/workflows/. Don't use for agent-file checks (use skill-writer) or PR bodies (use gitflow).
---

# Testing and CI

## Local checks

- Use the root Vitest projects in `vitest.config.ts`; package tests reach CI through the root
  include pattern, not per-package `test` scripts.
- After changing exports, run `pnpm check:full --only knip`: changed-mode `pnpm check` skips knip
  (`scripts/check.ts`, `buildSteps`). Test imports count as knip usage; inspect unused exports in
  script entry points by hand (`knip.json`, `package.json`).
- Keep a source helper private when no other module imports it; full knip reports same-file-only
  exports under this repo's default configuration (`knip.json`).
- Confirm a filtered test command ran test files. A missing package script or unmatched pnpm
  filter can exit successfully without exercising a test (`package.json`,
  `packages/cli/package.json`).
- Run the TypeScript step for `expectTypeOf` assertions; Vitest does not typecheck them. Package
  tsconfigs include `test`, and `buildSteps` runs `tsc --noEmit` (`scripts/check.ts`).
- Give a new package a TypeScript source file before running typecheck, and add runtime
  dependencies when its source uses them; an empty scaffold can fail TypeScript or knip
  (`packages/daemon/tsconfig.json`, `scripts/check.ts`, `knip.json`).
- Read a changing abort flag through a function when a later check follows `await`; direct
  narrowing can survive the await and trip strict lint (`packages/adapters/src/runner/runner.ts`,
  `eslint.config.js`).
- Keep timing-sensitive startup checks in their own Vitest project. Select `startup` explicitly;
  compare base and branch under similar load before changing the threshold (`vitest.config.ts`,
  `scripts/check.ts`, `packages/cli/test/startup.test.ts`, `describe('board startup',`).

## Test isolation

- Run tests through the root config so `packages/testkit/src/global-setup.ts` scrubs credentials
  and assigns temporary home directories before workers fork.
- The network guard in `packages/testkit/src/setup.ts` patches sockets in a Vitest worker only.
  A spawned child needs its own isolation; pass `BOARD_HOME` explicitly when a daemon test needs
  it (`packages/testkit/src/network.ts`, `packages/testkit/src/env.ts`).
- When a test invokes a CI helper, replace inherited `GITHUB_OUTPUT` with a temporary file and
  clear event variables (`scripts/ci.test.ts`, `describe('ci.ts CLI',`).
- For `vi.waitFor` near a short timer, set a shorter polling interval and assert the state before
  acting; its default poll can otherwise mask the race (`packages/daemon/test/lifecycle.test.ts`,
  `describe('runDaemon',`).

## CI and dependencies

- Add a new CI job to `ci-ok.needs` and its verdict handling in `scripts/ci.ts`; accepted skips
  are explicit there (`.github/workflows/ci.yml`, `scripts/ci.test.ts`).
- Keep no-install CI jobs on built-in Node imports and set
  `pnpm_config_verify_deps_before_run=false` for their pnpm commands (`.github/workflows/ci.yml`,
  `scripts/ci.ts`, `scripts/guardrails.ts`).
- Keep PR secret scans on the net merge-ref diff and the scheduled scan on full history;
  `scripts/ci.ts` chooses the range and `scripts/gitleaks.sh` rejects scan errors
  (`.github/workflows/ci.yml`, `.github/workflows/security.yml`).
- Renovate groups catalog dependencies by `pnpm.catalog.default` or `pnpm.catalog.runtime`, not
  plain package dependency types (`renovate.json`, `pnpm-workspace.yaml`).
- When a package calls a system binary, list it in `knip.json` `ignoreBinaries` if knip cannot
  infer it as a dependency; explain that check change in the PR (`knip.json`, `gitflow`).
