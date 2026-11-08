# Troubleshooting

Run `board doctor --json` for check IDs, status, and a specific `fix`. A failed check blocks
readiness; a warning names a condition to review. Run `board doctor --offline` when the daemon
is down to validate `config.yaml` first. The checks below include both Slack-configured and
Slack-free installations. For a hung or stopped daemon, a Slack outage, an answer that never
reached its agent, or a planned pause, follow the [runbook](docs/runbook.md).

## Doctor checks

### config

Create or correct `config.yaml` using the [configuration reference](docs/configuration.md) and
[JSON Schema](packages/contracts/config.schema.json). The reported path points to the first
invalid field. An offline pass checks this file only.

### service.installed

The systemd user unit is missing. Run `board service install` after confirming the Node and
package paths visible to a live Spur session.

### service.node

The Node path stored in the unit is missing or invalid. Reinstall with `board service install`
using the Node visible to Spur sessions, so the unit is written with an absolute working path.

### service.running

Check `board service status`, then start or restart the user service. Read its journal if it
stops again.

### flock

Install `flock` from util-linux and rerun the doctor.

### path.current

Install the package in a prefix whose `bin` appears on the current `PATH`, then check
`board --version`.

### path.spur

Start a live Spur session to let the doctor inspect its `PATH`. If the Board binary is absent
there, install it with that session's Node and a user prefix on that `PATH`.

### skills.codex_visibility

Checks the skill install of each configured Spur project, without depending on live sessions.
The doctor asks Spur's `GET /projects` at `adapters.spur.baseUrl` for the project's main
checkout, then checks two things there:

- `.agents/skills/spur-board` in the main checkout is a link to an installed product skill:
  `$CODEX_HOME/skills/spur-board` when `CODEX_HOME` is set, otherwise
  `~/.codex/skills/spur-board`, or `~/.claude/skills/spur-board`. Create it with
  `ln -s ~/.codex/skills/spur-board .agents/skills/spur-board` from the main checkout after
  `board skills install`. Run the doctor with the same `CODEX_HOME` as `board skills install`.
- `projects.<id>.symlinks` in the project's `spur.yaml` (or `spur.yml`) lists
  `.agents/skills/spur-board`, so Spur links the skill into each new worktree.

A failure means a project used by Codex misses one of the two. A project counts as used by
Codex when a live Codex session runs in it, its `spur.yaml` entry sets `defaultAgent: codex`,
its `symlinks` list the path, or the main-checkout link resolves. A Codex-only project with
none of these signals is not checked.

A warning means the doctor could not decide: Spur is not reachable at `adapters.spur.baseUrl`,
a `spurProjects` name in `config.yaml` is not a Spur project ID, or the project's `spur.yaml`
does not define the project. Start Spur, correct the name or the `spur.yaml` entry, then rerun
the doctor. The [setup skill](packages/skills/setup/SKILL.md) gives the project-checkout steps.

### sessions.codex_skill

Warns about live Codex sessions that cannot see the product skill while their project's install
passes `skills.codex_visibility`. Spur links `.agents/skills/spur-board` only when it creates a
worktree, so these sessions started before the link. Start new sessions to replace them. It
passes while `skills.codex_visibility` fails or warns: fix that check first, then rerun.

### sessions.stale

Restart live sessions started before the latest `board skills install`; they do not reload
new skill files automatically. Verify any session whose start time cannot be read.

### http.port

Runs only without `--offline`. It binds `127.0.0.1` on `http.port` from `config.yaml` and closes
at once, the way the daemon would listen. It passes when the port is free, when `http.port` is
`0`, or when the process holding the port answers with a spur-board daemon instance header. Otherwise
it fails and names the port and the holder as `<name> (pid <pid>)`. When `ss` cannot see the
owner, for example a process of another user, the fix says "a process not visible to this
user"; run `ss -ltnp 'sport = :<port>'` as that user or with privileges to name it. Stop that
process or set `http.port` to a free port, then start the service again. Any spur-board daemon passes
this check, including one of another user or another `BOARD_HOME`. `board service install` runs
the same check and stops with exit 4 before it writes the unit.

### daemon.available

Start or restart the user service, then rerun `board doctor --json`. If it still fails, check
the service journal. The CLI connects to `http.port` in `config.yaml` (default `4777`) unless
`BOARD_DAEMON_URL` is set; that variable overrides the configured port. An empty or invalid
`BOARD_DAEMON_URL`, or `http.port: 0` without the variable, fails before any request is sent.

### secrets

Keep `secrets.env` a regular private file with mode `0600` beside `config.yaml`. Add the key
names listed in the check's `fix` through a private local input method. Do not display secret
values. A legacy `slack.env` can be migrated after checking which keys it contains.

### jira.credentials

Check the Jira account email, API token, project access, and configured Jira URL. This check
passes without Jira trackers. It cannot be repaired by an offline doctor pass.

### github.credentials

Check `GITHUB_TOKEN` and repository access. This check also probes check-run contexts and
requested review team names. A `FORBIDDEN` result for a `CheckRun` or `INSUFFICIENT_SCOPES` for
a team name needs the GitHub recovery below. A repository without check contexts can pass the
check-data probe.

### link.rules

For each github-issues project, the daemon reads the last 50 open or merged PRs updated in
`tracker.repo` and matches up to 10 of them authored by `operatorGithubLogin` against
`projects[].link`. The check never blocks. It passes when every sampled PR yields an issue
number, or when no project uses GitHub Issues. A warning names, per project, how many sampled PRs
match and the unmatched PRs as `#<number>` with their branch. Change `projects[].link` to follow
the repository's branch and PR title rules, which the repository's CI title check and its agents'
skills enforce. Other warnings say the operator has no PRs there, the PRs could not be read,
`tracker.repo` is missing from `projects[].repos`, or `GITHUB_TOKEN` is missing.

### spur.api

Start the Spur API or correct `adapters.spur.baseUrl` in `config.yaml`.

### spur.send

The daemon delivers doorbells with `POST <adapters.spur.baseUrl>/sessions/<id>/send`. This
check sends that request to the reserved session `spur-board-doctor-probe`, which never exists,
so no agent receives it; it passes when Spur answers that the session is not found. No answer
means Spur is down or `adapters.spur.baseUrl` is wrong: start Spur or correct the URL. Any other
answer means that Spur API does not accept doorbell sends: update Spur, or point
`adapters.spur.baseUrl` at the Spur daemon. Restart the service after changing `config.yaml`.

### slack.auth

Check `SLACK_BOT_TOKEN`, its bot scopes, and app installation. Add missing scopes to the app
and reinstall it before rerunning the doctor.

### slack.orchestrators_member

Invite the bot to the private orchestrators channel whose ID is stored in
`slack.channels.orchestrators`. `#orchestrators` is only a default name.

### slack.feed_member

Invite the bot to the private feed channel whose ID is stored in `slack.channels.feed`.
`#board-feed` is only a default name.

### slack.command

Check that the installed Slack slash command matches `slack.command` in `config.yaml`.
`/board` is the default, not a fixed name. To verify the installed manifest through the API,
provide `SLACK_APP_CONFIG_TOKEN` and `slack.appId`; otherwise inspect the command manually.

### slack.configured

Slack is not configured. Questions addressed to the operator remain visible through the
Board inbox. Use the setup skill to assign the orchestrators and feed channel IDs when Slack
delivery is wanted. This check appears instead of the four Slack integration checks above.

### operator.path

Choose a Spur project marked `operator`, or create a named token in a chosen folder and approve
its request in Slack. A token waiting for approval does not satisfy this check.

### versions

Install matching CLI and skill versions, then restart the daemon. After an upgrade, rerun
`board skills install`, check `board --version` in both the current and live Spur session
`PATH`, and restart sessions that still use an older skill. If the service unit points to an
old Node or package path, run `board service install` again.

## Exit codes 3, 4, and 5

- **3 — not applied:** a dependency prevented the action. Fix the dependency, then retry the
  same action with its existing idempotency key.
- **4 — configuration:** `config` means a config field, private secret key, or environment
  variable is wrong: correct the named one and retry after validation. An empty `BOARD_TOKEN`
  override fails with `config`. `BOARD_DAEMON_URL` must be a valid HTTP(S) address when set; an
  empty value fails. Use `board doctor --offline` to check `config.yaml` while the service is
  down. `identity_missing` means there is no Spur session, `BOARD_TOKEN` is unset, and the CLI
  found no `.spur-board/token` walking up from the current folder. Run the command in a Spur
  session of a project listed in `config.yaml`, or run
  `board token create --name <name> --into <folder>` and approve the request in Slack. An
  operator-only command such as `board token list` needs a Spur project marked `operator` or an
  approved token. `service_start_failed` means `board service install` or
  `board service restart` left the unit installed but the daemon did not start: read
  `journalctl --user -u spur-board.service -n 100` and run `board doctor`, fix the cause, then
  run `board service restart`.
- **5 — outcome unknown:** the action may already have happened. Read the task or item first;
  if a mutation still needs to be retried, reuse its original idempotency key. A read-only
  request can be repeated after the dependency recovers.

## Doorbells not arriving

Workers never get the doorbell that asks them to check the Board inbox after a question is
answered. Run `board doctor --json` and check `spur.api` and `spur.send`. Then search the
service journal from `journalctl --user -u spur-board` for lines with `"call":"spur.send"` and
`"outcome":"error"`; the error names the HTTP status Spur returned. Earlier versions ran the
`spur` command and failed with `spur send failed to start` because the service `PATH` lacks the
directory Spur installs into: upgrade the package and restart the service. If the doorbell was
delivered but the agent never acted on the answer, follow
[runbook section 4](docs/runbook.md#4-answer-never-reached-the-agent-answer_undelivered).

## Logs and request IDs

Read the service journal with `journalctl --user -u spur-board`. Logs are JSON lines; find the
`requestId` from the CLI error in the journal to follow one request through the daemon. Share
the request ID and a redacted error with an issue report, never tokens or private file contents.

## EADDRINUSE: the daemon restarts every 5 seconds

**Symptom:** the service journal repeats a `start failed` line with `module` `http` and the
error `listen EADDRINUSE: address already in use 127.0.0.1:<port>`, and systemd restarts the
daemon every 5 seconds.

**Check:** run `board doctor`; the `http.port` check names the process holding the port. Run
`ss -ltnp 'sport = :<port>'` to list the listener yourself.

**Fix:** set `http.port` in `config.yaml` to a free port. Avoid Spur's server port 4310 and the
ports from 4311 upward that its MCP port takes (spur-board keeps 4310-4399 as a margin for them),
Spur's web UI port 5555, its Playwright sidecar ports 8730-8799, and the Linux ephemeral range
32768-60999. Then run `board service restart`, and update `BOARD_DAEMON_URL` if it is set.

**Upgrade:** the default `http.port` moved from 4311 to 4777. A `config.yaml` with
`http.port: 4311` keeps the old port; clients that set `BOARD_DAEMON_URL` to the old port need
the new one after the daemon restarts.

## GitHub check runs or review teams lack access

A fine-grained personal access token can read a private repository and its pull requests while
every `CheckRun` under `statusCheckRollup.contexts` returns `FORBIDDEN` with a resource-access
error: "Resource not accessible by personal access token". It lacks Checks permission. A classic
token with `repo` but without `read:org` can return `INSUFFICIENT_SCOPES` for a requested
review team's `Team.name`. Use a **classic personal access token with the `repo` and `read:org`
scopes**, and authorize it for organization SSO where applicable. Put it in `GITHUB_TOKEN`
through private local input, restart the service, and rerun `board doctor`. A GitHub App with
the needed permissions may be an alternative in a future release.
