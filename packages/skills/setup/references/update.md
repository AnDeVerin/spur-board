# Update run

Use this when the installed package is older than the intended release. `board update` does the whole update and rolls back by itself when the new version is unhealthy. Keep completed configuration and operator access intact.

1. Check the package version, the live Spur session Node and PATH, installed skill stamps, `board service status`, and current `board doctor --json` results. Record the blocking checks: they do not stop the update, and only checks that start blocking after it make it roll back.
   If the help of the installed package lists no `board update`, follow [First upgrade](#first-upgrade-without-board-update) instead of steps 2-10.
2. Run every `board` command below with the Node and PATH of a live Spur session. The update refuses when this shell's Node, package path or `BOARD_HOME` and `XDG_*` settings differ from the service unit, or when the running daemon uses another data directory or config file, drop-ins and environment files included; its hint quotes both sides. If the service was installed from another environment, ask before running `board service install` from this one.
3. The update needs a running daemon. If the service is stopped, ask before starting it with `board service restart`.
4. Tell the operator the installed version and the target, then ask before updating. The service is down for the update.
5. Run `board update` for the latest release, or `board update <version>` for a named one. Progress lines go to stderr; the JSON result goes to stdout. A result with `changed` as `false` means the version was already installed; stop there.
6. On success, report `from`, `to`, `database.schemaChanged` and each `operator` line. Agent sessions that run `board mcp` must restart to load the new catalog; the skill reinstall already messaged live Spur sessions to read the `spur-board` skill again. Ask the operator to stop and wake the sessions the `sessions.stale` line lists under stop and wake, which keeps their conversations; for sessions it names as still queued, rerun `board doctor --json` in a minute. After a rollback to a version installed before, sessions told about it earlier get no new message and stay listed. Do not restart the service or reinstall the skills again: the update did both.
7. On exit 4 with `update_rolled_back`, the previous version is running again unless the hint reports a failed restart. Report the hint: it names the failed step and says whether the database was kept, restored, or not changed. At `first poll`, a source did not finish its first complete poll within five minutes. Fix the cause with the operator, then run `board update` again.
8. On exit 4 with `rollback_failed`, follow `Failed update or rollback` in TROUBLESHOOTING.md: fix the step the hint names, then run `board rollback --yes` again.
9. On any other exit 4 (`config`) or exit 2 (`usage`), nothing was changed. Report the hint and fix what it names; an older target is refused and points to `board rollback`. When another update or rollback holds the update lock, the hint gives the PID that took it: wait for it and the install it started to finish, and never remove the lock file.
10. To go back to the version before the last update, first run `board rollback` without `--yes`. Outside a terminal it changes nothing, prints what it would do and the `Lost:` text to stderr, and exits 2. Tell the operator that text: either nothing, or the Board changes and journal events recorded after the update started. Run `board rollback --yes` only after the operator agrees.
11. Never rewrite settled config or secrets, reissue an operator token, uninstall the service, or revoke a token as part of an update.

## First upgrade without `board update`

Do this once; every later upgrade uses `board update`.

1. Install the newer package with the Node and user prefix of a live Spur session. Verify `board --version` there.
2. Note whether `board service status` reports `active` as `active`. Run the new package's `board service install`. Run `board service restart` only when the service was active before, install reported `changed` as `false`, and the daemon version changed.
3. Ask before writing agent skill folders, then run `board skills install`.
4. Run `board doctor --json` until no blocking check remains. The skill install asks a running daemon of the same version to message live sessions; ask the operator to stop and wake the sessions `sessions.stale` lists under stop and wake.
