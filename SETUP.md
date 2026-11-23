# Manual setup

The [`spur-board-setup` skill](packages/skills/setup/SKILL.md) is the assisted route. These steps
follow the same order for a manual installation. Check each existing setting before changing it.
Keep tokens out of chat, command history, and logs.

## 1. Inspect the machine and session

Use Linux with systemd user services, `flock`, npm, Node 24.12+ (24.x) or 26.x, and a running
Spur 1.53.0 or newer. `board doctor` reads the running Spur daemon's version (check
`spur.version`); restart the Spur daemon after upgrading Spur. Check the Node executable and
`PATH` from a live Spur session; an interactive shell can use a different Node. Check Spur through
its HTTP API or its CLI from your home folder. Running the Spur CLI inside a folder containing
`spur.yaml` can attach that folder to the daemon.

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

Slack is optional. To run without it, skip the Slack app and leave `operator` and `slack` out of
`config.yaml`; the Board then writes nothing for Slack and delivers Spur doorbells as usual. A
Spur project with role `operator` is the operator: questions addressed to you wait in
`board inbox operator` and the web inbox. An operator under `projects[].spurProjects` sees only
that project; with several Board projects, list a single operator in top-level `spurProjects`
instead, which serves every project that lists no operator of its own. Items and blocks raised
while Slack is off get no Slack line when you add Slack later. To turn Slack off on an existing install, also remove
`SLACK_BOT_TOKEN` and `SLACK_API_URL` from `secrets.env`: with either one and no Slack channels,
the daemon does not start. `SLACK_APP_TOKEN` and `SLACK_APP_CONFIG_TOKEN` are unused without
Slack and can go too. Add `operator.slack` back before `board rollback` to a version
that requires it. Without Slack, skip [Slack app](#slack-app) and continue at
[Configuration and secrets](#configuration-and-secrets); the rest of this section applies either
way.

### Slack app

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
`SLACK_APP_TOKEN`.

### Configuration and secrets

Store project details in `config.yaml`. With Slack, also store the channel IDs, the chosen app
name and slash command, and the operator's Slack user ID; without Slack, leave out the `operator`
and `slack` blocks of the example. For example, replace every placeholder with your own values:

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
future release. A `ready-for-dev` column that
[mirrors a GitHub Project status](docs/configuration.md#example-mirror-a-github-project-status-to-ready-for-dev)
also needs the `read:project` scope.

Validate the file before starting the service:

```sh
board doctor --offline
```

An offline pass checks configuration only; it cannot prove tokens or integrations work.

### Optional browser access

The npm package ships the built web UI; its optional web listener is off by default. Set
`web.port` and `web.publicOrigin` together in config.yaml, for example:

```yaml
web:
  port: 7777
  publicOrigin: https://{port}.local.example
```

The daemon binds this separate listener to `127.0.0.1`; `{port}` resolves to the actual port.
The web UI has no login of its own. Anyone who reaches it can use the web-bound reads and
`comment.add` / `block.answer` / `block.followup` / `item.close` / `task.move` / `task.order` /
`inbox.ack` / `task.submit` / `task.return` / `task.wait` as operator without a token. Another
machine reaches it only through an authenticating reverse proxy or an SSH tunnel; see
[Remote access through Caddy with basic auth](#remote-access-through-caddy-with-basic-auth).
Host/Origin guards protect against foreign browser pages, not network members or local users.
See [Security](SECURITY.md).

A busy web port leaves the agent API running; `board doctor --json` reports `web.listening`
as a nonblocking warning. Free the port or change the settings, then restart the daemon. An unset
or unreachable `web.spurUiOrigin` also only warns and never blocks setup or update; see the
[UI diagnostics and private CA recipe](TROUBLESHOOTING.md#webspuruiorigin).
Missing UI assets return
503 with the hint ``UI is not built: run `pnpm --filter @spur-board/web build` ``; health and
operations still work. An installed package has the assets; only a repository checkout needs
[Building the web UI](#building-the-web-ui).

The page carries the Spur mark as its tab icon and a web app manifest, so a phone can install
the Board as a standalone app. Installing needs the HTTPS `web.publicOrigin` (a secure origin,
such as the Caddy proxy below) with a certificate the phone trusts; plain HTTP offers no
install. In Chrome on Android use the menu, then Install app; in Safari on iOS use Share, then
Add to Home Screen.

#### Remote access through Caddy with basic auth

This subsection documents one route: Caddy installed as a host package on the Linux Board host.
Caddy serves HTTPS, asks for a user name and password, and passes each request to the loopback
listener. Running Caddy in a container is not covered here: the sample's upstream
`127.0.0.1:7777` is the host's loopback, so such a container needs host networking; see
[Caddy's container notes](https://caddyserver.com/docs/running#docker-compose).

Pick one of two certificate variants first:

- Public name: `board.example.com` resolves in public DNS to the Board host. Caddy gets a public
  certificate by itself, which needs ports `80` and `443` reachable from the internet. Basic auth
  is then the only boundary: use a long random password, and do not `bind` Caddy to a private
  address, which would stop certificate renewal.
- Private name: the name resolves only on the operator's private network. Add `tls internal` to
  the site block so Caddy signs the certificate with its own local CA, and trust that CA's root
  certificate on the laptop: the package keeps it at
  `/var/lib/caddy/.local/share/caddy/pki/authorities/local/root.crt`, readable only by root and
  the `caddy` user, so print it on the Board host with
  `sudo cat /var/lib/caddy/.local/share/caddy/pki/authorities/local/root.crt`. Limit who reaches
  the login with `bind` to a private address or a firewall.

Then, in this order:

1. Install Caddy 2.8 or newer from Caddy's own package repository, as
   [Caddy's install docs](https://caddyserver.com/docs/install) show for your distribution. A
   distribution's own repository may ship an older release, which names the directive
   `basicauth` and rejects the sample's `basic_auth`. The package runs Caddy as the systemd
   service `caddy`.
2. Print a password hash with `caddy hash-password`; it asks for the password without echoing
   it.
3. Replace the contents of `/etc/caddy/Caddyfile` with this site block, the hash in place of the
   placeholder. For a private name, add `tls internal` as the first line inside the block.

   ```caddyfile
   board.example.com {
   	# Browsers fetch the web app manifest without credentials; these files hold no Board data.
   	@appfiles path /manifest.webmanifest /favicon.svg /favicon-32.png /apple-touch-icon.png /icons/icon-192.png /icons/icon-512.png /icons/icon-512-maskable.png
   	handle @appfiles {
   		reverse_proxy 127.0.0.1:7777
   	}
   	handle {
   		basic_auth {
   			operator <hash printed by caddy hash-password>
   		}
   		reverse_proxy 127.0.0.1:7777
   	}
   }
   ```

4. Set the same name in config.yaml:

   ```yaml
   web:
     port: 7777
     publicOrigin: https://board.example.com
   ```

   On an existing install, restart the daemon with `board service restart`. On a fresh install,
   the daemon starts when `board service install` runs in
   [section 4](#4-install-the-service-and-choose-operator-access).

5. Reload Caddy so it reads the new file: `sudo systemctl reload caddy`. If the service is not
   running, start it with `sudo systemctl start caddy`.
6. Once the daemon is running (on a fresh install, after
   [section 4](#4-install-the-service-and-choose-operator-access)), check from the laptop:
   `curl -sI https://board.example.com/` gives `401`. For a private name,
   add `--cacert` with the root certificate copied from the Board host; only root and the `caddy`
   user can read it there, so print it with `sudo cat` on that path. Then open
   `https://board.example.com` in a browser and log in as `operator`.

`web.publicOrigin` must be exactly the URL the laptop opens: `https://`, the site name, a
`:<port>` only when Caddy listens on a port other than 443, and no path or trailing slash.
Caddy passes the `Host` and `Origin` headers on unchanged; when either differs from that
origin, the daemon answers 403.

Live updates come from `GET /v1/events`. Caddy flushes `text/event-stream` responses at once
and sets no read timeout, so the sample needs no extra directive. Another proxy must pass the
`Host` and `Origin` headers unchanged, keep response buffering off for `/v1/events`, and set a
read timeout above 15 seconds, the heartbeat interval.

In `board doctor --json`, the `web` check validates the settings offline and `web.listening`
reports whether the loopback listener bound. Neither check probes the proxy, its authentication
or TLS.

Without a proxy, an SSH tunnel works instead. It replaces the proxy setup, because the daemon
accepts one origin: set `publicOrigin: http://127.0.0.1:7777` in place of
`https://board.example.com`. On an existing install, restart the daemon with
`board service restart`. On a fresh install, the daemon starts when `board service install` runs
in [section 4](#4-install-the-service-and-choose-operator-access). Once the daemon is running
(on a fresh install, after section 4), on the laptop run:

```sh
ssh -L 127.0.0.1:7777:127.0.0.1:7777 <user>@<board-host>
```

Then open `http://127.0.0.1:7777`, not `localhost`: the daemon compares the full host, so
another name or local port gets 403. The explicit first `127.0.0.1` keeps the forward on the
laptop's loopback even when its SSH client sets `GatewayPorts`, so the SSH login is then the
boundary.

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

Without Slack, use a Spur project marked `operator`: a token request needs Slack approval. A token
approved while Slack was on keeps working after Slack is removed, until `board token revoke`.
Approve the request in Slack before using the token; the Slack prompt shows the same
`requestHash` the command printed, so approve only a request whose hash matches. The CLI looks for the folder's
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

Fix each blocking doctor result and rerun until the checks are green. When the install changes the
version, it asks the running daemon to message each live Spur session of a configured project that
has a `spur-board` skill file changed since it started or was last told; the message names those
files, and a session already told gets nothing. A `sessions.stale` warning lists the sessions that
started before the skill files last changed and have no delivered message: stop and wake them in
Spur, which keeps the conversation. Sessions whose message is still queued are named apart; rerun doctor in a minute.
With Slack, after the first complete poll, look for the `spur-board is live` line in the
configured feed channel; without it, check the web inbox or `board status`. See [TROUBLESHOOTING.md](TROUBLESHOOTING.md) for check-specific fixes and logs.

To upgrade, run `board update` for the latest release, or `board update <version>` for a given one,
from a shell with the same Node and `BOARD_HOME` or `XDG_*` settings as the service (a live Spur
session). The service must be running. The command checks the target and the daemon first and
confirms that the target's tarball downloads with `npm pack`, waiting up to 10 minutes for a
release published moments ago, then saves a copy of the installed package and a backup of the
database, installs the new package, restarts the service, reinstalls the skills, waits up to five
minutes for every source's first complete poll and runs doctor. It keeps configuration, secrets and operator access. If the new
version fails a step, it puts the previous package and, when the schema changed, the database back
and exits 4 with `update_rolled_back`. On success it prints `operator` lines: restart agent sessions
that run `board mcp`, and stop and wake the Spur sessions doctor lists as stale; the skill reinstall
already messaged the other live sessions with changed `spur-board` files, naming those files, and
sent nothing when the contents did not change or a session was already told. After
`board rollback` to a version installed before, sessions told about that version earlier get no new
message: stop and wake the ones doctor lists. To go back to the version before the last update
later, run `board rollback`; it first prints what data is lost, then asks to continue, or needs
`--yes` outside a terminal. See
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

Check the link with `board status`, which lists tasks with their navigation links and the unlinked
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

## Building the web UI

The npm package ships the built UI, so only a repository checkout needs this step. From a
repository checkout run `pnpm install`, then `pnpm --filter @spur-board/web build`.
`pnpm package:build` also builds and assembles the UI into the CLI package after its clean
build. The installed assets include local fonts and their OFL license. Dark is the initial
fallback; the status bar theme menu offers Light, Dark and Auto, remembers the preference when browser storage
is available, and Auto follows the system appearance.

With `web.port` and `web.publicOrigin` configured, the daemon serves the packaged SPA and local
assets on its separate loopback web listener. A “UI is not built” 503 means assets need
building/packaging; restart the daemon after rebuilding because it loads assets at startup.
`pnpm package:smoke` verifies installed `GET /`, a referenced asset, the web app manifest, the
favicons and the app icons on an isolated listener.
The shell gets live updates from `GET /v1/events` on the same listener; behind a reverse proxy,
turn response buffering off for that path and keep the read timeout above 15 seconds. The status bar shows the daemon version from
`status.get` `daemon.version` and stays empty until the first status read.
