# Runbook

What to do when the Board misbehaves in production. Each section names the symptom, the
commands that confirm it, and the fix. The service is the systemd user unit
`spur-board.service`; [TROUBLESHOOTING.md](../TROUBLESHOOTING.md) covers individual doctor
checks and exit codes, and [cli.md](cli.md) lists every command.

## 1. Daemon hung

**Symptom.** CLI calls connect but get no answer: they wait 30 seconds and exit 5 (outcome
unknown). Slack `/board` gets no reply and the feed goes quiet. The daemon sends a watchdog
ping to systemd after each successful tick of its once-a-minute loop. After 3 minutes without
a ping, systemd stops the daemon with SIGABRT and starts it again 5 seconds later, so a hang
normally clears on its own.

**Check.**

```sh
journalctl --user -u spur-board.service -g 'Watchdog timeout'
systemctl --user show spur-board.service -p NRestarts -p WatchdogUSec
journalctl --user -u spur-board.service -g 'board tick failed' --since -1h
```

A `Watchdog timeout` line marks each watchdog kill, and `NRestarts` counts automatic restarts.
`Result` returns to `success` once the restarted daemon is up, so it does not show past kills.
`WatchdogUSec=infinity` means the unit was installed before the watchdog existed and nothing
restarts a hung daemon. Repeated matches from the last command mean ticks are failing: about
three failed ticks in a row also stop the pings and trigger a restart.

**Fix.**

- One restart: nothing to do.
- `WatchdogUSec=infinity`: run `board service install` to rewrite the unit.
- Repeated restarts: read the journal lines just before each timeout, run `board doctor`, and
  fix the cause it reports. If nothing explains the hang, report the log lines.
- Agents that got exit 5 repeat the same command with the same key; the product skill tells
  them how.

## 2. Daemon crashed or stopped

**Symptom.** Agent commands exit 3: `daemon_unavailable` while the daemon is down, or
`starting` while it comes back. Agents then ask in their own session and repeat `board ask`
later with the same text and key. `board doctor` fails `daemon.available`.

**Check.**

```sh
board service status
systemctl --user status spur-board.service
journalctl --user -u spur-board.service -n 100
board doctor --offline
```

In the journal, look for `start failed` (with the `module` that failed), `invalid config in`,
`fatal`, `Slack Socket Mode start failed` and `systemd notify failed`. The offline doctor
validates `config.yaml` without the daemon.

**Fix.**

- Bad config or secrets: correct `config.yaml` or `secrets.env`, then run
  `board service restart`.
- The unit is missing: run `board service install`.
- The service stops when you log out: `board service status` reports lingering as off. With
  the operator's consent, run `loginctl enable-linger "$USER"`.

`Restart=on-failure` restarts the daemon 5 seconds after a crash, but not after a clean stop.
With Socket Mode configured, a Slack that cannot be reached at start makes the daemon exit,
so it restarts every 5 seconds until Slack is reachable again.

## 3. Slack transport down

**Symptom.** Feed lines, questions and answers stop arriving in Slack, and `/board` gets no
reply, while the daemon itself is running.

**Known gap.** The Board does not raise an operator item for transport failures yet, and the
core path that would mark a connection down for more than 5 minutes exists but is never
called. Until both land, diagnose with the doctor and the journal.

**Check.**

```sh
board doctor
journalctl --user -u spur-board.service --since -1h
```

Read the `slack.auth`, `slack.orchestrators_member` and `slack.feed_member` checks.

**Fix.**

- Token revoked or a scope missing: put a new token in `secrets.env`, then run
  `board service restart`.
- Bot removed from a channel, or the channel archived: invite the bot again, or point
  `slack.channels.*` in `config.yaml` at a live channel.
- Network or Slack outage: wait. Sends back off up to 60 seconds between attempts. A message
  that still fails after 30 minutes is marked `post_failed` and is retried at the next start,
  so run `board service restart` once Slack is back.

When a permanent failure holds a whole space, the Board probes it once a minute. The first
successful send clears the hold, and the waiting messages go out.

## 4. Answer never reached the agent (`answer_undelivered`)

**Symptom.** `board status` lists "Answer to block B<n> on <KEY> was not read". The worker's
doorbell rang three times, with pauses of 2, 5 and 15 minutes, and the worker never
acknowledged the answer. This item does not appear in the feed.

**Check.**

```sh
board status
board task history <KEY>
```

The task history shows a "Doorbell delivery exhausted" entry. The task view and the inbox
listing (see [cli.md](cli.md)) show the open block and whether the answer is still unread.

**Fix.**

- The worker session is alive: in that session, read the inbox and run
  `board inbox ack <entries> --key <key>` for the answer. The ack clears the item.
- The session has ended: nothing can acknowledge the doorbell. Give the answer to the session
  that takes over the task, then close the item.
- The answer is no longer needed: run `board item close <item> --key <key>`.

`board item retry` does not apply to this item.

## 5. Stopping the Board for a while

**How.** Run `systemctl --user stop spur-board.service`. Add
`systemctl --user disable spur-board.service` to keep it off across logins. Resume with
`systemctl --user enable --now spur-board.service` or `board service restart`.
`board service uninstall` removes the unit and is not a pause.

**While stopped.** Agent commands exit 3; agents ask in their own session and keep their keys
for the retry. Doorbells do not ring, outgoing messages wait in the database, and trackers are
not polled. Ask anyone who sent `/board` during the pause to send it again.

**On start.** Sends that were in flight are checked before any resend, and `post_failed`
messages are retried. Inbound recovery scans the open conversations. `board status` reports
warming up until the first complete poll.

**Check.**

```sh
board service status
board status
```

**Fix.** A package update runs `board service install`, which enables and starts a stopped
service. To keep the pause, run `systemctl --user stop spur-board.service` again after the
update, and `disable` again if you had disabled it.
