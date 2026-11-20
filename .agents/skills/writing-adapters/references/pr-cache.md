# PR cache

Read with `references/github-responses.md`, PR poll chunks and index.

- Per-instance adapter state is allowed: the Spur adapter (`createSpurAdapter`) and the PR cache
  in the `githubSources` closure, keyed by number, holding the PRs requested in the last poll and
  those the last successful discovery listed; a failed discovery drops none. It lives in memory.
- A discovered PR core does not request, unless persisted terminal policy suppresses it, gets
  two full reads (the first with a `null` fingerprint, the second indexed), then one index alias
  per poll while discovery lists it, plus a full read whenever the index rules out reuse, such
  as an open PR with a non-green rollup.
- A discovered PR core does not request is cached and reused by the same rules as a requested
  one, but adds no entity and never holds the cursor once reused. Its facts go out every poll, so
  a batch core did not accept loses nothing. Tests: `describe('PR discovery reads')`.
- Cache fingerprint: `JSON.stringify` of the parsed index alias (`prIndex.ts`). The `edited`
  alias (the comment updated last) and each review's `lastEditedAt` change it on an edit. It
  lists each check's name and state without `isRequired`: a `SUCCESS` rollup also covers skipped
  checks, which core judges red when required. Re-emit the cached facts only when the
  fingerprint, the `feedbackCursors` entry and the `continuations` entry match, `feedbackComplete` is true, the
  read is younger than `OPEN_REFRESH_MS` or `CLOSED_REFRESH_MS`, the index lists every check,
  review, review thread and review request (the full read pages past 100, the index does not),
  and an open PR's rollup is `null` or `SUCCESS` with every listed check green, required or not
  (check run `SUCCESS` or `NEUTRAL`, status `SUCCESS`): a failed rollup can hide a check that
  finished, and a skipped check can turn required with no fingerprint change.
- Write the cache only from a full read, with the index fingerprint of the same poll, or with a
  `null` fingerprint when that poll had no index entry: such an entry is indexed next poll and
  never reused. Delete the entry on `not_found`, `no_access` and `pollPr`. An old entry would
  re-emit facts older than ones already delivered.
- A new input to what a full read returns, such as a comment cursor or a held history, joins
  the cache key. A re-emitted entry carries no `continuation`, so core keeps its row. It carries
  the full read's `reviewRule` again (github-rules sources), so a batch core did not accept
  loses no review rule.

## Pair cache

- `pairCache` in the `githubSources` closure holds, per PR number, the head it was read for and
  the `approvalPairs` computed for it by approved commit: counted, `history_rewritten` or
  `pr_too_large`, never `rate_limit`. Its pairs go out again on every poll, full read or reused.
- Prune: drop a number no longer requested or in `terminalPrs`; an item with a new head starts
  an empty entry; an item no longer open drops it. A PR with no item this poll (failed or
  deferred detail read, `no_access`) keeps its entry.
- An unreadable `PrCommits` response (any GraphQL error, null `repository` or `pullRequest`, a
  malformed part, null `tree.entries`, head not listed) sets `unreadableUntil`: no read for that
  head for `UNREADABLE_RETRY_MS` (15 minutes). A transient failure sets nothing and is retried
  next poll.
- The walk (`approvalPairs`) compares each top-level entry by `oid` and `mode`, reads every
  parent (fewer listed than `totalCount` is unreadable), and takes an approved commit that is an
  unlisted parent of a commit the head reaches as an ancestor: it landed on the base.
- A readable read records the PR's `baseRefName`. When PRs with cached pairs get a full read,
  one aliased `PrBases` (`basesQuery`) checks their bases; a changed base drops the PR's entry,
  since a retarget changes the list but not the head. A failed check keeps it.
- Time: `pairReader` starts no read once `APPROVAL_PASS_MS` (2 s) passed in the pass and times
  each out at `APPROVAL_REQUEST_MS` (4 s), so `pollPr` (10 s deadline, same queue) waits at most
  6 s on it. `throttled` pauses the source's reads (`pairPause`) until `retryAt`, else for
  `APPROVAL_THROTTLE_MS` (1 minute); `auth` for 15 minutes. Unread PRs leave pairs out.
- On-demand first: the runner aborts `PollContext.optionalSignal` when `pollPr` queues behind
  the poll in flight. `pairReader` then cuts its read in flight short and sends no more, so the
  poll returns its batch and `pollPr` starts without waiting for approval history.
- `pollPr` reads no commits, sends no `approvalPairs` and leaves the pair cache as it was.
- Tests: `describe('approval watch')` in `packages/adapters/test/github/prBatch.test.ts`.
