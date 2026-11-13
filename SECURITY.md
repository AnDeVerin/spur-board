# Security policy

## Supported versions

Only the latest release of `spur-board` gets security fixes. Check that the problem still exists
in it before you report.

## Report a vulnerability

Report it privately through GitHub:
[Report a vulnerability](https://github.com/AnDeVerin/spur-board/security/advisories/new) on the
repository's Security tab. Do not open a public issue or pull request for it. Include the
version, the steps to reproduce and the impact you see.

## Secrets

Never commit tokens, keys or other secrets. Keep them in private local files as
[SETUP.md](SETUP.md) describes. gitleaks scans staged changes in the pre-commit hook, each pull
request's diff in CI, and the full history in a weekly CI scan. If a secret reaches a commit,
revoke it first; removing it from the history does not make it safe again.

## Trust model

The board protects the operator's board from mistakes and from other unprivileged OS users on
the same host. It does not protect it from the agents it serves, or from root and other
administrators of the host, who can read and change any of its files. A report that relies on
one of the limits below is not a vulnerability; a way around a guarantee below is.

- **Single-user host.** One operator runs one daemon under their own OS account. The daemon,
  the CLI, the MCP server and every agent session the board serves run as that user.
- **Loopback API only.** The daemon listens on `127.0.0.1` (port 4777 by default, set by
  `http.port`) and has no option to bind another address. It refuses a request whose `Host`
  header is not `127.0.0.1:<port>`, and any request that carries an `Origin` header, so a web
  page in a local browser cannot call it.
- **A session id is the agent's credential.** An agent sends its `SPUR_SESSION` value in the
  `x-board-session` header and sends no secret. The daemon accepts any id of a session that has
  not ended, from its own snapshot or from the local Spur server, whose Spur project is listed
  under `projects[].spurProjects`. Whoever knows such an id can act as that agent, and as the
  operator when that Spur project has the `operator` role.
- **Agents can read the operator's files.** Agents run as the operator's OS user, so file modes
  do not stop them: they can read `.spur-board/token` files, `secrets.env` and the database, and
  use an operator token. Do not give an agent work you would not do yourself with these
  credentials.
- **Operator tokens last until revoked.** `board token create` writes a random secret to
  `<folder>/.spur-board/token`; the daemon stores only its SHA-256 hash. A request lapses after
  15 minutes unless the operator approves it in the messenger. An approved token has no expiry:
  it works until `board token revoke`, and the daemon checks its status on every call. See
  [SETUP.md](SETUP.md) for the operator paths.

### Other OS users on the same host

This subsection is about unprivileged users; root is out of scope. Another local user can
connect to the loopback port. Without a credential they can:

- read `GET /v1/schema`, `/v1/health` and `/v1/doctor`;
- check a token's status by its hash;
- request an operator token, which only raises an approval item for the operator; at most 10
  requests wait at once.

They cannot run board operations without a live session id from a configured Spur project or an
approved token. Treat both as secrets: a leaked session id or token file lets that user act as
its owner.

File access depends on the modes below:

- `.spur-board/token` files and their folder are created as `0600` and `0700`. The CLI ignores a
  token file or folder that another user owns or that group or others can access.
- The daemon refuses to start when group or others can access `secrets.env`, and
  `board service install` and `board doctor` require mode `0600`. The daemon does not create
  this file.
- Without `BOARD_HOME`, `config.yaml` and `secrets.env` live in the config directory
  `$XDG_CONFIG_HOME/spur-board` (default `~/.config/spur-board`), and `board.sqlite` and
  `board.lock` in the data directory `$XDG_DATA_HOME/spur-board` (default
  `~/.local/share/spur-board`). With `BOARD_HOME`, all four files live in that one directory.
- The daemon creates the data directory (or `BOARD_HOME`) as `0700` when it does not exist, with
  the lock file `board.lock` as `0600`. It never creates the config directory and does not change
  the mode of a directory that already exists. Keep both the config and the data directory (or
  `BOARD_HOME`) private.
- Each time the daemon starts it sets `board.sqlite`, its `-wal` and `-shm` files and its
  migration backups (`board.sqlite.v<n>.<time>.bak`) to `0600`, whatever the umask, and refuses to
  start when it cannot. It writes every database copy as `0600` and keeps only the newest 5
  migration backups. `board doctor` fails `database.private` when group or others can access
  `board.sqlite`.
- The user unit that `board service install` and `board update` write sets `UMask=0077`, so the
  files the service creates are owner-only. The daemon does not set the mode of `config.yaml`: it
  follows the umask and the directory it is in.

For the contribution flow, see [CONTRIBUTING.md](CONTRIBUTING.md).
