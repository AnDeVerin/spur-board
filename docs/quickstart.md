# Quickstart: from zero to a first task in Done

This page takes you from a fresh Linux host to one GitHub issue that moves through To Do, Dev,
Review and Done. It builds the setup from the minimal example:
[`examples/minimal/config.yaml`](../examples/minimal/config.yaml) is the Board config and
[`examples/minimal/projects.spur.yaml`](../examples/minimal/projects.spur.yaml) holds the three
Spur projects: `example-worker`, `example-reviewer` and `example-operator`. Open each file on the
repository page and copy its contents when a step asks for it.

Each step shows the command, what success looks like, and where to look when it fails. The
[Board overview](overview.md) explains the columns and turns behind them.

## Requirements

- Linux with systemd user services and `flock`.
- Node 24.12+ (24.x) or 26.x, with its npm.
- Spur 1.53.0 or newer. The minimal example was checked with Spur 1.62.3.
- A GitHub classic personal access token with the `repo` and `read:org` scopes, authorized for
  SSO where the organization uses it.
- The [GitHub CLI](https://cli.github.com/), and a GitHub repository you own where you can open
  issues and pull requests.
- Claude Code in the Spur sessions. Codex works too: follow step 3 of the
  [minimal example](../examples/minimal/README.md#steps) and
  [skills.codex_visibility](../TROUBLESHOOTING.md#skillscodex_visibility).

Slack and the web UI are not needed. [Add more columns](#add-more-columns) shows how to add them
later.

### Install Spur

```sh
npm install -g @shugaev/spur
spur init
```

`board doctor` blocks on a Spur older than 1.53.0 with
[spur.version](../TROUBLESHOOTING.md#spurversion).

### Sign GitHub in and set a Git identity

Sign in as the user that runs the Spur sessions, with the GitHub account you will put in
`operatorGithubLogin`. The agents push branches and open pull requests under it; the Board sees
only pull requests by this author.

```sh
gh auth login
gh auth setup-git
gh auth status
```

Skip `gh auth setup-git` if you push over SSH. Set a Git commit identity for the same user, so the
worker can commit:

```sh
git config --global user.name "Your Name"
git config --global user.email "you@example.com"
```

## Steps

### 1. Install the package

Install with the Node that Spur sessions use, under a user prefix whose `bin` is on their `PATH`:

```sh
npm i -g --prefix "$HOME/.local" spur-board
board --version
```

**Success looks like:** `board --version` prints the installed version.

**If it fails:** a `command not found` means the prefix `bin` is not on `PATH`;
[Install the package](../SETUP.md#2-install-the-package) covers the prefix and the Node choice.

### 2. Install the skills

```sh
board skills install
```

**Success looks like:** one row per agent and skill, with the columns `agent`, `skill` and
`changed`.

**If it fails:** a Codex session that cannot see the skill is covered by
[skills.codex_visibility](../TROUBLESHOOTING.md#skillscodex_visibility).

### 3. Put the example config and Spur projects in place

Clone your repository. Copy the contents of `projects.spur.yaml` to `spur.yaml` at the root of the
checkout, replace `example-org/example-repo`, `example-user` and the project names with your own
values, and connect it from the checkout:

```sh
spur connect spur.yaml
```

Copy the contents of `config.yaml` to `~/.config/spur-board/config.yaml` and replace the same
values. Put `GITHUB_TOKEN=<your token>` in `~/.config/spur-board/secrets.env` with mode `0600`.
Then check the config:

```sh
chmod 600 ~/.config/spur-board/secrets.env
board doctor --offline
```

**Success looks like:** the command exits 0 and every line starts with `PASS` or `WARNING`.

**If it fails:** a `FAIL config` line names the field to fix
([config](../TROUBLESHOOTING.md#config)); a `FAIL secrets` line is about `secrets.env`
([secrets](../TROUBLESHOOTING.md#secrets)). Spur refuses a project id that another connected
spur.yaml already uses: rename all three projects in both files
([Refused Spur session](../TROUBLESHOOTING.md#refused-spur-session)).
[Configuration and secrets](../SETUP.md#configuration-and-secrets) covers another config directory and Jira projects.

### 4. Start the service

```sh
board service install
```

**Success looks like:** the output names the `unitFile` it wrote and whether it `changed`.

**If it fails:** the install stops with exit 4 before it writes the unit when `http.port`, 4777 by
default, is taken: see [http.port](../TROUBLESHOOTING.md#httpport) and, for a daemon that keeps
restarting, [EADDRINUSE](../TROUBLESHOOTING.md#eaddrinuse-the-daemon-restarts-every-5-seconds). A
missing or failed unit: [service.installed](../TROUBLESHOOTING.md#serviceinstalled); the wrong
Node: [service.node](../TROUBLESHOOTING.md#servicenode).

### 5. Run `board doctor` until green

Start the reviewer and the operator sessions from the checkout and keep them open. The Board does
not start them. Always pass a prompt: a session started without one skips the project's steps.

```sh
spur spawn example-reviewer "Review tasks in the Board's Review column for example-org/example-repo."
spur spawn example-operator "Act as the Board operator for example-org/example-repo."
```

With both sessions live, run every check:

```sh
board doctor
```

**Success looks like:** the command exits 0 with no `FAIL` line. `WARNING web.spurUiOrigin` is
expected without a Spur UI origin. `path.spur` and `orchestrator.sessions` pass once the sessions
are live; they warn when run before this step.

**If it fails:** an old Spur: [spur.version](../TROUBLESHOOTING.md#spurversion). A token without
`read:org`, or not authorized for SSO:
[github.credentials](../TROUBLESHOOTING.md#githubcredentials). Check runs or review teams the
token cannot read:
[GitHub check runs or review teams lack access](../TROUBLESHOOTING.md#github-check-runs-or-review-teams-lack-access).
No live reviewer session:
[orchestrator.sessions](../TROUBLESHOOTING.md#orchestratorsessions). Spur not found on the
service's `PATH`: [path.spur](../TROUBLESHOOTING.md#pathspur).

### 6. Open a GitHub issue

```sh
gh issue create --repo example-org/example-repo --title "Add a hello script" --body "Add hello.sh that prints hello."
```

`gh` prints the issue URL; its number is `<N>` below. The Board polls GitHub issues about every
two minutes. After that, in the `example-operator` session, ask it to run `board status`:

```text
Run board status and tell me the column of example-org/example-repo#<N>.
```

**Success looks like:** `example-operator` reports the task `example-org/example-repo#<N>` in
`todo`.

**If it fails:** with `label` uncommented under `tracker` in `config.yaml`, only issues with that
label become tasks: add the label. A token that cannot read the repository:
[github.credentials](../TROUBLESHOOTING.md#githubcredentials).

### 7. Watch the worker take it

Start one worker session for the issue, with the issue URL in the prompt:

```sh
spur spawn example-worker "Work on https://github.com/example-org/example-repo/issues/<N>"
```

The worker links its session to the task, and the Board moves the task to Dev. In the
`example-operator` session, ask it to run `board status` again:

```text
Run board status and tell me the column and turn reason of example-org/example-repo#<N>.
```

**Success looks like:** `example-operator` reports the task in `dev` with the turn reason
`dev: no_pr`. Later the worker's pull request shows on GitHub:

```sh
gh pr list --repo example-org/example-repo --author example-user
```

It lists a pull request whose body says `Closes #<N>`.

**If it fails:** a task that stays in `todo` means the session is not linked:
[Link worker sessions to tasks](../SETUP.md#6-link-worker-sessions-to-tasks). A pull request with no
CI checks waits in Dev until you uncomment `reposWithoutCi` in `config.yaml`
([config.yaml fields](configuration.md#configyaml-fields)). A worker that never gets its turn:
[Doorbells not arriving](../TROUBLESHOOTING.md#doorbells-not-arriving).

### 8. Watch the reviewer review it

When the checks pass and the worker submits its head, the task moves to Review and the reviewer
gets a turn. In the `example-operator` session, ask it to run `board status`:

```text
Run board status and tell me the column and turn reason of example-org/example-repo#<N>.
```

**Success looks like:** `example-operator` reports the task in `review` with the turn reason
`review: no_review_on_head`. After the reviewer submits, the task waits in `review` until you
merge. When the reviewer returns the task, it goes back to `dev`, the worker fixes what the
reviewer named, and the task comes back to Review.

**If it fails:** no live reviewer session:
[orchestrator.sessions](../TROUBLESHOOTING.md#orchestratorsessions). A reviewer that never wakes
up: [Doorbells not arriving](../TROUBLESHOOTING.md#doorbells-not-arriving).

### 9. Merge the pull request

The agents never merge: you do. Open the pull request in the browser and press the merge button:

```sh
gh pr view <PR> --repo example-org/example-repo --web
```

**Success looks like:** the merge closes the issue:

```sh
gh issue view <N> --repo example-org/example-repo --json state
```

It prints `"state": "CLOSED"`.

**If it fails:** an issue that stays open means the pull request body lacks `Closes #<N>`; close
it by hand. A token that cannot read the merge:
[github.credentials](../TROUBLESHOOTING.md#githubcredentials).

### 10. See the task in Done

In the `example-operator` session, ask it to run `board status`:

```text
Run board status and tell me the column and turn reason of example-org/example-repo#<N>.
```

**Success looks like:** `example-operator` reports the task in `done` with the turn reason
`done: wrap up`. The worker finishes its Done turn.

**If it fails:** a task that stays in Review has no linked pull request: its author is not
`operatorGithubLogin`, or its branch and title do not match the link rules
([link.rules](../TROUBLESHOOTING.md#linkrules)).

## Add more columns

The minimal project has To Do, Dev, Review and Done. Each section below adds one part. Columns go
under `projects[].columns` in canonical order: To Do, Triage, Ready for Dev, Dev, Review, Product
Review, External Review, QA, Ready to Merge, Done. Insert each new entry between its neighbours in
that order, then restart the service so the daemon reads the change.

### The Backlog group

Triage and Ready for Dev join To Do in the Backlog group, where a task rests until work starts.
Insert them after `todo`:

```yaml
- id: todo
- id: triage
- id: ready-for-dev
```

With `projects[].columns[].source` set to a tracker source on `ready-for-dev`, the Board places
tasks from a GitHub Project status; the token then also needs `read:project`. See
[Mirror a GitHub Project status to Ready for Dev](configuration.md#example-mirror-a-github-project-status-to-ready-for-dev)
and the [Backlog band](web-ui-board.md) of the web UI.

### Product Review

Product Review is a second review after Review. Insert it after `review`:

```yaml
- id: product-review
  orchestrator: none
```

`projects[].columns[].orchestrator` picks who takes its turns: `none` gives them to the operator,
or name a Spur project with role `orchestrator`. See
[Gates and placement](how-board-works-columns.md#gates-and-placement).

### External Review

External Review waits for an approval by someone other than `operatorGithubLogin`, with no turn.
Insert it after Product Review, or after `review`:

```yaml
- id: external-review
  approvalRule: github-rules
```

`projects[].columns[].approvalRule` is `any-approval` by default; `github-rules` also follows
GitHub's review rule. `projects[].checksGate: external-review` moves the wait for green checks to
this column. See [Green checks at External Review](configuration.md#example-green-checks-at-external-review)
and
[Follow the GitHub review rule at External Review](configuration.md#example-follow-the-github-review-rule-at-external-review).

### QA

QA is a test pass before the merge. Insert it after External Review, or after the last review
column you have:

```yaml
- id: qa
  orchestrator: none
```

`projects[].columns[].orchestrator` works as for Product Review: `none` gives the turns to the
operator. See [Gates and placement](how-board-works-columns.md#gates-and-placement).

### Ready to Merge

Ready to Merge holds a task with green checks until you merge. Insert it before `done`:

```yaml
- id: ready-to-merge
  requireResolvedThreads: true
```

`projects[].columns[].requireResolvedThreads` defaults to true here: an unresolved review thread
sends the task back to Dev. See [config.yaml fields](configuration.md#configyaml-fields).

### Slack

Slack adds feed lines for items addressed to you and threads for questions you answer by
replying. Add at the top level of `config.yaml`:

```yaml
operator:
  slack: U0123456789
slack:
  channels:
    orchestrators: C0123456789
    feed: C0123456789
```

`operator.slack` is your Slack user ID; `slack.channels.orchestrators` and `slack.channels.feed`
are the channel IDs. Slack also needs its tokens in `secrets.env`. See
[Create the Slack app and configuration](../SETUP.md#3-create-the-slack-app-and-configuration).

### The web UI

The web UI shows the columns, the inbox and service health in a browser. Add at the top level of
`config.yaml`:

```yaml
web:
  port: 7777
  publicOrigin: http://127.0.0.1:7777
```

Set `web.port` and `web.publicOrigin` together. The web UI has no login of its own: reach it from
another machine only through an authenticating reverse proxy or an SSH tunnel. See
[Optional browser access](../SETUP.md#optional-browser-access).

## Where to go next

- [Board overview](overview.md): the columns, turns and the inbox in one page.
- [Manual setup](../SETUP.md): every install and config step in detail.
- [Configuration reference](configuration.md): every `config.yaml` field and its default.
- [Troubleshooting](../TROUBLESHOOTING.md): each doctor check and its fix.
