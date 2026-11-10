# Manual setup

The [`spur-board-setup` skill](packages/skills/setup/SKILL.md) is the assisted route. These steps
follow the same order for a manual installation. Check each existing setting before changing it.
Keep tokens out of chat, command history, and logs.

## 1. Inspect the machine and session

Use Linux with systemd user services, `flock`, npm, Node 24.12+ (24.x) or 26.x, and a running
Spur. Check the Node executable and `PATH` from a live Spur session; an interactive shell can
use a different Node. Check Spur through its HTTP API or its CLI from your home folder. Running
the Spur CLI inside a folder containing `spur.yaml` can attach that folder to the daemon.

The default files are `$HOME/.config/spur-board/config.yaml` and
`$HOME/.config/spur-board/secrets.env` (or under `$XDG_CONFIG_HOME/spur-board/`). `BOARD_HOME`
places them together in another directory. Inspect existing configuration before writing.

## 2. Install the package

Use the Node and npm visible to a live Spur session. Choose a user npm prefix whose `bin` is on
that session's `PATH`, commonly `$HOME/.local`. Install with that Node:

```sh
npm i -g --prefix "$HOME/.local" spur-board
board --version
```

Verify the version from the live session's `PATH`. If the intended version is already there,
keep it.

## 3. Create the Slack app and configuration

Choose private channels for the orchestrators and feed roles. The app must be invited before it
can see a private channel. The example names `#orchestrators` and `#board-feed` are defaults,
not requirements. The slash command defaults to `/board`; these names can be changed. Generate
an app manifest, then create or update the app in Slack:

```sh
board slack manifest --app-name spur-board --command /board
```

The slash command, the app name and the channel names must not already be used by another app
or another Board in the same workspace. When two Boards share a workspace and use the same
command or channel names, commands and delivery can reach the wrong Board. Before you generate
the manifest, type the command in a Slack message box and check that autocomplete offers no
existing command with that name, and check the workspace's installed apps and channels. If a name
is taken, pick a prefix of your own and use it for every name, for example the `/acme-board`
command, the `acme-board` app, and the `#acme-orchestrators` and `#acme-board-feed` channels:

```sh
board slack manifest --app-name acme-board --command /acme-board
```

The manifest does not create the app-level token. Create one with `connections:write` in the
app settings. Install the app to the workspace to obtain its bot token (`xoxb-…`); put that
value in `SLACK_BOT_TOKEN`. Put the app-level `connections:write` token (`xapp-…`) in
`SLACK_APP_TOKEN`. Store channel IDs, the chosen app name and slash command, project details,
and the operator's Slack user ID in `config.yaml`. For example, replace every placeholder with
your own values:

```yaml
projects:
  - id: board
    tracker:
      type: jira
      baseUrl: https://jira.example.invalid
      jql: 'project = BOARD'
      doneStatuses: [Done]
      readyStatuses: [Ready]
    repos: [example/board]
    operatorGithubLogin: example-user
    spurProjects:
      - name: operator
        role: operator
      - name: example-workers
        role: worker
operator:
  slack: U0123456789
slack:
  channels:
    orchestrators: C0123456789
    feed: C0123456790
digest:
  tz: UTC
```

The `spurProjects` name must match a live Spur project, and `digest.tz` is required. Set
`operatorGithubLogin` to the GitHub account agents open PRs under: PR discovery keeps only PRs by
that author, and it need not be the maintainer's own account. Use the
[configuration reference](docs/configuration.md) and [JSON Schema](packages/contracts/config.schema.json)
for fields and defaults.

For a `github-issues` project, the Board finds a PR's issue through `projects[].link`: the issues
the PR closes, a pattern on its head branch, and a pattern on its title. Set those patterns to the
branch and PR title rules your tracker repository already follows. The Board does not enforce
naming; the repository does, through its CI title check and the skills its agents use. When the
rules and the actual PR names differ, PRs stay unlinked. `board doctor` compares the link rules
with your recent PRs in the tracker repository and names the PRs they miss.

`tracker.label` and `tracker.milestone` are optional, and at most one may be set. With neither,
every open issue of `tracker.repo` becomes a task, including after a filter is removed from a
running config.

A Jira project links a PR in any of its repos by a `tracker.projectKeys` key (such as PROJ-12) in
its title or head branch, and sets `projects[].link` only when its repos name keys another way.

Put tokens in a private regular `secrets.env` file with mode `0600`; never put them in
`config.yaml`. `GITHUB_TOKEN` is required, `JIRA_EMAIL` and `JIRA_API_TOKEN` are needed for Jira,
and `SLACK_BOT_TOKEN` and `SLACK_APP_TOKEN` are needed when Slack is configured. The
[configuration reference](docs/configuration.md#secretsenv-keys) lists optional names. Provide
values through a private local input method and check only key names and file mode afterward.

For GitHub check runs and requested review teams on private repositories, use a
**classic personal access token with the `repo` and `read:org` scopes**. Authorize it for organization
SSO where applicable. A fine-grained personal access token can resolve the repository and pull
requests yet return `FORBIDDEN` for every `CheckRun` in `statusCheckRollup.contexts`, because it
lacks Checks permission. A classic token without `read:org` can return `INSUFFICIENT_SCOPES` for
a requested review team. A GitHub App with the needed permissions may be an alternative in a
future release.

Validate the file before starting the service:

```sh
board doctor --offline
```

An offline pass checks configuration only; it cannot prove tokens or integrations work.

## 4. Install the service and choose operator access

Check the service first, then install it if missing:

```sh
board service status
board service install
```

The unit uses absolute Node and package paths. User lingering keeps it running after logout;
enable it only if you want that behavior.

Choose one operator path. A Spur project marked `operator` in `config.yaml` needs no token. For
an operator session outside Spur, choose a folder and request a named token there:

```sh
board token create --name <name> --into <folder>
```

Approve the request in Slack before using the token. The CLI looks for the folder's
`.spur-board/token` while walking upward from the current directory, stopping at the root of
the git worktree, or at home outside git. Home itself is never searched, so when home is the
worktree root, choose a subfolder.
Register `board mcp` with the operator's agent if it is not already registered.

## 5. Install skills and verify

Install the bundled skills for Claude Code and Codex, then check a fresh agent session sees
them:

```sh
board skills install
board doctor --json
```

Fix each blocking doctor result and rerun until the checks are green. Warnings about sessions
that started before the latest skill install mean those sessions need a restart. After the first
complete poll, look for the `spur-board is live` line in the configured feed channel. See
[TROUBLESHOOTING.md](TROUBLESHOOTING.md) for check-specific fixes and logs.

To upgrade, run `board update` for the latest release, or `board update <version>` for a given
one, from a shell with the same Node and `BOARD_HOME` or `XDG_*` settings as the service (a live
Spur session). The service must be running. The command checks the target and the daemon
first, then saves a copy of the installed package and a backup of the database, installs the
new package, restarts the service, reinstalls the skills, waits up to five minutes for every
source's first complete poll and runs doctor. It keeps configuration, secrets and operator
access. If the new version fails a step, it puts the previous package and, when the schema
changed, the database back and exits 4 with `update_rolled_back`. On success it prints
`operator` lines: restart agent sessions that run `board mcp`, and stop and wake the Spur
sessions doctor lists as stale. To go back to the version before the last update later, run
`board rollback`; it first prints what data is lost, then asks to continue, or needs `--yes`
outside a terminal. See
[Failed update or rollback](TROUBLESHOOTING.md#failed-update-or-rollback).

### Upgrading from a version without `board update`

The installed package may predate `board update`. Upgrade it once by hand; every later upgrade
uses `board update`. Install the newer package with the Node and user prefix of a live Spur
session and verify `board --version` there. Note whether `board service status` reports
`active` as `active`. Run the new package's `board service install`: it rewrites the unit when
it differs, starts a stopped service, and restarts an active service when the unit changed. Run
`board service restart` only when the service was active before, install reported `changed` as
`false`, and the daemon version changed. Run `board skills install`, then `board doctor --json`
until no blocking check remains.

## 6. Link worker sessions to tasks

The Board links a Spur session to a task by three rules, in this order:

1. Explicit label: the session's Spur link `board-worker` (as worker) or `board-other` (as other)
   points at the task, as `<Jira base>/browse/KEY-12` or
   `https://github.com/<owner>/<repo>/issues/12`.
2. Pull request: the session's `pr` link is a PR linked to the task. A session off that PR's head
   branch goes to the branch rule first and otherwise links only as other.
3. Branch: the session's branch contains the task key or equals the head branch of a PR linked
   to the task.

A `board-worker` or `board-other` label links a session from any Spur project. The pull request
and branch rules need the session's Spur project listed in that project's `spurProjects` with
`role: worker`. A worker still needs its Spur project in `spurProjects`, with any role, to read
its task, ask questions or comment through the Board. The
[configuration reference](docs/configuration.md#session-links) gives each rule in full.

For a GitHub Issues task, a branch name such as `<agent>-12-slug` does not contain the task key,
and the worker's PR links to the issue only after it exists. Set the label when the worker
starts. `spur spawn` cannot set links, so make this the worker's first step, with the owner and
repo spelled as in `tracker.repo`:

```sh
spur slots --session "$SPUR_SESSION" --link board-worker=https://github.com/<owner>/<repo>/issues/<N>
```

A script that spawns the session passes the new session's ID instead of `$SPUR_SESSION`.

Check the link with `board status --detail`, which lists tasks with their links and the unlinked
sessions. If a session is not linked, the operator can run `board link` as
`board link <task> --session <session> --reason <value> --key <key>`; the session becomes worker
when the task has none, otherwise other.

A session of a `role: worker` Spur project whose `pr` link is a PR it only reviews, on a branch
other than the PR's head, links to that PR's task by the pull request rule as other, even when the
task has no worker. A review session checked out on the PR's head branch links as worker when the
task has none, unless it sets `board-other` to the task's URL before its `pr` link appears. A later
label changes nothing, because a link keeps its first role; the operator then removes the link
with `board unlink <task> --session <session> --reason <value> --key <key>`. No automatic rule
links it to that task again; `board link` restores it with its original role.
