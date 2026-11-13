# Comment history pages

The GitHub adapter reads a PR's comments newest first: the first page comes with the PR content,
and `readFeedback` in `packages/adapters/src/github/index.ts` pages back after `fullPr` returns
the content. These rules differ from content pages on purpose: the history has its own
completeness fact, `feedbackComplete`, so a gap can be stated without guessing a fact.

- Stop at the cursor core supplies in `PollContext.feedbackCursors`: on a comment with the
  cursor id, or one strictly older than its time. No cursor: read back to the start of the PR.
- At most `FEEDBACK_PAGES` comment pages per PR per poll, the first one included. Reaching the
  cap with older pages left sets `feedbackComplete: false`.
- A history page that fails `transient` keeps the PR with the comments read so far and
  `feedbackComplete: false`; `Batch.complete` and the entity status do not change. That covers
  transport errors, HTTP 5xx, scoped GraphQL errors, a malformed page, a repeated or missing
  cursor, and a missing `rateLimit`: the one place a missing budget does not fail the poll.
- `throttled`, `auth`, `config`, an abort and any error that is not an `AdapterError` reject the
  poll, as on any other page.
- Check `signal.aborted` before treating a `transient` error as per-PR: `GithubClient.query`
  wraps an abort while reading the body as `transient`.
- Report each history page's budget right after the query, before any error check, as `fullPr`
  does; the batch keeps the last budget read.
- Tests: `describe('PR feedback')` in `packages/adapters/test/github/prBatch.test.ts`.

## Continuation across polls

A history past the page cap continues over later polls (A10 in
`packages/contracts/src/adapters.ts`): core holds the comments read so far and an opaque resume
position per source and PR in `pr_continuation`, and passes them back in
`PollContext.continuations`.

- Phase 1 pages back from the newest comment until it reaches the cursor or the start of the PR,
  or joins the newest held comment (same id, or a comment strictly older than it).
- Phase 2, after a join, reads further back from the held `resume`. Both phases share one
  `FEEDBACK_PAGES` budget.
- The run is the comments read now plus the held comments not newer than the oldest one read
  now; a held comment newer than that and not listed again was deleted and is dropped.
- `feedbackComplete` is true only when that run reaches the cursor or the start of the PR.
- Statements on a `pr` item of `poll`: `null` once the newest pages alone reach the cursor or
  the start; `{ resume }` after phase 2 (`null` at the start); a new `{ resume }` with the held
  run dropped when phase 1 spends the budget without a join.
- A stale resume page states `null`: a scoped GraphQL error, a malformed page, a missing or
  repeated start position, or nodes newer than the run that overlap none of it.
- A transient failure thrown on any page, and a phase-1 page failure or a missing or repeated
  start position on the oldest newest-first page, state nothing: core keeps its row.
- `pollPr` reads with the held run and the cursor the runner takes from `core.context` for its
  ref, within the same budget, and states nothing (A9); the runner refuses a `continuation`.
- Core deletes the row of a PR with no unbanned link; a deleted comment older than the newest
  pages stays in the held run until a statement replaces it.
- Tests: `describe('comment history continuation')` in
  `packages/adapters/test/github/prBatch.test.ts`; core `packages/core/test/app/observe.test.ts`.
