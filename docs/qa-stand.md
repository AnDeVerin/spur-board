# QA stand

A stand is a disposable board for QA: one process that holds the daemon on a temporary home with
dummy secrets, fake Slack, Spur and GitHub APIs, a network guard and a control endpoint. It never
talks to a real service and is removed by `pnpm stand down`. `pnpm stand help` lists every
command.

Successful startup and reset await the initial adapter attempts, including failed attempts,
then an outbox pulse so the default stand's live announcement and its conversation are ready.
This does not drain all scenario work; scenario settlement still uses its existing waits.

Every stand needs a readable, valid live board `config.yaml`: `pnpm stand` finds it through
`BOARD_HOME`, else `XDG_CONFIG_HOME` (default `~/.config`), checks its ports against it, and
refuses with `live_config` when it is missing, unreadable or invalid.

Agents read the skills `qa-stand`, `qa-seed` and `qa-report` before a QA round.

## Driving pnpm stand mcp from a shell

`pnpm stand mcp --as <role>` serves MCP over stdio: one JSON-RPC message per line in, one reply
line per request out. It exits when stdin closes, so keep stdin open until every reply has
arrived. This example lists the tools and comments on a task as `worker`:

```sh
pnpm stand up --scenario columns-basic
out=$(mktemp)
{
  cat <<'EOF'
{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"shell","version":"0"}}}
{"jsonrpc":"2.0","method":"notifications/initialized"}
{"jsonrpc":"2.0","id":2,"method":"tools/list"}
{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"comment_add","arguments":{"task":"stand-org/board#1","text":"Hello from the shell.","idempotencyKey":"shell-comment-1"}}}
EOF
  # Keep stdin open until the three requests with an id have a reply each.
  until [ "$(wc -l < "$out")" -ge 3 ]; do sleep 0.2; done
} | pnpm stand mcp --as worker > "$out"
cat "$out" && rm "$out"
```

- The notification gets no reply. Line 2 of the output lists the tools; line 3 holds the new
  comment, authored by `agent:stand-worker/<session>`.
- `worker`, `orchestrator` and `curator` must send an `idempotencyKey` with every mutation: one
  new key per action, the same key on a retry. `operator` may omit it. Queries take none.
- If the server exits before it answers, the loop waits for ever: interrupt it and read
  `pnpm stand logs`.

## Spur sidecar

A Spur session can run the stand as a sidecar. Add it under the project in the Spur config:

```yaml
projects:
  <project>:
    path: <checkout>
    defaultBranch: main
    sidecars:
      board-stand:
        command: env -u <NAME> -u <OTHER_NAME> pnpm stand up --foreground --port $STAND_PORT --web-port $STAND_WEB_PORT
        autoStart: false
        ports:
          stand:
            env: STAND_PORT
            start: 4780
            end: 4799
          web:
            env: STAND_WEB_PORT
            start: 4780
            end: 4799
```

- `env -u` unsets each variable the `external_secrets` refusal names; list the real credential
  variables of your environment there.
- Both port ranges must equal the live board's `stand.portRange` (4780-4799 when it is omitted):
  the guard reads the live config and refuses a port outside that range with `port_range`. Each
  stand takes two ports, so the default band holds 10 stands.
- Drop `--web-port $STAND_WEB_PORT` and the `web` port when the live `web.publicOrigin` has no
  `{port}`: the guard refuses a web port then (`web_origin`).
- The sidecar process is the stand's parent, so no `--watch-pid` is needed.
- Start it on demand: `spur sidecar start --session <id> --name board-stand`.
- Stop it with `pnpm stand down`, then `spur sidecar stop --session <id> --name board-stand`.
  `down` stops the stand and removes its home; the sidecar reports its port
  `dead not-listening` until it is stopped.
- `spur sidecar stop` alone also ends the stand process but keeps its home,
  `spur-board-stand.*` under `TMPDIR`. Remove it with `pnpm stand down --home <dir>`; the next
  `pnpm stand up` removes it too.
- After the stop the session no longer lists the sidecar; `spur sidecar ports` can still show
  its reserved port as `dead not-listening`.
- The sidecar and the tester must run with the same `TMPDIR`, a private directory of mode 700;
  `pnpm stand` finds stands only under it.
- An errored session leaves its sidecars disabled while the agent keeps working: run
  `pnpm stand status` after a session is restored, and start the sidecar again if no stand
  answers.

## Browser QA

A stand serves the web UI from `packages/web/dist` of the checkout it runs from.

- Build the UI from the tested checkout first: `pnpm --filter @spur-board/web build`. Without
  it, `/` answers 503 `UI is not built`.
- The stand reads the UI files when it starts: after a rebuild, run `pnpm stand reset`.
- `pnpm stand up` prints `webUrl` when the live board's `web.publicOrigin` has `{port}`, e.g.
  `https://{port}.<domain>`. The stand fills `{port}` with its own web port from the live
  `stand.portRange`: the first free one, or the next free one when a concurrent stand binds it
  first. A `--web-port` you pass is never moved: when it is taken, `up` fails. Without such a
  template `up` says so on stderr and the stand runs API-only.
- The stand sets `web.spurUiOrigin` to `https://spur.stand.invalid`, so task cards draw the Spur
  session link. That host does not resolve: check the link's `href`, never follow it.
- Shortcuts for a browser round: `<webUrl>/?open=<task key>` with the key URL-encoded
  (`?open=stand-org%2Fboard%234`) opens a task view (`docs/web-ui-task-view.md`), the localStorage key `board-project` holds the selected project,
  and `document.documentElement.dataset.theme` names the active theme.
- Open the build only at that `webUrl`; never the live board's web address. Prototype static
  files may use a loopback static server
  (`.agents/skills/qa-report/references/prototype-vs-build.md`).
