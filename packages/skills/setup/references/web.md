# Optional browser access

Web is off by default. Enable it only on a private network limited to the operator's devices.
Anyone reaching the port can run web-bound reads and the three writes, `comment.add`,
`block.answer` and `block.followup`, as operator without a token. Browser Host/Origin checks do not authenticate
network members or local OS users.

Set `web.port` and `web.publicOrigin` together in config.yaml:

```yaml
web:
  port: 7777
  publicOrigin: https://{port}.local.example
```

The listener binds `127.0.0.1`. Configure a reverse proxy to preserve the original Host and
use the exact resolved public origin. Every `{port}` is replaced with the actual listener port.
The browser gets live updates from `GET /v1/events`: turn proxy response buffering off for that
path (the stream sends `X-Accel-Buffering: no`, which nginx honours; other proxies need it
disabled) and keep the proxy read timeout above 15 seconds, the heartbeat interval.
After restarting the daemon, run `board doctor --json`: `web` checks the configuration and
`web.listening` checks whether the listener bound. A busy port leaves the agent API running;
the listener check warns without blocking setup or updates. Free it or choose another web port
and restart. An unset or unreachable `web.spurUiOrigin` also only warns. HTTP UI origins work
on any host without voice; `web.publicOrigin` still requires HTTPS outside loopback. For private
CA trust, use a separate systemd service drop-in with `NODE_EXTRA_CA_CERTS`; see
[Troubleshooting](../../../../TROUBLESHOOTING.md#webspuruiorigin).

The listener serves the packaged browser UI and its assets. A missing UI build returns 503 with
``UI is not built: run `pnpm --filter @spur-board/web build` ``.
Run that build, then restart the daemon: it loads the assets at startup. Health and catalog
operations remain usable. Request logs record the web channel and untrusted
forwarded client metadata and user agent. Journal events and history retain `via: web` beside
the operator actor.
