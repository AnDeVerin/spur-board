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
- [Contributing](CONTRIBUTING.md) and [security policy](SECURITY.md) (planned in #7)
