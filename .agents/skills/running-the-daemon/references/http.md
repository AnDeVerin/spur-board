# Daemon HTTP modules

## Composition

```text
agent CLI/MCP -> API Fastify (http.port) -> shared ops route -> registry
browser/proxy -> Web Fastify (web.port) -> shared ops route -> registry
                                         operator caller
```

- Build one `createOperationRegistry` and share it with HTTP, web and inbound; share `runOperation`, `afterOperation` and first-poll callbacks across HTTP transports.
- Register the optional `createWebModule` only when `web.port` is set; keep HTTP available without Slack or web.
- Bind both instances to `127.0.0.1`; port 0 selects a free port, and web resolves `publicOrigin` using the actual bound port.
- Answer `503 starting` until `state()` is `ready`; retain stopping responses during shutdown.
- Keep both modules at `stopStage: 'final'` so delivery finishes before close and sockets close before the store.
- Close a partially started instance on failure or abort; propagate API startup errors, but log optional web failures and keep the daemon running.
- Report web module state through `web.listening` in daemon doctor, independently of the CLI's offline `web` configuration check.

## Agent API

- Use `listenApiServer` with `http.port`; require the actual loopback Host, reject every Origin and require JSON for POST.
- Keep schema, doctor, token and skill routes on this instance only; health is shared by both listeners.
- Resolve sessions through core snapshots and a bounded Spur lookup on a miss; wrap the lookup in `ctx.logCall` and verify bearer tokens against current storage on every request.
- Keep token approval and denial in authenticated inbound handling, outside the catalog; require the configured gateway user and space.
- Log accepted token names, never bearer values.

## Web

- Require exact resolved public-origin Host, exact Origin on methods other than GET/HEAD, JSON POST and no `Sec-Fetch-Site: cross-site`; never add CORS headers or trust proxy identity.
- Serve only bound catalog operations, health and memory-mapped static assets; leave token, skill, schema, doctor and future events routes absent.
- Identify every web operation as operator and allow it only when `operation.web !== null`; keep the two enabled writes in the catalog.
- Wrap request dispatch with `withVia('web', fn)` so journal events and history retain `via: web`; keep `afterOperation` and detached job triggers outside that scope.
- Reject raw and encoded traversal before fallback; use index fallback only for extensionless paths outside the `/v1/` namespace, and return the build-hint 503 when index is absent.
- Set CSP (`default-src 'self'; frame-ancestors 'none'`), DENY, nosniff and no-referrer on every response.
- Default webRoot next to the daemon bundle; no request-path filesystem reads.
- Treat network access as operator authority; browser guards do not authenticate network members or local OS users.

## Logs

- Log each request's requestId, method, path and status through `ctx.log`, without query strings or bodies.
- Log web `via`, forwarded client metadata and user agent as untrusted audit fields, never identity.
- Log `unexpected` reply causes at error with err and requestId; never expose causes in responses.
