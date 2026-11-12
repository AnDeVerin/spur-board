# Daemon HTTP module

## HTTP

- Register `createHttpModule(ctxFor('http'))` last, even without Slack. It answers `503 starting`
  until `state()` is `ready`.
- Build one `createOperationRegistry` in `main` and pass it to HTTP and inbound. Do not register
  individual operations in the HTTP module.
- Bind with `listenApiServer` on `127.0.0.1` and configured `http.port`; 0 selects a free port.
  Log the bound port. The module reads a
  session snapshot through core, then uses a bounded live Spur lookup on a miss. Wrap that call
  in `ctx.logCall`; verify bearer tokens against the current store state on each request. Log an
  accepted token's name, never its bearer value.
- Keep token approval and denial in the authenticated inbound gateway handler, outside the
  operation catalog; a button press requires the configured gateway user and space.
- Log each request's `requestId`, method, path and status through `ctx.log`, without the query
  string; an `unexpected` reply also logs `http request failed` at error with `err` and
  `requestId`. Register HTTP at `stopStage: 'final'` so outbox delivery finishes before close.
