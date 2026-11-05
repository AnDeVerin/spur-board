# Secret files

Use this when secret names are missing or a legacy `slack.env` is present. Work in the resolved Board config directory; never display values or paste them into chat, logs, or shell history.

1. Inspect whether `secrets.env` and `slack.env` are regular files, their modes, and their key names only. The config directory must be private and `secrets.env` must have mode `0600`.
2. Ask the operator to enter any missing values through a private local mechanism. Required names are `GITHUB_TOKEN`; `JIRA_EMAIL` and `JIRA_API_TOKEN` when Jira is used; and `SLACK_BOT_TOKEN` and `SLACK_APP_TOKEN` when Slack is configured. Do not create placeholder values.
3. If `slack.env` exists, ask before migration. For duplicate names, ask which value to keep without revealing either. Preserve every unrelated existing `secrets.env` key.
4. Build a new regular `secrets.env` with mode `0600` without logging its content. Verify its key names and mode before removing `slack.env`. Leave the source untouched on any error or if consent is withheld.
5. Check only presence and permissions afterward. Online doctor performs the integration checks; an offline doctor pass does not validate the secret values.
