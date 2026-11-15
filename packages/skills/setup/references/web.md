# Optional browser access

Web is off by default. Enable it only on a private network limited to the operator's devices.
Anyone reaching the port can run web-bound reads and the two writes, `comment.add` and
`block.answer`, as operator without a token. Browser Host/Origin checks do not authenticate
network members or local OS users.

Set `web.port` and `web.publicOrigin` together in config.yaml:

```yaml
web:
  port: 7777
  publicOrigin: https://{port}.local.example
```

The listener binds `127.0.0.1`. Configure a reverse proxy to preserve the original Host and
use the exact resolved public origin. Every `{port}` is replaced with the actual listener port.
After restarting the daemon, run `board doctor --json`: `web` checks the configuration and
`web.listening` checks whether the listener bound. A busy port leaves the agent API running;
free it or choose another web port and restart.

A missing UI build returns 503 with
``UI is not built: run `pnpm --filter @spur-board/web build` ``.
Run that build when the UI package is available. Health and catalog operations remain usable.
The listener does not supply the SPA. Request logs record the web channel and untrusted
forwarded client metadata and user agent. Journal events and history retain `via: web` beside
the operator actor.
