---
name: spur-board-setup
description: Install, configure, check, and update spur-board with an operator. Use when asked to set up or upgrade the Board. Don't use for daily operations; use spur-board.
---

# Set up spur-board

Ask one question at a time, only when current state cannot answer it. Check before every write. Ask before changing package, config, secret, service, token, skill-folder, or project-checkout state, or enabling lingering. Never show secret values or put them in chat, logs, or shell history. A same-version rerun changes nothing and repeats no answered question. Never uninstall the service or revoke a token without an explicit operator request.

## 1. Inspect

- Check Linux, systemd user services, npm, `flock`, and Node 24.12+ (24.x) or 26.x. Read the PATH and Node executable from a live Spur session and check its version; the interactive shell may use another Node. Stop with a specific fix for any missing prerequisite.
- Check Spur through its HTTP API, or run its CLI from the home folder. Running it inside a folder with `spur.yaml` can attach that folder to the daemon.
- Locate `config.yaml` and `secrets.env` under `$XDG_CONFIG_HOME/spur-board/` (default `$HOME/.config/spur-board/`), or under `$BOARD_HOME` when set. Inspect configured fields, required secret _names_ and file modes, package and skill versions, service status, operator access, and product-skill visibility. Never print private file contents.
- If config exists, run `board doctor --offline`; it checks config only. If the service is reachable, record failed and warning check names from `board doctor --json`.

## 2. Install the package

- Check whether the required package version and `board` binary are visible on the live session PATH. If current, skip installation.
- Otherwise choose a user npm prefix whose `bin` is on that PATH, commonly `$HOME/.local`; use the live session's Node and npm for `npm i -g --prefix <prefix> spur-board`. Verify `board --version` with the live session PATH.

## 3. Complete missing configuration

- Discover repositories, Spur projects, and GitHub logins where possible. For each unset value, ask one question and write only that answer: Jira filter and statuses if used, repositories, project names and roles, the GitHub login agents open PRs under per project (PR discovery filters by it; not always the operator's), and the operator's Slack user ID. Preserve settled and unrelated fields; validate against the shipped config schema.
- If Slack roles are unset, follow [Slack setup](references/slack.md). List channels visible to the bot and ask which serve orchestrators and feed; store their IDs. The bot sees only private channels it joined.
- Check required secret names and permissions. Follow [secret files](references/secrets.md) for private entry and any existing `slack.env` migration. Write `config.yaml` and a regular mode `0600` `secrets.env` only when needed.
- For a `github-issues` project, follow [worker links](references/worker-links.md).
- After config edits, run `board doctor --offline` and apply its config fixes. An offline pass does not prove service or integration readiness.

## 4. Start service and grant access

- Check `board service status`; if absent, run `board service install`. Ask before enabling user lingering, which keeps the service running after logout.
- If operator access is unset, ask whether the operator will use a Spur project marked `operator` or a session outside Spur rooted in a chosen folder. The project path needs no token. For the folder path, check for an existing valid token; only if absent run `board token create --name <name> --into <folder>`, then ask the operator to approve the request in Slack. Check existing agent registration before registering `board mcp`.
- Check installed skill stamps and content. If absent or older, ask before writing skill folders, run `board skills install`, then verify both Claude Code and Codex copies.
- For a Spur project used by Codex, check `.agents/skills/spur-board/SKILL.md` in a fresh session. If missing, ask before touching the project's main checkout. In that checkout, link the path to the installed product skill, for example `ln -s "$HOME/.codex/skills/spur-board" .agents/skills/spur-board`. Add `/.agents/skills/spur-board` to the Git exclude file resolved by `git rev-parse --git-path info/exclude`. Add `.agents/skills/spur-board` to that project's `symlinks` in `spur.yaml` and reload Spur config. Start a new session and verify the injected SKILL.md resolves.

## 5. Finish

- Run `board doctor --json`. For each failed check, inspect state, apply its `fix` with any needed consent, and repeat until green. Report warnings, especially live sessions started before the last skill install; they must restart to load it.
- Wait for the feed's `spur-board is live` line after the first complete poll. If absent, inspect doctor checks and service logs and continue the fix loop. Confirm receipt without exposing a channel ID.

## Update

Follow [the update run](references/update.md): `board update`, or a manual first upgrade when it is missing.
