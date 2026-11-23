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
   care; [Versions and the changelog](#versions-and-the-changelog) says which type bumps what.
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
- CI `acceptance-gates` - a PR that changes a UI file (under `packages/web/` outside `test/`,
  `gallery/` and `kit/`, or `docs/design-system-decisions.md`) needs `## Acceptance gates` in
  its body. Write the head SHA each gate last passed on, or `n/a` for a gate the task does not
  use; an applicable gate that has not passed is never `n/a`, and with no passed head CI stays
  red until a human decides. The section holds only the `tester:` and `designer:` lines; any
  other line fails. The job fails while a UI file changed after a named head and re-runs when the
  description is edited.

A check passes only when its exit code is 0.

## Review and merge

Every change needs the code owner's approval ([.github/CODEOWNERS](.github/CODEOWNERS)). The
maintainer merges by hand with a squash merge; the squash commit takes the PR title and the PR
body as its message. Review changes go in new commits; never force-push a pushed branch.

## Versions and the changelog

spur-board follows semantic versioning. semantic-release reads each squash commit on `main`: `feat`
bumps the minor, `fix` and `perf` bump the patch, and other types release nothing. A breaking
change, a `!` after the scope or a breaking footer, bumps the minor while the version is 0.x and
the major from 1.0.0 on. The maintainer cuts 1.0.0 in a PR with a `!` title that removes the 0.x
clamp in `scripts/release-analyzer.ts`.

Breaking: the config schema, CLI commands and flags, MCP operations, HTTP API operations, error codes and their HTTP status or exit code, stored data and migrations, and web routes users bookmark.

Not breaking: UI layout and wording.

A breaking PR writes its upgrade note as the paragraph right above `Closes #<N>`, after every
other section of the body. The paragraph starts with `BREAKING CHANGE: ` (uppercase, a colon and
a space) and says what changed and how to migrate the config. Use no `#` after its first line,
because a line with a `#` ends the footer. Lines after `Closes #<N>` do not reach the notes. The
release notes list the paragraph under **BREAKING CHANGES**, and list under each entry only the
references made with a closing keyword, such as `Closes #<N>` or `Fixes #<N>`.

Every release puts its notes on the
[GitHub releases page](https://github.com/AnDeVerin/spur-board/releases).
[CHANGELOG.md](CHANGELOG.md) holds its header and the upgrade notes of earlier releases; until the
release job commits it, GitHub releases carry every release's notes. The release identity (#867)
is a GitHub App: the release job mints a short-lived token from it and pushes the changelog commit
and the tag with that token, and only that token gets past the `main` rulesets. To switch the
commit on, in this order:

1. Create a GitHub App on your personal account. Under "Where can this GitHub App be installed?"
   choose `Only on this account`, turn the webhook off, and give it the repository permission
   `Contents: Read and write` and nothing else (GitHub adds Metadata read-only). Install it only
   on `spur-board`.
2. Generate a private key for the App and store it as the secret `RELEASE_APP_PRIVATE_KEY` in the
   `npm` environment. Store the App's client ID as the repository variable
   `RELEASE_APP_CLIENT_ID`.
3. Add the App to the bypass list of both rulesets, `main` and `main-review`, with the mode
   `Always allow`.
4. Set the repository variable `RELEASE_CHANGELOG_COMMIT` to `true`, in lowercase. Each release
   then prepends its notes to CHANGELOG.md and commits it to `main` as
   `chore(release): <version> [skip ci]` before tagging that commit. Unset the variable to stop.

To rotate the key, generate a new private key, replace the secret, then delete the old key. To
revoke the identity, delete the App's private keys or remove the App from both bypass lists, and
unset the variable.

If the changelog commit lands on `main` but the tag push fails, the next push to `main` releases
again, at that version or higher if the new commits raise the bump, and its entry replaces the
untagged CHANGELOG.md entry.

## Web shell

Build the private React/Vite package with `pnpm --filter @spur-board/web build`; typecheck with
`pnpm --filter @spur-board/web typecheck`. Unit tests run through the root Vitest unit project:
`pnpm exec vitest run --project unit packages/web/test scripts/web.test.ts scripts/web-shell-qa.test.ts`.
The kit test runs in the process project:
`pnpm exec vitest run --project process packages/web/test/kit.test.ts`.
The shared Vitest root setup builds fresh web assets once before any selected project's workers
start, into the run's temporary harness directory. Asset tests consume that provided directory;
they neither require nor clean `packages/web/dist`. This applies to direct Vitest, local checks,
pre-push, CI and mutation runs. Existing workflow builds remain explicit build coverage; test
preparation independently rebuilds fresh assets for isolation. A standalone build is still
needed for serving or assembling output outside tests.
Components use CSS Modules and custom properties from `packages/web/src/ds/tokens.css`. Shared
components live in `packages/web/src/ds/` and are imported through `ds/index.ts`. Keep prototype
token names and values. Raw hex/RGB literals outside the token file fail the style policy test.
Primary, secondary, tertiary and status text meet 4.5:1; the attention chip is a deliberate
prototype exemption. The shell uses secondary text. A container with tertiary text
takes the `quiet` class from `ds/index.ts`; the `design-system` skill describes the pattern.

To add a design system component:

1. Create `packages/web/src/ds/<Name>/` with `<Name>.tsx`, `<Name>.module.css` and
   `<Name>.examples.tsx`.
2. Export at least one named zero-prop example per state or variant from `<Name>.examples.tsx`.
3. Re-export the component by name from `ds/index.ts`.
4. Run `pnpm ds:build` and check the component in the gallery (`design/README.md`, Run).

JetBrains Mono is local, emitted as hashed WOFF2 files, with `packages/web/OFL.txt` copied into
the published package. No external font requests or HTML injection. Browser code imports the
narrow `@spur-board/contracts/browser` entry; the build rejects server/catalog modules.
`pnpm package:build` builds web, runs the CLI clean build, then copies web output and verifies
its asset graph. React and React DOM ship in those assets; Vite remains build tooling.
The daemon loads `web/` next to its bundle at startup. Use the assembled/installed package
for daemon-backed serving; a source daemon does not read `packages/web/dist` directly, except a
stand, which passes it as its web root (`docs/qa-stand.md`).

For controlled shell states, exercise the shell with
`node scripts/web-shell-qa.ts --port 4780` through a disposable session sidecar after building.
This loopback fixture answers `status.get`, `config.get` (one project, `web`),
`inbox.operator`, `task.get` (task `PROJ-1` with why, for any key) and `task.history` (three
events of `PROJ-1`, for any key) and serves controlled stream
scenarios; it is never packaged.
Installed package smoke separately exercises the real configured web listener and assets. POST to
`/__qa/scenario/loading|empty|healthy|mixed|read-error|refresh-error|recovered|stream-drop`;
`loading` holds all five reads, `read-error` and `refresh-error` fail all five, and
POST `/__qa/release` releases held loading reads. The footer shows `status.get`
`daemon.version`, which the fixture's status scenarios supply; it stays empty until the first read.
