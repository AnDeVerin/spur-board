# Slack setup

Use this when the orchestrators or feed channel is not configured, or the app-level token is missing.

1. Check the bot's current channel membership. List the private channels it can see and ask the operator, one choice at a time, which should serve orchestrators and feed. An empty list does not prove no channels exist: the bot sees only private channels to which it was invited. Store channel IDs in config, never guessed names.
2. If no channel fits, ask for an operator-chosen prefix and suggest available names using it. The operator creates or invites the app to channels; ask before any app or channel change.
3. Check whether an app and slash command already exist. If either is missing, use `board slack manifest --app-name <name> --command <slash-command>` to prepare a manifest with operator-chosen names. The operator creates the Slack app; do not claim the manifest creates it.
4. The manifest cannot create the app-level token with `connections:write`. Guide the operator through creating that token in Slack, then use the private entry procedure in [secret files](secrets.md). Never ask for a token value in chat.
5. Check channel membership and command configuration with online doctor. If a check fails, apply its reported fix after inspecting state.
