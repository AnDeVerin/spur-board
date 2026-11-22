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

The board protects the operator's board from mistakes within the transport boundaries below. It does not protect it from the agents it serves, or from root and other
administrators of the host, who can read and change any of its files. A report that relies on
one of the limits below is not a vulnerability; a way around a guarantee below is.

- **Single-user host.** One operator runs one daemon under their own OS account. The daemon,
  the CLI, the MCP server and every agent session the board serves run as that user.
- **Agent API.** The daemon listens on `127.0.0.1` (port 4777 by default, set by
  `http.port`) and has no option to bind another address. It refuses a request whose `Host`
  header is not `127.0.0.1:<port>`, and any request that carries an `Origin` header, so a web
  page in a local browser cannot call it.
- **A session id is the agent's credential.** An agent sends its `SPUR_SESSION` value in the
  `x-board-session` header and sends no secret. The daemon accepts any id of a session that has
  not ended, from its own snapshot or from the local Spur server, whose Spur project is listed
  under `projects[].spurProjects`. Whoever knows such an id can act as that agent, and as the
  operator when that Spur project has the `operator` role. The `board` CLI and `board mcp` also
  send `x-board-via: cli` or `x-board-via: mcp`; the agent API keeps only those two values, and
  the web listener ignores the header.
- **Agents can read the operator's files.** Agents run as the operator's OS user, so file modes
  do not stop them: they can read `.spur-board/token` files, `secrets.env` and the database, and
  use an operator token. Do not give an agent work you would not do yourself with these
  credentials.
- **Operator tokens last until revoked.** `board token create` writes a random secret to
  `<folder>/.spur-board/token`; the daemon stores only its SHA-256 hash. A request lapses after
  15 minutes unless the operator approves it in the messenger. An approved token has no expiry:
  it works until `board token revoke`, and the daemon checks its status on every call. See
  [SETUP.md](SETUP.md) for the operator paths.
- **The journal records the actor and the channel.** Each journal event records who acted (the
  operator, an agent and its session, or the board) and, in `via`, the channel the write arrived
  through, whoever the actor: `slack` or `web` where the daemon received the write, or `cli` or
  `mcp` as the `board` client reported it; scheduled work and older clients have none. The
  channel is not proof of who typed the write, and `cli` or `mcp` is not proof of the client
  either.

### Optional web listener

Web is off by default. Setting both `web.port` and `web.publicOrigin` starts a separate
`127.0.0.1` listener. The web UI has no login of its own: everyone who can reach that port can
act as the operator through web-bound reads and the ten writes, `comment.add`, `block.answer`,
`block.followup`, `item.close`, `task.move`, `task.order`, `inbox.ack`, `task.submit`,
`task.return` and `task.wait`, without a token.
Another machine reaches the listener only through an authenticating reverse proxy, which must
preserve the original `Host`, or an SSH tunnel. With the proxy, its authentication is the
boundary: the only one for a public name, and for a private name a private network limited to
the operator's devices is a second layer. With the tunnel, the SSH login is the boundary. See
[Remote access through Caddy with basic auth](SETUP.md#remote-access-through-caddy-with-basic-auth).

Exact Host and Origin checks, JSON POST bodies, cross-site fetch rejection and no CORS stop
foreign browser pages and DNS rebinding. They do not authenticate network members or local OS
users, who can supply these headers themselves. Token, skill, schema and doctor routes are
absent on the web listener; it serves operations, health, the `GET /v1/events` stream and the
UI files. CSP blocks inline scripts/styles and external resources.
Request logs record `via: web`, forwarded client metadata and user agent alongside the request
ID, method, path and status. Forwarded IP metadata is untrusted audit data, never identity.
Journal events from web writes persist `via: web`. Task history keeps `actor: operator` and
includes `via: web`, so clients can show `operator (web)` without changing actor IDs.

### Other OS users on the same host

This subsection is about unprivileged users; root is out of scope. Another local user can
connect to the loopback port. Without a credential they can:

- read `GET /v1/schema`, `/v1/health` and `/v1/doctor`;
- check a token's status by its hash;
- request an operator token, which only raises an approval item for the operator; at most 10
  requests wait at once;
- make the daemon send its skill reload message, fixed text naming allowlisted skill file names,
  to the live sessions of configured Spur projects; the file change times in the request decide
  which names appear and which sessions get one, at most once per session for the version the
  daemon runs;
- for session ids they already know, read whether and when each got that message, for one
  version or the newest of each state across versions; the daemon never lists a session id the
  request does not name.

On the agent API they cannot run board operations without a live session id from a configured
Spur project or an approved token. With web enabled, they can use its operator operations without
either credential. Treat both as secrets: a leaked session id or token file lets that user act as
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
