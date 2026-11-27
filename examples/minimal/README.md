# Minimal example: one repository, Todo, Dev, Review, Done

This example runs the Board for one public GitHub repository in one checkout, with the public
Spur and Claude Code or Codex. The agents follow the `spur-board` skill. The example runs
without Slack or the web UI.

- [`config.yaml`](config.yaml) - the Board config: one `github-issues` project with the columns
  Todo, Dev, Review and Done, the dispatcher on, and three Spur projects.
- [`projects.spur.yaml`](projects.spur.yaml) - the Spur projects: `example-worker` works on one
  issue per session, `example-reviewer` runs the Review column, and `example-operator` is the
  operator's session. Each has a short prompt step that points to the `spur-board` skill.

Replace `example-org/example-repo`, `example-user` and the project names with your own values in
both files.

The [quickstart requirements](../../docs/quickstart.md#requirements) cover Node, GitHub CLI and
the agent CLI. Your GitHub repository needs at least one commit on its default branch so Spur can
create worktrees. The [quickstart](../../docs/quickstart.md) shows how to verify each step.

## Steps

1. Install Spur and set it up:

   ```sh
   npm install -g --prefix "$HOME/.local" @shugaev/spur
   export PATH="$HOME/.local/bin:$PATH"
   spur init
   ```

   Add the `export` line to your shell profile. The Board needs Spur 1.53.0 or later. This example
   was checked with Spur 1.62.3. See [Install Spur](../../docs/quickstart.md#install-spur) for what
   `spur init` sets up and which notices to expect.

2. Install the `spur-board` package as [SETUP.md](../../SETUP.md#2-install-the-package) says, then
   install the agent skills:

   ```sh
   board skills install
   ```

   [SETUP.md](../../SETUP.md#5-install-skills-and-verify) explains what it installs.

3. Clone the repository, copy `projects.spur.yaml` to `spur.yaml` at the root of the checkout,
   replace the example values, and set each project's `defaultBranch` to the repository's default
   branch if it is not `main`. Add `/spur.yaml` to `.git/info/exclude` in the clone to keep it out
   of commits, then connect it from the checkout:

   ```sh
   spur connect spur.yaml
   ```

   For Codex, set `defaultAgent: codex`, after `board skills install` link
   `.agents/skills/spur-board` in the checkout to the installed skill, and uncomment `symlinks` in
   each project ([TROUBLESHOOTING.md](../../TROUBLESHOOTING.md#skillscodex_visibility)). Spur
   refuses a project id or `sessionPrefix` that another connected spur.yaml already uses: for a
   second copy of this example, rename all three projects in both files.

4. Sign GitHub in for the agents, as the user that runs the Spur sessions and as the account set
   in `operatorGithubLogin`. The agents push branches and open PRs under it; they never merge.
   The Board does not see PRs by another author. This needs the
   [GitHub CLI](https://cli.github.com/):

   ```sh
   gh auth login
   gh auth setup-git
   gh auth status
   ```

   Skip `gh auth setup-git` if you push over SSH. Set a Git commit identity for the same user,
   so the worker can commit:

   ```sh
   git config --global user.name "Your Name"
   git config --global user.email "you@example.com"
   ```

5. Copy `config.yaml` to `~/.config/spur-board/config.yaml` and replace the example values. Put
   `GITHUB_TOKEN` in `secrets.env` in the same directory, with mode `0600`, as
   [SETUP.md](../../SETUP.md#configuration-and-secrets) says. Using another config directory: see
   [SETUP.md](../../SETUP.md#configuration-and-secrets). Then check the config:

   ```sh
   board doctor --offline
   ```

6. Install the service, as
   [SETUP.md](../../SETUP.md#4-install-the-service-and-choose-operator-access) says:

   ```sh
   board service install
   ```

7. Complete the [first run of each agent](../../docs/quickstart.md#first-run-of-the-agent) from
   the checkout. Then start the reviewer and operator sessions from the checkout. A Review turn
   with no live reviewer session reports `no-session` after about 10 minutes.

   ```sh
   spur spawn example-reviewer "Review tasks in the Board's Review column for example-org/example-repo."
   spur spawn example-operator "Act as the Board operator for example-org/example-repo."
   ```

   Always pass a prompt: a spawn without a prompt starts without the project's steps. With both
   sessions live, run every check:

   ```sh
   board doctor
   ```

   Its `path.spur` and `orchestrator.sessions` checks need live Spur sessions, so they warn when
   run before this step. `Waiting` in `spur list` is normal between turns. `Completed` can describe a
   finished prompt or an ended session. The `orchestrator.sessions` check shows which reviewer
   session can receive the next turn. If it reports no live reviewer, repeat the reviewer launch
   command above to start a replacement.

8. Start one worker session per issue, with the issue URL in the prompt:

   ```sh
   spur spawn example-worker "Work on https://github.com/example-org/example-repo/issues/<N>"
   ```

## What happens next

The issue is a task in Todo. When the worker links its session, the Board moves the task to Dev
and gives the worker a Dev turn. The worker pushes, opens a PR that closes the issue and submits
its head. With green checks the task goes to Review. The reviewer posts its verdict, reviewed
head and notes on the PR, then submits the head or returns the task to Dev with the changes it
needs. Follow [Quickstart step 9](../../docs/quickstart.md#9-merge-the-pull-request) to check the
verdict and Board Review gate on the current head before you merge. The task then moves to Done,
and the worker wraps up and submits its Done turn.

If the repository runs no CI checks, uncomment `reposWithoutCi` in `config.yaml`: otherwise a PR
with no checks waits in Dev.

With separate checkouts for the worker, reviewer and operator, put each project in the spur.yaml
of its own checkout with `path: .`, or give it an absolute path, and connect each file.
