# Stand refusals

`up` refuses with exit 3 and `stand refused (<reason>)`; `demo next|status|reset` refuse
`external_secrets` the same way and print their own command to rerun:

| Reason | Cause | Fix |
|---|---|---|
| `live_home` | stand root inside the live board's home | set `TMPDIR` elsewhere |
| `unsafe_root` | `TMPDIR` or a parent owned by another user, or group- or world-writable without the sticky bit | `TMPDIR` = a private directory, mode 700 |
| `live_config` | the live config is missing, unreadable or invalid, or this checkout's schema rejects it (e.g. an older A/B base) | fix it or set `BOARD_HOME`; for schema skew, run the stand from a checkout whose schema accepts the live config |
| `live_port` | the live config's `http.port` or `web.port` | `--port 0` or a port from the live `stand.portRange` |
| `port_range` | port outside the live `stand.portRange` | `--port 0` or a port from the live `stand.portRange` |
| `port_clash` | `--port` equals `--web-port` | two different ports |
| `web_origin` | `--web-port` given, but the live `web.publicOrigin` has no `{port}` | omit `--web-port` |
| `external_secrets` | real credential variables in the environment | rerun the printed `env -u <NAME> ... pnpm stand <command>`; for `up`, add your `--scenario` and `--port` |
| `env_proxy` | the Node env proxy is on | start without it |
