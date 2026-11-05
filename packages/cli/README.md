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

## License

[MIT](LICENSE)
