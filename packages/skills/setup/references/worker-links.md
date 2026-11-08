# Worker links

Use this for each `github-issues` project with a `role: worker` entry in `spurProjects`. A worker session links to its task through a `board-worker` Spur link, or later through its PR or branch.

1. For each `role: worker` entry in that project's `spurProjects`, ask how its workers start (a script, an orchestrator prompt, a spawn step). Read that flow; do not change it yet.
2. Check that the flow sets the session's `board-worker` link to `https://github.com/<owner>/<repo>/issues/<N>`, with owner and repo spelled letter for letter as in `tracker.repo`, and no trailing slash, query or fragment. A URL cased differently links nothing and reports no error.
3. If it does not, suggest adding `spur slots --session "$SPUR_SESSION" --link board-worker=<issue URL>` as the worker's first step. `spur spawn` cannot set links; a script that spawns the session passes the new session's ID instead of `$SPUR_SESSION`. Ask before editing the flow.
4. Confirm `operatorGithubLogin` is the account the agents' PRs are authored by. It may differ from the maintainer's own account; PR discovery keeps only PRs by this author.
5. Read the tracker repo's branch and PR title rules (its CI title check and agent skills) and set `projects[].link` to match. The Board does not enforce naming. `board doctor` reports `link.rules`: how many of the operator's recent PRs the rules match.
6. After a worker starts, check `board status --detail` within one Spur poll: the task lists the session as worker. If it does not, the operator can run `board link <task> --session <id> --reason <text> --key <key>`.
