# AGENTS.md

A map of the repo for agents and contributors. The rules live in the files and skills it links.

## Packages

- `packages/contracts` - zod schemas, config, enums, journal events, the gateway contract, the
  operation catalog, error codes and typed IDs. Skill: `working-with-contracts`.
- `packages/cli` - the sole publishable `spur-board` package. Its built `board` binary bundles
  workspace code; the source CLI has catalog commands and the shared daemon HTTP client. It imports
  only `@spur-board/contracts` among workspace packages; the boundary lint is in `eslint.config.js`.
- `packages/core` - the SQLite store in `src/store/`. Skill: `working-with-storage`.
- `packages/gateway-slack` - Slack outbound delivery through the Web API.
- `packages/adapters` - the adapter runner in `src/runner/`: per-source schedule, backoff,
  throttle and budget waits, batch validation and the source state reported to core. Adapters
  import only `@spur-board/contracts` and `runner/`; the boundary lint is in `eslint.config.js`.
  Test fakes come from `@spur-board/adapters/testing`.
- `packages/daemon` - the daemon process: config and secrets loading, the single-instance lock,
  the redacting pino logger and the start and shutdown lifecycle. Run it with
  `pnpm --filter @spur-board/daemon daemon` (`daemon:dev` pretty-prints the log). Skill:
  `running-the-daemon`.
- `packages/testkit` - the shared Vitest harness: environment scrub and network guard. Skill:
  `testing-and-ci`.
- `scripts/` - repo tooling, run as `node scripts/<name>.ts` through the pnpm scripts below. Check
  scripts and tests use `testing-and-ci`.
- `.github/` - CI workflows, the PR template and the issue forms. CI workflows use
  `testing-and-ci`.
- A PR that adds a package or a root script updates this map.

## Commands

- `pnpm install` - installs dependencies and turns on the git hooks. Run it in every new
  worktree; the hooks need `node_modules`. When `node_modules` already exists, pnpm skips
  `prepare`: run `pnpm run prepare` to turn the hooks on.
- `pnpm check` - format, lint, types and tests for changed files and affected packages; knip runs
  only when a global change triggers full mode.
- `pnpm run check --pre-push` - checks the Git refs being pushed: changed-file format and lint,
  plus types and unit tests for changed packages (all packages for shared root changes). It
  checks only refs at the current HEAD and uses two Vitest workers by default; set a positive
  integer `VITEST_MAX_WORKERS` to override that limit. A missing base for a new ref stops the
  check with recovery guidance.
- `pnpm check:full [--only format,lint,types,knip,test]` - the same over the whole repo.
- `pnpm guardrails [base]` - lists the changed tests and checks a PR must explain; base defaults
  to `origin/main`, agents pass the handoff's `origin/main` SHA.
- `pnpm ci:status [PR]` - the latest CI state of a PR's head commit, by job and step.
- `pnpm format` - prettier over the repo.
- `pnpm gen` - regenerate the config schema, operation snapshot and product skill command section.
- `pnpm package:build` - bundle the CLI and daemon and copy the binary and migrations.
- `pnpm package:pack [directory]` - build, pack, and validate the npm tarball.
- `pnpm package:check <tarball>` - reject files outside the package allowlist or a missing binary.
- `pnpm package:smoke [tarball]` - install and exercise the packed CLI and daemon.
- `BOARD_LIVE_CHANNEL=<test-channel-id> pnpm smoke:live` - manually run Slack gateway conformance
  in a private test channel; use before M1 acceptance, after Slack SDK updates and before releases.
- `pnpm upgrade:smoke [tarball]` - test migration from the previous published version when present.
- `pnpm gen:config-schema`, `pnpm gen:ops-snapshot` - regenerate the config JSON schema and the
  operation catalog snapshot.
- A check passes only when its exit code, read directly, is 0. Never read it through a pipe:
  `cmd | tail` reports the exit code of `tail`.

## Workflow

- Work an issue with `/manager <issue-number>` (Codex: `$manager <issue-number>`). The skill
  scores the task into a tier and routes it through role agents; its rules are in
  `.agents/skills/manager/SKILL.md`.
- Role agents live in `.agents/agents/`. `.claude/agents/` and `.codex/agents/` are copies of
  them and `.claude/skills` links to `.agents/skills`; change the source and its copies in the
  same commit.
- The manager keeps its spec in `.scratch/spec-<issue-number>.md`. `.scratch/` is not committed.
- Branches, commits and PRs follow `gitflow`; agent files follow `skill-writer`.
- A review on your PR requests changes -> run `pr-comments-fix` (Codex: `$pr-comments-fix`).

## Issue to PR

- One issue, one branch, one PR. The PR title is a conventional commit with the issue number
  first in the subject, e.g. `feat(core): #15 add the config schema`.
- The body comes from `.github/pull_request_template.md`, filled as `gitflow` says, and keeps
  `Closes #<issue-number>`.
- Before opening the PR run `pnpm check`, then `pnpm guardrails`. Every file guardrails reports,
  and every deleted, skipped or weakened check, gets a line under `## Changed checks`; the CI
  guardrails job fails otherwise. The developer fills that section from its report.
- The reviewer runs `pnpm guardrails` before approving.
- Agents never merge, approve or push to `main`. A human merges.

## Git hooks

- pre-commit: gitleaks on the staged changes (needs `gitleaks` on `PATH`), then prettier on the
  staged files and re-stage. It refuses a file that is staged and also has unstaged changes, and
  `git commit <path>` when a file needs formatting. The CI secrets job scans only the PR's net
  diff, so only this hook catches a secret added and removed again inside one PR.
- pre-push: `pnpm run check --pre-push`; CI runs the full quality and test cycle.
- A hook refuses -> fix what it reports and commit again. If a check is unexpectedly slow,
  rerun its reported changed-file or direct-package command to identify the delay.

## Refused commands

Claude Code runs `scripts/agent-guard.ts` before every Bash call (`.claude/settings.json`) and
refuses these with the reason. Codex has no such hook: follow the same rules yourself.

- `--no-verify` on any git command, and `git commit -n` - skips the hooks; fix what they report.
- Changing `core.hooksPath` (`git -c`, `git config`, removing or renaming the `core` section,
  `git config --edit`) or setting a `GIT_CONFIG*` variable - turns the hooks off.
- Force pushes: `-f`, `--force`, `--force-with-lease`, `--force-if-includes`, `--mirror`, a
  `+<refspec>` - rewrites remote history; push a new commit.
- `gh pr merge`, `gh api .../pulls/<n>/merge`, and the GraphQL `mergePullRequest` or
  `enablePullRequestAutoMerge` mutations - agents never merge.
- Command substitutions nested deeper than 8 levels - the guard cannot check them.

Not caught (the rules still apply): git and shell aliases, interpreters (`node -e`, `python -c`)
and script files, commands piped or fed into a shell (`echo ... | bash`, `bash <<<...`),
variables expanded into commands, and the GitHub API through `curl`.

## Reading a red CI run

- Run `pnpm ci:status [PR]` once; do not poll. It prints each job and failed step, the last log
  lines and a `repro:` command.
- Exit codes: 0 pass, 1 failed, 2 usage or gh read error, 3 pending (including no ci run yet), 4
  cancelled.
- A cancelled run is not a failure. A cancelled run with a newer run on the same commit is
  superseded and does not count; editing the PR title or body starts such a newer run.
- A red `ci-ok` follows the other jobs; read the job that failed.
- Rerun (`gh run rerun <id> --failed`) only a cancelled run or an infrastructure failure.
- Otherwise reproduce with the printed `repro:` command, fix, and push a new commit.

## Issues

Issue forms live in `.github/ISSUE_TEMPLATE/`: feature, bug and spike. Each has Context, Scope,
Out of scope, Acceptance criteria, Design notes and Dependencies.
