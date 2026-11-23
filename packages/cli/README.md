# spur-board

A kanban for agent-driven development on top of [Spur](https://github.com/ashugaev/spur): a
local daemon that tracks tasks across GitHub, Jira and agent sessions, a `board` CLI and MCP
server for agents, and optionally Slack for the human operator.

**Status:** early development. Work is tracked in
[GitHub Issues](https://github.com/AnDeVerin/spur-board/issues).

## What it needs

Linux with systemd user services and `flock` (util-linux), Node 24.12+ (24.x) or 26.x, a running
[Spur](https://github.com/ashugaev/spur) 1.53.0 or newer, a GitHub token (a classic personal
access token with the scopes listed in
[SETUP.md](https://github.com/AnDeVerin/spur-board/blob/main/SETUP.md#configuration-and-secrets)),
Jira credentials for Jira projects, and optionally a Slack app. The optional web console has no
login of its own and needs an authenticating reverse proxy or an SSH tunnel to reach it from
another machine.

## Start here

1. [Overview](https://github.com/AnDeVerin/spur-board/blob/main/docs/overview.md): what the
   Board does and how tasks move through its columns.
2. [Quickstart](https://github.com/AnDeVerin/spur-board/blob/main/docs/quickstart.md): from zero
   to a first task in Done with the minimal example.
3. [SETUP.md](https://github.com/AnDeVerin/spur-board/blob/main/SETUP.md): every install step,
   file location and command.
4. [Configuration reference](https://github.com/AnDeVerin/spur-board/blob/main/docs/configuration.md):
   every `config.yaml` field and secret.
5. [TROUBLESHOOTING.md](https://github.com/AnDeVerin/spur-board/blob/main/TROUBLESHOOTING.md):
   doctor checks and their fixes.
6. [Docs index](https://github.com/AnDeVerin/spur-board/blob/main/docs/README.md): the guides for
   users and contributors.

## Setup with an agent

Ask your agent to check whether `spur-board-setup` is already installed. If it is missing, the
agent asks your approval to write its skill folders before running
`npx -y spur-board@latest skills install`. It then reads the installed `spur-board-setup` skill
and follows it through a green `board doctor`. With Slack, it then waits for the live
announcement in the feed; without Slack, it checks the web inbox or `board status`. The agent
checks state before each action, asks one question at a time, and asks before changing package,
config, secret, service, token, skill-folder, or project-checkout state or enabling lingering. You
supply Jira and GitHub tokens, and the Slack app if you use Slack, through private local input;
never paste tokens into chat.

## License

[MIT](https://github.com/AnDeVerin/spur-board/blob/main/LICENSE)
