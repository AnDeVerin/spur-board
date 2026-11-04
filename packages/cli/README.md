# spur-board

A kanban board for agent-driven development on top of [Spur](https://github.com/ashugaev/spur):
a local daemon that tracks tasks across GitHub, Jira and agent sessions, a `board` CLI and MCP
server for agents, and Slack for the human operator.

**Status:** early development. Work is tracked in
[GitHub Issues](https://github.com/AnDeVerin/spur-board/issues).

## Setup with an agent

Ask your agent to run `npx -y spur-board@latest skills install`, read the installed
`spur-board-setup` skill, and follow it through a green `board doctor` and the live announcement.
The agent checks existing state first and asks one question at a time. It asks before writing to
your skill folders, enabling lingering, or migrating existing secrets. You create the Slack app
and supply Jira and GitHub tokens through private local input; never paste tokens into chat.

## License

[MIT](LICENSE)
