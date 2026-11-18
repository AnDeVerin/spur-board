---
name: testing-and-ci
description: Tests, fakes, clocks, flaky quarantine, checks and CI. Use when you write or change tests, fix a failing check, or edit packages/testkit/, scripts/check*, vitest.config.ts or .github/workflows/. Don't use for package dependencies (use working-in-the-monorepo) or agent files (use skill-writer).
---

# Testing and CI

## Writing tests

- Read `references/test-layers.md` for the layer to use, stand scenarios, the existing fakes,
  clock seams, the waits rule, harness guarantees and flaky-test quarantine.
- Give the test a fake or a local server instead of `vi.mock` (`viMockBan`, `eslint.config.js`).
- Code under test takes a `clock` or `now` seam; never assert on the real time.
- Put tests that read design system CSS or token values in a Node-side `scripts/web*.test.ts`,
  as `scripts/web-tokens.test.ts` does: `packages/web/test/` may not import `node:` modules
  (`local/web-import-boundary`, `eslint.config.js`), and Vitest reads CSS there as an empty string,
  `?raw` imports included.

## Local checks

- Use the root Vitest projects in `vitest.config.ts`; package tests reach CI through the root
  include pattern, not per-package `test` scripts.
- Read `references/local-checks.md` for what each check mode runs, knip, TypeScript and lint
  traps, single-file snapshot updates and running `check --pre-push` by hand.

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

## Doc checks

- Guides fail `packages/skills/test/skill-sync.test.ts` on a command with subcommands, even with
  a key (`board task <key>`, `board comment`), and on a lowercase `board <word>` in prose: README,
  SETUP, TROUBLESHOOTING, the runbook, the setup skill. Describe the action, cite a leaf command,
  or write "Board".
- `skill-sync.test.ts` keeps each guide (`docs/how-board*.md`, `docs/web-ui*.md`) and its copy
  in `packages/skills/spur-board/references/` below 8192 bytes; `doc-caps.test.ts` warns above
  80%. CI tests the merge with `main`, so two PRs that each grow one guide can pass alone and
  fail together: measure after merging current `main`.
- No skill or guide check reads `docs/configuration.md`; check commands in its prose in
  `scripts/gen-docs.test.ts`, where `registeredCommands()` gives each command path and options.

## CI and dependencies

- For CI triggers, reporters, release permissions and dependency update policy, read
  `references/ci-workflows.md`.
- Add a new CI job to `ci-ok.needs` and its verdict handling in `scripts/ci.ts`; accepted skips
  are explicit there (`.github/workflows/ci.yml`, `scripts/ci.test.ts`).
- Keep no-install CI jobs on built-in Node imports and set
  `pnpm_config_verify_deps_before_run=false` for their pnpm commands (`.github/workflows/ci.yml`,
  `scripts/ci.ts`, `scripts/guardrails.ts`).
- Keep PR secret scans on the net merge-ref diff and the scheduled scan on full history;
  `scripts/ci.ts` chooses the range and `scripts/gitleaks.sh` rejects scan errors
  (`.github/workflows/ci.yml`, `.github/workflows/security.yml`).
- When a package calls a system binary, list it in `knip.json` `ignoreBinaries` if knip cannot
  infer it as a dependency; explain that check change in the PR (`knip.json`, `gitflow`).
