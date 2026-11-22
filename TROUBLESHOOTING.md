# Troubleshooting

Run `board doctor --json` for check IDs, status, and a specific `fix`. A failed check blocks
readiness; a warning names a condition to review. Run `board doctor --offline` when the daemon
is down to validate `config.yaml` first. The checks below include both Slack-configured and
Slack-free installations. For a hung or stopped daemon, a Slack outage, an answer that never
reached its agent, or a planned pause, follow the [runbook](docs/runbook.md).

## Doctor checks

Warnings never block readiness or an update. Blocking failures retain these gates:

| Checks                                                                                                                                                                                                | Policy and reason                                                                                             |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `config`                                                                                                                                                                                              | Blocking: invalid daemon config.                                                                              |
| `service.installed`, `service.node`, `service.running`, `flock`, `http.port`, `daemon.available`                                                                                                      | Blocking: runtime, lock, API and service prerequisites.                                                       |
| `database.private`, `secrets`                                                                                                                                                                         | Blocking: private storage and configured credentials.                                                         |
| `jira.credentials`, `github.credentials`, `spur.api`, `spur.send`, `spur.version`                                                                                                                     | Blocking when configured: polling, enrichment or doorbell work fails; GitHub throttle warnings stay advisory. |
| `slack.auth`, `slack.orchestrators_member`, `slack.feed_member`, known `slack.command` mismatch                                                                                                       | Blocking when configured: delivery and inbound commands; unknown or unconfigured results warn.                |
| `operator.path`                                                                                                                                                                                       | Blocking: no operator session or approved token for required operator work.                                   |
| `web.listening`, `web.spurUiOrigin`, `path.current`, `path.spur`, `skills.codex_visibility`                                                                                                           | Warning: optional browser or agent tooling; the daemon continues.                                             |
| `versions`                                                                                                                                                                                            | Blocking daemon/running CLI mismatch; warning auxiliary PATH binary or skill versions.                        |
| `web`, `projects.checksGate`                                                                                                                                                                          | Passing configured-state report; no independent failure gate.                                                 |
| `stand.port_range`, `link.rules`, `github.review_rule`, `github.mirror`, `sessions.codex_skill`, `sessions.stale`, `operator.tokens`, `curator.sessions`, `orchestrator.sessions`, `slack.configured` | Advisory; preserve their warnings.                                                                            |

### config

Create or correct `config.yaml` using the [configuration reference](docs/configuration.md) and
[JSON Schema](packages/contracts/config.schema.json). The reported path points to the first
invalid field. An offline pass checks this file only. A Spur project can be listed under only one
Board project.

### web

Reports configured state, including offline: `off` when `web.port` is omitted, or `on` with
its resolved `web.publicOrigin`. This passing check validates settings only; it does not probe
or start a listener. Set `web.port` and `web.publicOrigin` together. Every `{port}` in the public
origin is replaced by the configured port. `web.spurUiOrigin` independently configures the UI
origin; it accepts no placeholders.

### web.listening

The daemon reports whether its optional web listener is bound. A busy web port warns in this
check while the agent API continues running. Free `web.port` or select another port and restart
the daemon. This differs from `web`, which validates the settings offline; `web.listening`
reports whether the loopback listener bound. Neither check probes the proxy, its authentication
or TLS.

The web UI has no login of its own: anyone who reaches it acts as operator. The daemon binds it
to `127.0.0.1`; another machine reaches it only through an authenticating reverse proxy or an
SSH tunnel, as
[Remote access through Caddy with basic auth](SETUP.md#remote-access-through-caddy-with-basic-auth)
shows. Set `web.port` and `web.publicOrigin` together and keep `Host` unchanged through the
proxy. Origin must exactly match the resolved public origin. A 503 page
saying "UI is not built" means the UI assets are absent: run
`pnpm --filter @spur-board/web build` in a checkout, assemble with `pnpm package:build`, and
restart the daemon to reload assets. Health and operations
remain usable. See [Security](SECURITY.md) before enabling anonymous operator access.

### web.spurUiOrigin

Online doctor checks the optional Spur UI origin independently of `web.port`. When unset, it
warns without blocking: set `web.spurUiOrigin` for the intended session links at
`<origin>/sessions/<session id>`; otherwise the fallback is plain session IDs.
One unauthenticated GET to the origin root passes on any HTTP response, including redirects
and error statuses, without following redirects or reading the body. This does not check
individual session pages. Every transport error or two-second timeout warns without blocking
doctor, setup, updates or rollback. Recognized cause codes identify refused connections, DNS,
unreachable networks, TLS and timeouts without exposing raw transport text.
Start the Spur UI or correct `web.spurUiOrigin` in
`config.yaml`. Restart the daemon after config changes and rerun `board doctor --json`.
Offline doctor validates configuration only and sends no probe.

For an expired certificate (`CERT_HAS_EXPIRED`), renew it. For a private or self-signed CA
(`DEPTH_ZERO_SELF_SIGNED_CERT`, `SELF_SIGNED_CERT_IN_CHAIN`,
`UNABLE_TO_VERIFY_LEAF_SIGNATURE`, `UNABLE_TO_GET_ISSUER_CERT_LOCALLY`), install the CA in
system trust or supply its PEM root through `NODE_EXTRA_CA_CERTS` at daemon startup. A shell
export alone does not change an already running user service. Create a separate drop-in:

```sh
mkdir -p ~/.config/systemd/user/spur-board.service.d
```

Write `~/.config/systemd/user/spur-board.service.d/ca.conf` with an absolute CA path:

```ini
[Service]
Environment="NODE_EXTRA_CA_CERTS=/path/to/ca-root.pem"
```

Then run `systemctl --user daemon-reload` and `systemctl --user restart spur-board.service`.
Install and update replace the generated main unit while preserving this separate drop-in;
update accepts the additional effective CA environment variable. Alternatively use an HTTP UI
origin on any host without voice. `web.publicOrigin` and credential-bearing adapter URLs keep
their HTTP loopback restrictions. Never disable TLS verification globally.

### stand.port_range

Reports the effective stand port range, including offline. Omission uses 4780..4799 and preserves
legacy configs: overlap with `http.port` or `web.port` produces a nonblocking warning naming
each port. Set a nonoverlapping `stand.portRange` to clear it. Explicit ranges, including `{}`
with default endpoints, reject overlaps during config validation. The stand takes its web port,
and an explicit API port, from this range and refuses `http.port` and `web.port`; an API port of
0, the default, is assigned by the kernel.

### projects.checksGate

Reports the `checksGate` of each project in `config.yaml` as `<project>=<column>`, including
offline; `dev` when the key is absent. It always passes: a value other than `dev`, `review`,
`product-review` or `external-review`, or a column that is absent or disabled, fails `config`.
The daemon reads the key at start, so a change takes effect after a restart; `board config get`
shows the value the running daemon uses.

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

Start a live Spur session to let the doctor inspect its `PATH`; `sessions.stale` defines a live
session. If the Board binary is absent there, install it with that session's Node and a user
prefix on that `PATH`.

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

A warning can mean a project used by Codex misses one of the two. A project counts as used by
Codex when a live Codex session runs in it, its `spur.yaml` entry sets `defaultAgent: codex`,
its `symlinks` list the path, or the main-checkout link resolves. A Codex-only project with
none of these signals is not checked.

A warning also means the doctor could not decide: Spur is not reachable at `adapters.spur.baseUrl`,
a `spurProjects` name in `config.yaml` is not a Spur project ID, or the project's `spur.yaml`
does not define the project. Start Spur, correct the name or the `spur.yaml` entry, then rerun
the doctor. The [setup skill](packages/skills/setup/SKILL.md) gives the project-checkout steps.

### sessions.codex_skill

Warns about live Codex sessions (as `sessions.stale` defines them) that cannot see the product
skill while their project's install passes `skills.codex_visibility`. It decides per session: a
session passes when any of its processes works in a directory whose `.agents/skills/spur-board`
resolves to an installed copy, or its `CODEX_HOME` has `skills/spur-board/SKILL.md`, so child
processes in other directories do not flag it. Start and link times are not used. It warns when
no process of the session has that link, the link is broken, or it resolves to another copy.
Spur links `.agents/skills/spur-board` only when it creates a worktree, so start new sessions to
replace the ones it names. It passes while `skills.codex_visibility` warns: fix that check
first, then rerun.

### sessions.stale

Lists live Spur sessions whose `SPUR_PROJECT` is a configured `spurProjects` name and that
started before the `spur-board` skill files last changed; sessions of other projects, or with no
project, are left out. Each install stamp records, per file, when its content last changed and
in which version, so an install that only changes the version flags no session. A session does
not reload new skill files on its own. When an install changes the version, `board skills install`
asks the daemon to message each live session of a configured project that has a file changed
after the session was first seen or after its last delivered reload message. The message names
only those files, `SKILL.md` first; with more than six it asks for `SKILL.md` and every file in
the `references/` folder. A session already told about every change gets no message, and the next
install that changes the version catches up a session whose message was never delivered. A
session that got the message after the last content change, under any version, drops out of
this check. A session
whose message is still queued is named in a separate sentence: rerun doctor in a minute.
Stop and wake each remaining listed session in Spur: that restarts the agent and keeps the
conversation. A session can instead read the files the fix names again (`SKILL.md` and every
file in `references/` when it cannot tell which changed), under `~/.claude/skills/spur-board/`
(Claude Code) or `~/.codex/skills/spur-board/` (Codex, `$CODEX_HOME/skills/spur-board/` when
set), but doctor compares start times with the install stamp and keeps listing it. When a
connected session's start time cannot be read, the fix names it too and asks for every file. A
rerun at the same version sends nothing. After a rollback to a version that was installed
before, the sessions that already got that version's message get no new one and stay listed:
stop and wake them.

A live session is a local process with `SPUR_SESSION` set whose session Spur does not report as
ended. The doctor asks Spur's `GET /sessions` at `adapters.spur.baseUrl`, and
`GET /sessions/<id>` for a session missing from that list, and leaves out sessions that are
completed, killed, errored with no running agent, or unknown to Spur. Running, waiting, stopped
and paused sessions stay. Every session check uses this set. When Spur is unreachable or its list
cannot be read, the doctor checks every process session; a session whose own status cannot be
read stays too.

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

### database.private

Runs only without `--offline`. It reads the mode of `board.sqlite` in the data directory (or
`BOARD_HOME`) and fails when group or others have any access to it. A missing database passes.
The daemon sets `board.sqlite`, its `-wal` and `-shm` files and its migration backups to `0600`
each time it starts, so this fails only when the mode was changed while it ran, or when the
daemon has not started since an older version. Run `chmod 600` on the file, or restart the
service.

### daemon.available

Start or restart the user service, then rerun `board doctor --json`. If it still fails, check
the service journal. The CLI connects to `http.port` in `config.yaml` (default `4777`) unless
`BOARD_DAEMON_URL` is set; that variable overrides the configured port. An empty or invalid
`BOARD_DAEMON_URL`, or `http.port: 0` without the variable, fails before any request is sent.
Without the variable, a missing, malformed or invalid `config.yaml` also fails with `config`
before any request: the CLI does not guess the default port. Set `BOARD_DAEMON_URL` to the
daemon address, or fix `config.yaml` with `board doctor --offline` and set `http.port`.

### secrets

Keep `secrets.env` a regular private file with mode `0600` beside `config.yaml`. Add the key
names listed in the check's `fix` through a private local input method. Do not display secret
values. A legacy `slack.env` can be migrated after checking which keys it contains.

### jira.credentials

Check the Jira account email, API token, project access, and configured Jira URL. This check
passes without Jira trackers. It cannot be repaired by an offline doctor pass.

### github.credentials

Check `GITHUB_TOKEN` and repository access. This check also probes check-run contexts and
requested review teams. A `FORBIDDEN` result for a `CheckRun` or `INSUFFICIENT_SCOPES` for
a requested review team needs the GitHub recovery below. A repository without check contexts can
pass the check-data probe.
When GitHub rate limits the token, the check is a non-blocking warning because access was not
checked; rerun `board doctor` after the limit resets.

### link.rules

For each project, the daemon reads the last 50 open or merged PRs updated in each sampled
repository and matches up to 10 of them authored by `operatorGithubLogin` against
`projects[].link`. A github-issues project samples `tracker.repo`; a Jira project samples every
`projects[].repos` entry. The check never blocks. It passes when every sampled PR yields an issue
number (for a Jira project, a `tracker.projectKeys` key). A warning names, per project, how many sampled PRs
match and the unmatched PRs as `#<number>` with their branch. Change `projects[].link` to follow
the repository's branch and PR title rules, which the repository's CI title check and its agents'
skills enforce. Other warnings say the operator has no PRs there, the PRs could not be read,
`tracker.repo` is missing from `projects[].repos`, or `GITHUB_TOKEN` is missing.

### github.review_rule

Listed only when a project's `external-review` column sets `approvalRule: github-rules`. For each of
that project's `projects[].repos`, the daemon reads the default branch's review rule from its branch
protection and the rulesets that apply to it, and prints what it read: the source (branch
protection, ruleset or both), the required approvals, code owner review, resolved conversations and
required checks. The Board reads each PR's own base branch the same way on every full PR read. The
check never blocks and is separate from `github.credentials`. It warns when the branch has no branch
protection or ruleset, when the rule requires no approval, code owner review or resolved
conversations (no review rule to follow), when it could not confirm all ruleset rules were read
(more than 100 apply, or GitHub's answer does not say whether more follow), when the read fails, for
example because the token cannot read the rules, or when `GITHUB_TOKEN` is missing. The check reads
only the default branch: a PR whose own base branch rule the token cannot read keeps its head
undecided in External Review, and the task's `--why` shows it as `review_rule_unreadable`, even
while this check passes. With no review rule to follow, add a required approval or code owner review
to the default branch, or remove `approvalRule` from the column. When the read fails, give the token
read access to the branch protection and rulesets of every base branch, the same advice Doctor gives
when it could not confirm all ruleset rules were read; a rule may still apply (Doctor cannot confirm
one exists when GitHub's answer has no `pageInfo`), so removing `approvalRule` could weaken the
gate. Doctor therefore leaves out the removal advice while a project with a repo that has no review
rule to follow also has a repo whose rule is in force or could not be read in full: removing
`approvalRule` from the column would turn off the gate of that repo too.

### github.mirror

Listed only when a `github-issues` project's `ready-for-dev` column sets a tracker `source`. For
each such project the daemon reads the GitHub Project once with `GITHUB_TOKEN`, as the Board does
on every poll: the Project named by `source.project`, its single-select field `source.field` and
the option `source.value`. It passes naming the Project title, the field and the option it read.
The token needs the `read:project` scope (a fine-grained token: Projects read access for the
owner). The check never blocks. It warns when `GITHUB_TOKEN` is missing, when the read could not
finish within the doctor deadline (rerun `board doctor`, then check the daemon log), or with the
failure code of the read, followed by the fix of the first one listed:

- `mirror_project_forbidden`: the Project was not found or is not readable. Check the owner and
  number against the Project URL and give the token the `read:project` scope.
- `mirror_field_not_found`: the Project has no single-select field `source.field`, or the field
  has no option `source.value`, letter case included. The warning names both.
- `mirror_snapshot_incomplete`: the read did not fit one page: more than 100 open issues in the
  tracker repository, or an issue in more than 20 Projects.
- `mirror_rate_limited`: GitHub rate-limited the read; rerun after the reset.
- `mirror_read_failed`: a network, server or other GitHub error; usually transient.

[Errors](docs/errors.md) gives each code's meaning and fix. While a read fails the Board moves
no task in or out of `ready-for-dev`.

### spur.api

Start the Spur API or correct `adapters.spur.baseUrl` in `config.yaml`.

### spur.send

The daemon delivers doorbells with `POST <adapters.spur.baseUrl>/sessions/<id>/send`. This
check sends that request to the reserved session `spur-board-doctor-probe`, which never exists,
so no agent receives it; it passes when Spur answers that the session is not found. No answer
means Spur is down or `adapters.spur.baseUrl` is wrong: start Spur or correct the URL. Any other
answer means that Spur API does not accept doorbell sends: update Spur, or point
`adapters.spur.baseUrl` at the Spur daemon. Restart the service after changing `config.yaml`.

### spur.version

The check reads `version` from `GET <adapters.spur.baseUrl>/info`, which the running Spur daemon
answers. It passes at Spur 1.53.0 or newer, the oldest Spur with every Spur API the Board calls.
Below that it fails and blocks: upgrade Spur to 1.53.0 or newer, then restart the Spur daemon and
rerun `board doctor`. It warns without blocking when Spur gives no answer, is still starting, or
reports a version that is not a release, such as `0.0.0-dev` or a source checkout without tags.
`spur --version` shows the installed Spur CLI, not the running daemon: a Spur daemon that was not
restarted after an upgrade still reports its old version here, so restart the Spur daemon after
upgrading Spur.

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
provide `SLACK_APP_CONFIG_TOKEN` and `slack.appId`; otherwise inspect the command manually. If
the command answers from another app or Board, see
[Slash command answers from another app](#slash-command-answers-from-another-app).

### slack.configured

Slack is not configured. Questions addressed to the operator remain visible through the
Board inbox. Use the setup skill to assign the orchestrators and feed channel IDs when Slack
delivery is wanted. This check appears instead of the four Slack integration checks above.

### operator.path

Choose a Spur project marked `operator`, or create a named token in a chosen folder and approve
its request in Slack. A token waiting for approval does not satisfy this check.

### operator.tokens

A warning names approved tokens that need a look; it never blocks. "No token file" means the
token was created on this machine and its folder, or the `.spur-board/token` file in it, is gone.
"Unused" means no call has used the token for `operatorAccess.unusedAfterDays` days (default 14),
counted from its approval when it was never used. Tokens created on another machine get only the
unused check. Revoke a token nothing uses with `board token revoke <name>`; to keep a token you
use rarely, raise `operatorAccess.unusedAfterDays` in `config.yaml` and restart the service.

### orchestrator.sessions

Reports each configured orchestrator, its assigned columns and the live session that receives
its rings. A warning is nonblocking: assign a column to an unused orchestrator or start a live
session for one without a session. Finished and missing sessions are excluded. Long reports
are shortened to the diagnostic limit.

### curator.sessions

Lists each Board project with its curator and the curator's live session. A warning names the
Board projects whose curator has no live session: start a Spur session of that curator. A Board
project with no curator is listed and does not warn. This check never blocks readiness.

### versions

Only a mismatch between the daemon and the running CLI blocks. Other PATH binaries and skill
stamps warn, including when they also differ during a blocking daemon mismatch.

Install matching CLI and skill versions with `board update`: it restarts the daemon and
reinstalls the skills. Then check `board --version` in both the current and live Spur session
`PATH`, and ask sessions that still use an older skill to re-read the `spur-board` skill. If the
service unit points to an old Node or package path, run `board service install` again.

## Refused Spur session

Inside a Spur session the session wins over a token: `SPUR_SESSION` is sent and neither
`BOARD_TOKEN` nor `.spur-board/token` is read. A session whose Spur project is in no
`projects[].spurProjects` or top-level `spurProjects` of the Board's `config.yaml`, or is listed
under several Board projects, is refused with `forbidden` (exit 1), and the hint names the Spur
project and the fix. Keep the Spur project under exactly one Board project in the Board's
`config.yaml`, not Spur's `spur.yaml`, and restart the Board daemon. A Spur project that
orchestrates columns or is the operator across several Board projects goes in top-level
`spurProjects` instead.

The rule exists because a session's identity is its Spur project and session ID, so a Spur project
under two Board projects would leave its sessions without one owning Board project. The session's
roles are looked up by its Spur project, and a curator ring picks the newest live session of the
curator's Spur project. The daemon refuses such a
`config.yaml` at start and names the Spur project and both Board projects. To run two Board
projects, give each its own Spur projects.

A Spur project listed with `role: operator` under `projects[].spurProjects` has operator access
only on the Board project that lists it. A top-level `spurProjects` entry with `role: operator`
serves every Board project without its own operator. Operator commands that name no project, such
as `board token list`, `board task add` with a key that matches no unique project tracker, and `board item retry`
or `board item close` on an item of no task, project question or project source, run only for the
operator token, the board-wide operator, or the operator of a one-project Board without a
board-wide operator.
Before this rule, a project
operator of a Board with several projects and no board-wide operator acted on every Board
project; such a Board now refuses it with `forbidden` outside its own project. To keep one
operator across projects, move its Spur project to top-level `spurProjects` with
`role: operator` and remove it from `projects[].spurProjects`; a Spur project named `operator`
or `none` is refused there, so rename it in Spur first. A Board project that keeps its own
operator binding is not served by the top-level operator, so also remove the local operator
bindings from every Board project it should serve. To keep separate operators, give each
Board project its own operator Spur project. Restoring an archived task counts as that task's
project. Retrying or closing an item of a task counts as that task's project, and of a
`board project ask` question as that question's project, its failed post, a Slack answer whose
author is unavailable and a failed Slack reply in its thread included. A failed feed post of an
item, or a failed edit of that post, counts as that item's project. An item of a project's
repository or tracker source, such as a red default branch or a failing tracker poll, counts as
that project; a failing Spur poll counts as the Board's. Once that project has left
the config, the item counts as the Board's. `board inbox operator` and `board status` list an
item for the same operators that may retry or close it. Operations open
only to project agents, such as `board ask`, still need the session's Spur project listed under
that task's Board project. `board inbox ack` is also open to the operator; the operator token
acks only turns (`T<n>`): orchestrator turns and turns addressed to the operator. Linking a session to a task from its pull
request or branch needs its Spur project listed with `role: worker` under that task's Board
project; a `board-worker` link label works from any Spur project.

## Exit codes 3, 4, and 5

- **3 — not applied:** a dependency prevented the action. Fix the dependency, then retry the
  same action with its existing idempotency key.
- **4 — configuration:** `config` means a config field, private secret key, or environment
  variable is wrong: correct the named one and retry after validation. An empty `BOARD_TOKEN`
  override fails with `config`. `BOARD_DAEMON_URL` must be a valid HTTP(S) address when set, and `http:` only on
  a loopback host; an empty value fails. Without `BOARD_DAEMON_URL`, a missing, malformed or invalid `config.yaml`
  fails with `config` and nothing is sent: set the variable, or fix the file and its `http.port`.
  Use `board doctor --offline` to check `config.yaml` while the service is
  down. `identity_missing` means there is no Spur session, `BOARD_TOKEN` is unset, and the CLI
  found no `.spur-board/token` walking up from the current folder to the root of its git
  worktree, or to home outside git; home itself is never searched, even as a worktree root. A
  token above the worktree root or in home is not used: create one in a folder inside the
  worktree or set `BOARD_TOKEN`. Run the command in a Spur
  session of a project listed in `config.yaml`, or run
  `board token create --name <name> --into <folder>` and approve the request in Slack. When
  `<folder>/.spur-board/token` already exists, `board token create` replaces it only if the
  daemon reports that token expired or denied; an approved, pending, revoked or unknown token
  stays in place and the command fails with `config`, naming the file and the fix. An
  operator-only command such as `board token list` needs a Spur project marked `operator` or an
  approved token. `service_start_failed` means `board service install` or
  `board service restart` left the unit installed but the daemon did not start: read
  `journalctl --user -u spur-board.service -n 100` and run `board doctor`, fix the cause, then
  run `board service restart`. `update_rolled_back` means `board update` failed and put the
  previous version back, and `rollback_failed` means a rollback stopped part way: see
  [Failed update or rollback](#failed-update-or-rollback).
- **5 — outcome unknown:** the action may already have happened. Read the task or item first;
  if a mutation still needs to be retried, reuse its original idempotency key. A read-only
  request can be repeated after the dependency recovers.

## Failed update or rollback

`board update` keeps its state in the data directory: `$BOARD_HOME` when set, else
`$XDG_DATA_HOME/spur-board/`, default `$HOME/.local/share/spur-board/`. Under it,
`update/state.json` records the last update, `update/package-<version>/` is a copy of the
package before the update, and `update/db/board-<version>.sqlite` is the database backup taken
with the service stopped. A new update replaces them only once its own copy and backup are
complete, so `board rollback` keeps returning to the version before the last successful update
when a later update stops early. A running update or rollback holds a lock on
`update/update.lock`, shared with the service stop, the npm install and the other install steps
it starts; the lock ends when all of them have exited, and the file stays.

- `config` before any change: the hint names the reason. A target whose tarball the registry
  lists but did not serve within 10 minutes (`tarball wait` lines after each HTTP 404; a download
  still running at the bound is stopped), or whose tarball fails its integrity check
  (`EINTEGRITY`), is refused with the service still running; run the update again later. When another update or rollback holds the lock, the
  hint gives the PID that took it; wait for it. If that process is gone, an npm install it
  started may still run; wait for that too. Never remove `update/update.lock`: that
  does not stop the holder and lets a second update start beside it. A running service whose
  command differs from this shell's, or whose process uses another data directory or config
  file, is refused. Its `BOARD_HOME`, `XDG_*` and `HOME` come from the unit, its drop-ins and
  any `EnvironmentFile`: `systemctl --user cat spur-board.service` shows them. As in the daemon,
  a relative `BOARD_HOME` counts from the service's working directory, and without `HOME` the
  account's home from the passwd entry is used. Remove the override and run
  `board service install`, or run the update from the environment the service runs with. A
  service whose process runs as another user, as a unit with `User=` under root's user manager
  can, is refused, and so is one whose real or effective uid differs from this shell's: run the
  update as that user. A service with no running process is refused
  too: run `board service restart`.

- `update_rolled_back`: the update failed and the previous version runs again. The hint names
  the failed step. If it stopped at `stop`, `lock wait` or `database backup`, the package,
  database and the record of the last update were not changed; for `lock wait` stop the process
  whose PID the hint gives. If an update is interrupted at those steps, the service may stay
  stopped: run `board service restart`. At
  `first poll`, a source of the new version did not finish its first complete poll within five
  minutes; check the source's credentials and network with `board doctor`. After a later step,
  the hint says whether the database was kept or restored from the backup. Fix the cause, then
  run `board update` again.
- `rollback_failed`: a rollback stopped part way and the service may be down. `board update`
  refuses until a rollback finishes. Fix the step the hint names, then run
  `board rollback --yes` again; it repeats the whole rollback from the saved copy.
- `board rollback` returns to the version before the last update. It keeps the current
  database when the update did not change the schema, and loses nothing. When the schema
  changed, it restores the backup and loses the Board changes and journal events recorded after
  the update started. It prints which case applies before it acts.

If `board` no longer runs, recover by hand, with `<data>` for the data directory above and
`<prefix>` for the npm prefix the package was installed into:

1. Stop the service: `systemctl --user stop spur-board.service`.
2. Replace `<prefix>/lib/node_modules/spur-board` with a copy of `<data>/update/package-<version>/`,
   for example `cp -a` into the emptied directory.
3. If the update changed the schema, or the restored daemon logs that the database is newer than
   its code, remove `board.sqlite-wal` and `board.sqlite-shm` next to `board.sqlite`, then copy
   `<data>/update/db/board-<version>.sqlite` over `board.sqlite`. The service must stay stopped.
4. Run `board service install` and `board skills install`, then `board doctor`.
5. Delete `<data>/update/state.json`; while it records an unfinished update, `board update`
   refuses to start.

## Slash command answers from another app

**Symptom:** the Board's slash command gets a reply from another app or another operator's
Board, or Board commands and feed posts reach the wrong Board.

**Cause:** another app or Board in the same workspace uses the same slash command or channel
names.

**Fix:** choose a command that no other app in the workspace uses, for example one with your own
prefix such as `/acme-board`; type it in a Slack message box to check that autocomplete offers no
existing command with that name. Regenerate the manifest with
`board slack manifest --app-name <name> --command <slash-command>`, update the app in Slack from
it, and reinstall the app to the workspace. If channel names collide too, use channels of your
own with distinct names and invite the app to them. Then update `config.yaml`: set
`slack.command` to the new command, `slack.appName` if you renamed the app, and
`slack.channels` to the new channel IDs. The daemon reads its configuration only at startup, so
restart the service with `board service restart` after these changes, then rerun `board doctor`.

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
review team. Use a **classic personal access token with the `repo` and `read:org` scopes**, and
authorize it for organization SSO where applicable. Put it in `GITHUB_TOKEN` through private
local input, restart the service, and rerun `board doctor`. A GitHub App with the needed
permissions may be an alternative in a future release.

## Web shell assets

Build a checkout's UI with `pnpm --filter @spur-board/web build`, or assemble the published
package with `pnpm package:build`. Packaging checks `dist/web/index.html`, every referenced
JS/CSS/font, the top-level `OFL.txt`, the manifest link in the index, and the web app manifest,
favicons and app icons, including every icon the manifest lists; a missing asset fails the
installed smoke test. A “UI is not built” 503 from the configured web listener calls for
rebuilding/reinstalling those assets and restarting the daemon. Installed smoke checks that the
actual web listener serves `/` and a referenced asset with HTTP 200. It requires the index to
link exactly the manifest, the SVG and 32px favicons and the touch icon, and the manifest to list
exactly the 192, 512 and 512 maskable icons. It fetches each one and checks the status, the media
type (parameters such as `charset` aside) and the bytes. "Installed web index references no
manifest." means the installed `index.html` has no manifest link; "Installed web index links ...,
expected ..." and "Installed web manifest icons are ..., expected ..." name a missing or extra
app file; "Installed web app file ... did not match ..." names the file the listener served
wrong. Rebuild and reinstall the package in each case.

### Live updates stuck on reconnecting

The web UI gets live updates from a server-sent event stream at `/v1/events` on the web
listener. When the live indicator in the header stays on reconnecting or offline:

- A reverse proxy that buffers responses holds the stream back. The daemon sends
  `X-Accel-Buffering: no`, which nginx honours; turn buffering off for `/v1/events` on other
  proxies.
- The proxy's read timeout must exceed 15 seconds: the daemon sends a heartbeat comment every
  15 seconds and nothing else on a quiet board.
- A 502 or a dropped stream while the daemon restarts is expected; the shell reconnects with
  backoff and rereads everything once the new daemon answers. When the new daemon runs another
  version, after an update, the page reloads itself and keeps unsent text.
- A 503 with `Retry-After: 5` and a plain-text body means 32 streams are already open, one per
  browser tab. Close unused tabs of the shell. A client that stops reading keeps its slot until it
  disconnects.
- A 403 means the request's Host or Origin differs from `web.publicOrigin`: open the shell at
  that origin.

Reconnecting changes only the header indicator. Once the stream is offline, or a configuration
or status read fails, the columns dim under an error banner that gives the time of the data on
screen and offers Retry now: it reconnects at once when the stream waits between attempts, and
rereads; while an update reload is pending it reloads the page instead. When the page cannot
reload itself after an update, the banner names the version and offers Reload. A failed read keeps the last data; a first load that fails shows the banner with no
data and no columns. See the [web UI](docs/web-ui.md) guide for every state. The status bar keeps
the theme menu, which works independently of reads and tolerates blocked browser storage. Auto
follows the system; explicit Light/Dark choices stay fixed.
