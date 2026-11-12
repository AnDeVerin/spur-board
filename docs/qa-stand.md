# QA stand

A stand is a disposable board for QA: one process that holds the daemon on a temporary home with
dummy secrets, fake Slack, Spur and GitHub APIs, a network guard and a control endpoint. It never
talks to a real service and is removed by `pnpm stand down`. `pnpm stand help` lists every
command.

Agents read three skills before a QA round:

- `qa-stand` - start, stop, roles, refusals and cleanup;
- `qa-seed` - scenarios, fakes, the stand clock, waits and the violation log;
- `qa-report` - the plan, the evidence layout and the outcome on the live board.

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
- The port range is the stand's own (4780-4799). In the foreground the stand stops with its
  parent, the sidecar process, so no `--watch-pid` is needed.
- Start it on demand: `spur sidecar start --session <id> --name board-stand`.
- The sidecar and the tester must run with the same `TMPDIR`, a private directory of mode 700;
  `pnpm stand` finds stands only under it.
- An errored session leaves its sidecars disabled while the agent keeps working: run
  `pnpm stand status` after a session is restored, and start the sidecar again if no stand
  answers.
