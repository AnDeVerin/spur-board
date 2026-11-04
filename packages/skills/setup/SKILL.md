---
name: spur-board-setup
description: Install, configure, check, and update spur-board with an operator. Use when asked to set up or upgrade the Board. Do not use for daily operations; use spur-board.
---

# Set up spur-board

Guide the operator one question at a time. Before each question or write, inspect the current state and skip fields and actions already complete. Do not echo token values, print private files, paste secrets into chat, or put them in shell history. Report only key names, file modes, check names, and safe summaries. A second run at the same package version must make no changes and ask no answered question. Treat a rerun with a newer package as an upgrade.

## 1. Inspect before changing anything

- Check that Linux, systemd user services, Node 22 or newer, npm, and `flock` from util-linux are available. Stop with the missing prerequisite and its install action.
- Check Spur through its HTTP API. If using the `spur` CLI, run it from the home folder, never from a folder containing `spur.yaml`: that CLI can attach the folder to the Spur daemon. Read the PATH and Node executable from a live Spur session; do not assume the interactive shell's Node version manager is visible there.
- Locate `config.yaml` and `secrets.env` under `$XDG_CONFIG_HOME/spur-board/` (default: `$HOME/.config/spur-board/`), or directly under `$BOARD_HOME` when set. Check existing config fields and only whether required secret names exist. Check file type and mode without displaying values. Check the installed package and skill versions, current service status, operator access, and whether the product skill is visible in a configured Spur Codex session.
- Run `board doctor --offline` if a config already exists. This validates config only; it does not establish secret, service, network, or skill readiness. Record failed and warning check names from `board doctor --json` when the service can be contacted.

## 2. Install the package only if needed

- Choose the Node executable seen in the live Spur session. Select a user npm prefix whose `bin` directory is on that session's PATH, commonly `$HOME/.local`. Verify with a session PATH lookup. A version-manager global prefix from the interactive shell may be invisible to Spur sessions.
- If the required package version is absent, use that Node and its npm to install `spur-board` into the selected prefix with `npm i -g --prefix <prefix> spur-board`. Verify `board --version` using the live session PATH. Do not reinstall a matching version on a same-version rerun.

## 3. Fill only missing configuration

- Discover repository names, Spur projects and GitHub logins from the current environment where possible. For each missing item, ask one question, wait for its answer, then write only that field: the Jira filter and statuses if Jira is used; repositories; Spur project names and worker or operator roles; each project's operator GitHub login; and the operator's Slack user ID. Do not ask again for a value already present in config. Preserve unrelated config and validate against the shipped config schema.
- Use Slack to list channels the bot can actually see, and present that list to the operator. The bot sees only private channels to which it was invited; an empty list is not proof that no channels exist. Ask which channels should serve the orchestrators and feed roles. Store their IDs, not names, in config. If none fit, suggest available names using a prefix chosen by the operator and use `board slack manifest --app-name <name> --command <slash-command>` for the app setup. The manifest cannot create the app-level token with `connections:write`; walk the operator through creating it in Slack. Ask for consent before any app or channel changes. The operator creates the Slack app and Jira and GitHub tokens; guide them, but never request values in chat.
- Write `config.yaml` in the resolved config directory without replacing settled fields. Write tokens only to a regular `secrets.env` with mode `0600`; the config directory should be private. Required names are `GITHUB_TOKEN`, `JIRA_EMAIL` and `JIRA_API_TOKEN` for Jira, and `SLACK_BOT_TOKEN` and `SLACK_APP_TOKEN` when Slack channels are configured. Have the operator enter values through a private local mechanism and check only presence and permissions.
- If `slack.env` exists beside config, ask permission before migration. Inspect its key names without showing values. Resolve duplicate names with the operator, preserve unrelated existing `secrets.env` keys, and merge into a new mode `0600` regular file without logging content. Verify destination key presence and mode before removing `slack.env`; leave the source untouched on any error or if consent is withheld.
- Run `board doctor --offline` after config changes and apply its config fixes. Do not interpret its success as an online pass.

## 4. Start the service and enroll the operator

- Check `board service status`. If not installed, run `board service install`. Ask before enabling user lingering; explain that it keeps the service running after logout. Never uninstall the service during setup.
- Ask which operator path to use only if it is not already configured: a Spur project marked `operator`, or an outside-Spur session rooted in a chosen folder. The Spur project needs no token. For the folder path, check for an existing valid token before requesting one; then run `board token create --name <name> --into <folder>` only if needed. Ask the operator to approve the pending request in Slack. Do not revoke or replace a token without an explicit request. Register `board mcp` with the operator's agent; check existing registration first.
- Ask before writing to agent skill folders. If absent or older, run `board skills install`, then inspect both Claude Code and Codex installed skill stamps and content. A matching version stamp alone is not proof of matching bytes during a local same-version trial.
- Spur gives each Codex session its own `CODEX_HOME`. For every configured Spur project used by Codex, check whether `.agents/skills/spur-board/SKILL.md` is visible. If absent, arrange a source link to the installed product skill and add `.agents/skills/spur-board` to that project's untracked `spur.yaml` `symlinks` list; exclude the link from Git. Start a new session and verify it can read the injected skill.

## 5. Finish and verify

- Run `board doctor --json` and apply each reported `fix`, one at a time, after checking state and any needed consent. Repeat until no blocking failure remains. Report warnings, especially sessions started before the last skill install; those sessions need restarting to load the new skill. Do not claim readiness from `board doctor --offline`.
- Wait for the feed's `spur-board is live` announcement after the first complete poll. Confirm receipt without exposing a channel ID. If it does not appear, report the relevant doctor checks and service logs, then continue the fix loop.

## Update run

Compare the installed package and skill versions with the intended release. Install a newer package with the Node and prefix visible to Spur sessions, request permission for skill-folder writes, run `board skills install`, and run `board service restart` only when the installed service needs the new version. Run `board doctor --json` until green and name live sessions shown as using an older skill so the operator can restart them. Do not rewrite completed config, reissue operator tokens, or repeat settled questions. Never uninstall the service or revoke tokens unless the operator explicitly requests it.
