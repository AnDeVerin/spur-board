# QA stand

A stand is a disposable board for QA: one process that holds the daemon on a temporary home with
dummy secrets, fake Slack, Spur and GitHub APIs, a network guard and a control endpoint. It never
talks to a real service and is removed by `pnpm stand down`. `pnpm stand help` lists every
command.

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
        command: env -u <NAME> -u <OTHER_NAME> pnpm stand up --foreground --port $STAND_PORT
        autoStart: false
        ports:
          stand:
            env: STAND_PORT
            start: 4780
            end: 4799
```

- `env -u` unsets each variable the `external_secrets` refusal names; list the real credential
  variables of your environment there.
- The port range is the stand's own (4780-4799). The sidecar process is the stand's parent, so
  no `--watch-pid` is needed.
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
