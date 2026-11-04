---
name: gitflow
description: Branches, commits, pushes and pull requests for this repo - naming, history rules, the PR title and a body filled from the PR template and the spec. Use when you create a branch, commit, push, or open or update a PR. Don't use for review comments on an open PR (use pr-comments-fix).
---

# Gitflow

One issue, one branch, one PR. Explain why in the PR body.

## Branch

- Name: `<agent>-<issue-number>-<slug>`, e.g. `claude-10-process-skills`; use a short lowercase slug.
- Branch from `main` at the `origin/main` SHA the handoff gives. One issue per branch.

## Commits

- Conventional commits: `<type>(<scope>): <summary>`, imperative, no trailing period.
- Changes to agent files (`.agents/`, `.claude/`, `.codex/`, `AGENTS.md`) go in their own
  commit (`chore(agents)`, or `fix(<skill>)` for a stale rule), apart from code changes.
- Leave the session marker out of commits and PR titles.
- Run `pnpm check` before opening the PR as `AGENTS.md` requires; use it again when a wider local
  check is needed. Without a `package.json`, report `no checks available`. Never wait for or poll
  remote CI.
- The pre-push hook checks the refs being pushed: changed-file format and lint plus types and unit
  tests for changed packages (all packages for shared root changes). Push only the checked-out
  HEAD. `VITEST_MAX_WORKERS` defaults to two and accepts a positive integer override. CI runs
  `check:full`, including startup and process tests.
- If pre-push is unexpectedly slow, rerun the reported changed-file or direct-package command
  to identify the delay, then push again.

## History

- Never amend, rebase or force-push a commit that has been pushed. Fixes go in new commits.
- The branch conflicts with `main`: merge `main` into the branch, resolve, commit the merge. Do
  not rebase a pushed branch.
- Never push to `main`, merge a PR, or approve one. A human merges; the repo squash-merges.

## PR title

A conventional commit with the issue number first in the subject, e.g.
`feat(core): #15 add the config schema`, so the PR list shows which issue to read. The type comes
first because releases are versioned from it. The squash commit takes the PR title and GitHub
appends the PR number: `feat(core): #15 add the config schema (#71)`.

## PR body

1. Copy `.github/pull_request_template.md` to `.scratch/pr-body-<issue-number>.md`.
2. Fill each section as mapped below and follow the rules in the template's comments.
3. Delete every `<!---` comment line, the placeholder rows, and `## Changed checks` when it has
   no entries.
4. Keep `Closes #<issue-number>`. The last line is the session marker: the one your launch
   instructions give, else `[AI-generated, session: $SPUR_SESSION]` with the variable expanded.
   It appears once.
5. No PR yet: `gh pr create --base main --title "<title>" --body-file .scratch/pr-body-<N>.md`,
   opened ready for review. A PR exists: `gh pr edit <N> --body-file .scratch/pr-body-<N>.md`.
   Never mark a draft you did not open as ready.

### Mapping from the spec

- Description - what changes for the user, the CLI or API caller, or the agent, from the spec's
  Objective. Out-of-scope follow-ups go in the last bullet with their issue number.
- Architecture decisions - one row per `### Design` entry: decision, the alternative it beat,
  why. Reword each row in plain words; a spec row that cites a private decision or task ID, a
  person, a company or a machine path loses that reference in the PR. No material choice -> one
  line `None - <why>`, e.g. `None - follows the existing pattern in the manager skill`. Never
  invent an alternative to fill a row.
- Testing - one line per acceptance criterion of the issue, in the issue's order: the criterion,
  then the test, or the command and the output it printed, taken from the spec's
  `### Verification` and the close-out evidence. Tick `[x]` only when that proof was observed in
  this run; otherwise leave `[ ]` and write `pending - <why>`.
- Risk - `high`, `medium` or `low` with a one-line reason, from the spec's `### Risks`.
- Changed checks - one line per entry below, from the developer's `Changed checks` output.

### Changed checks

This list wins over the template's shorter comment. Each of these gets its own line, saying what
changed and why:

- deleted tests, or fewer `expect` assertions;
- weakened or changed assertions: a looser matcher, a changed expected value;
- skipped or focused tests: `.skip`, `.only`, `xit`;
- changed snapshots or golden files;
- changed test, lint, TypeScript or CI config, or the shared test kit;
- disabled or loosened lint rules, e.g. `eslint-disable`;
- type escapes: `@ts-ignore`, `@ts-expect-error`, `as any`;
- `continue-on-error` or any other way to let a CI step fail silently;
- loosened thresholds: coverage, timeouts, retries.

Any other change to a test or a check also gets a line. No entries -> delete the section.

## Public text

PR titles, bodies, commits and comments are public. Write them in English, in your own words.
Leave out private notes, decision or task IDs, people, companies and machine paths.
