---
name: spur-board-setup
description: Install, configure, check, and update spur-board with an operator. Use when asked to set up or upgrade the Board. Don't use for daily operations; use spur-board.
---

# Set up spur-board

Ask one question at a time when inspection cannot answer it. Check before writing. Ask before changing package, config, secret, service, token, skill-folder, or project-checkout state, or enabling lingering. Never show secret values or put them in chat, logs, or shell history. A same-version rerun changes nothing and repeats no answered question. Never uninstall the service or revoke a token without an explicit operator request.

## 1. Inspect

- Check prerequisites, Spur and the config files as in [inspection](references/inspect.md).
- Never print private file contents. Stop with a specific fix for any missing prerequisite.
- If config exists, run `board doctor --offline`; it checks config only. If the service is reachable, record failed and warning check names from `board doctor --json`.

## 2. Install the package

- Check whether the required package version and `board` binary are visible on the live session PATH. If current, skip installation.
- Otherwise choose a user npm prefix with `bin` on that PATH, often `$HOME/.local`; use the live session's Node and npm for `npm i -g --prefix <prefix> spur-board`. Verify `board --version` with the session PATH.

## 3. Complete missing configuration

- Discover repositories, Spur projects, and GitHub logins where possible. Ask and write only unset values: Jira filter and statuses if used, repositories, project names and roles, and the GitHub login agents open PRs under per project (PR discovery filters by it; not always the operator's). Preserve settled and unrelated fields; validate against the shipped config schema.
- If Slack is unset, ask whether the operator wants Slack. Without it, leave `operator` and `slack` out and make one Spur project role `operator`, in top-level `spurProjects` when there are several Board projects (a project's own operator sees only that project); questions then wait in `board inbox operator` and the web inbox. With it, ask for the operator's Slack user ID and follow [Slack setup](references/slack.md). List channels visible to the bot and ask which serve orchestrators and feed; store their IDs. The bot sees only private channels it joined.
- Check required secret names and permissions. Follow [secret files](references/secrets.md) for private entry and any existing `slack.env` migration. Write `config.yaml` and a regular mode `0600` `secrets.env` only when needed.
- For a `github-issues` project, follow [worker links](references/worker-links.md).
- For browser access, follow [web setup](references/web.md); check `web.listening`.
- After config edits, run `board doctor --offline` and apply its config fixes. Offline checks do not prove service or integration readiness.

## 4. Start service and grant access

- Check `board service status`; if absent, run `board service install`. Ask before enabling user lingering, which keeps the service running after logout.
- For operator access, skill installs and Codex project links, follow [access and skills](references/access.md).

## 5. Finish

- Run `board doctor --json`. For each failed check, inspect state, apply its `fix` with any needed consent, and repeat until green. Report warnings. In `sessions.stale`, the operator stops and wakes stale ones; rerun doctor for queued ones.
- With Slack, wait for the feed's `spur-board is live` line after the first complete poll; without it, check the web inbox or `board status`. If absent, inspect doctor checks and service logs and continue the fix loop. Confirm receipt without exposing a channel ID.

## Update

Follow [the update run](references/update.md): `board update`, or a manual first upgrade when it is missing.
