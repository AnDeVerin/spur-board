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
