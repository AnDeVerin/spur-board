# Demo walkthrough

The `walkthrough` stand scenario is the [Demo board](demo.md) plus one new task, issue 440 "Let
users pin favourite projects to the sidebar", in Todo. Each `pnpm stand demo next` moves that
task one visible step towards Done through the fake GitHub and Spur and the Board's public API,
and returns once the Board shows the new state. The showcase cards around it never move, and the
page stays open: no step restarts the daemon. It runs on a disposable [QA stand](qa-stand.md),
never a live board.

## Start

Build the web UI from the checkout you demo, then start a stand seeded with the scenario:

```sh
pnpm --filter @spur-board/web build
pnpm stand up --scenario walkthrough
```

`up` detaches and prints one JSON line with the stand's `home` and `webUrl`; the demo task's key
is `scenario.tasks.demo`. From a Spur session, run the stand as the `board-stand` sidecar with
`pnpm stand up --foreground --scenario walkthrough` ([Spur sidecar](qa-stand.md#spur-sidecar)).
Open the Board at `<webUrl>/` and keep the page open for the whole walkthrough.

## Commands

- `pnpm stand demo next` runs the next step. It prints `step <n>/13: <title>`, the narration
  line, `open: <webUrl>/?open=...` for a step with a view to open, and the next step's title.
- `pnpm stand demo status` prints the step the demo is at, without running one.
- `pnpm stand demo reset` seeds the scenario again with fresh times and goes back to step 0. It
  prints `violations cleared: <n>`: the violation log is dropped, so save
  `pnpm stand violations` first. An open page reconnects by itself within a few seconds; reload
  it if it shows offline.
- `pnpm stand reset` also goes back to step 0, onto the seed's snapshot with its old times.

`demo next` after step 13 exits 1: run `demo reset` to start again.

## Step 1 - Ready for Dev

Act 1, picked up. Narration:

> Issue 440 is marked Ready in the GitHub Project, and the Board mirrors it into Ready for Dev.

Point at the card leaving Todo for Ready for Dev, and the column's `mirror` executor line.

## Step 2 - Dev

Narration:

> A worker session is linked to the task: it moves to Dev, and the worker takes its turn.

Point at the card in Dev with the worker's taken turn.

## Step 3 - A question to the operator

Act 2, a question. Narration:

> The worker is unsure about the scope and asks the operator; the question waits on the card.

Open `<webUrl>/?open=block%3A<id>`, the URL `demo next` prints. You may answer the question here
in the web UI; step 4 then only checks it is answered.

## Step 4 - The answer

Narration:

> The operator answers from the Board; the question closes and the worker carries on.

Open `<webUrl>/?open=inbox`: the answer is under handled entries.

## Step 5 - A pull request

Act 3, a pull request. Narration:

> The worker opens pull request 440; the Board links it by its branch and shows the checks running.

Open `<webUrl>/?open=stand-org%2Fboard%23440`, the task view, with the PR and its pending checks.

## Step 6 - Review

Narration:

> The checks pass and the worker submits the head; the task moves to Review and the conductor takes it.

Point at the card in Review with the conductor's taken turn.

## Step 7 - Changes requested

Act 4, changes requested. Narration:

> Review finds two problems and returns the task to Dev, with a code block for the worker.

Open `<webUrl>/?open=stand-org%2Fboard%23440`: the return with 2 findings, the code block and the
worker's untaken turn.

## Step 8 - A new head

Act 5, a new head. Narration:

> The worker pushes a fix and submits the new head; the code block closes and Review starts again.

Point at the card back in Review on the new head.

## Step 9 - Product Review

Narration:

> Review passes the new head, and the conductor takes the Product Review turn.

Point at the card in Product Review.

## Step 10 - External Review

Narration:

> Product Review passes too; the task waits in External Review for an outside approval, with no turn.

Open `<webUrl>/?open=stand-org%2Fboard%23440`: "Why it is here" shows it is not approved yet.

## Step 11 - Approved

Act 6, the approval. Narration:

> quill-teodor approves the pull request on GitHub; the task moves on to QA and the conductor takes it.

Point at the card in QA with the conductor's taken turn.

## Step 12 - Ready to Merge

Narration:

> QA passes; the task is Ready to Merge, and the operator gets the merge turn in the inbox.

Open `<webUrl>/?open=inbox`: the operator's merge turn on issue 440.

## Step 13 - Done

Act 7, the merge. Narration:

> The pull request is merged and the issue closed; the task lands in Done with a wrap-up turn for the worker.

Open `<webUrl>/?open=stand-org%2Fboard%23440`: the task in Done, its History lists every step.

## Limits

- Act by hand only to answer the question at step 3. Any other change in the web UI or the fakes
  can make the next step fail: `demo next` then exits 1 and refuses until `pnpm stand demo reset`.
- `pnpm stand demo reset` and `pnpm stand reset` drop the violation log: read and save
  `pnpm stand violations` first.
- Done tasks archive at the first Saturday 00:00 UTC after the seed: run `demo reset` after it.
- The role sessions stay working, so the Board sends no reminders and nothing moves between
  steps; the [Demo board](demo.md) limits apply to the showcase cards.
