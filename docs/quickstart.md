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
  issues and pull requests. Its default branch needs at least one commit for Spur to create
  worktrees. Adding a README when you create the repository is enough.
- Claude Code in the Spur sessions. Codex works too: follow step 3 of the
  [minimal example](../examples/minimal/README.md#steps) and
  [skills.codex_visibility](../TROUBLESHOOTING.md#skillscodex_visibility). After step 3, from the
  checkout, create the skills directory and link the installed skill into it; both commands are
  safe to rerun:

  ```sh
  mkdir -p .agents/skills
  ln -sfn "${CODEX_HOME:-$HOME/.codex}/skills/spur-board" .agents/skills/spur-board
  ```

Slack and the web UI are not needed. [Add more columns](#add-more-columns) shows how to add them
later.

### On Ubuntu or Debian

Ubuntu 24.04 ships Node 18 in its default apt repository. Select the latest 24.x release, which
includes npm, on the [Node.js download page](https://nodejs.org/en/download).

Install Node 24 system-wide so both your shell and `/usr/bin/node` use it. Spur's systemd user
services run `/usr/bin/node` directly. If an older system package already owns that path, use a
Node 24 package source that upgrades the system package in place.

Install `gh` using the [GitHub CLI apt repository instructions](https://github.com/cli/cli/blob/trunk/docs/install_linux.md#debian).

### Install Spur

Install Spur under `~/.local` so npm needs no root access. Put `~/.local/bin` on `PATH` for both
Spur and the Board:

```sh
npm install -g --prefix "$HOME/.local" @shugaev/spur
export PATH="$HOME/.local/bin:$PATH"
spur init
```

Add the `export` line to your shell profile so new shells and the Spur sessions keep it.

`spur init` installs and starts the Spur systemd user services, enables user linger so they keep
running after logout, and may use `sudo` to install Tailscale. For this local setup you can
ignore the `Tailscale not up` notice and the warning about a missing `~/.codex/skills` directory.

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

**Success looks like:** a list with one entry per agent and skill. Each entry has the fields
`agent`, `skill` and `changed`. When stdout is redirected or piped, the command prints the same
entries as a JSON array.

**If it fails:** a Codex session that cannot see the skill is covered by
[skills.codex_visibility](../TROUBLESHOOTING.md#skillscodex_visibility).

### 3. Put the example config and Spur projects in place

Clone your repository. Copy the contents of `projects.spur.yaml` to `spur.yaml` at the root of the
checkout, replace `example-org/example-repo`, `example-user` and the project names with your own
values, and set `defaultBranch` in all three projects to your repository's default branch if it is
not `main`. Add `/spur.yaml` to `.git/info/exclude` in the clone to keep the local configuration
out of commits. Then connect it from the checkout:

```sh
spur connect spur.yaml
```

Create the private config directory and an empty `secrets.env` with mode `0600` before you write
anything there, so the token is never readable by other users. The commands are safe to rerun:
they keep an existing `secrets.env` and its token.

```sh
mkdir -p ~/.config/spur-board
chmod 700 ~/.config/spur-board
[ -e ~/.config/spur-board/secrets.env ] || install -m 600 /dev/null ~/.config/spur-board/secrets.env
```

Copy the contents of `config.yaml` to `~/.config/spur-board/config.yaml` and replace the same
values. If your repository runs no CI checks, uncomment `reposWithoutCi` now: without it, a pull
request with no checks waits in Dev, and the daemon reads the config only when it starts. Add the
line `GITHUB_TOKEN=<your token>` to `secrets.env`, then check the config:

```sh
board doctor --offline
```

**Success looks like:** the command exits 0 and every line starts with `PASS` or `WARNING`.

**If it fails:** a `FAIL config` line names the field to fix
([config](../TROUBLESHOOTING.md#config)). The offline check does not read `secrets.env`; step 4
does. Spur refuses a project id that another connected
spur.yaml already uses: rename all three projects in both files
([Refused Spur session](../TROUBLESHOOTING.md#refused-spur-session)).
[Configuration and secrets](../SETUP.md#configuration-and-secrets) covers another config directory and Jira projects.

### 4. Start the service

```sh
board service install
```

**Success looks like:** the output names the `unitFile` it wrote and whether it `changed`.

**If it fails:** the install stops with exit 4 before it writes the unit when
`~/.config/spur-board/secrets.env` is missing, unreadable or not mode `0600`: fix it as
[secrets](../TROUBLESHOOTING.md#secrets) says and run the install again. It also stops with exit 4
when `http.port`, 4777 by default, is taken: see [http.port](../TROUBLESHOOTING.md#httpport) and, for a daemon that keeps
restarting, [EADDRINUSE](../TROUBLESHOOTING.md#eaddrinuse-the-daemon-restarts-every-5-seconds). A
missing or failed unit: [service.installed](../TROUBLESHOOTING.md#serviceinstalled); the wrong
Node: [service.node](../TROUBLESHOOTING.md#servicenode).

### First run of the agent

Before starting your first Spur session, launch each agent from the checkout as the same user
who runs Spur. For Claude Code, run `claude --dangerously-skip-permissions` to use the permission
mode Spur uses. Claude Code can ask whether you trust the workspace, show a Bypass Permissions
warning, and offer a renderer. Run `codex` if you use Codex and follow its own first-run prompts.
Sign in if prompted and exit each agent once it is ready for input.

If a spawn is already stuck on a dialog, open `spur list` in a terminal, select the session and
press Enter to attach. You can also run `tmux -L spur-4310 attach -t SESSION_ID`, replacing
`SESSION_ID` with the ID from the session launch output. The socket is `spur-<port>`, with `4310`
as the default Spur daemon port. Answer the dialogs, detach with Ctrl+G, then run
`spur kill SESSION_ID` and repeat the original spawn command with its prompt.

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

**Success looks like:** the command exits 0 with no `FAIL` line. `Waiting` in `spur list` is normal
between turns. `Completed` can describe a finished prompt or an ended session. The
`orchestrator.sessions` check shows which reviewer session the Board last saw as live. If it
reports `no live session` just after launch, wait for the next successful Spur poll and rerun
`board doctor`. If the reviewer is still running, check the session setup. Start a replacement
only after confirming the previous reviewer session has ended.
`WARNING web.spurUiOrigin` is expected without a Spur UI origin.
`WARNING link.rules` is expected until the repository has a pull request by `operatorGithubLogin`.
It never blocks
([link.rules](../TROUBLESHOOTING.md#linkrules)). `path.spur` and `orchestrator.sessions` must
show `PASS` once the sessions are live; they warn when run before this step, and a warning does
not change the exit code.

**If it fails:** an old Spur: [spur.version](../TROUBLESHOOTING.md#spurversion). A token without
`read:org`, or not authorized for SSO:
[github.credentials](../TROUBLESHOOTING.md#githubcredentials). Check runs or review teams the
token cannot read:
[GitHub check runs or review teams lack access](../TROUBLESHOOTING.md#github-check-runs-or-review-teams-lack-access).
No live reviewer session:
[orchestrator.sessions](../TROUBLESHOOTING.md#orchestratorsessions). `WARNING path.spur` with
live sessions means `board --version` failed on the `PATH` of the first live session: `board` is
missing there, or it is found but cannot run, for example because that `PATH` has no Node. The
agents then cannot query the Board or submit their turns. Run `board --version` in each session,
install the package with that session's Node and a prefix on its `PATH`, then rerun the check
([path.spur](../TROUBLESHOOTING.md#pathspur)).

### 6. Open a GitHub issue

```sh
gh issue create --repo example-org/example-repo --title "Add a hello script" --body "Add hello.sh that prints hello."
```

`gh` prints the issue URL; its number is `<N>` below. The Board polls GitHub issues about every
two minutes. After that, in the `example-operator` session, ask it to run `board status`.

The CLI takes its identity from the Spur session it runs in, so `board status` in a plain shell
fails with `identity_missing`. Type the request in the `example-operator` session, or send it from
a shell with `spur send <session id> "…"` and read the reply by opening the session from
`spur list`, which also shows the session id:

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
`example-operator` session, ask for the task's current state:

```text
Run board task example-org/example-repo#<N> --why and tell me the column, open turn reason, and any holds.
```

**Success looks like:** if the task is in `dev` with no open turn and a `submit_pending` hold,
the worker already submitted. The PR can be open on GitHub while the task query still reports
the Dev gate's `pr_open` condition as `failed` with reason `no_pr`. The Board links the PR on the
next poll that sees it. While the worker is still on its first Dev turn, the turn reason is
`dev: no_pr`. The task may already be in `review` by the time you check. Find the worker's pull
request on GitHub:

```sh
gh pr list --repo example-org/example-repo --author example-user --json number,body
```

It lists a pull request whose `body` says `Closes #<N>`; its `number` is `<PR>` in step 9.

**If it fails:** a task that stays in `todo` means the session is not linked:
[Link worker sessions to tasks](../SETUP.md#6-link-worker-sessions-to-tasks). A pull request with no
CI checks waits in Dev until `reposWithoutCi` lists the repository: uncomment it in `config.yaml`
and run `board service restart`, because the daemon reads the config only when it starts
([config.yaml fields](configuration.md#configyaml-fields)). If the task stays in `dev` after
the Board polls the repository, ask `example-operator` to check the task query's `links` for a
`kind: pr` entry with the `ref` `example-org/example-repo#<PR>`. If it is present, ask which Dev
gate condition still holds the task in Dev. If it is missing, check that the PR author is
`operatorGithubLogin` and that its branch or title matches the link rules
([link.rules](../TROUBLESHOOTING.md#linkrules)). A worker that never gets its turn:
[Doorbells not arriving](../TROUBLESHOOTING.md#doorbells-not-arriving).

### 8. Watch the reviewer review it

When the checks pass and the worker submits its head, the task moves to Review and the reviewer
gets a turn. In the `example-operator` session, ask it to run `board status`:

```text
Run board status and tell me the column and turn reason of example-org/example-repo#<N>.
```

**Success looks like:** if the task is in `review` and the reviewer already submitted, the turn
is closed. Go on to step 9 and check the Review gate. While the reviewer works, the open turn has
the reason `review: no_review_on_head`. If step 7 showed `submit_pending` in Dev, wait for the
Board to link the PR on the next poll and for its checks to pass. When the reviewer returns the
task, it goes back to `dev`, the worker fixes what the reviewer named, and the task comes back to
Review.

**If it fails:** no live reviewer session:
[orchestrator.sessions](../TROUBLESHOOTING.md#orchestratorsessions). A reviewer that never wakes
up: [Doorbells not arriving](../TROUBLESHOOTING.md#doorbells-not-arriving).

### 9. Merge the pull request

The agents never merge: you do. The reviewer posts its verdict, reviewed head, turn ID and notes
on the pull request before submitting or returning the Board turn. The comment looks like this:

```text
Board Review — Verdict: Ready | Head: <reviewed SHA> | Turn: <Review turn ID> | Notes: Checked the acceptance criteria and test results.
```

Open the pull request and read the latest reviewer comment for the current head. A change to the
pull request description can lead to another Review turn on the same commit:

```sh
gh pr view <PR> --repo example-org/example-repo --web
```

The task stays in `review` after a submit. Ask `example-operator` what the task waits for, and
find the submitted turn in History. If you have a comment, use its turn ID to match the notes
to that submission:

```text
Run board task example-org/example-repo#<N> --why --refresh and tell me what the task waits for on the refreshed head.
Run board task history example-org/example-repo#<N> and tell me which Review turn submitted that head and what full SHA it submitted.
```

If the comment is missing after an operator takeover or it still shows an earlier verdict,
use the submitted turn in History for the outcome. Just before merging, read the head SHA from
GitHub:

```sh
gh pr view <PR> --repo example-org/example-repo --json headRefOid --jq '.headRefOid'
```

When the Board reports `waits for: merge of example-org/example-repo#<PR> (a human)`, the Review
gate is met on the current head. If the submitted SHA also matches GitHub, press the merge button.
If the refresh fails or the SHAs differ, recheck the gate and the head before merging.
[Gates and placement](how-board-works-columns.md#gates-and-placement) explains the gates.

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
Run board status and tell me the column and turn reason of example-org/example-repo#<N>. Then run
board task example-org/example-repo#<N> --why and board task history example-org/example-repo#<N>
and tell me whether the task has an open turn and how its done: wrap up turn closed.
```

**Success looks like:** `example-operator` reports the task in `done`. While the worker is still
wrapping up, the task also has an open turn with the reason `done: wrap up`. The worker closes
that turn with `board submit` at the head the turn names; an ack alone leaves it open. Then the
task stays in `done` with no open turn, and the history lists the wrap-up turn's `turn_closed`
with outcome `submitted`.

**If it fails:** a task that stays in Review after the merge reads `waits for: ticket to close`:
check that step 9 shows `CLOSED`, then ask again after the next issue poll, about two minutes.

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
    feed: C0987654321
```

`operator.slack` is your Slack user ID; `slack.channels.orchestrators` and `slack.channels.feed`
are the IDs of two separate channels. Do not use one channel for both: messages in the feed
channel do not start operator conversations. Slack also needs its tokens in `secrets.env`. See
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
