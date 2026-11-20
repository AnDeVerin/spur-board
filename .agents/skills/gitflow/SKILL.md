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
- A behaviour change ships its doc updates in the same commit; surfaces: `developer`, Docs.
- Leave the session marker out of commits and PR titles.
- Run `pnpm check` before opening the PR as `AGENTS.md` requires; use it again when a wider local
  check is needed. Never wait for or poll remote CI.
- The pre-push hook checks the refs being pushed: changed-file format and lint plus types and unit
  tests for changed packages (all packages for shared root changes). Push only the checked-out
  HEAD. CI runs `check:full`, including startup and process tests.

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
3. Delete every `<!---` comment line, the placeholder rows, `## Changed checks` when it has
   no entries, and `## Acceptance gates` when the PR changes no UI file; otherwise fill its
   `tester:` and `designer:` lines (`references/pr-body.md`): `n/a` only for a gate the task
   does not use, never for an applicable gate that has not passed.
4. Keep `Closes #<issue-number>`. The last line is the session marker: the one your launch
   instructions give, else `[AI-generated, session: $SPUR_SESSION]` with the variable expanded.
   It appears once.
5. No PR yet: `gh pr create --base main --title "<title>" --body-file .scratch/pr-body-<N>.md`,
   opened ready for review. A PR exists: `gh pr edit <N> --body-file .scratch/pr-body-<N>.md`.
   Never mark a draft you did not open as ready.

### Mapping from the spec

- How each template section is filled from the spec: `references/pr-body.md`.

### Changed checks

- The changes that each need a Changed checks line, and the CI `guardrails` rule:
  `references/pr-body.md`.

## Public text

PR titles, bodies, commits and comments are public. Write them in English, in your own words.
Leave out private notes, decision or task IDs, people, companies and machine paths.
