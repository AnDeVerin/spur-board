# Contributing to spur-board

Thanks for helping. Work goes from an issue to a branch to a pull request. The repository map,
commands and the full rules for agents and contributors are in [AGENTS.md](AGENTS.md). Report
security problems privately as described in [SECURITY.md](SECURITY.md), not in a public issue.

## Set up

Run `pnpm install` in every new clone or worktree. It installs dependencies and turns on the git
hooks: pre-commit runs gitleaks and prettier on staged changes, pre-push runs
`pnpm run check --pre-push`. Fix what a hook reports and commit again; never skip the hooks.

## Issue to PR

1. Start from an issue, or open one with a form in
   [.github/ISSUE_TEMPLATE/](.github/ISSUE_TEMPLATE/).
2. One issue, one branch, one PR.
3. The PR title is a conventional commit with the issue number first in the subject, e.g.
   `feat(core): #15 add the config schema`. Releases are versioned from the type, so pick it with
   care.
4. Fill the body from [the PR template](.github/pull_request_template.md) and keep
   `Closes #<issue-number>`.

## Checks

- `pnpm check` - format, lint, types and tests for changed files and affected packages. Run it
  before opening the PR.
- `pnpm check:full` - the same over the whole repo; CI runs the full cycle.
- `pnpm guardrails` - lists the changed tests and checks a PR must explain. Each file it reports,
  and every deleted, skipped or weakened check, gets a line under `## Changed checks` in the PR
  body; the CI guardrails job fails otherwise.

A check passes only when its exit code is 0.

## Review and merge

Every change needs the code owner's approval ([.github/CODEOWNERS](.github/CODEOWNERS)). The
maintainer merges by hand with a squash merge; the squash commit takes the PR title. Review
changes go in new commits; never force-push a pushed branch.
