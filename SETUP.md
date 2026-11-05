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

The manifest does not create the app-level token. Create one with `connections:write` in the
app settings. Store channel IDs, the chosen app name and slash command, project details, and
the operator's Slack user ID in `config.yaml`. Use the
[configuration reference](docs/configuration.md) and [JSON Schema](packages/contracts/config.schema.json)
for fields and defaults.

Put tokens in a private regular `secrets.env` file with mode `0600`; never put them in
`config.yaml`. `GITHUB_TOKEN` is required, `JIRA_EMAIL` and `JIRA_API_TOKEN` are needed for Jira,
and `SLACK_BOT_TOKEN` and `SLACK_APP_TOKEN` are needed when Slack is configured. The
[configuration reference](docs/configuration.md#secretsenv-keys) lists optional names. Provide
values through a private local input method and check only key names and file mode afterward.

For GitHub check runs on private repositories, use a **classic personal access token with the
`repo` scope**. Authorize it for organization SSO where applicable. A fine-grained personal
access token can resolve the repository and pull requests yet return `FORBIDDEN` for every
`CheckRun` in `statusCheckRollup.contexts`, because it lacks Checks permission. A GitHub App
with the needed permissions may be an alternative in a future release.

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
`.spur-board/token` while walking upward from the current directory, stopping at home.
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

For upgrades, repeat the checks with the new package and skill versions. Preserve settled
configuration and operator access; restart the service when its package or Node path changes.
