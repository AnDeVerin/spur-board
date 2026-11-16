# Contributing to spur-board

Thanks for helping. Work goes from an issue to a branch to a pull request. The repository map,
commands and the full rules for agents and contributors are in [AGENTS.md](AGENTS.md). Report
security problems privately as described in [SECURITY.md](SECURITY.md), not in a public issue.

## Set up

Install [gitleaks](https://github.com/gitleaks/gitleaks#installing) and keep it on `PATH`; the
pre-commit hook refuses commits without it.

Run `pnpm install` in every new clone or worktree. It installs dependencies and turns on the git
hooks: pre-commit runs gitleaks and prettier on staged changes, pre-push runs
`pnpm run check --pre-push`. When `node_modules` already exists, pnpm skips `prepare`; run
`pnpm run prepare` to turn the hooks on. Fix what a hook reports and commit again; never skip the
hooks.

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
- `pnpm guardrails` - lists the changed tests and checks a PR must explain, every added, changed
  or deleted test file included. Each file it reports, and every deleted, skipped or weakened
  check, gets a line under `## Changed checks` in the PR body; the CI guardrails job fails
  otherwise and re-runs when the PR description is edited.

A check passes only when its exit code is 0.

## Review and merge

Every change needs the code owner's approval ([.github/CODEOWNERS](.github/CODEOWNERS)). The
maintainer merges by hand with a squash merge; the squash commit takes the PR title. Review
changes go in new commits; never force-push a pushed branch.

## Web shell

Build the private React/Vite package with `pnpm --filter @spur-board/web build`; typecheck with
`pnpm --filter @spur-board/web typecheck`. Unit tests run through the root Vitest unit project:
`pnpm exec vitest run --project unit packages/web/test scripts/web.test.ts`.
The shared Vitest root setup builds fresh web assets once before any selected project's workers
start, into the run's temporary harness directory. Asset tests consume that provided directory;
they neither require nor clean `packages/web/dist`. This applies to direct Vitest, local checks,
pre-push, CI and mutation runs. Existing workflow builds remain explicit build coverage; test
preparation independently rebuilds fresh assets for isolation. A standalone build is still
needed for serving or assembling output outside tests.
Components use CSS Modules and custom properties from `packages/web/src/ds/tokens.css`; the
empty `ds/index.ts` is reserved for the design system. Keep prototype token names and values.
Raw hex/RGB literals outside the token file fail the style policy test. Primary, secondary and
status text meet 4.5:1; tertiary text and the attention chip are deliberate prototype exemptions.
The shell uses secondary text. Future quiet text components must raise tertiary to secondary on
hover, focus-within and touch, as described in #535.

JetBrains Mono is local, emitted as hashed WOFF2 files, with `packages/web/OFL.txt` copied into
the published package. No external font requests or HTML injection. Browser code imports the
narrow `@spur-board/contracts/browser` entry; the build rejects server/catalog modules.
`pnpm package:build` builds web, runs the CLI clean build, then copies web output and verifies
its asset graph. React and React DOM ship in those assets; Vite remains build tooling.
The daemon loads `web/` next to its bundle at startup. Use the assembled/installed package
for daemon-backed serving; a source daemon does not read `packages/web/dist` directly, except a
stand, which passes it as its web root (`docs/qa-stand.md`).

For controlled shell states while the stream server (#533) is pending, exercise the shell with
`node scripts/web-shell-qa.ts --port 4780` through a disposable session sidecar after building.
This loopback fixture serves controlled status/stream scenarios; it is never packaged.
Installed package smoke separately exercises the real configured web listener and assets. POST to
`/__qa/scenario/loading|empty|healthy|mixed|read-error|refresh-error|recovered|stream-drop`;
POST `/__qa/release` releases held loading reads. The footer displays the CLI version embedded
at build time; #547 will switch it to the daemon version without changing this shell's wire API.
