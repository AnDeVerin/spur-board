# spur-board

A kanban board for agent-driven development on top of [Spur](https://github.com/ashugaev/spur):
a local daemon that tracks tasks across GitHub, Jira and agent sessions, a `board` CLI and MCP
server for agents, and Slack for the human operator.

**Status:** early development. Work is tracked in
[GitHub Issues](https://github.com/AnDeVerin/spur-board/issues).

## Setup with an agent

Ask your agent to check whether `spur-board-setup` is already installed. If it is missing, the
agent asks your approval to write its skill folders before running
`npx -y spur-board@latest skills install`. It then reads the installed `spur-board-setup` skill
and follows it through a green `board doctor` and the live announcement. The agent checks state
before each action, asks one question at a time, and asks before changing package, config,
secret, service, token, skill-folder, or project-checkout state or enabling lingering. You create
the Slack app and supply Jira and GitHub tokens through private local input; never paste tokens
into chat.

## Live Slack conformance

Run the live gateway check manually in a private test channel:

```sh
BOARD_LIVE_CHANNEL=<test-channel-id> pnpm smoke:live
```

Use the daemon's local `config.yaml` and mode-protected `secrets.env`. The secrets file must provide
`SLACK_BOT_TOKEN` and `SLACK_APP_TOKEN`; the test channel ID comes only from
`BOARD_LIVE_CHANNEL`. The command rejects either configured delivery channel, refuses `CI=true`,
and does not print tokens or the channel ID. It prints timed instructions for a thread reply,
edit, button press, slash command, mention, and a reply while disconnected. Press Enter after each
guided action. A case fails if its required observation does not arrive; a rate-limit case passes
only when the run sees a real 429 and honors `Retry-After`.

Run this check before M1 acceptance (#66), after each Slack SDK update, and before every release.
Capture the final case report for the change review. The fake and live coverage is described in
the [gateway testkit README](packages/gateway-testkit/README.md).

## License

[MIT](LICENSE)
