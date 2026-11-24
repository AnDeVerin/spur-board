# Demo board

The `showcase` stand scenario fills every column of the Board with invented work, so a demo can
walk through each column and state without a live board. It runs on a disposable
[QA stand](qa-stand.md): fake GitHub, Spur and Slack, never a real service.

## Before you start

- Run the stand from a spur-board checkout of the version you demo, in a separate worktree, not
  the live board's main checkout: the web build writes `packages/web/dist` of the checkout it
  runs from. For example:

  ```sh
  git worktree add --detach ../spur-board-demo origin/main
  cd ../spur-board-demo
  pnpm install
  ```

- Build the web UI there and run every `pnpm stand` command from that directory.
- With another stand live on the machine, `seed`, `wait` and `down` exit 2 with
  `Several live stands; pick one with --home`: pass `--home <home>`, the `home` that `up`
  printed, to every later stand command.
- A shell holding external credentials (`GITHUB_TOKEN`, `GH_TOKEN`, `SLACK_*`, `JIRA_*`,
  `BOARD_TOKEN`, Spur secrets) must unset them for every stand command: `up` and `demo` refuse
  with `external_secrets` and print the command as run, without them. Prefix each command, for example:

  ```sh
  env -u GITHUB_TOKEN -u JIRA_API_TOKEN pnpm stand up --scenario showcase
  ```

## Start

Build the web UI from the checkout you demo, then start a stand seeded with the scenario:

```sh
pnpm --filter @spur-board/web build
pnpm stand up --scenario showcase
```

`up` detaches and prints one JSON line. Keep its `home` and `webUrl`; `pnpm stand status --json`
prints them again, with the seeded task keys and block IDs under `scenario`.

From a Spur session, run the stand as the `board-stand` sidecar with
`pnpm stand up --foreground --scenario showcase` in place of `pnpm stand up --foreground`
([Spur sidecar](qa-stand.md#spur-sidecar)).

The ages on the cards count from the seed. To make them fresh again, seed once more and wait:

```sh
pnpm stand seed showcase
pnpm stand wait scenario
```

Stop the stand with `pnpm stand down` when the demo is over.

To walk one task from Todo to Done on this Board a step at a time, seed `walkthrough` instead:
[Demo walkthrough](demo-walkthrough.md).

## Web address

`up` prints `webUrl` only when the live board's `web.publicOrigin` has `{port}`, for example
`https://{port}.<domain>`: the stand fills in its own web port. Without `{port}`, `up` says so on
stderr and the stand is API-only, with nothing to show in a browser. Open the Board only at that
`webUrl`, never at the live board's address.

The Board opens on project `stand`, the first project; the project switcher in the header
changes it, and the browser keeps the choice in localStorage `board-project`.

## Themes

The theme menu in the status bar switches Light, Dark and Auto. The browser keeps the choice in
localStorage `board-theme` (`light`, `dark` or `auto`), so a reload keeps it.

## Columns

The tasks, pull requests and reviewers are invented. Each line names a column ID and what it
shows:

- `todo` - three cards outside the GitHub Project, the oldest six days old.
- `triage` - two cards the operator moved by hand, with the reason in History.
- `ready-for-dev` - two cards the GitHub Project `stand-org/1` places through its Status `Ready`.
- `dev` - a live task: the worker's taken turn, checks pending and an open question to the
  operator with two replies; and a task returned from QA with 3 findings, a worker code block,
  an untaken worker turn and an operator comment.
- `review` - the conductor's taken Review turn.
- `product-review` - the conductor's Product Review turn, open and not taken.
- `external-review` - a task waiting for an outside review, with no turn; the "Why it is here"
  table of its task view shows "Approved: not approved".
- `qa` - an open QA turn on a head an outside reviewer approved.
- `ready-to-merge` - the operator's turn on a PR whose approval is 3 commits behind its head; in
  Dev the task carried a worker question the operator answered and followed up.
- `done` - five finished tasks; one ran the whole flow, and its History lists each step.

The inbox also holds a failure: the default branch of `stand-org/board` is red.

## Best views

Take keys and IDs from `pnpm stand status --json`, under `scenario`; URL-encode a task key.

- The Board: `<webUrl>/`.
- The returned task's view: `<webUrl>/?open=stand-org%2Fboard%23388`, the key of
  `scenario.tasks.returned`.
- The operator inbox, with the open entries and the handled answer and turn:
  `<webUrl>/?open=inbox`.
- The open question in Dev: `<webUrl>/?open=block%3A<id>`, with `<id>` from
  `scenario.blocks.question`, for example `?open=block%3AB1`.
- The services panel: `<webUrl>/?open=services`.

Column help has no address of its own: open `<webUrl>/` and click the executor line under the
column name (`manual` or `mirror · Stand roadmap`, the GitHub Project's title, in the Backlog parts).

## Limits

- Done tasks archive at the first Saturday 00:00 UTC after the seed: seed again after it.
- `pnpm stand reset` restores the seed's snapshot with its old times, so the ages grow; use
  `pnpm stand seed showcase` instead.
- The handled turn drops out of the inbox 24 hours after the seed, the handled answer about 6
  hours after it: the answer keeps its place in the task's History, about 18 hours before the seed.
- The role sessions stay working, so the Board sends no reminders and nothing moves on its own;
  History spreads the steps over the hours before the seed, and the answered question in
  Ready to Merge moves with it, while a task view lists open blocks, their replies and task
  comments at the seed time. Its "Latest submission" time is the seed time too: the submission
  record is not backdated, so it is later than the submit step in History.
