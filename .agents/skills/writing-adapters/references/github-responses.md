# GitHub responses

GitHub-specific parsing rules for `GithubClient.query` callers in
`packages/adapters/src/github/`.

- GraphQL errors in a 200 response: `GithubClient.query` maps rate limiting to a synthetic 429
  and `INSUFFICIENT_SCOPES` to `auth`.
- Parse a GraphQL root only after `GithubClient.query` classifies `errors` and its scoped errors
  are handled; denied fields arrive null, so make them nullable.
- Unknown shape in one PR: leave it out, clear `complete`, report it `no_access` if requested;
  rethrow its error if nothing else answered. Other unknown shapes fail the poll.
- Comment history: read `references/comment-history.md`.

## Partial errors that keep complete

An exception to the SKILL.md rule "A missing or denied requested entity gets `not_found` or
`no_access`; any other partial error clears `complete`":

- Except a denied `closingIssuesReferences` (`deniedReference`) or a `null` `requestedReviewer`:
  drop it, keep `complete`.
- Except a denied `baseRef` or field below it on a github-rules detail read (`deniedBranchRule`):
  keep the PR, send its `reviewRule` with `rule: null`, keep `complete`; core decides nothing.
- Except an error under `repository.defaultBranchRef` in discovery, or an unknown shape there:
  drop `Batch.defaultBranch`, keep discovery `ok` and `complete` (`readDiscovery`,
  `defaultBranchFact`). `INSUFFICIENT_SCOPES` and rate limits there still fail the request in
  `GithubClient.query` (`auth`, `throttled`) and blind the source, as on the PR detail read.
- Except a failed, errored or malformed `PrCommits` read (`commitsQuery`, `approvalWatch.ts`):
  leave out that PR's missing `approvalPairs`, keep `complete` and `parseError`. Never pass its
  errors to `rejectUnscoped`; `approvalPairs` reads `repository` with `safeParse` and never throws.
  `throttled`, `auth` and an abort still reject the poll.

## PR poll chunks and index

`pollRepository` in `packages/adapters/src/github/index.ts`; tests `describe('PR poll chunks')`
and `describe('PR index cache')` in `packages/adapters/test/github/prBatch.test.ts`.

- Suppress persisted merged PRs before constructing aliases, including discovery cursor ties.
- Defer persisted closed PRs until core requests a state-only recheck; select identity and state,
  answer in `prProbes`, and leave facts, history, freshness and misses alone when still closed.
  OPEN discovery bypasses deferral for every known closed PR, regardless of author; a nonclosed
  or unknown probe state requires a full read in the same poll. Failed reads stay due.
- Order: discovery, its own request; due state probes; the index (`indexQuery`, 50 aliases) of every requested PR
  and of each discovered one the cache holds; full reads (`detailQuery`, 10 aliases, requested
  PRs in their own chunks first) of the PRs the index shows changed and of discovered ones the
  cache does not hold; last, one `PrCommits` read per requested open PR item, read in full or
  reused, with an approval off its head and a pair missing from the pair cache
  (`readApprovalPairs`, `references/pr-cache.md`). Below 3 times `github.reserveRemaining` it
  sends none and the missing pairs go out as `rate_limit`; it never defers a detail read.
- Discovery lists `OPEN` PRs on bootstrap and `OPEN, MERGED, CLOSED` after it (`discoveryQuery`):
  a merge or close moves `updatedAt`, so an unlinked operator PR's new state reaches core
  through its detail read. The bootstrap `mergedBaseline` reads the newest `MERGED, CLOSED` PR, so
  the first cursor sits past the history later polls list.
- A transient failure (5xx, cut-off body, timeout) of discovery, an index chunk or a detail
  chunk counts toward `MAX_FAILED_REQUESTS` per poll; an aliased chunk is resent as two halves
  down to one PR. At the cap nothing more is sent. If no request succeeded, rethrow the first
  failure.
- `throttled`, `auth`, `config`, an abort, a non-`AdapterError` or a failed `fullPr` page
  rejects the poll; nothing is resent.
- A requested PR left unread (chunk given up, never sent, or deferred because `remaining` fell
  below `github.reserveRemaining`) is `no_access`, the batch is incomplete, and an unread
  discovered PR holds the cursor. Discovery and the index still run below the reserve.
- An index alias with an error, an unknown shape or an unscoped error in its chunk means
  changed: read in full. Unscoped errors on a detail chunk still reject.
- The PR cache, discovered PR reads and the cache fingerprint: read `references/pr-cache.md`.

## Budget

- PR queries select `rateLimit { cost limit remaining resetAt }`; a missing cost is allowed and
  never inferred from remaining-budget changes. Keep the latest remaining/reset independently.
- `Batch.budget.limit` comes only from a valid positive integer `limit`; a missing or invalid one
  is left out and never fails the poll or drops remaining/reset (`GithubClient.query`).
- Capture valid reported cost before GraphQL classification and PR parsing; sum it once per
  attempt in `Batch.usage`, or attach it to `AdapterError.usage` when the attempt rejects.
- Expose pending cost through optional `Adapter.takeUsage`; the runner drains it synchronously
  on cancellation and persists it through the source report chain, including during stop.
  Preserve the original abort reason and never infer a cost for a request that did not report one.
- The runner persists successful batch usage with the observation and failed usage with a source
  report, even when state text is unchanged; never report a committed batch's cost twice.
- Core persists reported samples and exposes the sum in `(now - 1h, now]` as `pointsLastHour` for
  PR sources, including after restart. Tests: `state probes and reported source cost` in
  `packages/adapters/test/runner/runner.test.ts`.
- Nested thread comments (`comments(last: 100)` under `reviewThreads(first: 100)`) add about 100
  requests per PR to each detail alias's cost; detail chunks hit `github.reserveRemaining` sooner.
- Issues reads `x-ratelimit-remaining`/`-reset` and omits bad ones; it adds `x-ratelimit-limit`
  only when it is a positive safe integer (`restBudget` in `packages/adapters/src/github/issues.ts`).
- Core keeps each source's budget from its last batch that carried one in `source_state` and
  shows it as `sources[].budget` in `status.get`; a batch or source report without a budget leaves
  it unchanged (`sourceState` in `packages/core/src/app/observe.ts`).
