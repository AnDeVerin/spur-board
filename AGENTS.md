# AGENTS.md

A map of the repo for agents and contributors. The rules live in the files and skills it links.

## Packages

- `packages/contracts` - zod schemas, config, enums, journal events, the gateway contract, the
  operation catalog, error codes and typed IDs. Skills: `working-with-contracts`,
  `adding-an-operation`; `handling-errors` for error codes.
- `packages/cli` - the sole publishable `spur-board` package. Its built `board` binary bundles
  workspace code; the source CLI has catalog commands and the shared daemon HTTP client. It imports
  only `@spur-board/contracts` among workspace packages; the boundary lint is in `eslint.config.js`.
  Skill: `designing-agent-surfaces`.
- `packages/core` - the SQLite store in `src/store/`. Skill: `working-with-storage`.
- `packages/gateway-slack` - the Slack gateway: Web API delivery, Socket Mode inbound,
  thread-history recovery and the board slash commands. Tests and the stand get its fake Slack API
  from `@spur-board/gateway-slack/testing`. Skill: `building-messenger-connectors`.
- `packages/gateway-testkit` - the gateway conformance suite, its case registry for fake and live
  targets, and an in-memory fake gateway with `slack-like` and `telegram-like` profiles. Skill:
  `building-messenger-connectors`.
- `packages/skills` - the product skills that `board skills install` ships; not a workspace
  package.
- `packages/adapters` - the adapter runner in `src/runner/`: per-source schedule, backoff,
  throttle and budget waits, batch validation and the source state reported to core. Adapters
  import only `@spur-board/contracts` and `runner/`; the boundary lint is in `eslint.config.js`.
  Test fakes come from `@spur-board/adapters/testing`. Skill: `writing-adapters`.
- `packages/daemon` - the daemon process: config and secrets loading, the single-instance lock,
  the redacting pino logger and the start and shutdown lifecycle. Run it with
  `pnpm --filter @spur-board/daemon daemon` (`daemon:dev` pretty-prints the log). Skill:
  `running-the-daemon`.
- `packages/stand` - a private disposable board for agents and tests: one process holding the
  in-process daemon on a temp home with dummy secrets, the fake Slack API, the network guard and a
  control endpoint (`wait`, `poll`, `reset`, `seed`, `fake`, `violations`). An in-memory fake Spur
  and the fakes in `src/fakes/` answer the real adapters through one in-process `fetch`; the named
  scenarios `seed` and `up --scenario` set up live in `src/scenarios/`. Production packages never
  import it; the boundary lint is in `eslint.config.js`.
- `packages/testkit` - the shared Vitest harness: environment scrub and network guard. Skill:
  `testing-and-ci`.
- `scripts/` - repo tooling, run as `node scripts/<name>.ts` through the pnpm scripts below. Check
  scripts and tests use `testing-and-ci`.
- `.github/` - CI workflows, the PR template and the issue forms. CI workflows use
  `testing-and-ci`.
- A PR that adds a package or a root script updates this map. Adding a package, a dependency
  or a cross-package import: skill `working-in-the-monorepo`.

## Commands

- `pnpm install` - installs dependencies and turns on the git hooks. Run it in every new
  worktree; the hooks need `node_modules`. When `node_modules` already exists, pnpm skips
  `prepare`: run `pnpm run prepare` to turn the hooks on.
- `pnpm check` - format, lint, types and tests for changed files and affected packages, plus the
  `agents` step (`pnpm lint:agents`) when `.agents/`, `.claude/`, `.codex/`, `AGENTS.md` or
  `scripts/agents.ts` change; knip runs only when a global change triggers full mode.
- `pnpm run check --pre-push` - checks the Git refs being pushed: changed-file format and lint,
  plus types and unit tests for changed packages (all packages for shared root changes) and the
  `agents` step for changed agent files. It checks only refs at the current HEAD and uses two
  Vitest workers by default; set a positive integer `VITEST_MAX_WORKERS` to override that limit.
  A missing base for a new ref stops the check with recovery guidance.
- `pnpm check:full [--only format,lint,types,knip,agents,test]` - the same over the whole repo.
- `pnpm guardrails [base]` - lists the changed tests and checks a PR must explain; base defaults
  to `origin/main`, agents pass the handoff's `origin/main` SHA.
- `pnpm ci:status [PR]` - the latest CI state of a PR's head commit, by job and step.
- `pnpm format` - prettier over the repo.
- `pnpm gen` - regenerate the config schema, operation snapshot and product skill command section.
- `pnpm agents:sync [--check]` - generate `.claude/agents/`, `.codex/agents/`, the `.claude/skills`
  link and the skills and roles table from `.agents/`; `--check` reports drift without writing.
- `pnpm lint:agents` - check agent files against `skill-writer` and run `agents:sync --check`; the
  `agents` step of `pnpm check`, pre-push and `check:full` runs it.
- `pnpm package:build` - bundle the CLI and daemon and copy the binary and migrations.
- `pnpm package:pack [directory]` - build, pack, and validate the npm tarball.
- `pnpm package:check <tarball>` - reject files outside the package allowlist or a missing binary.
- `pnpm package:smoke [tarball]` - install and exercise the packed CLI and daemon.
- `BOARD_LIVE_CHANNEL=<test-channel-id> BOARD_LIVE_CHANNEL_NAME=<test-channel-name> pnpm smoke:live`
  - run Slack gateway conformance from an interactive terminal after checking private channel
    metadata; use before M1 acceptance, after Slack SDK updates and before releases.
- `pnpm stand up|down|status|logs|board|mcp|wait|poll|reset|seed|fake|violations` - run a stand under `$TMPDIR`;
  `pnpm stand` prints the commands. `up` refuses real external credentials in the environment,
  the live board's home and port 4777.
- `pnpm upgrade:smoke [tarball]` - test migration from the previous published version when present.
- `pnpm update:smoke [tarball]` - run `board update` and `board rollback` on a global install
  through a loopback registry and a fake `systemctl`; needs npm, `flock` and the npm registry.
- `pnpm gen:config-schema`, `pnpm gen:ops-snapshot` - regenerate the config JSON schema and the
  operation catalog snapshot.
- A check passes only when its exit code, read directly, is 0. Never read it through a pipe:
  `cmd | tail` reports the exit code of `tail`.

## Workflow

- Work an issue with `/manager <issue-number>` (Codex: `$manager <issue-number>`). The skill
  scores the task into a tier and routes it through role agents; its rules are in
  `.agents/skills/manager/SKILL.md`.
- Role agents live in `.agents/agents/`. `pnpm agents:sync` generates `.claude/agents/`,
  `.codex/agents/`, the `.claude/skills` link and the table below from the tracked sources; edit
  the source, run it, and commit the outputs with the source.
- The manager keeps its spec in `.scratch/spec-<issue-number>.md`. `.scratch/` is not committed.
- Branches, commits and PRs follow `gitflow`; agent files follow `skill-writer`.
- A review on your PR requests changes -> run `pr-comments-fix` (Codex: `$pr-comments-fix`).
- Never run `board service install`, `restart` or `uninstall`, or a `systemctl --user` command
  that changes a unit, outside a disposable VM or container: they act on the machine's real user
  manager. `BOARD_HOME` moves config and secrets, not the unit (`servicePaths`,
  `packages/cli/src/service.ts`). Check the unit with a temporary `HOME` and `XDG_CONFIG_HOME`
  and a fake `systemctl` on `PATH` (`scripts/package-smoke.ts`); a check that needs real
  systemd is a manual operator step.

## Skills and roles

Generated from frontmatter by `pnpm agents:sync`; edit the source file, not this table.

<!-- BEGIN GENERATED SKILLS AND ROLES: pnpm agents:sync -->

<!-- prettier-ignore-start -->

| Name | Kind | Description |
| --- | --- | --- |
| [adding-an-operation](.agents/skills/adding-an-operation/SKILL.md) | skill | Path of an operation from catalog to handler, store, CLI, MCP, generated files and tests |
| [building-messenger-connectors](.agents/skills/building-messenger-connectors/SKILL.md) | skill | Messenger gateway rules - obligations, conformance, inbound ack and dedupe, recover and gap, outbound results |
| [code-simplifier](.agents/skills/code-simplifier/SKILL.md) | skill | Simplify the branch diff without changing behaviour - remove duplication, dead code and needless layers |
| [designing-agent-surfaces](.agents/skills/designing-agent-surfaces/SKILL.md) | skill | Rules for what agents see from the board - MCP tool names, descriptions, schemas and annotations, and CLI output, stdout and help |
| [gitflow](.agents/skills/gitflow/SKILL.md) | skill | Branches, commits, pushes and pull requests for this repo - naming, history rules, the PR title and a body filled from the PR template and the spec |
| [handling-errors](.agents/skills/handling-errors/SKILL.md) | skill | Rules for errors - Result vs throw, retries, the ERRORS catalog, hints, exit codes, boundary catches, one shape over HTTP, CLI and MCP |
| [manager](.agents/skills/manager/SKILL.md) | skill | Run a GitHub issue through tiered gates of role agents - plan, spec check, one Clarify round, implement, review, PR, close-out |
| [pr-comments-fix](.agents/skills/pr-comments-fix/SKILL.md) | skill | Answer feedback on your own PR - collect unresolved review threads and new comments, fix or reply with a reason, push once, sign each post |
| [running-the-daemon](.agents/skills/running-the-daemon/SKILL.md) | skill | Rules for packages/daemon/ - modules, config and secrets, logging and redaction, pollers, shutdown, the lock |
| [skill-writer](.agents/skills/skill-writer/SKILL.md) | skill | Rules for writing and changing skills, role agents and AGENTS.md - format, frontmatter, triggers, size budgets, copies |
| [testing-and-ci](.agents/skills/testing-and-ci/SKILL.md) | skill | Tests, fakes, clocks, flaky quarantine, checks and CI |
| [working-in-the-monorepo](.agents/skills/working-in-the-monorepo/SKILL.md) | skill | Package map, allowed dependencies, PR order, new packages, catalog versions, boundary lint errors |
| [working-with-contracts](.agents/skills/working-with-contracts/SKILL.md) | skill | Rules for changing packages/contracts - zod schemas, config fields, enums, journal event kinds, port contracts, breaking changes and PR order |
| [working-with-storage](.agents/skills/working-with-storage/SKILL.md) | skill | Rules for the SQLite store (packages/core/src/store/) and outbox (packages/core/src/app/{outbox,sender}.ts) - transactions, outbox, migrations and tests, PRAGMAs |
| [writing-adapters](.agents/skills/writing-adapters/SKILL.md) | skill | Rules for packages/adapters/ - port, untrusted responses, failure kinds, rate limits, budget, fakes and tests |
| [architect](.agents/agents/architect.md) | role | Turn the issue into an executable spec after repo recon - findings, change map, invariants, acceptance criteria bound to verification |
| [critic](.agents/agents/critic.md) | role | Falsify the researcher's options, score each against doing nothing, and select one |
| [designer](.agents/agents/designer.md) | role | UI design gate. Plan mode reviews the UI in a spec before code; code mode checks layout, tokens and states of the changed web UI |
| [developer](.agents/agents/developer.md) | role | Implement the spec, checking it against the code; tier 0 works from the issue, tier 3 does recon, plan and code in one context. Writes code and tests, runs local checks, commits |
| [researcher](.agents/agents/researcher.md) | role | Find 2-3 distinct ways to build the change, with code evidence, keeping verified facts apart from inferences |
| [reviewer](.agents/agents/reviewer.md) | role | Code review gate - falsify the branch diff against the spec's criteria, invariants and tests, and catch checks weakened without notice |
| [spec-critic](.agents/agents/spec-critic.md) | role | Try to falsify the architect's spec before any code - cited facts, change map, invariants, and a bound verification for every criterion |
| [tester](.agents/agents/tester.md) | role | Validation gate - exercise the change as a user would (CLI, API, or web UI through a browser tool) and return PASS or FAIL with evidence |

<!-- prettier-ignore-end -->

<!-- END GENERATED SKILLS AND ROLES -->

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

## Accepted risks

Gaps kept on purpose. Do not raise them in reviews or open issues for them.

- `board skills install` (`packages/cli/src/skills.ts`) checks the skill parent directories
  before it changes any skill and refuses a symlinked skill directory. It does not guard against
  a process of the same user replacing a parent directory with a symlink mid-install: that
  process can already write those files itself, and Node has no directory-relative file
  operations to pin the parent (#151).
- `projects[].link.branchPattern` and `titlePattern` (`packages/contracts/src/config.ts`) can be
  written to run slowly and stall one GitHub poll: Node regexes have no work bound. The operator
  writes both patterns in their own config, and branch names and titles come from PRs the board
  finds for `operatorGithubLogin` or that were linked by hand, so no third party controls either
  input. Validation only checks that a pattern compiles, starts with `^` and has one capture
  group, and branches and titles over 255 characters are not matched. Do not add more
  validation rules (#188).
