# spur-board

spur-board is a local kanban view for development with agents. It joins tasks from Jira and
GitHub with Spur sessions, offers a `board` CLI and MCP server, and sends operator updates to
Slack.

It needs Linux with systemd user services, Node 24.12+ (24.x) or 26.x, a running
[Spur](https://github.com/ashugaev/spur), a Slack app, and Jira and GitHub tokens. The project is
in early development; work is tracked in [GitHub Issues](https://github.com/AnDeVerin/spur-board/issues).

## Set up with an agent

Give your agent this command:

```sh
npx -y spur-board@latest skills install
```

Then ask it to use the `spur-board-setup` skill. The skill checks the installation, asks for
missing choices one at a time, and finishes with a green `board doctor` and a live announcement
in the feed channel. Enter tokens through a private local method, never in chat.

## Set up by hand

1. Check the prerequisites and install the package with the Node executable visible to Spur
   sessions.
2. Create the Slack app and put configuration and tokens in private local files.
3. Install the user service, choose an operator access path, install the agent skills, and run
   the doctor checks.

Follow [SETUP.md](SETUP.md) for the commands and file locations. Use
[TROUBLESHOOTING.md](TROUBLESHOOTING.md) when a check fails. The default Slack names are
`#orchestrators`, `#board-feed`, and `/board`; all are configurable.

## Reference and project files

- [CLI commands](docs/cli.md), [configuration](docs/configuration.md), and the [docs index](docs/)
- [MIT license](LICENSE)
- Contribution and security guidance is tracked in [issue #7](https://github.com/AnDeVerin/spur-board/issues/7).

## Live Slack conformance

Run this check from a repository clone after `pnpm install`. Invite the Slack app to the designated
private test channel, and stop any running daemon process that uses the same app token. Concurrent
Socket Mode connections can split events between the daemon and this check.

Run the live gateway check manually in that channel:

```sh
BOARD_LIVE_CHANNEL=<test-channel-id> BOARD_LIVE_CHANNEL_NAME=<test-channel-name> pnpm smoke:live
```

Use the daemon's local `config.yaml` and mode-protected `secrets.env`. The secrets file must provide
`SLACK_BOT_TOKEN` and `SLACK_APP_TOKEN`; the test channel ID and expected name come only from
`BOARD_LIVE_CHANNEL` and `BOARD_LIVE_CHANNEL_NAME`. The command looks up the channel with
`conversations.info` and requires its ID and name to match, its privacy flag to be true, and its
type to be a channel rather than a direct message. The bot token needs `groups:read` to read private
channel metadata. The command rejects configured delivery channels, shared channels, pending external shares, or archived channels,
non-interactive input and `CI=true` before sending a live post. It never prints tokens, the channel
ID or the channel name. It prints timed instructions for a thread reply,
edit, button press, slash command, mention, and a reply while disconnected. Press Enter after each
guided action. A case fails if its required observation does not arrive.
The guided slash instruction uses `slack.command` from the local config.

To rerun only the thread mention, use:

```sh
BOARD_LIVE_CHANNEL=<test-channel-id> BOARD_LIVE_CHANNEL_NAME=<test-channel-name> pnpm smoke:live --case guided-mention
```

The focused run creates a root thread and reports only the mention case. In Slack, use **Reply in
thread** on that root message, type `@`, select the app from autocomplete, and include the prompt's
marker. The mention prompt allows five minutes; other guided prompts allow 90 seconds. Rate-limit
is outside the supported live case set. The report says `NOT RUN rate-limit` unless a normal
delivery happens to receive a 429; then it records whether the `Retry-After` wait and retry worked.

Run this check before M1 acceptance (#66), after each Slack SDK update, and before every release.
Capture the final case report for the change review. The fake and live coverage is described in
the [gateway testkit README](packages/gateway-testkit/README.md).
